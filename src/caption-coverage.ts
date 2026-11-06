import { detectSilence } from "./silence.js";

/**
 * Caption coverage: how much of the speech in the transcribed audio the
 * written cues actually cover.
 *
 * A transcription can stop before the end of the audio, or skip a quiet
 * stretch, and still exit cleanly; the draft then simply has no captions
 * there. After `caption` transcribes, the audio is measured with ffmpeg's
 * silencedetect (the same pass `detect-silence` runs): its keep spans are the
 * speech. The cue spans are subtracted from them, and what is left over —
 * speech no cue covers — is reported. All times are the audio's own seconds,
 * the same clock the cues are timed on.
 *
 * The span math (`mergeSpans`, `subtractSpans`, `captionCoverage`) is pure and
 * asserted without ffmpeg; `measureSpeech` is the live pass and never throws:
 * a missing ffmpeg or an unreadable file becomes a `skipped` reason.
 */

/** A span of the audio, in seconds. */
export interface TimeSpan {
  start: number;
  end: number;
}

export interface CaptionCoverage {
  /** Seconds of non-silent audio. */
  speech_s: number;
  /** Seconds of that speech a cue covers. */
  captioned_s: number;
  /** captioned_s / speech_s (1 when the audio holds no speech). */
  ratio: number;
  /** Speech no cue covers, each span at least the --min-uncaptioned length. */
  uncaptioned: Array<{ start_s: number; end_s: number }>;
  /** Seconds of the listed spans that come after the last cue ends. */
  tail_uncaptioned_s: number;
}

export type CoverageReport = CaptionCoverage | { skipped: string };

/** Shortest uncaptioned speech span reported, seconds. */
export const DEFAULT_MIN_UNCAPTIONED = 1.5;

// Rounding noise from µs → s conversions must not hide a span sitting exactly
// at the threshold.
const EPSILON = 1e-6;

/** Sort spans and merge the ones that overlap or touch. Empty spans drop. */
export function mergeSpans(spans: TimeSpan[]): TimeSpan[] {
  const sorted = spans.filter((span) => span.end > span.start).sort((a, b) => a.start - b.start);
  const merged: TimeSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  return merged;
}

/** The parts of `from` that no span of `minus` covers. */
export function subtractSpans(from: TimeSpan[], minus: TimeSpan[]): TimeSpan[] {
  const cut = mergeSpans(minus);
  const left: TimeSpan[] = [];
  for (const span of mergeSpans(from)) {
    let cursor = span.start;
    for (const c of cut) {
      if (c.end <= cursor) continue;
      if (c.start >= span.end) break;
      if (c.start > cursor) left.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
      if (cursor >= span.end) break;
    }
    if (cursor < span.end) left.push({ start: cursor, end: span.end });
  }
  return left;
}

function total(spans: TimeSpan[]): number {
  return spans.reduce((sum, span) => sum + (span.end - span.start), 0);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Compare the speech spans with the cue spans. `uncaptioned` lists only the
 * uncovered speech spans of at least `minUncaptioned` seconds; shorter ones
 * (a breath, a cue ending a few frames early) still count against
 * captioned_s and ratio.
 */
export function captionCoverage(
  speech: TimeSpan[],
  cues: TimeSpan[],
  minUncaptioned = DEFAULT_MIN_UNCAPTIONED,
): CaptionCoverage {
  const speechSpans = mergeSpans(speech);
  const speechS = total(speechSpans);
  const uncovered = subtractSpans(speechSpans, cues);
  const captionedS = Math.max(0, speechS - total(uncovered));
  const listed = uncovered.filter((span) => span.end - span.start >= minUncaptioned - EPSILON);
  const lastCueEnd = cues.reduce((end, cue) => Math.max(end, cue.end), 0);
  return {
    speech_s: round3(speechS),
    captioned_s: round3(captionedS),
    ratio: speechS > 0 ? Math.round((captionedS / speechS) * 10_000) / 10_000 : 1,
    uncaptioned: listed.map((span) => ({ start_s: round3(span.start), end_s: round3(span.end) })),
    tail_uncaptioned_s: round3(total(listed.filter((span) => span.start >= lastCueEnd - EPSILON))),
  };
}

/**
 * The speech in `audioPath` as spans (silencedetect's keep spans, unpadded),
 * or why it could not be measured. Never throws: the coverage check must not
 * fail a caption run that already succeeded.
 */
export function measureSpeech(audioPath: string, ffmpegCmd: string): TimeSpan[] | { skipped: string } {
  let keeps: ReturnType<typeof detectSilence>["keeps"];
  try {
    keeps = detectSilence(audioPath, { ffmpegCmd, pad: 0 }).keeps;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { skipped: /is unavailable at/.test(message) ? "ffmpeg not found" : "ffmpeg could not read the audio" };
  }
  // An open-ended keep span means neither ffprobe nor ffmpeg reported the
  // audio's length, so the speech after the last silence has no known end.
  if (keeps.some((keep) => keep.end === null)) return { skipped: "audio length unknown" };
  return keeps.map((keep) => ({ start: keep.start, end: keep.end as number }));
}

function seconds(n: number): string {
  return `${n.toFixed(2)}s`;
}

/** The one stderr line a run with uncaptioned speech prints. */
export function uncaptionedWarning(coverage: CaptionCoverage): string {
  const spans = coverage.uncaptioned;
  const missing = spans.reduce((sum, span) => sum + (span.end_s - span.start_s), 0);
  const list = spans.map((span) => `${span.start_s.toFixed(2)}-${seconds(span.end_s)}`).join(", ");
  const tail =
    coverage.tail_uncaptioned_s > 0
      ? ` ${seconds(coverage.tail_uncaptioned_s)} of it comes after the last cue: the transcription may have stopped before the end of the audio.`
      : "";
  return (
    `[uncaptioned-speech] ${seconds(missing)} of speech in ${spans.length} span${spans.length === 1 ? "" : "s"} ` +
    `has no caption (${Math.round(coverage.ratio * 100)}% of the speech is captioned): ${list}.${tail}\n`
  );
}
