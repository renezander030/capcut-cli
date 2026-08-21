import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Draft, Segment } from "./draft.js";
import { extractText } from "./draft.js";

/**
 * Headless ffmpeg proxy renderer.
 *
 * Closes the blind-edit loop: a CapCut draft is opaque JSON you cannot watch
 * until you open the app. `render` flattens the draft's MAIN video track
 * (trim source range + apply per-segment speed + scale to a low-res proxy),
 * mixes every audio-track segment, and optionally burns the text segments in
 * with `--burn-captions`. The result is a watchable preview MP4 — NOT CapCut's
 * final render (no multi-track video compositing, no effects/transitions). It
 * exists to verify "did my edit land where I meant it" without launching CapCut.
 *
 * Architecture mirrors `caption` (shell-out to an external binary, here ffmpeg)
 * and `export --batch` (a deterministic, unit-tested command builder, with the
 * live run gated behind host availability). `buildRenderPlan` is pure so the
 * filter graph can be asserted in tests without invoking ffmpeg; `renderDraft`
 * runs it unless `--dry-run`.
 */

const US = 1_000_000; // microseconds per second — CapCut's timing unit

export interface RenderOptions {
  out?: string; // output file; default <draftdir>/preview.mp4
  scale?: number; // proxy scale factor applied to canvas dims (default 0.5)
  fps?: number; // output fps override (default draft.fps or 30)
  ffmpegCmd?: string; // ffmpeg binary (default "ffmpeg")
  burnCaptions?: boolean; // draw text-track segments onto the video
  allVideoTracks?: boolean; // composite overlay video tracks
  dryRun?: boolean; // build the plan, do not execute ffmpeg
  progress?: boolean; // stream ffmpeg's own stderr instead of buffering it
}

const RENDER_TIMEOUT_MS = 600_000;

/**
 * ffmpeg writes one stats line per frame to stderr, so a ten-minute 30fps
 * render emits ~18k of them. Node's spawnSync default is 1 MiB, which a long
 * render overruns — and spawnSync reports that through `r.error` with code
 * ENOBUFS rather than by throwing, so the old code fell into the generic
 * failure branch and told the user to install ffmpeg. That advice was wrong
 * twice over: ffmpeg was installed, and it had already rendered most of the
 * file. probe.ts, scenes.ts and probeFfmpegCapabilities all set a cap; this
 * was the one media spawn that did not.
 */
const RENDER_MAX_BUFFER = 64 * 1024 * 1024;

const FFMPEG_FAILURE_HINTS: Array<{ pattern: RegExp; explain: (match: RegExpMatchArray) => string }> = [
  {
    pattern: /Unknown decoder '([^']+)'|Decoder \(codec ([^)]+)\) not found/,
    explain: (m) =>
      `This ffmpeg build has no decoder for '${m[1] ?? m[2]}'. Install a fuller build (the "free" or "full" ffmpeg packages carry AV1/HEVC), or transcode the source first.`,
  },
  {
    pattern: /Unknown encoder '([^']+)'/,
    explain: (m) =>
      `This ffmpeg build has no '${m[1]}' encoder. \`capcut doctor\` reports which encoders were detected; install a build that includes it.`,
  },
  {
    pattern: /No such filter: '([^']+)'|Unknown filter '([^']+)'/,
    explain: (m) =>
      `This ffmpeg build lacks the '${m[1] ?? m[2]}' filter. Rendering without --burn-captions or --all-video-tracks avoids the filters that need it.`,
  },
  {
    pattern: /moov atom not found|Invalid data found when processing input/,
    explain: () =>
      "An input file is truncated or not the container its extension claims. `capcut lint` flags unreadable media before a render reaches ffmpeg.",
  },
  {
    pattern: /No such file or directory/,
    explain: () =>
      "An input path does not exist on this machine. `capcut relink` repairs a draft whose media moved; `capcut lint` lists the missing files.",
  },
  {
    pattern: /Permission denied/,
    explain: () => "ffmpeg could not read an input or write the output. Check permissions on the draft folder.",
  },
];

/**
 * Turn an ffmpeg stderr tail into one actionable line, or "" when nothing in it
 * is recognised. Pure and exported so the mapping is testable without ffmpeg —
 * same reason `buildRenderPlan` is pure.
 */
