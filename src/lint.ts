import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { bubbleCatalogue, imageAnimCatalogue } from "./decorators.js";
import type { Draft, Segment, Track } from "./draft.js";
import { extractText, findMaterial, getTracksByType } from "./draft.js";
import { type Category, listEnum, type Namespace } from "./enums.js";
import { copyAssetDeduped, effectCatalogue, filterCatalogue } from "./factory.js";
import { ffprobeAvailable, isVfr, probeMedia } from "./probe.js";
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

      if (s.target_timerange.duration > opts.maxCueDurationUs) {
        issues.push({
          severity: "warning",
          code: "cue-too-long",
          message: `Caption ${shortId(s.id)} runs ${Math.round(s.target_timerange.duration / 1000)}ms (>${opts.maxCueDurationUs / 1_000_000}s)`,
          fixable: FIXABLE_CODES.has("cue-too-long"),
          location: { track: track.name, segment_id: s.id },
        });
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

  return issues;
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

  // Pass 4: re-wrap over-long caption lines at word boundaries. Each break
  // swaps one space for one newline — string length never changes, so the
  // UTF-16LE byte offsets in the content's styles[] ranges stay valid. Words
  // longer than the limit are never split and stay reported.
  for (const track of getTracksByType(draft, "text")) {
    for (const s of track.segments) {
      const mat = findMaterial(draft.materials.texts, s.material_id);
      if (!mat) continue;
      let parsed: { text?: unknown };
      try {
        parsed = JSON.parse(mat.content);
      } catch {
        continue;
      }
      if (typeof parsed.text !== "string") continue;
      const wrapped = rewrapText(parsed.text, opts.maxCharsPerLine);
      if (wrapped === parsed.text) continue;
      parsed.text = wrapped;
      mat.content = JSON.stringify(parsed);
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

// Greedy word wrap that only swaps spaces for newlines (1:1, length-neutral).
// Each break replaces one space with '\n', picked so the emitted line never
// exceeds maxChars — inside a multi-space run the surplus spaces land after
// the break instead of overflowing the broken line. A segment with no space
// at or before the cap (an over-long word, space-less CJK text) is emitted
// unchanged, so re-running the wrap is always a no-op and --fix converges.
function wrapLine(line: string, maxChars: number): string {
  let out = "";
  let rest = line;
  while (rest.length > maxChars) {
    // Break at the last space that keeps the emitted line within maxChars…
    let brk = rest.lastIndexOf(" ", maxChars);
    if (brk === -1) {
      // …or after an unbreakable over-long head, at the first space past it.
      brk = rest.indexOf(" ", maxChars);
      if (brk === -1) break;
    }
    out += `${rest.slice(0, brk)}\n`;
    rest = rest.slice(brk + 1);
  }
  return out + rest;
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
