/**
 * Experimental, unofficial client for ByteDance CapCut's cloud subtitle
 * translation (`translate --cloud` and `caption --translate <lang>`). These are
 * CapCut's private endpoints as its desktop app calls them, not a published
 * API: ByteDance can change or refuse them at any time.
 */
import { randomUUID } from "node:crypto";
import type { CaptionCue, CaptionWord } from "./caption.js";

/**
 * Standard HTTP headers accepted by ByteDance CapCut's sync task endpoint.
 */
export const DEFAULT_CAPCUT_TRANSLATE_HEADERS: Record<string, string> = {
  Host: "editor-api-sg.capcutapi.com",
  "App-Sdk-Version": "8.5.0",
  "Content-Type": "application/json",
  appID: "359289",
  appvr: "8.5.0",
  ch: "capcutpc_web_product",
  "device-time": "1776996536",
  lan: "en",
  loc: "VN",
  pf: "4",
  sign: "279639a654a9a0928d629f54e79fd626",
  "sign-ver": "1",
  tdid: "7522322460692940289",
  "x-ss-stub": "52ac308361babf4705e2f350bd2f7506",
  "X-SS-DP": "359289",
  "x-tt-trace-id": "00-bd3f507b106864a86c4b8b860105ffff-bd3f507b106864a801",
  "User-Agent": "Cronet/TTNetVersion:488a55ee 2025-07-10 QuicVersion:55af8b7a 2024-11-18",
  "x-khronos": "1776996536",
};

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
 * Normalizes user-supplied language string into CapCut's canonical language code.
 */
export function normalizeLanguageCode(lang: string): string {
  const clean = lang.trim().toLowerCase();
  if (LANGUAGE_ALIASES[clean]) {
    return LANGUAGE_ALIASES[clean];
  }
  // Try case-insensitive lookup
  for (const [k, v] of Object.entries(LANGUAGE_ALIASES)) {
    if (k.toLowerCase() === clean || v.toLowerCase() === clean) {
      return v;
    }
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
}

export interface CloudTranslateOptions {
  from?: string; // source language code or name, default auto-detect ("UNSPECIFIED")
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  chunkSize?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRY_ATTEMPTS = 3;

/**
 * Send POST request to CapCut editor API with retry and timeout.
 */
async function sendTranslateRequest(
  url: string,
  body: string,
  timeoutMs: number,
  retryDelayMs: number,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: DEFAULT_CAPCUT_TRANSLATE_HEADERS,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) return res;

      if ((res.status === 429 || res.status >= 500) && attempt < RETRY_ATTEMPTS) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      return res;
    } catch (e) {
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      const err = e as Error;
      throw new Error(
        err.name === "TimeoutError"
          ? `CapCut Cloud Translation request timed out after ${Math.round(timeoutMs / 1000)} s (${RETRY_ATTEMPTS} tries).`
          : `CapCut Cloud Translation request failed: ${err.message}`,
      );
    }
  }
}

interface CommonTaskSyncResponse {
  ret: string | number;
  errmsg: string;
  data?: {
    tasks?: Array<{
      id?: string;
      req_key?: string;
      status?: string;
      payload?:
        | string
        | {
            translation?: Record<
              string,
              Array<{
                text?: string;
                start_time?: number;
                end_time?: number;
                translation_text?: string;
                translation_words?: Array<{
                  text?: string;
                  start_time?: number;
                  end_time?: number;
                }>;
              }>
            >;
          };
    }>;
  };
}

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
  const timeoutMs = opts?.requestTimeoutMs ?? 60_000;
  const retryDelayMs = opts?.retryDelayMs ?? 1500;
  const url = "https://editor-api-sg.capcutapi.com/lv/v1/common_task/sync";

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

    const res = await sendTranslateRequest(url, JSON.stringify(bodyObj), timeoutMs, retryDelayMs);
    if (!res.ok) {
      throw new Error(`CapCut Cloud Translation HTTP error: ${res.status} ${res.statusText}`);
    }

    const reply = (await res.json()) as CommonTaskSyncResponse;

    if (String(reply.ret) === "1014") {
      throw new Error(
        "CapCut Cloud Translation returned error 1014 (System Busy / Security Token). Try again later or use Anthropic translation.",
      );
    }

    if (String(reply.ret) !== "0") {
      throw new Error(`CapCut Cloud Translation failed [ret=${reply.ret}]: ${reply.errmsg || "Unknown error"}`);
    }

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

    const translationMap = (payload as { translation?: Record<string, unknown[]> })?.translation;
    const targetItems = translationMap?.[targetCode];

    if (!Array.isArray(targetItems)) {
      throw new Error(
        `CapCut Cloud Translation: language "${targetLang}" (${targetCode}) was not recognized or returned no translations.`,
      );
    }

    for (let j = 0; j < chunk.length; j++) {
      const original = chunk[j];
      const item = targetItems[j] as
        | {
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
        | undefined;

      const transText = item?.translation_text ?? original.text;
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
        translation_text: transText,
        translation_words: transWords && transWords.length > 0 ? transWords : undefined,
      });
    }
  }

  return allResults;
}

/**
 * Translate a list of text strings via CapCut Cloud Translation.
 * Preserves exact array length and ordering.
 */
export async function translateTextsCapcutCloud(
  texts: string[],
  targetLang: string,
  opts?: CloudTranslateOptions,
): Promise<string[]> {
  if (texts.length === 0) return [];
  const utterances: CloudTranslateUtterance[] = texts.map((t) => ({
    start_time: 0,
    end_time: 0,
    text: t,
  }));
  const items = await translateUtterancesCapcutCloud(utterances, targetLang, opts);
  return items.map((item) => item.translation_text);
}

/**
 * Translate caption cues via CapCut Cloud Translation, updating cue text and
 * word-level karaoke timestamps in microseconds.
 */
export async function translateCuesCapcutCloud(
  cues: CaptionCue[],
  targetLang: string,
  opts?: CloudTranslateOptions,
): Promise<CaptionCue[]> {
  if (cues.length === 0) return [];

  const utterances: CloudTranslateUtterance[] = cues.map((cue) => ({
    start_time: Math.round(cue.startUs / 1000),
    end_time: Math.round(cue.endUs / 1000),
    text: cue.text,
  }));

  const items = await translateUtterancesCapcutCloud(utterances, targetLang, opts);

  return cues.map((cue, idx) => {
    const item = items[idx];
    const transText = item?.translation_text || cue.text;
    const transWords: CaptionWord[] | undefined = item?.translation_words
      ? item.translation_words.map((w) => ({
          word: w.text,
          startUs: Math.round(w.start_time * 1000),
          endUs: Math.round(w.end_time * 1000),
        }))
      : undefined;

    return {
      startUs: cue.startUs,
      endUs: cue.endUs,
      text: transText,
      words: transWords && transWords.length > 0 ? transWords : undefined,
    };
  });
}
