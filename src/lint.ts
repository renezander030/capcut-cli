import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { bubbleCatalogue, imageAnimCatalogue } from "./decorators.js";
import type { Draft, Segment, Track } from "./draft.js";
import { extractStyleRanges, extractText, findMaterial, getTracksByType } from "./draft.js";
import { type Category, listEnum, type Namespace } from "./enums.js";
import { copyAssetDeduped, effectCatalogue, filterCatalogue } from "./factory.js";
import { ffprobeAvailable, isVfr, probeMedia } from "./probe.js";
import { assessMediaRegistrationAt } from "./store.js";
import { rangesLookDoubled, repairDoubledRanges } from "./text-offsets.js";
import { allUserEnumIds } from "./user-enums.js";
import { atLeast } from "./version.js";

export type Severity = "error" | "warning" | "info";

export interface LintIssue {
  severity: Severity;
  code: string;
  message: string;
  fixable: boolean;
  /** Concrete remediation one-liner for report-only issues (the user runs it
   * deliberately — unlike --fix, it may touch content or need a human input
   * such as the replacement media directory). */
  suggested_command?: string;
  location?: {
    track?: string;
    segment_id?: string;
    material_id?: string;
    path?: string;
  };
}

// Codes that lintDraft can mechanically repair via fixDraft. Membership here
// is necessary but not sufficient for fixable:true — line-too-long,
// caption-gap-too-small, main-track-gap, and media-outside-draft are
// additionally stamped per instance, so an issue is only marked fixable when
// fixDraft can actually clear that exact instance. dangling-companion-ref is
// always safely fixable: the repair drops a ref that points at nothing —
// never a segment, never a material.
//
// Deliberately NOT here: missing-material and missing-file (the only safe
// repair would delete user timeline content or guess a path — report-only,
// each carrying a suggested_command; `remove`, `relink`, and `replace-media`
// are the intended deliberate repairs), and unknown-effect-slug (repair
// would mean guessing which resource the author meant).
const FIXABLE_CODES = new Set<string>([
  "cue-too-long",
  "caption-overlap",
  "caption-gap-too-small",
  "line-too-long",
  "dangling-companion-ref",
  "main-track-gap",
  "media-outside-draft",
  "text-range-doubled",
]);

// Floor for any duration --fix writes: 100ms = three frames at the 30fps
// draft default. Below roughly one frame (33,333us at 30fps) CapCut cannot
// render the caption at all, so a "repair" that short would silently delete
// it from playback. Pass 3 skips shrinks that would land under this floor and
// the corresponding caption-gap-too-small issue is reported with
// fixable:false instead.
export const MIN_CAPTION_DURATION_US = 100_000;

export interface LintOptions {
  maxCharsPerLine: number;
  maxCueDurationUs: number;
  minGapBetweenCaptionsUs: number;
  checkLocalPaths: boolean;
  /** Reading-speed ceiling in characters per second. maxCueDurationUs caps how
   * LONG a caption may stay up; this caps how FAST it goes by, which is the
   * limit a viewer actually feels — 45 characters in 1.2s breaks no absolute
   * duration rule and is still unreadable. 20 is the common subtitling ceiling
   * (BBC/Netflix sit at 17-20 for Latin scripts). */
  maxCharsPerSecond?: number;
  /** Fraction of a vertical canvas's height treated as safe for captions,
   * measured from the centre outward in CapCut's normalized transform space.
   * A caption past it sits where TikTok/Reels/Shorts draw their own UI. */
  safeAreaFraction?: number;
  /** ffprobe local media that exists (VFR/unreadable checks). Best-effort:
   * silently skipped when ffprobe is unavailable. Default true. */
  probeMedia?: boolean;
  ffprobeCmd?: string;
  /** Absolute path of the draft's folder (the directory holding the timeline
   * file). Enables the media-outside-draft check and its --fix stage-in;
   * library callers that lint a Draft with no on-disk home simply omit it and
   * the rule never runs. */
  draftDir?: string;
  /** Preview mode for fixDraft: staging external media copies a file into the
   * draft folder — a side effect no draft write can roll back — so under
   * dry-run the stage-in pass is skipped entirely and its issues stay
   * reported. The pure-JSON repair passes run either way (the caller's
   * dry-run save discards them). */
  dryRun?: boolean;
}

export const DEFAULT_LINT_OPTIONS: LintOptions = {
  maxCharsPerLine: 42, // BBC subtitle standard
  maxCueDurationUs: 7_000_000, // 7s; longer caps are hard to read
  minGapBetweenCaptionsUs: 0, // overlap = error; gap = no rule by default
  checkLocalPaths: true,
  probeMedia: true,
  maxCharsPerSecond: 20, // upper end of the BBC/Netflix reading-speed range
  safeAreaFraction: 0.85, // |transform.y| past this is under the platform UI
};

