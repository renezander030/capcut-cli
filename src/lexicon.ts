/**
 * Pronunciation lexicon for `tts --lexicon`: rewrite only the text handed to
 * the TTS engine ("Nguyen" -> "Win"), never what the draft shows.
 *
 * Matching is leftmost-longest over the source text. A rule whose first/last
 * character is a word character (letter, digit, mark, underscore) only matches
 * where the neighbouring text character is not one, so "SQL" never fires inside
 * "MySQLite". CJK scripts have no word boundaries: CJK characters neither need
 * nor block a boundary, so a CJK rule matches anywhere and "SQL" still matches
 * in "我用SQL". Offsets are JS string (UTF-16 code unit) indices into the
 * source text. Pure: no I/O, so the matcher is unit-testable on its own.
 */

export interface LexiconRule {
  text: string;
  say: string;
  /** Default true. */
  case_sensitive: boolean;
}

export interface LexiconApplied {
  rule_text: string;
  say: string;
  /** UTF-16 code unit offsets into the source text, end exclusive. */
  source_start: number;
  source_end: number;
}

export interface LexiconResult {
  spoken_text: string;
  applied: LexiconApplied[];
}

/** A lexicon problem carrying its refusal gate id (`lexicon-invalid` / `lexicon-ambiguous`). */
export class LexiconError extends Error {
  constructor(
    readonly gate: "lexicon-invalid" | "lexicon-ambiguous",
    message: string,
  ) {
    super(message);
    this.name = "LexiconError";
  }
}

const WORD_CHAR = /^[\p{L}\p{N}\p{M}_]$/u;
const CJK_CHAR = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]$/u;

function isCjk(ch: string): boolean {
  return CJK_CHAR.test(ch);
}

/** A character that forms a word with an adjacent rule edge (CJK excluded). */
function bindsWord(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch) && !isCjk(ch);
}

/** The full code point ending just before code unit `i`. */
function charBefore(s: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const low = s.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = s.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

/** The full code point starting at code unit `i`. */
function charAt(s: string, i: number): string | undefined {
  if (i >= s.length) return undefined;
  const cp = s.codePointAt(i);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/**
 * Validate a parsed lexicon document: `{ "rules": [...] }` or a bare array of
 * `{ text, say, case_sensitive? }`. Throws LexiconError(lexicon-invalid).
 */
export function parseLexicon(doc: unknown): LexiconRule[] {
  const list = Array.isArray(doc)
    ? doc
    : doc !== null && typeof doc === "object" && Array.isArray((doc as { rules?: unknown }).rules)
      ? (doc as { rules: unknown[] }).rules
      : undefined;
  if (list === undefined) {
    throw new LexiconError(
      "lexicon-invalid",
      'the lexicon must be { "rules": [ { "text": ..., "say": ... } ] } or a top-level array of rules.',
    );
  }
  return list.map((raw, i): LexiconRule => {
    const where = `rule ${i}`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new LexiconError("lexicon-invalid", `${where} is not an object.`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.text !== "string") throw new LexiconError("lexicon-invalid", `${where} needs a string "text".`);
    if (r.text.length === 0) throw new LexiconError("lexicon-invalid", `${where} has an empty "text".`);
    if (typeof r.say !== "string") {
      throw new LexiconError("lexicon-invalid", `${where} ("${r.text}") needs a string "say".`);
    }
    if (r.case_sensitive !== undefined && typeof r.case_sensitive !== "boolean") {
      throw new LexiconError("lexicon-invalid", `${where} ("${r.text}") has a non-boolean "case_sensitive".`);
    }
    return { text: r.text, say: r.say, case_sensitive: r.case_sensitive !== false };
  });
}

function matchesAt(source: string, i: number, rule: LexiconRule): boolean {
  const end = i + rule.text.length;
  if (end > source.length) return false;
  const slice = source.slice(i, end);
  if (rule.case_sensitive ? slice !== rule.text : slice.toLowerCase() !== rule.text.toLowerCase()) return false;
  // Boundaries are only demanded at rule edges that are themselves word
  // characters: "C++" may be followed by a letter, "SQL" may not.
  if (bindsWord(charAt(rule.text, 0)) && bindsWord(charBefore(source, i))) return false;
  if (bindsWord(charBefore(rule.text, rule.text.length)) && bindsWord(charAt(source, end))) return false;
  return true;
}

/**
 * Apply the rules to `source`: at each position the longest matching rule
 * wins; equally long matches that would say different things refuse with
 * LexiconError(lexicon-ambiguous). Replaced spans are not rescanned.
 */
export function applyLexicon(source: string, rules: readonly LexiconRule[]): LexiconResult {
  const byLength = [...rules].sort((a, b) => b.text.length - a.text.length);
  const applied: LexiconApplied[] = [];
  let spoken = "";
  let i = 0;
  while (i < source.length) {
    let winner: LexiconRule | undefined;
    for (const rule of byLength) {
      if (winner !== undefined && rule.text.length < winner.text.length) break;
      if (!matchesAt(source, i, rule)) continue;
      if (winner === undefined) winner = rule;
      else if (winner.say !== rule.say) {
        throw new LexiconError(
          "lexicon-ambiguous",
          `rules "${winner.text}" (say "${winner.say}") and "${rule.text}" (say "${rule.say}") both match ` +
            `"${source.slice(i, i + rule.text.length)}" at offset ${i}. Remove one or make them distinct.`,
        );
      }
    }
    if (winner === undefined) {
      spoken += source[i];
      i++;
      continue;
    }
    const end = i + winner.text.length;
    applied.push({ rule_text: winner.text, say: winner.say, source_start: i, source_end: end });
    spoken += winner.say;
    i = end;
  }
  return { spoken_text: spoken, applied };
}
