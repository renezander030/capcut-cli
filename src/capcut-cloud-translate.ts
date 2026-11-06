/**
 * Experimental, unofficial client for ByteDance CapCut's cloud subtitle
 * translation (`translate --cloud` and `caption --translate <lang>`). These are
 * CapCut's private endpoints as its desktop app calls them, not a published
 * API: ByteDance can change or refuse them at any time.
 */
import { randomUUID } from "node:crypto";
import { CAPCUT_EDITOR_HOST, capcutEditorHeaders, postEditorApi, requireRetOk } from "./capcut-cloud-headers.js";
import type { CaptionCue, CaptionWord } from "./caption.js";

/** The captured headers this client replays; the shared identity is in capcut-cloud-headers.ts. */
export const DEFAULT_CAPCUT_TRANSLATE_HEADERS: Record<string, string> = capcutEditorHeaders({
  appVersion: "8.5.0",
  time: "1776996536",
  sign: "279639a654a9a0928d629f54e79fd626",
  stub: "52ac308361babf4705e2f350bd2f7506",
  traceId: "00-bd3f507b106864a86c4b8b860105ffff-bd3f507b106864a801",
});

/**
 * Supported language mappings: friendly names / aliases to CapCut canonical codes.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  // English
  english: "en",
  en: "en",
  // Vietnamese
  vietnamese: "vi",
  tieng_viet: "vi",
  tiengviet: "vi",
  vi: "vi",
  // Spanish
  spanish: "es",
  espanol: "es",
  es: "es",
  // French
  french: "fr",
  francais: "fr",
  fr: "fr",
  // German
  german: "de",
  deutsch: "de",
  de: "de",
  // Chinese (Simplified & Traditional)
  chinese: "zh-CN",
  "simplified chinese": "zh-CN",
  "simplified-chinese": "zh-CN",
  "chinese simplified": "zh-CN",
  "zh-cn": "zh-CN",
  "zh-hans": "zh-CN",
  zh: "zh-CN",
  "traditional chinese": "zh-TW",
  "traditional-chinese": "zh-TW",
  "chinese traditional": "zh-TW",
  "zh-tw": "zh-TW",
  "zh-hant": "zh-TW",
  // Japanese
  japanese: "ja",
  nihongo: "ja",
  ja: "ja",
  // Korean
  korean: "ko",
  hangul: "ko",
  ko: "ko",
  // Portuguese
  portuguese: "pt",
  portugues: "pt",
  pt: "pt",
  "pt-br": "pt",
  "pt-pt": "pt",
  // Russian
  russian: "ru",
  ru: "ru",
  // Indonesian
  indonesian: "id",
  bahasa: "id",
  id: "id",
  // Thai
  thai: "th",
  th: "th",
  // Italian
  italian: "it",
  italiano: "it",
  it: "it",
  // Arabic
  arabic: "ar-SA",
  ar: "ar-SA",
  "ar-sa": "ar-SA",
  // Turkish
  turkish: "tr",
  tr: "tr",
  // Dutch
  dutch: "nl",
  nederlands: "nl",
  nl: "nl",
  // Polish
  polish: "pl",
  polski: "pl",
  pl: "pl",
  // Malay
  malay: "ms",
  ms: "ms",
  // Hindi
  hindi: "hi",
  hi: "hi",
};

/**
 * Normalizes user-supplied language string into CapCut's canonical language code,
 * in any letter case. Every alias is written in lower case and every canonical
 * code is also an alias of itself, so one lookup of the lower-cased input finds
 * it; anything else passes through trimmed.
 */
export function normalizeLanguageCode(lang: string): string {
  const clean = lang.trim().toLowerCase();
  if (LANGUAGE_ALIASES[clean]) {
    return LANGUAGE_ALIASES[clean];
  }
  return lang.trim();
}

export interface CloudTranslateUtterance {
  start_time: number; // ms
  end_time: number; // ms
  text: string;
}

export interface CloudTranslateWord {
  text: string;
  start_time: number; // ms
  end_time: number; // ms
}

export interface CloudTranslateItem {
  start_time: number;
  end_time: number;
  text: string;
  translation_text: string;
  translation_words?: CloudTranslateWord[];
  /** The service sent no translation for this line, so translation_text is the original text. */
  kept_original?: boolean;
}

export interface CloudTranslateOptions {
  from?: string; // source language code or name, default auto-detect ("UNSPECIFIED")
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  chunkSize?: number;
}

/** One translated line as the service sends it; every field may be missing. */
interface CloudTranslatedLine {
  text?: string;
  start_time?: number;
  end_time?: number;
  translation_text?: string;
  translation_words?: Array<{
    text?: string;
    start_time?: number;
    end_time?: number;
  }>;
}

/** The data of a common_task/sync answer: the payload arrives as a JSON string or an object. */
interface CommonTaskSyncData {
  tasks?: Array<{
    id?: string;
    req_key?: string;
    status?: string;
    payload?: string | { translation?: Record<string, CloudTranslatedLine[]> };
  }>;
}

/** The step name a failed translation request carries ("CapCut Cloud Translation HTTP error: ..."). */
const STEP = "Cloud Translation";

/**
 * Translate a batch of utterances via ByteDance CapCut cloud translation.
 */