export function lintDraft(draft: Draft, opts: LintOptions = DEFAULT_LINT_OPTIONS): LintIssue[] {
  const issues: LintIssue[] = [];
  // Built on the first reference that needs it, not up front: a draft whose
  // `materials` is missing entirely must still fail at the first lookup the
  // way the per-reference scan did, and the first loop skips those segments.
  let materialIds: Set<string> | null = null;
  const materialExists = (id: string): boolean => {
    if (materialIds === null) materialIds = materialIdSet(draft);
    return materialIds.has(id);
  };

  for (const seg of allSegments(draft)) {
    const s = seg.segment;
    if (!draft.materials || !s.material_id) continue;
    if (!materialExists(s.material_id)) {
      issues.push({
        severity: "error",
        code: "missing-material",
        message: `Segment ${shortId(s.id)} references material ${shortId(s.material_id)} that does not exist in any materials.*`,
        fixable: FIXABLE_CODES.has("missing-material"),
        suggested_command: `capcut remove <project> ${shortId(s.id)}`,
        location: { track: seg.track.name, segment_id: s.id, material_id: s.material_id },
      });
    }
  }

  // Companion refs that resolve to nothing — the leftover of a partial edit
  // (hand-edited JSON, an interrupted tool, a material deleted without its
  // refs). Unlike missing-material this never involves timeline content: the
  // ref points at nothing, so dropping it is always safe and --fix does.
  for (const seg of allSegments(draft)) {
    const s = seg.segment;
    for (const ref of s.extra_material_refs ?? []) {
      if (typeof ref !== "string" || ref === "") continue;
      if (materialExists(ref)) continue;
      issues.push({
        severity: "warning",
        code: "dangling-companion-ref",
        message: `Segment ${shortId(s.id)} carries companion ref ${shortId(ref)} in extra_material_refs that resolves to no material — the app's behaviour on it is undefined`,
        fixable: FIXABLE_CODES.has("dangling-companion-ref"),
        location: { track: seg.track.name, segment_id: s.id, material_id: ref },
      });
    }
  }

  for (const track of getTracksByType(draft, "text")) {
    const segs = [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const mat = findMaterial(draft.materials.texts, s.material_id);
      const text = mat ? extractText(mat.content) : "";

      // Style ranges this CLI wrote before 0.19.1 are UTF-16LE byte offsets —
      // twice the code-unit offsets CapCut stores (#85). A lone full-span
      // block survives that, because the app clamps [0,2n] back to the end of
      // the text, but every karaoke or keyword highlight lands past the end
      // and paints nothing. The doubled form is identifiable with certainty
      // (text-offsets.ts), which is what makes halving it a safe --fix rather
      // than a guess.
      if (mat) {
        const stored = extractStyleRanges(mat.content);
        if (rangesLookDoubled(text, stored)) {
          issues.push({
            severity: "warning",
            code: "text-range-doubled",
            message: `Caption ${shortId(s.id)} stores style ranges as UTF-16LE bytes — ${stored.length} range(s) ending at ${text.length * 2} on a ${text.length}-character text, so per-range styling points past the end`,
            fixable: FIXABLE_CODES.has("text-range-doubled"),
            location: { track: track.name, segment_id: s.id, material_id: mat.id },
          });
        }
      }

      if (s.target_timerange.duration > opts.maxCueDurationUs) {
        issues.push({
          severity: "warning",
          code: "cue-too-long",
          message: `Caption ${shortId(s.id)} runs ${Math.round(s.target_timerange.duration / 1000)}ms (>${opts.maxCueDurationUs / 1_000_000}s)`,
          fixable: FIXABLE_CODES.has("cue-too-long"),
          location: { track: track.name, segment_id: s.id },
        });
      }

      // Reading speed. cue-too-long above catches a caption that lingers; this
      // catches the opposite failure, a caption that is gone before it can be
      // read. Only meaningful with both text and a real duration, and counted
      // on visible characters (whitespace is not read).
      const cps = opts.maxCharsPerSecond;
      if (cps !== undefined && cps > 0 && text.length > 0 && s.target_timerange.duration > 0) {
        const visible = text.replace(/\s+/g, "").length;
        const seconds = s.target_timerange.duration / 1_000_000;
        const rate = visible / seconds;
        if (visible > 0 && rate > cps) {
          const needed = Math.ceil((visible / cps) * 1000);
          issues.push({
            severity: "warning",
            code: "caption-too-fast",
            message: `Caption ${shortId(s.id)} runs at ${rate.toFixed(1)} chars/s (>${cps}) — ${visible} characters in ${Math.round(seconds * 1000)}ms`,
            // Report-only: the repair is either more screen time (which moves
            // every later caption) or fewer words (an authoring decision).
            fixable: false,
            suggested_command: `capcut trim <project> ${s.id} <start> ${needed}ms  # or shorten the text`,
            location: { track: track.name, segment_id: s.id },
          });
        }
      }

      // Safe area. On a vertical canvas the platform draws its own UI over the
      // top and bottom bands, so a caption parked near either edge is covered
      // on the very platforms a 9:16 draft targets. Direction-agnostic on
      // purpose: both edges are unsafe, so this needs no assumption about
      // which way CapCut's transform.y points.
      const safe = opts.safeAreaFraction;
      const canvas = draft.canvas_config;
      if (
        safe !== undefined &&
        safe > 0 &&
        canvas &&
        typeof canvas.width === "number" &&
        typeof canvas.height === "number" &&
        canvas.height > canvas.width
      ) {
        const y = s.clip?.transform?.y;
        if (typeof y === "number" && Math.abs(y) > safe) {
          issues.push({
            severity: "warning",
            code: "caption-outside-safe-area",
            message: `Caption ${shortId(s.id)} sits at y=${y.toFixed(2)} on a ${canvas.width}x${canvas.height} vertical canvas (|y|>${safe}) — inside the band TikTok/Reels/Shorts overlay with their own UI`,
            fixable: false,
            suggested_command: `capcut text-style <project> ${s.id} --y ${(Math.sign(y) * safe).toFixed(2)}`,
            location: { track: track.name, segment_id: s.id },
          });
        }
      }

      for (const line of text.split(/\r?\n/)) {
        if (line.length > opts.maxCharsPerLine) {
          issues.push({
            severity: "warning",
            code: "line-too-long",
            message: `Caption ${shortId(s.id)} has ${line.length}-char line (>${opts.maxCharsPerLine}): "${line.slice(0, 50)}…"`,
            fixable:
              FIXABLE_CODES.has("line-too-long") &&
              mat !== undefined &&
              canFixLineTooLong(mat.content, opts.maxCharsPerLine),
            location: { track: track.name, segment_id: s.id },
          });
          break;
        }
      }

      const next = segs[i + 1];
      if (next) {
        const end = s.target_timerange.start + s.target_timerange.duration;
        const gap = next.target_timerange.start - end;
        if (gap < 0) {
          issues.push({
            severity: "error",
            code: "caption-overlap",
            message: `Captions ${shortId(s.id)} and ${shortId(next.id)} overlap by ${Math.round(-gap / 1000)}ms on track "${track.name}"`,
            fixable: FIXABLE_CODES.has("caption-overlap"),
            location: { track: track.name, segment_id: s.id },
          });
        } else if (gap > 0 && gap < opts.minGapBetweenCaptionsUs) {
          // Fixable only when pass 3's shrink leaves the earlier caption at or
          // above MIN_CAPTION_DURATION_US — otherwise the repair would crush
          // it to an unrenderable sliver, so it is report-only.
          const shrunkDuration = s.target_timerange.duration - (opts.minGapBetweenCaptionsUs - gap);
          issues.push({
            severity: "warning",
            code: "caption-gap-too-small",
            message: `Captions ${shortId(s.id)} and ${shortId(next.id)} are ${Math.round(gap / 1000)}ms apart (<${opts.minGapBetweenCaptionsUs / 1000}ms)`,
            fixable: FIXABLE_CODES.has("caption-gap-too-small") && shrunkDuration >= MIN_CAPTION_DURATION_US,
            location: { track: track.name, segment_id: s.id },
          });
        }
      }
    }
  }

  // Speed consistency. `capcut speed` maintains two things at once: the
  // segment's own `speed`, and the source span it consumes
  // (source.duration = target.duration * speed). A draft that has been through
  // another tool — or hand-edited — can carry a `speed` that disagrees with
  // its own timeranges, or with the linked speed material the app actually
  // reads. The app then plays the clip at one rate while every UI surface
  // reports another, and anything aligned to that clip (captions above all)
  // drifts with no visible cause. Both halves are mechanically checkable.
  for (const track of draft.tracks) {
    if (track.type !== "video" && track.type !== "audio") continue;
    for (const s of track.segments) {
      const speed = s.speed;
      if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) continue;
      const target = s.target_timerange?.duration;
      const source = s.source_timerange?.duration;
      if (typeof target === "number" && typeof source === "number" && target > 0 && source > 0) {
        const implied = source / target;
        // One frame at 30fps over a one-second clip is ~3%; 1% is comfortably
        // below that and still well above JSON rounding noise.
        if (Math.abs(implied - speed) / speed > 0.01) {
          issues.push({
            severity: "warning",
            code: "speed-timerange-mismatch",
            message: `Segment ${shortId(s.id)} declares speed ${speed} but its timeranges imply ${implied.toFixed(3)} (${source}us of source over ${target}us of timeline)`,
            fixable: false,
            suggested_command: `capcut speed <project> ${s.id} ${speed}  # rewrites source_timerange to match`,
            location: { track: track.name, segment_id: s.id },
          });
        }
      }
      for (const refId of s.extra_material_refs ?? []) {
        const speedMat = findMaterial(draft.materials.speeds, refId);
        if (!speedMat) continue;
        if (typeof speedMat.speed === "number" && Math.abs(speedMat.speed - speed) > 1e-6) {
          issues.push({
            severity: "warning",
            code: "speed-material-mismatch",
            message: `Segment ${shortId(s.id)} declares speed ${speed} but its speed material ${shortId(refId)} carries ${speedMat.speed} — the app reads the material`,
            fixable: false,
            suggested_command: `capcut speed <project> ${s.id} ${speed}  # re-syncs both`,
            location: { track: track.name, segment_id: s.id, material_id: refId },
          });
        }
      }
    }
  }

  // CapCut's main video track is magnetic: on open, the app pulls segments
  // left to close any gap between consecutive main-track segments
  // (sun-guannan/VectCutAPI#54), so a tool-written draft with such gaps
  // silently re-times itself the moment it is opened — and captions, overlays,
  // and audio aligned to the post-gap content drift out of sync. The main
  // track is the FIRST track of type "video" in array order (the bottom layer
  // of the stack — same convention render.ts flattens). Warning severity: the
  // draft opens fine, just not with the timing that was written. Fixable only
  // when the close-up is mechanically safe per canCloseMainTrackGap; otherwise
  // report-only, because re-timing the other tracks to follow the shift is a
  // content decision the CLI must not make on its own.
  const mainTrack = draft.tracks.find((t) => t.type === "video");
  if (mainTrack) {
    const segs = [...mainTrack.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      const next = segs[i + 1];
      const end = s.target_timerange.start + s.target_timerange.duration;
      const gap = next.target_timerange.start - end;
      if (gap <= 0) continue;
      const safe = canCloseMainTrackGap(draft, mainTrack, end);
      const issue: LintIssue = {
        severity: "warning",
        code: "main-track-gap",
        message:
          `Main video track has a ${Math.round(gap / 1000)}ms gap between segments ${shortId(s.id)} and ` +
          `${shortId(next.id)} — CapCut's magnetic main track closes it on open, silently shifting every ` +
          "later segment left (sun-guannan/VectCutAPI#54)",
        fixable: FIXABLE_CODES.has("main-track-gap") && safe,
        location: { track: mainTrack.name, segment_id: s.id },
      };
      if (!safe) {
        // Deliberate repair that keeps cross-track sync: move the dependent
        // segments left in lockstep with the main-track close-up — one shift
        // per segment (any track) starting at or after the gap.
        issue.suggested_command = `capcut shift <project> <each-segment-at-or-after-the-gap> -${gap / 1000}ms`;
      }
      issues.push(issue);
    }
  }

  if (opts.checkLocalPaths) {
    // Media probing (VFR / unreadable) is best-effort: only files that exist,
    // only when ffprobe runs — a host without ffprobe lints exactly as before.
    const probeCmd = opts.ffprobeCmd ?? "ffprobe";
    // Resolved on the first material that would actually be probed, because
    // ffprobeAvailable() spawns `ffprobe -version`: a caption-only draft (or
    // one whose media is all missing or remote) never probes anything, and
    // paid for that spawn regardless. probe.ts memoizes per command string,
    // so the spawn still happens at most once and the answer never changes.
    let probeReady: boolean | null = null;
    const shouldProbe = (): boolean => {
      if (probeReady === null) probeReady = (opts.probeMedia ?? true) && ffprobeAvailable(probeCmd);
      return probeReady;
    };
    for (const kind of ["videos", "audios"] as const) {
      for (const mat of draft.materials[kind] ?? []) {
        const m = mat as { id: string; path?: string; type?: string };
        if (typeof m.path !== "string" || m.path.length === 0) continue;
        if (m.path.startsWith("http://") || m.path.startsWith("https://")) continue;
        if (!fileExists(m.path)) {
          issues.push({
            severity: "error",
            code: "missing-file",
            message: `Material ${shortId(m.id)} (${kind}) references file that doesn't exist: ${m.path}`,
            fixable: FIXABLE_CODES.has("missing-file"),
            suggested_command: `capcut relink <project> --dir <directory-containing-the-files>`,
            location: { material_id: m.id, path: m.path },
          });
          continue;
        }
        if (!shouldProbe()) continue;
        const probe = probeMedia(m.path, probeCmd);
        if (probe === null) {
          issues.push({
            severity: "info",
            code: "media-unreadable",
            message: `Material ${shortId(m.id)} (${kind}) exists but ffprobe cannot parse it: ${m.path} — the app import or render may fail on it`,
            fixable: FIXABLE_CODES.has("media-unreadable"),
            suggested_command: `ffmpeg -i "${m.path}" -c:v libx264 -c:a aac <reencoded>.mp4`,
            location: { material_id: m.id, path: m.path },
          });
        } else if (kind === "videos" && m.type !== "photo" && probe.hasVideo && isVfr(probe)) {
          issues.push({
            severity: "info",
            code: "vfr-media",
            message:
              `Material ${shortId(m.id)} references variable-frame-rate media (avg ${probe.avgFps?.toFixed(2)} fps ` +
              `vs base ${probe.baseFps?.toFixed(2)}): ${m.path} — preview/render timing can drift and frame-based ` +
              "pipelines fail on missing frames; normalize to constant frame rate before editing",
            fixable: FIXABLE_CODES.has("vfr-media"),
            suggested_command: `ffmpeg -i "${m.path}" -fps_mode cfr -r 30 -c:a copy <normalized>.mp4`,
            location: { material_id: m.id, path: m.path },
          });
        }
      }
    }

    // Media referenced outside the draft folder plays fine on the machine
    // that authored the draft but breaks on any move: copy the draft to
    // another machine, reorganize the media folder, or open it on a sandboxed
    // macOS build that cannot read outside the draft, and the app shows the
    // black-screen/missing-media class (sun-guannan/VectCutAPI#48, #65;
    // luoluoluo22/jianying-editor-skill#16). Severity is info, not warning:
    // app-authored drafts routinely reference local imports wherever they
    // live on disk, so a warning would flip exit codes (0 -> 1) on a huge
    // installed base of perfectly valid drafts — the unknown-effect-slug
    // rationale. Fixable per instance: --fix stages the file into
    // assets/<kind>/ only when the source exists; a missing source is
    // report-only (there is nothing on disk to stage) with `relink` as the
    // deliberate repair. Only absolute paths are judged — a relative or
    // placeholder path resolves against the draft folder, and both
    // separator styles count as inside (the store.ts/factory.ts tolerant
    // prefix-compare convention).
    if (opts.draftDir) {
      for (const kind of ["videos", "audios"] as const) {
        for (const mat of draft.materials[kind] ?? []) {
          const m = mat as { id: string; path?: string };
          if (typeof m.path !== "string" || m.path.length === 0) continue;
          if (m.path.startsWith("http://") || m.path.startsWith("https://")) continue;
          if (!isAbsoluteAnyOs(m.path) || isUnderDir(m.path, opts.draftDir)) continue;
          const stageable = fileExists(m.path);
          const issue: LintIssue = {
            severity: "info",
            code: "media-outside-draft",
            message:
              `Material ${shortId(m.id)} (${kind}) references media outside the draft folder: ${m.path} — ` +
              "the draft breaks when that file moves or the folder is copied to another machine, and sandboxed " +
              "macOS builds can lose read access entirely (black screen — sun-guannan/VectCutAPI#48, #65; " +
              "luoluoluo22/jianying-editor-skill#16)",
            fixable: FIXABLE_CODES.has("media-outside-draft") && stageable,
            location: { material_id: m.id, path: m.path },
          };
          if (!stageable) {
            // The source is gone as well, so there is nothing to stage —
            // repoint the material first, then stage it in.
            issue.suggested_command = `capcut relink <project> --dir <directory-containing-the-files>`;
          }
          issues.push(issue);
        }
      }
    }
  }

  // Effect/filter/animation resource ids the bundled enum table doesn't know.
  // CapCut silently drops unknown resource ids (GuanYixuan/pyCapCut#12), so
  // surface them before the app eats them. Severity is info, not warning: the
  // bundled table only covers ids the CLI itself can write, while drafts made
  // in the CapCut app routinely use store-downloaded effects no table could
  // ever cover — a warning here would flip exit codes (0 -> 1) on perfectly
  // valid UI-authored drafts. Report-only: a repair would mean guessing which
  // resource the author meant.
  const known = knownEffectIds();
  const pushUnknown = (kind: string, name: string, badId: string, materialId: string) => {
    issues.push({
      severity: "info",
      code: "unknown-effect-slug",
      message: `${kind} "${name}" (material ${shortId(materialId)}) uses effect_id ${badId} not in the bundled enum table — fine for store effects added in the CapCut app, but ids the CLI wrote from a stale slug may be silently ignored`,
      fixable: FIXABLE_CODES.has("unknown-effect-slug"),
      location: { material_id: materialId },
    });
  };
  for (const mat of draft.materials.video_effects ?? []) {
    const m = mat as { id?: string; name?: string; type?: string; effect_id?: string; resource_id?: string };
    const effectId = typeof m.effect_id === "string" ? m.effect_id : "";
    const resourceId = typeof m.resource_id === "string" ? m.resource_id : "";
    if (!effectId && !resourceId) continue;
    if (known.has(effectId) || known.has(resourceId)) continue;
    pushUnknown(m.type ?? "effect", m.name ?? "?", effectId || resourceId, m.id ?? "");
  }
  for (const mat of draft.materials.material_animations ?? []) {
    const container = mat as { id?: string; animations?: Array<Record<string, unknown>> };
    for (const anim of container.animations ?? []) {
      const a = anim as { id?: string; name?: string; type?: string; resource_id?: string };
      const effectId = typeof a.id === "string" ? a.id : "";
      const resourceId = typeof a.resource_id === "string" ? a.resource_id : "";
      if (!effectId && !resourceId) continue;
      if (known.has(effectId) || known.has(resourceId)) continue;
      pushUnknown(`${a.type ?? "?"} animation`, a.name ?? "?", effectId || resourceId, container.id ?? "");
    }
  }
  // Same check for the other effect-shaped material arrays the CLI writes:
  // transitions, masks (resource_id only — mask materials carry no effect_id),
  // audio effects, and materials.filters (colour filters plus text_shape
  // bubbles, which share that array). Mask materials live under all three
  // variant keys the CLI touches: `common_mask` (what the `mask` command
  // writes), `common_masks` (JianYing 9.6+ / newer CapCut — `migrate`'s
  // legacy-to-new target), and `masks` (`migrate`'s new-to-legacy target).
  for (const kind of ["transitions", "common_mask", "common_masks", "masks", "audio_effects", "filters"] as const) {
    for (const mat of draft.materials[kind] ?? []) {
      const m = mat as { id?: string; name?: string; type?: string; effect_id?: string; resource_id?: string };
      const effectId = typeof m.effect_id === "string" ? m.effect_id : "";
      const resourceId = typeof m.resource_id === "string" ? m.resource_id : "";
      if (!effectId && !resourceId) continue;
      if (known.has(effectId) || known.has(resourceId)) continue;
      pushUnknown(m.type ?? kind, m.name ?? "?", effectId || resourceId, m.id ?? "");
    }
  }

  // pyJianYingDraft#192: font resource ids CapCut doesn't know are silently
  // replaced with the default font. Same trust model as unknown-effect-slug:
  // info-only (store/system fonts on app-authored drafts are legitimate),
  // report-only (a repair would guess the author's font). The capcut-namespace
  // fonts table is empty, so ids are effectively checked against the jianying
  // table; a resolvable on-disk font path silences the check because CapCut
  // loads the file regardless of id.
  for (const mat of draft.materials.texts ?? []) {
    const m = mat as {
      id?: string;
      content?: string;
      font_id?: string;
      font_resource_id?: string;
      font_path?: string;
    };
    const candidates = new Set<string>();
    const paths: string[] = [];
    if (typeof m.font_id === "string" && m.font_id) candidates.add(m.font_id);
    if (typeof m.font_resource_id === "string" && m.font_resource_id) candidates.add(m.font_resource_id);
    if (typeof m.font_path === "string" && m.font_path) paths.push(m.font_path);
    if (typeof m.content === "string") {
      try {
        const parsed = JSON.parse(m.content) as { styles?: Array<{ font?: { id?: string; path?: string } }> };
        for (const s of parsed.styles ?? []) {
          if (s.font?.id) candidates.add(s.font.id);
          if (s.font?.path) paths.push(s.font.path);
        }
      } catch {
        // Unparseable content is missing-material territory, not ours.
      }
    }
    if (candidates.size === 0) continue; // no font id set — default font, fine
    if ([...candidates].some((id) => known.has(id))) continue; // any known id → resolvable
    // A font with an on-disk file resolves regardless of id (CapCut loads from path).
    if (opts.checkLocalPaths && paths.some((p) => fileExists(p))) continue;
    issues.push({
      severity: "info",
      code: "unknown-font-id",
      message: `Text material ${shortId(m.id ?? "")} uses font id ${[...candidates][0]} not in the bundled font table and no resolvable font path — fine for store/system fonts, but ids set programmatically from a stale table may silently fall back to the default font (pyJianYingDraft#192)`,
      fixable: FIXABLE_CODES.has("unknown-font-id"),
      location: { material_id: m.id ?? "" },
    });
  }

  // pyJianYingDraft#160: mask materials live in one of three variant arrays
  // and the app reads exactly one, so entries in a variant the installed build
  // does not read silently never appear in the UI. Split-across-variants is
  // flagged for every app; the wrong-single-variant case is flagged only where
  // the boundary is evidence-backed (JianYing 9.6 renamed masks[] ->
  // common_masks[]) — CapCut single-variant drafts are never flagged, because
  // `common_mask` is the CLI's own CapCut-verified write target. Info-severity
  // and report-only: `capcut migrate` is the repair, and guessing would move
  // app-authored materials.
  const maskVariants = ["masks", "common_mask", "common_masks"] as const;
  const populatedMaskVariants = maskVariants.filter((key) => {
    const arr = (draft.materials as Record<string, unknown>)[key];
    return Array.isArray(arr) && arr.length > 0;
  });
  if (populatedMaskVariants.length > 1) {
    issues.push({
      severity: "info",
      code: "mask-field-mismatch",
      message:
        `Mask materials are split across ${populatedMaskVariants.map((key) => `materials.${key}`).join(" and ")} — ` +
        "the app reads only one array, so part of the masks will silently not appear. " +
        "Consolidate with `capcut migrate --from <ver> --to <ver>`",
      fixable: FIXABLE_CODES.has("mask-field-mismatch"),
    });
  } else if (populatedMaskVariants.length === 1 && draft.platform?.app_source === "lv") {
    const version = draft.platform.app_version ?? null;
    const actual = populatedMaskVariants[0];
    if (version) {
      const expected = atLeast(version, "9.6") ? "common_masks" : "masks";
      if (actual !== expected) {
        const hint = expected === "common_masks" ? "--from 5.9 --to 9.6" : "--from 9.6 --to 5.9";
        issues.push({
          severity: "info",
          code: "mask-field-mismatch",
          message:
            `Masks live in materials.${actual} but JianYing ${version} reads materials.${expected} — they will ` +
            `silently not appear in the app (pyJianYingDraft#160). Run \`capcut migrate ${hint}\``,
          fixable: FIXABLE_CODES.has("mask-field-mismatch"),
        });
      }
    }
  }

  // Unregistered-media sidecar note (pyCapCut#13): newer builds (reported on
  // CapCut International 9.1.0, macOS) show timeline media as "file
  // inaccessible" and prompt per-clip relinking when draft_meta_info.json's
  // draft_materials registers nothing. The repair is `capcut register
  // <project> --materials --apply` (src/materials-register.ts) — a sidecar
  // write, which lint --fix (a timeline-file repair) does not perform, so the
  // issue stays fixable:false and names the command. Info-severity: it can
  // never fail an exit code.
  // Gated on media that actually exists on disk: absent media is
  // missing-file's finding, and the 9.1.0 symptom is precisely media that IS
  // there and still shows inaccessible in the app.
  const presentLocalMedia = (["videos", "audios"] as const).some((kind) =>
    (draft.materials?.[kind] ?? []).some((mat) => {
      const p = (mat as { path?: unknown }).path;
      return typeof p === "string" && p.length > 0 && !/^https?:\/\//i.test(p) && fileExists(p);
    }),
  );
  if (opts.draftDir && presentLocalMedia) {
    const registration = assessMediaRegistrationAt(draft, opts.draftDir);
    // missing-file stays diagnose's finding: a folder with no sidecar at all
    // is the ordinary tool-built shape (`register` exists for it), not the
    // pyCapCut#13 shape where the sidecar is present and registers nothing.
    if (registration && registration.draft_materials !== "missing-file") {
      issues.push({
        severity: "info",
        code: "media-unregistered",
        message: registration.note,
        fixable: false,
        suggested_command: `capcut register ${opts.draftDir} --materials --apply`,
      });
    }
  }

  return issues;
}

