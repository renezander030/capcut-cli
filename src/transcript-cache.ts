import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeTemp } from "./atomic-write.js";
import type { CaptionCue, CaptionWord } from "./caption.js";

/**
 * Transcript cache for `caption`.
 *
 * Transcribing is the slow (and, with --cloud, the uploading) step of a
 * caption run; everything after it — --script matching, grouping, styling,
 * --translate — is cheap and deterministic. So the raw transcription is kept,
 * keyed by the exact audio bytes that were transcribed plus every setting that
 * changes what the engine returns, and a run that only changes the styling
 * reads it back instead of transcribing again.
 *
 * One JSON file per key under `transcriptCacheDir()`, written with the same
 * temp + fsync + rename as a draft save. An entry that cannot be read, does
 * not parse, or does not match its key is a miss and is rewritten.
 */

/** Bump when the stored shape, or what a stored transcription means, changes. */
export const TRANSCRIPT_CACHE_VERSION = 1;
export const TRANSCRIPT_CACHE_ENV = "CAPCUT_CLI_CACHE_DIR";

export type TranscriptCacheState = "hit" | "miss" | "off";

/** Everything that decides what a transcription returns. */
export interface TranscriptCacheKey {
  version: number;
  /** sha256 of the audio bytes handed to the engine (after any stream extraction). */
  audio_sha256: string;
  engine: string;
  whisper_cmd: string | null;
  model: string | null;
  language: string | null;
  /** "words": word-timestamp JSON (--karaoke / --word-reveal, --cloud); "lines": SRT cues. */
  word_timing: "words" | "lines";
  cloud: boolean;
}

export interface CachedTranscription {
  engine: string;
  cues: CaptionCue[];
  words: CaptionWord[];
}

interface CacheEntry {
  key: TranscriptCacheKey;
  transcription: CachedTranscription;
}

/**
 * Where entries live: CAPCUT_CLI_CACHE_DIR, else $XDG_CACHE_HOME/capcut-cli/transcripts,
 * else ~/.cache/capcut-cli/transcripts (%LOCALAPPDATA%\capcut-cli\cache\transcripts on
 * Windows, where HOME is usually unset).
 */
export function transcriptCacheDir(): string {
  const override = process.env[TRANSCRIPT_CACHE_ENV];
  if (override) return resolve(override);
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return join(xdg, "capcut-cli", "transcripts");
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? homedir(), "AppData/Local");
    return join(local, "capcut-cli", "cache", "transcripts");
  }
  return join(homedir(), ".cache", "capcut-cli", "transcripts");
}

/** sha256 of a file, read in chunks so long recordings are not held in memory. */
export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function transcriptCachePath(key: TranscriptCacheKey, dir = transcriptCacheDir()): string {
  return join(dir, `${createHash("sha256").update(JSON.stringify(key)).digest("hex")}.json`);
}

function isWord(value: unknown): value is CaptionWord {
  const word = value as CaptionWord | null;
  return (
    typeof word === "object" &&
    word !== null &&
    typeof word.word === "string" &&
    Number.isFinite(word.startUs) &&
    Number.isFinite(word.endUs)
  );
}

function isCue(value: unknown): value is CaptionCue {
  const cue = value as CaptionCue | null;
  return (
    typeof cue === "object" &&
    cue !== null &&
    typeof cue.text === "string" &&
    Number.isFinite(cue.startUs) &&
    Number.isFinite(cue.endUs) &&
    (cue.words === undefined || (Array.isArray(cue.words) && cue.words.every(isWord)))
  );
}

/** The stored transcription for `key`, or undefined when there is no usable entry. */
export function readTranscriptCache(key: TranscriptCacheKey): CachedTranscription | undefined {
  let entry: Partial<CacheEntry>;
  try {
    entry = JSON.parse(readFileSync(transcriptCachePath(key), "utf-8")) as Partial<CacheEntry>;
  } catch {
    return undefined;
  }
  const transcription = entry?.transcription;
  if (
    JSON.stringify(entry?.key) !== JSON.stringify(key) ||
    typeof transcription !== "object" ||
    transcription === null ||
    transcription.engine !== key.engine ||
    !Array.isArray(transcription.cues) ||
    !transcription.cues.every(isCue) ||
    !Array.isArray(transcription.words) ||
    !transcription.words.every(isWord)
  ) {
    return undefined;
  }
  return { engine: transcription.engine, cues: transcription.cues, words: transcription.words };
}

/**
 * Store a transcription under `key`, atomically. Best effort: a cache that
 * cannot be written never fails the caption run that produced the result.
 */
export function writeTranscriptCache(key: TranscriptCacheKey, transcription: CachedTranscription): void {
  const target = transcriptCachePath(key);
  const entry: CacheEntry = {
    key,
    transcription: { engine: transcription.engine, cues: transcription.cues, words: transcription.words },
  };
  let temp: string | undefined;
  try {
    mkdirSync(dirname(target), { recursive: true });
    temp = writeTemp(target, JSON.stringify(entry));
    renameSync(temp, target);
  } catch {
    if (temp) {
      try {
        unlinkSync(temp);
      } catch {
        /* ignore */
      }
    }
  }
}
