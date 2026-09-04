// Transcript-guided caption alignment (`caption --script`).
//
// Whisper hears the audio; the author already knows what was said. Names,
// product terms, numbers and punctuation are exactly what speech recognition
// gets wrong most often — and the pipelines that most want burned-in captions
// (talking-head shorts, narrated explainers, dubbed courses) usually have the
// script on hand (neo9su/autoclipvideo#174, baizhiheizi/enjoy_player#540 both
// ask for word timing on a KNOWN text rather than a fresh transcription).
// This module keeps whisper's timing and swaps in the script's wording:
//
//   1. tokenise both sides and compare on a normalised form (lower-case, NFKC,
//      punctuation stripped) so "Ramaris," and "ramaris" match;
//   2. globally align the two token sequences (Needleman–Wunsch: match +2,
//      near-miss substitution +1, other substitution −1, gap −1 — the classic
//      transcript-alignment scoring, with the near-miss term so a mis-heard
//      word pairs with the word it was, not with a neighbour);
//   3. every script word aligned to a recognised word inherits that word's
//      start/end; script words whisper missed are spread evenly across the gap
//      between their timed neighbours (or extrapolated at the edges at the
//      recognised words' median duration).
//
// The alignment is pure and deterministic, so tests assert it without whisper;
// the caller decides how the timed script words become cues (script lines are
// the natural cue boundaries — an author who pre-chunks the script controls
// exactly where the captions break).

import type { CaptionWord } from "./caption.js";

export interface AlignedWord extends CaptionWord {
  /** True when this script word was aligned to an identical recognised word. */
  matched: boolean;
  /** Which script line (0-based) the word came from — the cue boundary hint. */
  line: number;
}

export interface AlignmentReport {
  script_words: number;
  recognized_words: number;
  /** Script words aligned to an identical recognised token. */
  matched: number;
  /** Script words aligned to a DIFFERENT recognised token (whisper mis-heard). */
  substituted: number;
  /** Script words whisper produced nothing for (timing interpolated). */
  inserted: number;
  /** Recognised words the script does not contain (ignored). */
  dropped: number;
  /** matched / script_words — below ~0.5 the script probably does not belong to this audio. */
  match_ratio: number;
}

/** Comparison form of a token: NFKC, lower-case, letters/digits only (any script). */
export function normalizeToken(token: string): string {
  return token
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Script text → lines → words. Blank lines are dropped; a line is a unit the
 * caller may keep together as one cue. Tokens with no letters or digits
 * (a lone "—", "...") cannot be aligned or spoken and are removed.
 */
export function tokenizeScript(text: string): string[][] {
  const lines: string[][] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const words = rawLine
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0 && normalizeToken(w).length > 0);
    if (words.length > 0) lines.push(words);
  }
  return lines;
}

const MATCH = 2;
const NEAR_MATCH = 1;
const MISMATCH = -1;
const GAP = -1;

/** Levenshtein distance, only ever called for short, similarly-sized tokens. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Uint16Array(cols);
  let cur = new Uint16Array(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    cur[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[cols - 1];
}

/**
 * Substitution score for two different normalised tokens. A recogniser's
 * mistakes are usually NEAR misses ("chanel"/"channel", "ramarys"/"ramaris"),
 * so a pair within roughly 40% edit distance scores positive — that is what
 * makes the alignment prefer "ramaris ↔ ramarys" over pairing the recognised
 * word with whatever unrelated script word happens to sit next to it when the
 * plain mismatch scores tie. Cheap length/character prefilters keep the
 * Levenshtein call rare on a long transcript.
 */
function substitutionScore(a: string, b: string): number {
  if (a === b) return MATCH;
  const longest = Math.max(a.length, b.length);
  if (longest < 3 || Math.abs(a.length - b.length) > 2) return MISMATCH;
  if (a[0] !== b[0] && a[a.length - 1] !== b[b.length - 1]) return MISMATCH;
  return editDistance(a, b) / longest <= 0.4 ? NEAR_MATCH : MISMATCH;
}

/**
 * Needleman–Wunsch over the normalised tokens. Returns, per script word, the
 * index of the recognised word it aligned to (or -1), plus whether that pair
 * is an exact match. Typed arrays keep a 5k × 5k alignment (an hour of speech)
 * in the tens of megabytes and well under a second.
 */