export interface PipReport {
  overlays: number;
  overlay_keyframes: number;
  masks_attached: number;
  masks_orphaned: number;
  missing_media: string[];
}

/** PIP + local-mask validation (issue #78, split from #44): the four ways the
 * discussion-#43 workflow can be silently wrong, as countable facts — the
 * overlay never landed (overlays), the mask never got attached
 * (masks_orphaned), the keyframes did not write (overlay_keyframes), the
 * copied clip points at missing media (missing_media, by path — sourced from
 * the missing-file issues the ordinary lint walk already found, so the two
 * never disagree). Overlays are segments on every video track above the
 * first: the layer order sortTracks maintains and `duplicate` builds. */
export function buildPipReport(draft: Draft, issues: LintIssue[]): PipReport {
  const videoTracks = (draft.tracks ?? []).filter((track) => track.type === "video");
  let overlays = 0;
  let overlayKeyframes = 0;
  for (const track of videoTracks.slice(1)) {
    for (const seg of track.segments ?? []) {
      overlays++;
      const lists = (seg as Segment & { common_keyframes?: Array<{ keyframe_list?: unknown[] }> }).common_keyframes;
      for (const list of lists ?? []) {
        if (Array.isArray(list?.keyframe_list)) overlayKeyframes += list.keyframe_list.length;
      }
    }
  }
  const masks = maskAttachment(draft);
  const missing = new Set<string>();
  for (const issue of issues) {
    if (issue.code === "missing-file" && issue.location?.path) missing.add(issue.location.path);
  }
  return {
    overlays,
    overlay_keyframes: overlayKeyframes,
    masks_attached: masks.attached.length,
    masks_orphaned: masks.orphaned.length,
    missing_media: [...missing],
  };
}