export function explainFfmpegFailure(stderr: string): string {
  for (const { pattern, explain } of FFMPEG_FAILURE_HINTS) {
    const match = stderr.match(pattern);
    if (match) return explain(match);
  }
  return "";
}

export interface RenderInput {
  index: number;
  path: string;
  kind: "video" | "photo" | "audio";
}

export interface RenderPlan {
  output: string;
  width: number;
  height: number;
  fps: number;
  inputs: RenderInput[];
  filterComplex: string;
  args: string[];
  videoSegments: number;
  audioSegments: number;
  textOverlays: number;
  skipped: Array<{ segmentId: string; reason: string }>;
  overlaySegments: number;
  capabilities?: FfmpegCapabilities;
}

export interface RenderResult extends RenderPlan {
  ok: boolean;
  executed: boolean;
}

/**
 * Filters the base render chain hard-requires on every segment, regardless of
 * any user-facing flag (`--burn-captions`/`--all-video-tracks` gate drawtext/
 * overlay instead — see the fallback in renderDraft). A minimal/custom ffmpeg
 * build (e.g. Remotion's bundled compositor binary, which compiles in only an
 * explicit filter allowlist) can lack one of these silently: the graph still
 * spawns, but ffmpeg's own parser error ("No option name near ...") names a
 * fragment of the filter_complex string, not the missing filter (#89).
 */
const BASE_CHAIN_FILTERS = ["fps", "scale", "pad", "setsar", "format", "concat", "trim", "setpts"] as const;

// The audio side of the same graph has the same failure class (#91).
// Unconditional per audio segment: atrim/asetpts/adelay, then anull (one
// segment) or amix (several). The conditional three are emitted only when the
// draft sets a speed/volume/fade, so they are checked against the built plan
// rather than up front — and they fail rather than degrade, because silently
// dropping them changes the audio (unlike the drawtext/overlay flag fallbacks,
// which only withhold an explicitly optional extra).
const AUDIO_CHAIN_FILTERS = ["atrim", "asetpts", "adelay", "anull", "amix"] as const;
const AUDIO_CONDITIONAL_FILTERS = ["atempo", "volume", "afade"] as const;

/**
 * Every filter name the -filters probe checks. The chain/probe guard test
 * asserts the generated filter_complex never uses a name outside this list
 * (plus its explicit allowlist), so graph and probe cannot drift apart again.
 */
export const PROBED_FILTERS = [
  "drawtext",
  "overlay",
  ...BASE_CHAIN_FILTERS,
  ...AUDIO_CHAIN_FILTERS,
  ...AUDIO_CONDITIONAL_FILTERS,
] as const;

export interface FfmpegCapabilities {
  available: boolean;
  drawtext: boolean;
  overlay: boolean;
  x264: boolean;
  fps: boolean;
  scale: boolean;
  pad: boolean;
  setsar: boolean;
  format: boolean;
  concat: boolean;
  trim: boolean;
  setpts: boolean;
  atrim: boolean;
  asetpts: boolean;
  adelay: boolean;
  anull: boolean;
  amix: boolean;
  atempo: boolean;
  volume: boolean;
  afade: boolean;
}

type ProbedFilterFlags = Record<(typeof PROBED_FILTERS)[number], boolean>;

