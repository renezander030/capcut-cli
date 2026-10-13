import { existsSync } from "node:fs";
import { runFfmpegAnalysis } from "./ffmpeg-pass.js";
import { probeMedia } from "./probe.js";
import { parseFfmpegDuration, type SceneSegment } from "./scenes.js";

/**
 * Deterministic silence detection (ffmpeg silencedetect filter, no AI).
 *
 * Seeds the auto-cut workflow: dead air in a raw recording is invisible until
 * you know where the silence spans are. `detect-silence` runs ffmpeg's
 * silencedetect over a media file — `-af silencedetect=noise=TdB:d=D` writes
 * each span's silence_start/silence_end to stderr — and turns that into the
 * silence spans plus the complementary KEEP segments (the speech), both in
 * seconds and draft-native microseconds, ready for `cut`/`compile`.
 *
 * Architecture mirrors `detect-scenes`: parsing and span math are pure,
 * deterministic functions (`parseSilenceSpans`, `closeSilenceSpans`,
 * `padSilenceSpans`, `limitSilences`, `buildKeepSpans`, `spansToSegments`)
 * tests assert without invoking ffmpeg; the live shell-out (`detectSilence`)
 * throws an actionable error when ffmpeg is missing.
 */

const US = 1_000_000; // microseconds per second — CapCut's timing unit

export interface SilenceSpan {
  start: number; // seconds
  end: number | null; // null when the silence ran to the end of the input
}

export interface SilenceDetectOptions {
  thresholdDb?: number; // noise floor in dBFS; at/below counts as silence (default -30)
  minSilence?: number; // shortest silence ffmpeg reports, seconds (default 0.5)
  pad?: number; // margin kept around speech: shrink each span on both ends (default 0.1)
  limit?: number; // keep only the N longest silences
  ffmpegCmd?: string; // ffmpeg binary (default "ffmpeg")
  ffprobeCmd?: string; // ffprobe binary for the container duration (default "ffprobe")
  timeoutMs?: number; // kill ffmpeg after this long (default 600s)
  maxBufferBytes?: number; // ffmpeg stdout/stderr cap (default 64 MiB)
}

export interface SilenceReport {
  media: string;
  threshold_db: number;
  min_silence: number;
  pad: number;
  limit: number | null;
  duration: number | null;
  duration_us: number | null;
  // Where `duration` came from: ffprobe's container metadata, or the
  // centisecond-rounded "Duration:" header on ffmpeg's stderr (only used when
  // ffprobe is unavailable).
  duration_source: "container" | "ffmpeg-header" | null;
  silences: SceneSegment[];
  keeps: SceneSegment[];
}

/**
 * Parse the stderr of `-af silencedetect=noise=TdB:d=D -f null -`. Each span
 * emits two lines:
 *   [silencedetect @ 0x...] silence_start: 1.33915
 *   [silencedetect @ 0x...] silence_end: 3.55712 | silence_duration: 2.21798
 * A silence_start with no matching silence_end means the input ended during
 * the silence; the span is kept with end null.
 */
