import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

/**
 * Best-effort media dimension probe.
 *
 * `add-video` previously hardcoded 1920x1080 for every source, so a portrait
 * (1080x1920) clip landed in the draft as landscape and CapCut rendered it
 * letterboxed/cropped. This module shells out to `ffprobe` to read the real
 * stored dimensions AND the display rotation, then returns the dimensions as
 * they should appear on screen.
 *
 * Architecture mirrors `render`/`caption`: the parsing + rotation math is a
 * pure, deterministic function (`parseProbeStreams` / `displayDimensions`)
 * that tests can assert without invoking ffprobe; the live shell-out
 * (`probeVideoDimensions`) is best-effort and returns null whenever ffprobe is
 * missing, errors, or emits something we cannot parse. Callers fall back to
 * their previous defaults on null, so a host without ffprobe is never worse
 * off than before — it just does not get auto-detection.
 */

export interface ProbedDimensions {
  width: number;
  height: number;
  rotation: number; // normalized 0/90/180/270, clockwise
}

export interface MediaProbe {
  width: number | null;
  height: number | null;
  rotation: number;
  durationUs: number | null; // container duration (the LONGEST stream)
  videoDurationUs: number | null; // the video stream's own duration, when the container reports it
  fps: number | null;
  /** avg_frame_rate: frames / duration — the real average. */
  avgFps: number | null;
  /** r_frame_rate: the container's base/tick rate. Diverges from avgFps on
   * variable-frame-rate media. */
  baseFps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  audioChannels: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

/**
 * Variable-frame-rate heuristic: the average frame rate diverges from the
 * container's base rate by more than 1%. VFR media (screen recordings, phone
 * captures) is the classic silent breaker of frame-based pipelines — preview
 * and render timing drift, and strict renderers fail with missing-frame
 * errors (0xsline/OpenChatCut#1's failure class); the standard fix is to
 * normalize to constant frame rate before editing.
 */
export function isVfr(probe: MediaProbe): boolean {
  if (probe.avgFps === null || probe.baseFps === null || probe.baseFps <= 0) return false;
  return Math.abs(probe.avgFps - probe.baseFps) / probe.baseFps > 0.01;
}

const ffprobeAvailableCache = new Map<string, boolean>();

/** True when the ffprobe binary runs. Cached per command string. */
export function ffprobeAvailable(ffprobeCmd = "ffprobe"): boolean {
  const cached = ffprobeAvailableCache.get(ffprobeCmd);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    ok = spawnSync(ffprobeCmd, ["-version"], { encoding: "utf-8", timeout: 10_000 }).status === 0;
  } catch {
    ok = false;
  }
  ffprobeAvailableCache.set(ffprobeCmd, ok);
  return ok;
}

const probeCache = new Map<string, MediaProbe | null>();

function fraction(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const [a, b] = value.split("/").map(Number);
  const result = b ? a / b : a;
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function parseMediaProbe(json: string): MediaProbe | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const streams = Array.isArray(parsed.streams) ? (parsed.streams as Array<Record<string, unknown>>) : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!video && !audio) return null;

  let rotation = 0;
  const tags = video?.tags as Record<string, unknown> | undefined;
  if (tags?.rotate !== undefined && Number.isFinite(Number(tags.rotate))) rotation = Number(tags.rotate);
  else if (Array.isArray(video?.side_data_list)) {
    const item = (video.side_data_list as Array<Record<string, unknown>>).find((value) =>
      Number.isFinite(Number(value.rotation)),
    );
    if (item) rotation = Number(item.rotation);
  }
  rotation = normalizeRotation(rotation);
  let width = video && Number(video.width) > 0 ? Number(video.width) : null;
  let height = video && Number(video.height) > 0 ? Number(video.height) : null;
  if ((rotation === 90 || rotation === 270) && width && height) [width, height] = [height, width];

  const format = (parsed.format ?? {}) as Record<string, unknown>;
  const durationSeconds = fraction(format.duration) ?? fraction(video?.duration) ?? fraction(audio?.duration);
  const videoDurationSeconds = fraction(video?.duration);
  return {
    width,
    height,
    rotation,
    durationUs: durationSeconds === null ? null : Math.round(durationSeconds * 1_000_000),
    videoDurationUs: videoDurationSeconds === null ? null : Math.round(videoDurationSeconds * 1_000_000),
    fps: fraction(video?.avg_frame_rate) ?? fraction(video?.r_frame_rate),
    avgFps: fraction(video?.avg_frame_rate),
    baseFps: fraction(video?.r_frame_rate),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    audioChannels: audio && Number(audio.channels) > 0 ? Number(audio.channels) : null,
    videoCodec: typeof video?.codec_name === "string" ? video.codec_name : null,
    audioCodec: typeof audio?.codec_name === "string" ? audio.codec_name : null,
  };
}