/** Mask materials by attachment: a mask is attached when some segment's
 * extra_material_refs carries its id (how `mask` and the app wire them), and
 * orphaned otherwise. All three variant arrays are read — attachment is a
 * different question from which single array the installed build reads
 * (mask-field-mismatch covers that one). */
function maskAttachment(draft: Draft): { attached: string[]; orphaned: string[] } {
  const refs = new Set<string>();
  for (const { segment } of allSegments(draft)) {
    for (const ref of segment.extra_material_refs ?? []) refs.add(ref);
  }
  const attached: string[] = [];
  const orphaned: string[] = [];
  for (const key of ["masks", "common_mask", "common_masks"]) {
    const arr = (draft.materials as Record<string, unknown> | undefined)?.[key];
    if (!Array.isArray(arr)) continue;
    for (const mat of arr) {
      const id = (mat as { id?: string } | null)?.id;
      if (!id) continue;
      (refs.has(id) ? attached : orphaned).push(id);
    }
  }
  return { attached, orphaned };
}

/** The loud side of the --pip report: one warning per orphaned mask, so the
 * exit code fails CI exactly when the workflow's mask never got attached.
 * Emitted only under --pip: the check encodes the PIP workflow's expectation,
 * and an ordinary draft carrying an unreferenced mask is not necessarily
 * damaged (the #88 lesson) — but in a pipeline that just tried to attach one,
 * it is precisely the failure being looked for. */
