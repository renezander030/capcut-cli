// Retake detection (`detect-retakes`).
//
// A talking-head recording is full of second attempts: the speaker fluffs a
// sentence, pauses, and says it again. Silence detection finds the pause;
// nothing in the cut pipeline found the REPEAT, so the earlier attempt stayed
// in the timeline unless someone scrubbed for it. The one tool in the
// ecosystem that did try (mrbuslov/capcut-ai-editor, PR #3, 2026-08-07) shows
// the failure mode to design against: its sentence-similarity pass matched
// unrelated sentences 27 minutes apart and collapsed a 29-minute recording to
// 1:47. Hence the three guards here, all explicit parameters:
//
//   - a WINDOW: a candidate later take must start within N seconds of the
//     earlier one ending (default 60 s — nobody re-records a sentence half an
//     hour later);
//   - a MINIMUM LENGTH: cues shorter than N words never count (default 4 —
//     "yeah", "okay so" repeat constantly and are not retakes);
//   - a SIMILARITY floor on the normalised word sequences (default 0.8 of the
//     Ratcliff/Obershelp-style ratio 2·LCS/(|a|+|b|)), so a genuinely
//     rephrased sentence is not mistaken for a repeat.
//
// Convention: the LATER take is the keeper (that is why it was re-recorded);
// the earlier cue's span becomes a cut. Output mirrors detect-silence — cut
// spans plus the complementary keep spans, in seconds and microseconds — so
// the same `cut` / `compile` step consumes it. Pure and deterministic.

import { normalizeToken } from "./align.js";
import type { SceneSegment } from "./scenes.js";
import { buildKeepSpans, type SilenceSpan, spansToSegments } from "./silence.js";

const US = 1_000_000;

export interface RetakeCue {
  text: string;
  startUs: number;
  endUs: number;
}

export interface RetakeOptions {
  /** Max gap between the earlier cue's end and the later cue's start, seconds (default 60). */
  window?: number;
  /** Similarity floor on the normalised word sequences, 0..1 (default 0.8). */
  similarity?: number;
  /** Cues with fewer normalised words never count as a take (default 4). */
  minWords?: number;
}

export interface RetakeSide {
  text: string;
  start: number;
  end: number;
  start_us: number;
  end_us: number;
}

export interface RetakePair {
  earlier: RetakeSide;
  later: RetakeSide;
  similarity: number;
  /** Normalised word count of the earlier cue. */
  words: number;
}

export interface RetakeReport {
  source: string;
  window: number;
  similarity: number;
  min_words: number;
  cues: number;
  duration: number | null;
  duration_us: number | null;
  retakes: RetakePair[];
  /** Spans to drop: the earlier take of every pair, merged where they touch. */
  cuts: SceneSegment[];
  /** Everything else, over [0, duration] — what `cut`/`compile` keeps. */
  keeps: SceneSegment[];
}

/** Words of a cue in comparison form (empty tokens removed). */
export function normalizeWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 0);
}

/** Longest common subsequence length of two token arrays. */
function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 2·LCS/(|a|+|b|): 1 for identical sequences, 0 for nothing in common. */
export function sequenceSimilarity(a: string[], b: string[]): number {
  if (a.length + b.length === 0) return 0;
  return Math.round(((2 * lcsLength(a, b)) / (a.length + b.length)) * 1000) / 1000;
}

function side(cue: RetakeCue): RetakeSide {
  return {
    text: cue.text,
    start: round6(cue.startUs / US),
    end: round6(cue.endUs / US),
    start_us: cue.startUs,
    end_us: cue.endUs,
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Find retake pairs among time-ordered cues. Each earlier cue is compared with
 * the later cues that start inside the window; the FIRST later cue that
 * clears the similarity floor is its retake (closest repeat wins). A cue that
 * is itself the later half of one pair can still be the earlier half of the
 * next — three attempts at one sentence yield two pairs and keep the last.
 */
export function findRetakes(cues: RetakeCue[], opts: RetakeOptions = {}): RetakePair[] {
  const windowUs = Math.round((opts.window ?? 60) * US);
  const floor = opts.similarity ?? 0.8;
  const minWords = opts.minWords ?? 4;
  const ordered = [...cues].sort((a, b) => a.startUs - b.startUs);
  const tokens = ordered.map((c) => normalizeWords(c.text));
  const pairs: RetakePair[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (tokens[i].length < minWords) continue;
    for (let j = i + 1; j < ordered.length; j++) {
      if (ordered[j].startUs - ordered[i].endUs > windowUs) break;
      if (tokens[j].length < minWords) continue;
      const sim = sequenceSimilarity(tokens[i], tokens[j]);
      if (sim >= floor) {
        pairs.push({ earlier: side(ordered[i]), later: side(ordered[j]), similarity: sim, words: tokens[i].length });
        break;
      }
    }
  }
  return pairs;
}

/** Merge touching/overlapping spans, in time order. */
export function mergeSpans(spans: SilenceSpan[]): SilenceSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: SilenceSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.end !== null && span.start <= last.end) {
      if (span.end === null || (last.end !== null && span.end > last.end)) last.end = span.end;
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }
  return merged;
}

/**
 * The full report: pairs, the cut spans (earlier takes, merged) and the keep
 * spans over [0, duration]. `durationUs` null → the last cue's end bounds the
 * keeps (open-ended like detect-silence without a probe would be misleading
 * here: cues are timeline facts, not a stream probe).
 */
export function buildRetakeReport(
  cues: RetakeCue[],
  durationUs: number | null,
  opts: RetakeOptions,
  source: string,
): RetakeReport {
  const retakes = findRetakes(cues, opts);
  const cuts = mergeSpans(retakes.map((p) => ({ start: p.earlier.start, end: p.earlier.end })));
  const bound =
    durationUs !== null && durationUs > 0
      ? durationUs / US
      : cues.length > 0
        ? Math.max(...cues.map((c) => c.endUs)) / US
        : 0;
  return {
    source,
    window: opts.window ?? 60,
    similarity: opts.similarity ?? 0.8,
    min_words: opts.minWords ?? 4,
    cues: cues.length,
    duration: bound > 0 ? round6(bound) : null,
    duration_us: bound > 0 ? Math.round(bound * US) : null,
    retakes,
    cuts: spansToSegments(cuts),
    keeps: spansToSegments(buildKeepSpans(cuts, bound > 0 ? bound : null)),
  };
}