export function probeFfmpegCapabilities(command = "ffmpeg"): FfmpegCapabilities {
  const filterFlags = (test: (name: string) => boolean): ProbedFilterFlags =>
    Object.fromEntries(PROBED_FILTERS.map((name) => [name, test(name)])) as ProbedFilterFlags;
  try {
    const filters = spawnSync(command, ["-hide_banner", "-filters"], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const encoders = spawnSync(command, ["-hide_banner", "-encoders"], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const filterText = `${filters.stdout ?? ""}${filters.stderr ?? ""}`;
    const encoderText = `${encoders.stdout ?? ""}${encoders.stderr ?? ""}`;
    return {
      available: filters.status === 0,
      x264: /\blibx264\b/.test(encoderText),
      ...filterFlags((name) => new RegExp(`\\b${name}\\b`).test(filterText)),
    };
  } catch {
    return { available: false, x264: false, ...filterFlags(() => false) };
  }
}

/**
 * Filter names used in a filter_complex string, in the grammar buildRenderPlan
 * emits: `;`-separated chains of `,`-separated filters, each surrounded by
 * optional [labels], with single-quoted option values that may themselves
 * carry commas and brackets (drawtext's enable='between(t,..)'). Pure and
 * exported for the chain/probe guard test; renderDraft uses it to check the
 * conditional audio filters against what the plan actually emits.
 */
export function filterNamesInGraph(filterComplex: string): string[] {
  const names = new Set<string>();
  let element = "";
  let quoted = false;
  const flush = () => {
    const name = element.split("=", 1)[0]?.trim();
    element = "";
    if (name) names.add(name);
  };
  for (let i = 0; i < filterComplex.length; i++) {
    const ch = filterComplex[i];
    if (ch === "'") quoted = !quoted;
    if (!quoted) {
      if (ch === "," || ch === ";") {
        flush();
        continue;
      }
      if (ch === "[") {
        const close = filterComplex.indexOf("]", i);
        i = close === -1 ? filterComplex.length : close;
        continue;
      }
    }
    element += ch;
  }
  flush();
  return [...names].sort();
}

function findVideoPath(draft: Draft, materialId: string): string | undefined {
  const m = draft.materials.videos?.find((v) => v.id === materialId);
  return m?.path;
}

function findAudioPath(draft: Draft, materialId: string): string | undefined {
  const m = draft.materials.audios?.find((a) => a.id === materialId);
  return m?.path;
}

function isPhoto(draft: Draft, materialId: string): boolean {
  const m = draft.materials.videos?.find((v) => v.id === materialId);
  return (m?.type ?? "video") === "photo";
}

// The "main" video track = the first track of type "video" (CapCut lays the
// timeline out bottom->top from the tracks array, so the first video track is
// the base layer). Overlay video tracks are not composited in the proxy.
function mainVideoSegments(draft: Draft): Segment[] {
  const track = draft.tracks.find((t) => t.type === "video");
  if (!track) return [];
  return [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
}

function overlayVideoSegments(draft: Draft): Segment[] {
  const tracks = draft.tracks.filter((track) => track.type === "video").slice(1);
  return tracks.flatMap((track) => track.segments).sort((a, b) => a.target_timerange.start - b.target_timerange.start);
}

function audioSegments(draft: Draft): Segment[] {
  const segs: Segment[] = [];
  for (const t of draft.tracks) {
    if (t.type === "audio") segs.push(...t.segments);
  }
  return segs.sort((a, b) => a.target_timerange.start - b.target_timerange.start);
}

function textSegments(draft: Draft): Array<{ seg: Segment; text: string; color: string; fontSize: number; y: number }> {
  const out: Array<{ seg: Segment; text: string; color: string; fontSize: number; y: number }> = [];
  for (const t of draft.tracks) {
    if (t.type !== "text") continue;
    for (const s of t.segments) {
      const mat = draft.materials.texts?.find((m) => m.id === s.material_id);
      const raw = typeof mat?.content === "string" ? extractText(mat.content) : "";
      if (raw) {
        const material = mat as unknown as Record<string, unknown>;
        out.push({
          seg: s,
          text: raw,
          color: safeColor(material.text_color),
          fontSize: Number(material.font_size ?? 15),
          y: s.clip?.transform.y ?? -0.6,
        });
      }
    }
  }
  return out.sort((a, b) => a.seg.target_timerange.start - b.seg.target_timerange.start);
}

// atempo only accepts 0.5..2.0 per filter instance; we keep proxy audio simple
// and only retime when a single atempo can express it.
function atempoFor(speed: number): string | null {
  if (!speed || speed === 1) return null;
  if (speed >= 0.5 && speed <= 2) return `atempo=${round3(speed)}`;
  return null; // out of single-stage range — leave audio at source rate for the proxy
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// drawtext options are colon-separated, so a draft-supplied colour that carries a
// `:` escapes the fontcolor value and appends options of its own — `textfile=`
// would read a local file into the render. Accept only ffmpeg's two colour
// spellings: `0xRRGGBB[AA]` hex (what `#rrggbb` becomes) or a bare colour name,
// either with an optional `@alpha`. The charset has no `:` and no backslash, so a
// value that matches provably cannot leave the option it is written into. Names
// are checked on shape rather than against ffmpeg's ~140-entry colour list — the
// charset is what makes them safe, and passing them through keeps an unknown name
// failing in ffmpeg the way it does today instead of being silently repaired.
const FFMPEG_COLOR = /^(?:0x[0-9a-fA-F]{3,8}|[a-zA-Z]+)(?:@(?:0|1|0?\.\d+))?$/;

function safeColor(raw: unknown): string {
  if (typeof raw !== "string") return "white";
  const color = raw.replace("#", "0x");
  return FFMPEG_COLOR.test(color) ? color : "white";
}

// drawtext is whitespace/colon/quote sensitive; sanitize aggressively for a proxy.
function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "")
    .replace(/:/g, " ")
    .replace(/'/g, "")
    .replace(/"/g, "")
    .replace(/%/g, " ")
    .replace(/\r?\n/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Build the ffmpeg invocation for a draft. Pure and deterministic given the
 * draft + options (no uuids, no clock) so it can be asserted in tests.
 */
export function buildRenderPlan(draft: Draft, opts: RenderOptions): RenderPlan {
  const scale = opts.scale && opts.scale > 0 ? opts.scale : 0.5;
  const canvas = draft.canvas_config ?? { width: 1920, height: 1080, ratio: "16:9" };
  const width = Math.max(2, Math.round((canvas.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((canvas.height * scale) / 2) * 2);
  const fps = opts.fps && opts.fps > 0 ? opts.fps : draft.fps || 30;
  const output = opts.out ?? join(dirname(""), "preview.mp4");

  const inputs: RenderInput[] = [];
  const skipped: Array<{ segmentId: string; reason: string }> = [];
  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  const videoLabels: string[] = [];

  // --- video segments (main track) ---
  const vSegs = mainVideoSegments(draft);
  for (const seg of vSegs) {
    const path = findVideoPath(draft, seg.material_id);
    if (!path) {
      skipped.push({ segmentId: seg.id, reason: "no material path" });
      continue;
    }
    if (!existsSync(path)) {
      skipped.push({ segmentId: seg.id, reason: `file missing: ${path}` });
      continue;
    }
    const photo = isPhoto(draft, seg.material_id);
    const targetDur = round3(seg.target_timerange.duration / US);
    const idx = inputs.length;
    inputs.push({ index: idx, path, kind: photo ? "photo" : "video" });
    if (photo) {
      inputArgs.push("-loop", "1", "-t", String(targetDur), "-i", path);
    } else {
      inputArgs.push("-i", path);
    }
    const label = `v${idx}`;
    if (photo) {
      filterParts.push(
        `[${idx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p,` +
          `trim=duration=${targetDur},setpts=PTS-STARTPTS[${label}]`,
      );
    } else {
      const srcStart = round3(seg.source_timerange.start / US);
      const srcDur = round3(seg.source_timerange.duration / US);
      const speed = seg.speed || 1;
      const setpts = speed === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${round3(speed)}`;
      filterParts.push(
        `[${idx}:v]trim=start=${srcStart}:duration=${srcDur},${setpts},` +
          `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[${label}]`,
      );
    }
    videoLabels.push(`[${label}]`);
  }

  if (videoLabels.length === 0) {
    throw new Error(
      "render: no usable video segments found on the main video track " +
        "(missing material paths or files). Proxy render needs at least one video segment.",
    );
  }

  // concat video parts into a single stream
  let vOut = "vout";
  if (videoLabels.length === 1) {
    // single segment: rename its label to vout via a passthrough null filter
    filterParts.push(`${videoLabels[0]}null[${vOut}]`);
  } else {
    filterParts.push(`${videoLabels.join("")}concat=n=${videoLabels.length}:v=1:a=0[${vOut}]`);
  }

  // --- overlay video tracks ---
  let overlaySegments = 0;
  if (opts.allVideoTracks) {
    for (const seg of overlayVideoSegments(draft)) {
      const path = findVideoPath(draft, seg.material_id);
      if (!path || !existsSync(path)) {
        skipped.push({ segmentId: seg.id, reason: path ? `file missing: ${path}` : "no overlay material path" });
        continue;
      }
      const photo = isPhoto(draft, seg.material_id);
      const targetStart = round3(seg.target_timerange.start / US);
      const targetDur = round3(seg.target_timerange.duration / US);
      const idx = inputs.length;
      inputs.push({ index: idx, path, kind: photo ? "photo" : "video" });
      if (photo) inputArgs.push("-loop", "1", "-t", String(targetDur), "-i", path);
      else inputArgs.push("-i", path);

      const clip = seg.clip;
      const scale = clip?.scale.x ?? 1;
      const alpha = clip?.alpha ?? 1;
      const rotation = clip?.rotation ?? 0;
      const x = clip?.transform.x ?? 0;
      const y = clip?.transform.y ?? 0;
      const sourceStart = round3(seg.source_timerange.start / US);
      const sourceDur = round3(seg.source_timerange.duration / US);
      const speed = seg.speed || 1;
      const label = `ovsrc${overlaySegments}`;
      const filters = photo
        ? [`trim=duration=${targetDur}`, "setpts=PTS-STARTPTS"]
        : [
            `trim=start=${sourceStart}:duration=${sourceDur}`,
            speed === 1 ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${round3(speed)}`,
          ];
      filters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `scale=iw*${round3(scale)}:ih*${round3(scale)}`,
        rotation === 0 ? "null" : `rotate=${round3(rotation)}*PI/180:c=none:ow=rotw(iw):oh=roth(ih)`,
        "format=rgba",
        alpha === 1 ? "null" : `colorchannelmixer=aa=${round3(alpha)}`,
        `setpts=PTS+${targetStart}/TB`,
      );
      filterParts.push(`[${idx}:v]${filters.join(",")}[${label}]`);
      const next = `ovout${overlaySegments}`;
      filterParts.push(
        `[${vOut}][${label}]overlay=x='(W-w)/2+(${round3(x)}*W/2)':` +
          `y='(H-h)/2-(${round3(y)}*H/2)':enable='between(t,${targetStart},${round3(targetStart + targetDur)})':` +
          `eof_action=pass[${next}]`,
      );
      vOut = next;
      overlaySegments++;
    }
  }

  // --- captions (optional) ---
  const texts = opts.burnCaptions ? textSegments(draft) : [];
  let textOverlays = 0;
  for (const { seg, text, color, fontSize, y } of texts) {
    const t = escapeDrawtext(text);
    if (!t) continue;
    const start = round3(seg.target_timerange.start / US);
    const end = round3((seg.target_timerange.start + seg.target_timerange.duration) / US);
    const next = `vt${textOverlays}`;
    filterParts.push(
      `[${vOut}]drawtext=text='${t}':fontcolor=${color}:fontsize=${Math.max(12, Math.round((height / 640) * fontSize))}:` +
        `box=1:boxcolor=black@0.5:boxborderw=8:x=(w-text_w)/2:y=(h-text_h)/2-(${round3(y)}*h/2):` +
        `enable='between(t,${start},${end})'[${next}]`,
    );
    vOut = next;
    textOverlays++;
  }

  // --- audio segments ---
  const aSegs = audioSegments(draft);
  const audioLabels: string[] = [];
  for (const seg of aSegs) {
    const path = findAudioPath(draft, seg.material_id);
    if (!path) {
      skipped.push({ segmentId: seg.id, reason: "no audio material path" });
      continue;
    }
    if (!existsSync(path)) {
      skipped.push({ segmentId: seg.id, reason: `file missing: ${path}` });
      continue;
    }
    const idx = inputs.length;
    inputs.push({ index: idx, path, kind: "audio" });
    inputArgs.push("-i", path);
    const srcStart = round3(seg.source_timerange.start / US);
    const srcDur = round3(seg.source_timerange.duration / US);
    const startMs = Math.round(seg.target_timerange.start / 1000);
    const vol = seg.volume ?? 1;
    const tempo = atempoFor(seg.speed || 1);
    const fade = (draft.materials.audio_fades ?? []).find((item) =>
      (seg.extra_material_refs ?? []).includes(String(item.id)),
    ) as { fade_in_duration?: number; fade_out_duration?: number } | undefined;
    const fadeIn = (fade?.fade_in_duration ?? 0) / US;
    const fadeOut = (fade?.fade_out_duration ?? 0) / US;
    const targetDuration = seg.target_timerange.duration / US;
    const chain = [
      `atrim=start=${srcStart}:duration=${srcDur}`,
      "asetpts=PTS-STARTPTS",
      tempo,
      vol !== 1 ? `volume=${round3(vol)}` : null,
      fadeIn > 0 ? `afade=t=in:st=0:d=${round3(fadeIn)}` : null,
      fadeOut > 0 ? `afade=t=out:st=${round3(Math.max(0, targetDuration - fadeOut))}:d=${round3(fadeOut)}` : null,
      `adelay=${startMs}|${startMs}`,
    ].filter(Boolean);
    const label = `a${idx}`;
    filterParts.push(`[${idx}:a]${chain.join(",")}[${label}]`);
    audioLabels.push(`[${label}]`);
  }

  let aOut: string | null = null;
  if (audioLabels.length === 1) {
    aOut = "aout";
    filterParts.push(`${audioLabels[0]}anull[${aOut}]`);
  } else if (audioLabels.length > 1) {
    aOut = "aout";
    filterParts.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:normalize=0[${aOut}]`);
  }

  const filterComplex = filterParts.join(";");
  const args = [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterComplex,
    "-map",
    `[${vOut}]`,
    ...(aOut ? ["-map", `[${aOut}]`] : []),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
    ...(aOut ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    "-shortest",
    output,
  ];

  return {
    output,
    width,
    height,
    fps,
    inputs,
    filterComplex,
    args,
    videoSegments: videoLabels.length,
    audioSegments: audioLabels.length,
    textOverlays,
    overlaySegments,
    skipped,
  };
}

export function renderDraft(draft: Draft, filePath: string, opts: RenderOptions): RenderResult {
  const out = opts.out ?? join(dirname(filePath), "preview.mp4");
  const capabilities = probeFfmpegCapabilities(opts.ffmpegCmd ?? "ffmpeg");
  if (!capabilities.available) {
    throw new Error(
      `render: ffmpeg is unavailable at '${opts.ffmpegCmd ?? "ffmpeg"}'. ` +
        "Install ffmpeg or pass --ffmpeg-cmd <path>.",
    );
  }
  const missingBaseFilters = BASE_CHAIN_FILTERS.filter((name) => !capabilities[name]);
  if (missingBaseFilters.length > 0) {
    const list = missingBaseFilters.map((name) => `'${name}'`).join(", ");
    throw new Error(
      `render: ffmpeg at '${opts.ffmpegCmd ?? "ffmpeg"}' is missing the filter${missingBaseFilters.length > 1 ? "s" : ""} ${list}, ` +
        "which the base render chain applies to every segment unconditionally (not gated by any flag). " +
        "This is common on minimal/custom ffmpeg builds — e.g. Remotion's bundled compositor binary — that compile in only an explicit filter allowlist. " +
        `Install a full ffmpeg build, or point --ffmpeg-cmd at one that has it ('${opts.ffmpegCmd ?? "ffmpeg"} -hide_banner -filters' lists what's compiled in).`,
    );
  }
  const missingAudioFilters = AUDIO_CHAIN_FILTERS.filter((name) => !capabilities[name]);
  if (missingAudioFilters.length > 0) {
    const list = missingAudioFilters.map((name) => `'${name}'`).join(", ");
    throw new Error(
      `render: ffmpeg at '${opts.ffmpegCmd ?? "ffmpeg"}' is missing the filter${missingAudioFilters.length > 1 ? "s" : ""} ${list}, ` +
        "which the audio mix chain applies to every audio segment unconditionally (not gated by any flag). " +
        "This is common on minimal/custom ffmpeg builds — e.g. Remotion's bundled compositor binary — that compile in only an explicit filter allowlist. " +
        `Install a full ffmpeg build, or point --ffmpeg-cmd at one that has it ('${opts.ffmpegCmd ?? "ffmpeg"} -hide_banner -filters' lists what's compiled in).`,
    );
  }
  const fallbackSkipped: Array<{ segmentId: string; reason: string }> = [];
  const effective = { ...opts, out };
  if (effective.burnCaptions && !capabilities.drawtext) {
    effective.burnCaptions = false;
    fallbackSkipped.push({ segmentId: "captions", reason: "ffmpeg lacks drawtext; caption burn disabled" });
  }
  if (effective.allVideoTracks && !capabilities.overlay) {
    effective.allVideoTracks = false;
    fallbackSkipped.push({ segmentId: "overlays", reason: "ffmpeg lacks overlay filter; extra video tracks disabled" });
  }
  const basePlan = buildRenderPlan(draft, effective);
  const plan = { ...basePlan, capabilities, skipped: [...basePlan.skipped, ...fallbackSkipped] };

  // Speed/volume/fade filters are checked against the plan actually built:
  // a draft that never sets them must keep rendering on a build without them,
  // and one that does must fail here rather than silently lose the retiming.
  const usedFilters = new Set(filterNamesInGraph(plan.filterComplex));
  const missingConditional = AUDIO_CONDITIONAL_FILTERS.filter((name) => usedFilters.has(name) && !capabilities[name]);
  if (missingConditional.length > 0) {
    const list = missingConditional.map((name) => `'${name}'`).join(", ");
    throw new Error(
      `render: ffmpeg at '${opts.ffmpegCmd ?? "ffmpeg"}' is missing the filter${missingConditional.length > 1 ? "s" : ""} ${list}, ` +
        "which this draft's audio needs (atempo = speed retiming, volume = per-segment volume, afade = fades). " +
        "Rendering without them would silently change the audio, so render refuses instead of degrading. " +
        `Install a full ffmpeg build, or point --ffmpeg-cmd at one that has it ('${opts.ffmpegCmd ?? "ffmpeg"} -hide_banner -filters' lists what's compiled in).`,
    );
  }

  if (opts.dryRun) {
    return { ...plan, ok: true, executed: false };
  }

  const cmd = opts.ffmpegCmd ?? "ffmpeg";
  // --progress hands ffmpeg's stderr straight to the terminal. That is both the
  // live progress surface (a 600s render otherwise prints nothing at all, so a
  // working job and a hung one look identical) and the escape hatch for a
  // render whose output would outgrow RENDER_MAX_BUFFER, since inherited output
  // is never buffered by this process.
  const streamProgress = opts.progress === true;
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(cmd, plan.args, {
      encoding: "utf-8",
      timeout: RENDER_TIMEOUT_MS,
      maxBuffer: RENDER_MAX_BUFFER,
      ...(streamProgress ? { stdio: ["ignore", "pipe", "inherit"] } : {}),
    });
  } catch (e) {
    throw new Error(
      `render: ffmpeg is unavailable at '${cmd}'. Install ffmpeg (\`brew install ffmpeg\` / \`apt install ffmpeg\`) ` +
        `or pass --ffmpeg-cmd <path>. (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (r.error) {
    // spawnSync reports its own limits via r.error, not by throwing — a tripped
    // timeout/buffer means ffmpeg RAN, so "install ffmpeg" would be a lie.
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new Error(
        `render: ffmpeg timed out after ${RENDER_TIMEOUT_MS / 1000}s writing ${plan.output}. ` +
          "Lower --scale, shorten the timeline, or drop --all-video-tracks.",
      );
    }
    if (code === "ENOBUFS") {
      throw new Error(
        `render: ffmpeg produced more output than the ${Math.round(RENDER_MAX_BUFFER / (1024 * 1024))} MiB buffer ` +
          `while writing ${plan.output}. The render itself was fine — only this process's capture overflowed. ` +
          "Re-run with --progress, which streams ffmpeg's output instead of buffering it.",
      );
    }
    throw new Error(
      `render: ffmpeg is unavailable at '${cmd}'. Install ffmpeg (\`brew install ffmpeg\` / \`apt install ffmpeg\`) ` +
        `or pass --ffmpeg-cmd <path>. (${code ?? r.error.message})`,
    );
  }
  if (r.status !== 0) {
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    const tail =
      stderr.slice(-600) || (streamProgress ? "(ffmpeg output was streamed above)" : `ffmpeg exited ${r.status}`);
    const hint = explainFfmpegFailure(stderr);
    throw new Error(
      `render: ffmpeg failed.\n${tail}\n` +
        (hint ? `${hint}\n` : "") +
        "Re-run with --dry-run to inspect the filter graph without executing.",
    );
  }
  return { ...plan, ok: true, executed: true };
}