export function pipLintIssues(draft: Draft): LintIssue[] {
  const { orphaned } = maskAttachment(draft);
  return orphaned.map((id) => ({
    severity: "warning" as const,
    code: "mask-orphaned",
    message:
      `Mask material ${id} is not referenced by any segment's extra_material_refs, so it will not appear in the app. ` +
      "Attach it with `capcut mask <project> <segment-id> <slug>` or drop it with `capcut prune <project>`.",
    fixable: false,
    location: { material_id: id },
  }));
}

// Every effect_id/resource_id the CLI could have written into a draft: the
// bundled enums.json (both namespaces, all categories) plus the inline
// knossos-verified starter catalogues that enums.json doesn't carry.
const ENUM_CATEGORIES: Category[] = [
  "transitions",
  "masks",
  "image_intros",
  "image_outros",
  "image_combos",
  "text_intros",
  "text_outros",
  "text_loop_anims",
  "scene_effects",
  "character_effects",
  "audio_effects",
  "fonts",
  "filters",
];

let knownIdCache: Set<string> | null = null;

// Exported for harvest-enums, which needs the same known-id set to decide
// what is genuinely new. Cached per process: the CLI computes it before any
// catalogue write, so a same-process harvest --apply never reads its own
// output as already-known.
export function knownEffectIds(): Set<string> {
  if (knownIdCache) return knownIdCache;
  const ids = new Set<string>();
  const add = (id?: string) => {
    if (id) ids.add(id);
  };
  for (const namespace of ["capcut", "jianying"] as Namespace[]) {
    for (const category of ENUM_CATEGORIES) {
      for (const e of listEnum(category, namespace)) {
        add(e.effect_id);
        add(e.resource_id);
      }
    }
  }
  for (const e of [...effectCatalogue(), ...filterCatalogue(), ...imageAnimCatalogue(), ...bubbleCatalogue()]) {
    add(e.effect_id);
    add(e.resource_id);
  }
  // Harvested ids (slug-mapped kinds arrive via listEnum above; id-only kinds
  // — animations, bubbles, fonts — only here).
  for (const id of allUserEnumIds()) ids.add(id);
  knownIdCache = ids;
  return ids;
}