function alignTokens(script: string[], recognized: string[]): { pair: Int32Array; exact: Uint8Array } {
  const n = script.length;
  const m = recognized.length;
  const cols = m + 1;
  const score = new Int32Array((n + 1) * cols);
  // 0 = diagonal, 1 = up (script gap: word inserted), 2 = left (recognised dropped)
  const move = new Uint8Array((n + 1) * cols);
  for (let i = 1; i <= n; i++) {
    score[i * cols] = i * GAP;
    move[i * cols] = 1;
  }
  for (let j = 1; j <= m; j++) {
    score[j] = j * GAP;
    move[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    const s = script[i - 1];
    for (let j = 1; j <= m; j++) {
      const diag = score[(i - 1) * cols + (j - 1)] + substitutionScore(s, recognized[j - 1]);
      const up = score[(i - 1) * cols + j] + GAP;
      const left = score[i * cols + (j - 1)] + GAP;
      let best = diag;
      let via = 0;
      if (up > best) {
        best = up;
        via = 1;
      }
      if (left > best) {
        best = left;
        via = 2;
      }
      score[i * cols + j] = best;
      move[i * cols + j] = via;
    }
  }
  const pair = new Int32Array(n).fill(-1);
  const exact = new Uint8Array(n);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const via = i === 0 ? 2 : j === 0 ? 1 : move[i * cols + j];
    if (via === 0) {
      pair[i - 1] = j - 1;
      exact[i - 1] = script[i - 1] === recognized[j - 1] ? 1 : 0;
      i--;
      j--;
    } else if (via === 1) {
      i--;
    } else {
      j--;
    }
  }
  return { pair, exact };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Fallback word length when the recogniser produced no word timings at all. */
export const DEFAULT_WORD_DURATION_US = 300_000;

/**
 * Time the script against the recognised words. Every script word gets a
 * start/end; the report says how well the two sides agreed.
 */
export function alignScript(
  scriptLines: string[][],
  recognized: CaptionWord[],
): { words: AlignedWord[]; lines: AlignedWord[][]; report: AlignmentReport } {
  const flat: Array<{ word: string; line: number }> = [];
  scriptLines.forEach((line, index) => {
    for (const word of line) flat.push({ word, line: index });
  });
  const scriptNorm = flat.map((w) => normalizeToken(w.word));
  const recognizedNorm = recognized.map((w) => normalizeToken(w.word));
  const { pair, exact } = alignTokens(scriptNorm, recognizedNorm);

  const words: AlignedWord[] = flat.map((w, i) => {
    const r = pair[i] >= 0 ? recognized[pair[i]] : null;
    return {
      word: w.word,
      line: w.line,
      matched: exact[i] === 1,
      startUs: r ? r.startUs : Number.NaN,
      endUs: r ? r.endUs : Number.NaN,
    };
  });

  // Interpolate the untimed runs between their timed neighbours.
  const durations = recognized.map((w) => Math.max(1, w.endUs - w.startUs));
  const typical = median(durations) || DEFAULT_WORD_DURATION_US;
  let i = 0;
  while (i < words.length) {
    if (!Number.isNaN(words[i].startUs)) {
      i++;
      continue;
    }
    let end = i;
    while (end < words.length && Number.isNaN(words[end].startUs)) end++;
    const run = end - i; // words[i..end) untimed
    const prev = i > 0 ? words[i - 1] : null;
    const next = end < words.length ? words[end] : null;
    let spanStart: number;
    let spanEnd: number;
    if (prev && next) {
      spanStart = prev.endUs;
      spanEnd = Math.max(next.startUs, spanStart + run); // never zero-length
    } else if (prev) {
      spanStart = prev.endUs;
      spanEnd = spanStart + run * typical;
    } else if (next) {
      spanEnd = next.startUs;
      spanStart = Math.max(0, spanEnd - run * typical);
    } else {
      spanStart = 0;
      spanEnd = run * typical;
    }
    const slot = (spanEnd - spanStart) / run;
    for (let k = 0; k < run; k++) {
      words[i + k].startUs = Math.round(spanStart + slot * k);
      words[i + k].endUs = Math.round(spanStart + slot * (k + 1));
    }
    i = end;
  }
  // Timing must stay monotonic even when the recogniser's words overlap slightly.
  for (let k = 1; k < words.length; k++) {
    if (words[k].startUs < words[k - 1].endUs) words[k].startUs = words[k - 1].endUs;
    if (words[k].endUs <= words[k].startUs) words[k].endUs = words[k].startUs + 1;
  }

  const lines: AlignedWord[][] = scriptLines.map(() => []);
  for (const w of words) lines[w.line].push(w);

  let matched = 0;
  let substituted = 0;
  let inserted = 0;
  const usedRecognized = new Set<number>();
  for (let k = 0; k < words.length; k++) {
    if (pair[k] < 0) inserted++;
    else {
      usedRecognized.add(pair[k]);
      if (exact[k] === 1) matched++;
      else substituted++;
    }
  }
  const report: AlignmentReport = {
    script_words: words.length,
    recognized_words: recognized.length,
    matched,
    substituted,
    inserted,
    dropped: recognized.length - usedRecognized.size,
    match_ratio: words.length === 0 ? 0 : Math.round((matched / words.length) * 1000) / 1000,
  };
  return { words, lines, report };
}
