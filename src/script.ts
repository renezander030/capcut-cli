/**
 * Which script a caption is written in, and what that changes: the limits a
 * line and a reading speed are held to (lint), and how whisper's words are
 * joined and grouped into cues (caption). Latin and everything else share one
 * bucket; Chinese, Japanese and Korean each get their own because their
 * subtitling conventions differ from Latin ones and from each other.
 */

/** The script a caption is written in, as far as the line-length and
 * reading-speed rules care: Latin (and everything else), or one of the three
 * CJK scripts whose subtitling conventions differ from Latin ones. */
export type CaptionScript = "latin" | "zh" | "ja" | "ko";

export interface ScriptLimit {
  maxCharsPerLine?: number;
  maxCharsPerSecond?: number;
}

/** Caption limits that replace `maxCharsPerLine` / `maxCharsPerSecond` for a
 * cue written in the given script. An absent key falls back to the Latin
 * value for that rule. */
export type ScriptLimits = Partial<Record<Exclude<CaptionScript, "latin">, ScriptLimit>>;

/**
 * Where the Latin defaults (42 characters per line, 20 per second) come from
 * a Latin alphabet, a CJK character carries a syllable or a word, so a line
 * a third as long is already full and a third the speed is already fast:
 * the streaming style guides sit at 16 characters per line and 9 per second
 * for Simplified Chinese, 13 and 4 for Japanese, 16 and 12 for Korean. A
 * 30-character Chinese line passing a 42-character check is the failure this
 * table exists for.
 */
export const CJK_SCRIPT_LIMITS: ScriptLimits = {
  zh: { maxCharsPerLine: 16, maxCharsPerSecond: 9 },
  ja: { maxCharsPerLine: 13, maxCharsPerSecond: 4 },
  ko: { maxCharsPerLine: 16, maxCharsPerSecond: 12 },
};

const KANA = /[\u3040-\u30ff]/;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// Full-width punctuation and symbols travel with the CJK scripts and count
// towards the share, without deciding which script it is.
const CJK_ANY =
  /[\u3000-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/**
 * The script a caption's limits should follow: CJK when at least half of its
 * visible characters are CJK, then Japanese if any kana is present, Korean if
 * any hangul, else Chinese. A mixed caption below that share (a Latin line
 * with one CJK name) keeps the Latin limits.
 */
export function captionScript(text: string): CaptionScript {
  let total = 0;
  let cjk = 0;
  let kana = 0;
  let hangul = 0;
  let han = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total++;
    if (KANA.test(ch)) {
      kana++;
      cjk++;
    } else if (HANGUL.test(ch)) {
      hangul++;
      cjk++;
    } else if (HAN.test(ch)) {
      han++;
      cjk++;
    } else if (CJK_ANY.test(ch)) {
      cjk++;
    }
  }
  if (total === 0 || cjk * 2 < total) return "latin";
  if (kana > 0) return "ja";
  if (hangul > 0) return "ko";
  if (han > 0) return "zh";
  return "latin";
}

/**
 * How a cue's words are joined into its text: Chinese and Japanese are written
 * without spaces, so a space between two of whisper's tokens would land in the
 * caption; Korean and Latin scripts are written with them.
 */
export function wordSeparator(script: CaptionScript): string {
  return script === "zh" || script === "ja" ? "" : " ";
}

export interface GroupingDefaults {
  /** --max-words default for karaoke cues. */
  karaokeMaxWords: number;
  /** --max-chars default for karaoke cues. */
  karaokeMaxChars: number;
  /** --max-chars default when a script line outgrows one cue. */
  lineMaxChars: number;
}

/**
 * The defaults `caption` groups words with when the caller sets nothing. A
 * "word" whisper emits for Chinese or Japanese is a character or a short
 * token, so the Latin four-words-per-cue rule would cut a sentence into
 * fragments; there the character cap is the only bound, and it is the line
 * width the lint limits already hold captions to (16 zh, 13 ja, 16 ko).
 */
export function groupingDefaults(script: CaptionScript): GroupingDefaults {
  switch (script) {
    case "zh":
      return { karaokeMaxWords: Number.POSITIVE_INFINITY, karaokeMaxChars: 16, lineMaxChars: 16 };
    case "ja":
      return { karaokeMaxWords: Number.POSITIVE_INFINITY, karaokeMaxChars: 13, lineMaxChars: 13 };
    case "ko":
      return { karaokeMaxWords: 4, karaokeMaxChars: 16, lineMaxChars: 16 };
    default:
      return { karaokeMaxWords: 4, karaokeMaxChars: 28, lineMaxChars: 42 };
  }
}