export function summarize(issues: LintIssue[]): { errors: number; warnings: number; info: number; total: number } {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const i of issues) {
    if (i.severity === "error") errors++;
    else if (i.severity === "warning") warnings++;
    else info++;
  }
  return { errors, warnings, info, total: issues.length };
}

export function lintExitCode(summary: { errors: number; warnings: number }): number {
  if (summary.errors > 0) return 2;
  if (summary.warnings > 0) return 1;
  return 0;
}

export interface FixResult {
  fixed: LintIssue[];
  remaining: LintIssue[];
}

// Mechanically repair fixable issues on `draft` in place. Only issues whose
// code is in FIXABLE_CODES are touched — everything else is returned in
// `remaining` for the caller to report. Repairs are ordered so that earlier
// passes can uncover issues the next pass would fix (e.g. shortening an
// overlong cue may resolve an overlap on the same track).
export function fixDraft(draft: Draft, opts: LintOptions = DEFAULT_LINT_OPTIONS): FixResult {
  const before = lintDraft(draft, opts);
  const fixed: LintIssue[] = [];

  // Pass 0: close main-track gaps by pulling every later main-track segment
  // left — the same motion CapCut's magnetic main track performs on open
  // (sun-guannan/VectCutAPI#54), so the on-disk timing matches what the app
  // will show. Runs BEFORE the caption passes so canCloseMainTrackGap reads
  // the same cross-track state lintDraft stamped fixable from: passes 1-3
  // pull caption ends earlier, which could otherwise flip an instance stamped
  // fixable:false into a silently-applied repair. Each gap is closed only
  // when no other track has content playing at or after the gap start; such
  // content also sits after every EARLIER gap's start, so unsafe gaps are
  // always a prefix — closing the safe suffix never moves a segment another
  // track is aligned to. Gap widths and safety are read from the pre-pass
  // positions, then the cumulative shift is applied.
  const mainTrack = draft.tracks.find((t) => t.type === "video");
  if (mainTrack) {
    const segs = [...mainTrack.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    const original = segs.map((seg) => ({
      seg,
      start: seg.target_timerange.start,
      end: seg.target_timerange.start + seg.target_timerange.duration,
    }));
    let shift = 0;
    for (let i = 1; i < original.length; i++) {
      const gap = original[i].start - original[i - 1].end;
      if (gap > 0 && canCloseMainTrackGap(draft, mainTrack, original[i - 1].end)) shift += gap;
      if (shift > 0) original[i].seg.target_timerange.start = original[i].start - shift;
    }
  }

  // Pass 1: cap over-long cues. Shrinking these first can also close overlaps.
  for (const track of getTracksByType(draft, "text")) {
    for (const s of track.segments) {
      if (s.target_timerange.duration > opts.maxCueDurationUs) {
        const before = s.target_timerange.duration;
        s.target_timerange.duration = opts.maxCueDurationUs;
        if (s.source_timerange && s.source_timerange.duration === before) {
          s.source_timerange.duration = opts.maxCueDurationUs;
        }
      }
    }
  }

  // Pass 2: trim overlapping captions so each ends where the next begins.
  for (const track of getTracksByType(draft, "text")) {
    const segs = [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      const next = segs[i + 1];
      const end = s.target_timerange.start + s.target_timerange.duration;
      const overlap = end - next.target_timerange.start;
      if (overlap > 0) {
        const newDuration = Math.max(0, s.target_timerange.duration - overlap);
        const oldDuration = s.target_timerange.duration;
        s.target_timerange.duration = newDuration;
        if (s.source_timerange && s.source_timerange.duration === oldDuration) {
          s.source_timerange.duration = newDuration;
        }
      }
    }
  }

  // Pass 3: widen under-min gaps by pulling the earlier caption's end back —
  // the same mutation direction as pass 2, so it can never create a new
  // overlap or move a start. Skipped when the shrink would leave the caption
  // under MIN_CAPTION_DURATION_US: a sub-frame sliver is as gone as a deleted
  // caption, so those issues stay reported (with fixable:false) instead.
  if (opts.minGapBetweenCaptionsUs > 0) {
    for (const track of getTracksByType(draft, "text")) {
      const segs = [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
      for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        const next = segs[i + 1];
        const end = s.target_timerange.start + s.target_timerange.duration;
        const gap = next.target_timerange.start - end;
        if (gap > 0 && gap < opts.minGapBetweenCaptionsUs) {
          const newDuration = s.target_timerange.duration - (opts.minGapBetweenCaptionsUs - gap);
          if (newDuration < MIN_CAPTION_DURATION_US) continue;
          const oldDuration = s.target_timerange.duration;
          s.target_timerange.duration = newDuration;
          if (s.source_timerange && s.source_timerange.duration === oldDuration) {
            s.source_timerange.duration = newDuration;
          }
        }
      }
    }
  }

  // Pass 4b (order-independent of the caption passes): drop dangling
  // companion refs — an extra_material_refs entry that resolves to no
  // material. Removes the REF only, never a segment or a material.
  // No earlier pass adds or drops a material, so one id set answers the whole
  // sweep. Lazy for the same reason lintDraft's is: the set is only reached
  // once a ref has cleared the string check that always ran first.
  let refIds: Set<string> | null = null;
  const refResolves = (ref: string): boolean => {
    if (refIds === null) refIds = materialIdSet(draft);
    return refIds.has(ref);
  };
  for (const track of draft.tracks) {
    for (const s of track.segments) {
      if (!Array.isArray(s.extra_material_refs)) continue;
      s.extra_material_refs = s.extra_material_refs.filter(
        (ref) => typeof ref === "string" && ref !== "" && refResolves(ref),
      );
    }
  }

  // Pass 4: repair pre-0.19.1 doubled style ranges, then re-wrap over-long
  // caption lines. The repair runs first because the re-wrap shifts each later
  // range boundary across an inserted newline, and it can only do that in the
  // coordinates CapCut actually stores. A break at a space swaps one space for
  // one newline and leaves length alone; a break inside a space-less script
  // (CJK) inserts one. rewrapContent handles both and re-points the content's
  // styles[] code-unit ranges across any insertion, so per-range styling stays
  // on its characters. Over-long Latin words are still never split and stay
  // reported.
  for (const track of getTracksByType(draft, "text")) {
    for (const s of track.segments) {
      const mat = findMaterial(draft.materials.texts, s.material_id);
      if (!mat) continue;
      const undoubled = undoubleContent(mat.content);
      if (undoubled !== null) mat.content = undoubled;
      const rewrapped = rewrapContent(mat.content, opts.maxCharsPerLine);
      if (rewrapped !== null) mat.content = rewrapped;
    }
  }

  // Pass 5 (order-independent of the others): stage external media into the
  // draft's assets/<kind>/ — the same copyAssetDeduped path add-video and
  // add-audio go through, so collisions de-collide by content hash exactly
  // like theirs and re-adding already-staged media stays a no-op. The
  // rewritten path is regenerated with resolve() from the draft folder, which
  // is the only path shape the factory ever writes — wrong-OS separators in
  // the old value disappear by construction, never by string conversion. A
  // missing source is skipped (report-only: nothing on disk to stage) and
  // dry-run skips the whole pass, because a file copy is a side effect the
  // caller's discarded draft write cannot roll back.
  if (opts.draftDir && opts.checkLocalPaths && !opts.dryRun) {
    for (const kind of ["videos", "audios"] as const) {
      for (const mat of draft.materials[kind] ?? []) {
        const m = mat as { id: string; path?: string; material_name?: unknown; name?: unknown };
        if (typeof m.path !== "string" || m.path.length === 0) continue;
        if (m.path.startsWith("http://") || m.path.startsWith("https://")) continue;
        if (!isAbsoluteAnyOs(m.path) || isUnderDir(m.path, opts.draftDir)) continue;
        if (!fileExists(m.path)) continue;
        const assetKind = kind === "audios" ? "audio" : "video";
        const assetsDir = resolve(opts.draftDir, "assets", assetKind);
        const destPath = copyAssetDeduped(m.path, assetsDir, assetKind === "audio" ? "audio.mp3" : "media");
        m.path = destPath;
        // Keep the display-name fields tracking the staged file, the
        // replace-media convention — only visible when de-collision renamed.
        const filename = basename(destPath);
        if ("material_name" in m) m.material_name = filename;
        if ("name" in m) m.name = filename;
      }
    }
  }

  const after = lintDraft(draft, opts);
  const remaining: LintIssue[] = [];
  const afterKeys = new Set(after.map(issueKey));
  for (const issue of before) {
    if (!afterKeys.has(issueKey(issue))) fixed.push(issue);
  }
  for (const issue of after) remaining.push(issue);
  return { fixed, remaining };
}

// True when pass 4's re-wrap would actually clear a line-too-long issue on
// this material — the per-instance half of the fixable stamp. Three ways it
// cannot: content isn't JSON, or has no non-empty string `text` (the checker's
// extractText then measures a fallback string the fixer never touches), or
// re-wrapping still leaves an over-cap line (space-less text such as CJK
// captions, or single words longer than the cap — wrapping only swaps spaces
// for newlines, so those stay reported).
function canFixLineTooLong(content: string, maxChars: number): boolean {
  let parsed: { text?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof parsed.text !== "string" || parsed.text === "") return false;
  return rewrapText(parsed.text, maxChars)
    .split(/\r?\n/)
    .every((line) => line.length <= maxChars);
}

// Re-wrap only lines that exceed maxChars; existing line breaks are kept.
function rewrapText(text: string, maxChars: number): string {
  return text
    .split(/(\r?\n)/)
    .map((part, i) => (i % 2 === 0 && part.length > maxChars ? wrapLine(part, maxChars) : part))
    .join("");
}

// Scripts written without spaces, where a break between two characters is
// ordinary typography rather than a word split: CJK ideographs, kana, hangul,
// and the full-width punctuation that travels with them.
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;
// Characters that may not open a line: a break before one of these strands the
// punctuation at the start of the next line, which no CJK typesetter allows.
const CJK_NO_LINE_START = /[。、，．！？：；）】》」』〉…—ー～%,.!?:;)\]}]/;