export async function translateUtterancesCapcutCloud(
  utterances: CloudTranslateUtterance[],
  targetLang: string,
  opts?: CloudTranslateOptions,
): Promise<CloudTranslateItem[]> {
  if (utterances.length === 0) return [];

  const targetCode = normalizeLanguageCode(targetLang);
  const sourceCode = opts?.from && opts.from !== "auto" ? normalizeLanguageCode(opts.from) : "UNSPECIFIED";
  const chunkSize = opts?.chunkSize ?? 50;
  const timing = { requestTimeoutMs: opts?.requestTimeoutMs ?? 60_000, retryDelayMs: opts?.retryDelayMs ?? 1500 };
  const url = `https://${CAPCUT_EDITOR_HOST}/lv/v1/common_task/sync`;

  const allResults: CloudTranslateItem[] = [];

  for (let i = 0; i < utterances.length; i += chunkSize) {
    const chunk = utterances.slice(i, i + chunkSize);
    const bodyObj = {
      bind_id: randomUUID(),
      enter_from: "asr",
      tasks: [
        {
          payload: {
            source_language: sourceCode,
            target_languages: [targetCode],
            utterances: chunk.map((u) => ({
              start_time: Math.round(u.start_time),
              end_time: Math.round(u.end_time),
              text: u.text,
            })),
          },
          req_key: "cc_audio_subtitle_translate",
        },
      ],
    };

    // The translation is safe to repeat: a lost answer is asked for again.
    const reply = await postEditorApi<CommonTaskSyncData>(
      url,
      DEFAULT_CAPCUT_TRANSLATE_HEADERS,
      JSON.stringify(bodyObj),
      STEP,
      timing,
      true,
    );

    if (String(reply.ret) === "1014") {
      throw new Error(
        "CapCut Cloud Translation returned error 1014 (System Busy / Security Token). Try again later or use Anthropic translation.",
      );
    }
    requireRetOk(reply, STEP);

    const task = reply.data?.tasks?.[0];
    if (!task) {
      throw new Error("CapCut Cloud Translation: empty task response from server.");
    }

    let payload = task.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch (e) {
        throw new Error(`CapCut Cloud Translation: failed to parse payload JSON: ${(e as Error).message}`);
      }
    }

    const translationMap = (payload as { translation?: Record<string, CloudTranslatedLine[]> } | undefined)
      ?.translation;
    const targetItems = translationMap?.[targetCode];

    if (!Array.isArray(targetItems)) {
      throw new Error(
        `CapCut Cloud Translation: language "${targetLang}" (${targetCode}) was not recognized or returned no translations.`,
      );
    }

    // Translations pair with the lines sent by position, so a reply with more
    // or fewer lines would put text on the wrong timings: refuse it.
    if (targetItems.length !== chunk.length) {
      throw new Error(
        `CapCut Cloud Translation returned ${targetItems.length} line(s) for the ${chunk.length} sent; nothing was translated. Try again, or translate without --cloud.`,
      );
    }

    for (let j = 0; j < chunk.length; j++) {
      const original = chunk[j];
      const item: CloudTranslatedLine | undefined = targetItems[j];

      const translated = item?.translation_text?.trim() ? item.translation_text : undefined;
      const transWords: CloudTranslateWord[] | undefined = Array.isArray(item?.translation_words)
        ? item.translation_words
            .filter((w) => Boolean(w?.text?.trim()))
            .map((w) => ({
              text: (w.text || "").trim(),
              start_time: Math.round(w.start_time ?? original.start_time),
              end_time: Math.round(w.end_time ?? original.end_time),
            }))
        : undefined;

      allResults.push({
        start_time: original.start_time,
        end_time: original.end_time,
        text: original.text,
        translation_text: translated ?? original.text,
        translation_words: translated && transWords && transWords.length > 0 ? transWords : undefined,
        ...(translated ? {} : { kept_original: true }),
      });
    }
  }

  return allResults;
}

/**
 * Translate caption cues via CapCut Cloud Translation, updating cue text and
 * word-level karaoke timestamps in microseconds. A cue the service sent no
 * translation for keeps its text and its words, and is counted in kept_original.
 */
export async function translateCuesCapcutCloud(
  cues: CaptionCue[],
  targetLang: string,
  opts?: CloudTranslateOptions,
): Promise<{ cues: CaptionCue[]; kept_original: number }> {
  if (cues.length === 0) return { cues: [], kept_original: 0 };

  const utterances: CloudTranslateUtterance[] = cues.map((cue) => ({
    start_time: Math.round(cue.startUs / 1000),
    end_time: Math.round(cue.endUs / 1000),
    text: cue.text,
  }));

  const items = await translateUtterancesCapcutCloud(utterances, targetLang, opts);

  const translated = cues.map((cue, idx) => {
    const item = items[idx];
    if (item.kept_original) return cue;
    const transWords: CaptionWord[] | undefined = item.translation_words?.map((w) => ({
      word: w.text,
      startUs: Math.round(w.start_time * 1000),
      endUs: Math.round(w.end_time * 1000),
    }));

    return {
      startUs: cue.startUs,
      endUs: cue.endUs,
      text: item.translation_text,
      words: transWords && transWords.length > 0 ? transWords : undefined,
    };
  });
  return { cues: translated, kept_original: items.filter((item) => item.kept_original).length };
}