export function parseSilenceSpans(stderr: string): SilenceSpan[] {
  const spans: SilenceSpan[] = [];
  let pending: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(/\bsilence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (start) {
      // ffmpeg reports leading silence a hair before 0 (e.g. -0.00119).
      pending = Math.max(0, Number(start[1]));
      continue;
    }
    const end = line.match(/\bsilence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (end && pending !== null) {
      const endTime = Number(end[1]);
      if (endTime > pending) spans.push({ start: pending, end: endTime });
      pending = null;
    }
  }
  if (pending !== null) spans.push({ start: pending, end: null });
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Bound spans to a known duration: an open-ended span (silence to EOF) closes
 * at `duration`, ends clamp to it, and spans starting at/after it drop. With
 * an unknown duration the spans pass through untouched.
 */
export function closeSilenceSpans(spans: SilenceSpan[], duration: number | null): SilenceSpan[] {
  if (duration === null) return [...spans];
  const closed: SilenceSpan[] = [];
  for (const span of spans) {
    if (span.start >= duration) continue;
    const end = span.end === null ? duration : Math.min(span.end, duration);
    if (end > span.start) closed.push({ start: span.start, end });
  }
  return closed;
}

/**
 * Shrink each span by `pad` seconds on both ends so the keep segments retain a
 * margin around speech — cutting exactly at silence_end clips the soft attack
 * of the next word mid-syllable. A span not longer than 2*pad disappears
 * (never goes negative). An open-ended span keeps its null end: no speech
 * follows a silence that runs to EOF, so only its start is padded.
 */
export function padSilenceSpans(spans: SilenceSpan[], pad: number): SilenceSpan[] {
  if (pad <= 0) return [...spans];
  const padded: SilenceSpan[] = [];
  for (const span of spans) {
    const start = span.start + pad;
    if (span.end === null) {
      padded.push({ start, end: null });
      continue;
    }
    const end = span.end - pad;
    if (end > start) padded.push({ start, end });
  }
  return padded;
}

/** Keep the N longest silences (a silence to EOF always counts as longest,
 * earliest wins ties), returned back in time order. */
export function limitSilences(spans: SilenceSpan[], limit: number | undefined): SilenceSpan[] {
  if (limit === undefined || spans.length <= limit) return spans;
  const length = (s: SilenceSpan) => (s.end === null ? Number.POSITIVE_INFINITY : s.end - s.start);
  return [...spans]
    .sort((a, b) => length(b) - length(a) || a.start - b.start)
    .slice(0, limit)
    .sort((a, b) => a.start - b.start);
}

/**
 * Complement the silence spans over [0..duration]: the KEEP segments (speech)
 * an auto-cut feeds into `cut`/`compile`. A silence running to EOF ends the
 * list — nothing to keep after it. With an unknown duration the trailing keep
 * segment is open-ended (end null). An all-silence file keeps nothing.
 */
export function buildKeepSpans(silences: SilenceSpan[], duration: number | null): SilenceSpan[] {
  const keeps: SilenceSpan[] = [];
  let cursor = 0;
  for (const span of silences) {
    if (span.start > cursor) keeps.push({ start: cursor, end: span.start });
    if (span.end === null) return keeps;
    cursor = Math.max(cursor, span.end);
  }
  if (duration === null) keeps.push({ start: cursor, end: null });
  else if (cursor < duration) keeps.push({ start: cursor, end: duration });
  return keeps;
}

/** Spans -> detect-scenes' segment shape (seconds + draft-native microseconds). */
export function spansToSegments(spans: SilenceSpan[]): SceneSegment[] {
  return spans.map(({ start, end }) => ({
    start,
    end,
    duration: end === null ? null : round6(end - start),
    start_us: Math.round(start * US),
    end_us: end === null ? null : Math.round(end * US),
    duration_us: end === null ? null : Math.round(end * US) - Math.round(start * US),
  }));
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Live detection. Runs ffmpeg's silencedetect filter over `mediaPath` and
 * assembles the report. Throws with an actionable message when the file or
 * ffmpeg is missing, or when ffmpeg fails (mirrors detect-scenes).
 */
export function detectSilence(mediaPath: string, opts: SilenceDetectOptions = {}): SilenceReport {
  const thresholdDb = opts.thresholdDb ?? -30;
  const minSilence = opts.minSilence ?? 0.5;
  const pad = opts.pad ?? 0.1;
  const cmd = opts.ffmpegCmd ?? "ffmpeg";
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const maxBuffer = opts.maxBufferBytes ?? 64 * 1024 * 1024;
  if (!existsSync(mediaPath)) {
    throw new Error(`detect-silence: media not found: ${mediaPath}`);
  }
  const args = [
    "-hide_banner",
    "-i",
    mediaPath,
    "-af",
    `silencedetect=noise=${thresholdDb}dB:d=${minSilence}`,
    "-vn",
    "-f",
    "null",
    "-",
  ];
  const stderr = runFfmpegAnalysis({
    label: "detect-silence",
    what: "silence detection",
    cmd,
    mediaPath: mediaPath,
    args,
    timeoutMs,
    maxBuffer,
    timeoutHint: "Try a shorter input.",
    bufferHint: "Raise --min-silence to report fewer silence spans.",
  });
  // Keep segments must span the whole file, so the bound is the CONTAINER
  // duration (silence applies to the file timeline `cut` operates on, not one
  // stream). ffprobe reads the precise metadata; the centisecond-rounded
  // stderr header is only a fallback, and duration_source says which one the
  // report used.
  const probe = probeMedia(mediaPath, opts.ffprobeCmd ?? "ffprobe");
  const duration = probe?.durationUs != null ? probe.durationUs / US : parseFfmpegDuration(stderr);
  const durationSource: SilenceReport["duration_source"] =
    probe?.durationUs != null ? "container" : duration === null ? null : "ffmpeg-header";
  const silences = limitSilences(
    padSilenceSpans(closeSilenceSpans(parseSilenceSpans(stderr), duration), pad),
    opts.limit,
  );
  return {
    media: mediaPath,
    threshold_db: thresholdDb,
    min_silence: minSilence,
    pad,
    limit: opts.limit ?? null,
    duration,
    duration_us: duration === null ? null : Math.round(duration * US),
    duration_source: durationSource,
    silences: spansToSegments(silences),
    keeps: spansToSegments(buildKeepSpans(silences, duration)),
  };
}
