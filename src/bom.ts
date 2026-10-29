import { existsSync, readFileSync } from "node:fs";

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

/** Read UTF-8 subtitles without silently replacing malformed source bytes. */
export function readSubtitleText(path: string | number): string {
  const bytes = readFileSync(path);
  try {
    return stripBom(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    const source = typeof path === "number" ? "stdin" : path;
    throw new Error(`Subtitle input is not valid UTF-8: ${source}. Convert the file to UTF-8 before importing it.`);
  }
}