// True when a break between line[i-1] and line[i] is typographically legal.
function cjkBreakOk(line: string, i: number): boolean {
  if (i <= 0 || i >= line.length) return false;
  const prev = line[i - 1];
  const next = line[i];
  if (!CJK_CHAR.test(prev) && !CJK_CHAR.test(next)) return false;
  if (CJK_NO_LINE_START.test(next)) return false;
  // Never strand an opening bracket at the end of a line.
  if (/[（【《「『〈]/.test(prev)) return false;
  return true;
}

// Greedy word wrap. A space break swaps one space for one newline (1:1,
// length-neutral); a CJK break INSERTS a newline between two characters and so
// grows the string by one code unit, which is why callers that carry styles[]
// offsets must go through rewrapContent rather than calling this directly.
// A run that is neither breakable at a space nor CJK (an over-long Latin word)
// is still emitted unchanged, so re-running the wrap stays a no-op and --fix
// converges.
function wrapLine(line: string, maxChars: number): string {
  let out = "";
  let rest = line;
  while (rest.length > maxChars) {
    // Break at the last space that keeps the emitted line within maxChars…
    let brk = rest.lastIndexOf(" ", maxChars);
    if (brk !== -1) {
      out += `${rest.slice(0, brk)}\n`;
      rest = rest.slice(brk + 1);
      continue;
    }
    // …or, in a space-less script, between two characters at the cap, walking
    // back to the first legal break so closing punctuation never opens a line.
    let cut = -1;
    for (let i = Math.min(maxChars, rest.length - 1); i > 0; i--) {
      if (cjkBreakOk(rest, i)) {
        cut = i;
        break;
      }
    }
    if (cut !== -1) {
      out += `${rest.slice(0, cut)}\n`;
      rest = rest.slice(cut);
      continue;
    }
    // …or after an unbreakable over-long head, at the first space past it.
    brk = rest.indexOf(" ", maxChars);
    if (brk === -1) break;
    out += `${rest.slice(0, brk)}\n`;
    rest = rest.slice(brk + 1);
  }
  return out + rest;
}