export function probeMedia(path: string, ffprobeCmd = "ffprobe", useCache = true): MediaProbe | null {
  let cacheKey = `${ffprobeCmd}:${path}`;
  try {
    const stat = statSync(path);
    cacheKey += `:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
  if (useCache && probeCache.has(cacheKey)) return probeCache.get(cacheKey) ?? null;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(ffprobeCmd, ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", path], {
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const parsed = result.status === 0 && typeof result.stdout === "string" ? parseMediaProbe(result.stdout) : null;
  if (useCache) probeCache.set(cacheKey, parsed);
  return parsed;
}

/**
 * Parse `ffprobe -show_streams -print_format json` output and pull the stored
 * width/height plus display rotation off the first video stream. Rotation is
 * read from `tags.rotate` (older ffmpeg) or a Display Matrix `side_data_list`
 * entry (newer ffmpeg), normalized to 0/90/180/270 clockwise. Returns null if
 * the JSON has no usable video stream.
 */
export function parseProbeStreams(json: string): ProbedDimensions | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const streams = (parsed as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return null;

  const video = streams.find(
    (s) =>
      s &&
      typeof s === "object" &&
      (s as Record<string, unknown>).codec_type === "video" &&
      Number.isFinite(Number((s as Record<string, unknown>).width)) &&
      Number.isFinite(Number((s as Record<string, unknown>).height)),
  ) as Record<string, unknown> | undefined;
  if (!video) return null;

  const width = Number(video.width);
  const height = Number(video.height);
  if (!(width > 0) || !(height > 0)) return null;

  let rotation = 0;
  const tags = video.tags as Record<string, unknown> | undefined;
  if (tags && tags.rotate !== undefined && Number.isFinite(Number(tags.rotate))) {
    rotation = Number(tags.rotate);
  } else if (Array.isArray(video.side_data_list)) {
    for (const sd of video.side_data_list as Array<Record<string, unknown>>) {
      if (sd && Number.isFinite(Number(sd.rotation))) {
        rotation = Number(sd.rotation);
        break;
      }
    }
  }

  return { width, height, rotation: normalizeRotation(rotation) };
}

/** Normalize any degree value (negative or >360) to one of 0/90/180/270. */
export function normalizeRotation(rotation: number): number {
  const r = ((Math.round(rotation) % 360) + 360) % 360;
  // Snap to the nearest quarter turn; ffprobe occasionally reports e.g. -90.
  return (Math.round(r / 90) * 90) % 360;
}

/**
 * Apply rotation to stored dimensions to get on-screen (display) dimensions.
 * A 90/270 degree rotation swaps width and height.
 */
export function displayDimensions(d: ProbedDimensions): { width: number; height: number } {
  const rot = normalizeRotation(d.rotation);
  if (rot === 90 || rot === 270) return { width: d.height, height: d.width };
  return { width: d.width, height: d.height };
}

/**
 * Live, best-effort probe. Runs ffprobe against `path` and returns the
 * on-screen dimensions, or null if ffprobe is unavailable/fails/unparseable.
 * `ffprobeCmd` overrides the binary (mirrors render's `--ffmpeg-cmd`).
 */
export function probeVideoDimensions(
  path: string,
  ffprobeCmd = "ffprobe",
): { width: number; height: number; rotation: number } | null {
  const parsed = probeMedia(path, ffprobeCmd);
  if (!parsed?.width || !parsed.height) return null;
  return { width: parsed.width, height: parsed.height, rotation: parsed.rotation };
}
