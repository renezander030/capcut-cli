import { existsSync, readFileSync } from "node:fs";
import { parseSubtitles, type SrtCue } from "./srt.js";

/**
 * Lenient text reads: strip a leading UTF-8 BOM (U+FEFF). Windows PowerShell's
 * `Set-Content` (and some editors) prepend one to text files; `JSON.parse`
 * rejects it and the SRT/ASS/JSONL parsers would misread the first token.
 * Applied at every user-supplied text/JSON read path (draft files, presets,
 * @file arguments, stdin, subtitle files, compile specs, config). Writes never
 * emit a BOM, so saving a BOM'd file through the CLI drops it.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** A text file BOM-stripped, or null when it does not exist; other read errors propagate. */
export function readTextIfPresent(path: string): string | null {
  return existsSync(path) ? stripBom(readFileSync(path, "utf-8")) : null;
}

/** `raw` parsed as JSON when it is a plain object; null for an array, a scalar or a parse error. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A JSON metadata file as BOM-stripped text (`raw`, null when the file is
 * absent) and as a plain object (`obj`, null when absent or not an object).
 * Callers tell "missing" from "corrupt" by which of the two is null; read
 * errors other than absence propagate.
 */
export function readJsonObjectFile(path: string): { raw: string | null; obj: Record<string, unknown> | null } {
  const raw = readTextIfPresent(path);
  return { raw, obj: raw === null ? null : parseJsonObject(raw) };
}

/** Honor UTF BOMs or an explicitly selected encoding; never guess a legacy code page. */
export function readSubtitleText(path: string | number, encoding?: string): string {
  const bytes = readFileSync(path);
  const source = typeof path === "number" ? "stdin" : path;
  const detected =
    encoding ??
    (bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8");
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(detected, { fatal: true });
  } catch {
    throw new Error(`Unsupported subtitle encoding: ${detected}. Use a TextDecoder encoding such as windows-1252.`);
  }
  let text: string;
  try {
    text = stripBom(decoder.decode(bytes));
  } catch {
    throw new Error(
      `Subtitle input is not valid ${decoder.encoding.toUpperCase()}: ${source}. Convert the file to UTF-8 before importing it, or select its encoding with --encoding.`,
    );
  }
  if (text.includes("\0"))
    throw new Error(
      `Subtitle input contains NUL characters: ${source}. Select the file's encoding with --encoding or convert it to UTF-8.`,
    );
  return text;
}

/** The shared strict decoder and SRT/WebVTT parser, for files and stdin (fd 0). */
export function readSubtitleCues(path: string | number, encoding?: string): SrtCue[] {
  return parseSubtitles(readSubtitleText(path, encoding), true);
}