/**
 * Re-wrap a text material's `content`, keeping its styles[] ranges pointing at
 * the same characters. Returns the new content JSON, or null when nothing
 * changed or the content is not the shape we can safely rewrite.
 *
 * The subtlety this exists for: a space break is length-neutral, but a CJK
 * break inserts a newline, and styles[].range holds code-unit offsets (see
 * text-offsets.ts). Every inserted newline therefore shifts each later
 * boundary by exactly one code unit. Without that correction a Chinese
 * caption's per-range styling — karaoke highlights above all — would slide off
 * its characters, which is why the wrap refused to touch space-less text at
 * all until now.
 */
function rewrapContent(content: string, maxChars: number): string | null {
  let parsed: { text?: unknown; styles?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed.text !== "string" || parsed.text === "") return null;
  const original = parsed.text;
  const wrapped = rewrapText(original, maxChars);
  if (wrapped === original) return null;

  // Insertion points in ORIGINAL coordinates. Walk both strings together: the
  // wrap only ever swaps a space for a newline or inserts one, so a newline in
  // `wrapped` with no counterpart in `original` is an insertion at that index.
  const insertions: number[] = [];
  let o = 0;
  for (let w = 0; w < wrapped.length; w++) {
    if (o < original.length && wrapped[w] === original[o]) {
      o++;
      continue;
    }
    if (wrapped[w] === "\n") {
      if (o < original.length && original[o] === " ") {
        o++; // swapped, not inserted — length unchanged
      } else {
        insertions.push(o); // inserted before original index o
      }
      continue;
    }
    // Shapes we did not produce; leave the material alone rather than guess.
    return null;
  }
  if (o !== original.length) return null;

  parsed.text = wrapped;
  if (Array.isArray(parsed.styles) && insertions.length > 0) {
    const shiftOffset = (offset: number): number => {
      let shift = 0;
      for (const at of insertions) {
        if (at <= offset) shift += 1;
      }
      return offset + shift;
    };
    for (const style of parsed.styles as Array<{ range?: unknown }>) {
      const r = style.range;
      if (Array.isArray(r) && r.length === 2 && typeof r[0] === "number" && typeof r[1] === "number") {
        style.range = [shiftOffset(r[0]), shiftOffset(r[1])];
      }
    }
  }
  return JSON.stringify(parsed);
}

/**
 * Halve a text material's pre-0.19.1 doubled style ranges. Returns the new
 * content JSON, or null when the ranges are already code units — which is
 * every app-authored draft, every draft written from 0.19.1 on, and every
 * draft this has already repaired.
 */
function undoubleContent(content: string): string | null {
  let parsed: { text?: unknown; styles?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed.text !== "string" || !Array.isArray(parsed.styles)) return null;
  const styles = parsed.styles as Array<{ range?: unknown }>;
  const stored: Array<[number, number]> = [];
  for (const style of styles) {
    const r = style.range;
    if (Array.isArray(r) && r.length === 2 && typeof r[0] === "number" && typeof r[1] === "number") {
      stored.push([r[0], r[1]]);
    }
  }
  const repaired = repairDoubledRanges(parsed.text, stored);
  if (repaired === null) return null;
  let at = 0;
  for (const style of styles) {
    const r = style.range;
    if (Array.isArray(r) && r.length === 2 && typeof r[0] === "number" && typeof r[1] === "number") {
      style.range = repaired[at++];
    }
  }
  return JSON.stringify(parsed);
}

// True when closing the main-track gap that opens at `gapStartUs` is
// mechanically safe: no OTHER track has a segment still playing at or
// starting after that point, so the later main-track segments can move left
// without changing their timing relationship to any other track's content.
// Strict `>`: a segment that ends exactly at the gap start touches nothing
// that moves. Overlay video tracks count as other tracks — only the first
// video track is magnetic.
function canCloseMainTrackGap(draft: Draft, mainTrack: Track, gapStartUs: number): boolean {
  for (const track of draft.tracks) {
    if (track === mainTrack) continue;
    for (const s of track.segments) {
      if (s.target_timerange.start + s.target_timerange.duration > gapStartUs) return false;
    }
  }
  return true;
}

function issueKey(i: LintIssue): string {
  return `${i.code}|${i.location?.segment_id ?? ""}|${i.location?.material_id ?? ""}|${i.location?.path ?? ""}`;
}

function allSegments(draft: Draft): Array<{ track: Track; segment: Segment }> {
  const result: Array<{ track: Track; segment: Segment }> = [];
  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      result.push({ track, segment: seg });
    }
  }
  return result;
}

// Every material id in the draft, collected in one pass over materials.*.
// Resolving each segment's material_id (and each companion ref) by rescanning
// every materials array is quadratic — a 4000-caption draft walked ~32M
// entries per lint. Callers build this once and probe it instead. Only string
// ids are collected: the scan it replaces compared against a string id, so a
// material whose id is not a string could never match.
function materialIdSet(draft: Draft): Set<string> {
  const ids = new Set<string>();
  for (const arr of Object.values(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    for (const m of arr) {
      if (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string") {
        ids.add((m as { id: string }).id);
      }
    }
  }
  return ids;
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

// Absolute on either OS: POSIX /…, Windows drive X:\ or X:/, or UNC \\host.
// Only these can be judged against the draft folder — a relative (or
// placeholder) path resolves against the draft folder and is never flagged.
function isAbsoluteAnyOs(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

// Prefix containment tolerant of wrong-OS separators, the same both-styles
// compare store.ts (managed-path detection) and factory.ts
// (renameEntryFields) already use. No case-folding: renameEntryFields — the
// convention for comparing real path values, not a fixed marker — doesn't.
function isUnderDir(p: string, dir: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = norm(p);
  const base = norm(dir);
  return target === base || target.startsWith(`${base}/`);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
