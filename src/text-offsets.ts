// --- Where styles[].range offsets live ---
//
// A text material's `content` is a JSON string:
//   { text: "...", styles: [{ range: [start, end], size, bold, fill: {...} }, ...] }
//
// CapCut stores `range` in UTF-16 CODE UNITS — plain JS string indices. Until
// v0.19.1 this CLI believed they were UTF-16LE *bytes* and wrote every offset
// doubled (#85). One full-span range survived that, because `[0, 2n]` clamps
// back to the end of the text when the app opens the draft, which is why
// ordinary `add-text` looked right and the premise went unchallenged. A
// multi-range highlight did not: on a 17 code-unit string the emphasised span
// was written at `[22, 34]`, entirely past the end, so `text-ranges`,
// `caption --karaoke`, `--highlight-words` and any preset carrying
// `text_ranges` painted nothing.
//
// The evidence is a scan of 38 app-authored drafts on one machine (#85):
// across CapCut International 7.9.0 and 8.9.1, 211 text materials stored code
// units and none stored bytes. CLI-written drafts read back as code units once
// the app had re-saved them — the app parsing the doubled values, clamping
// them, and writing its own interpretation back.
//
// Every read and write of a stored offset goes through this module. The
// mapping is the identity today; it exists so that the day a JianYing
// (`app_source: "lv"`) draft turns out to store something else, there is one
// place to branch instead of eight.

/** JS string code-unit index -> the offset CapCut stores. */
export function toStoredOffset(text: string, codeUnitIdx: number): number {
  // Clamped for the same reason the app clamps: a range may not point past
  // the text it styles.
  return Math.max(0, Math.min(codeUnitIdx, text.length));
}

/** Stored offset -> JS string code-unit index. */
export function fromStoredOffset(text: string, storedOffset: number): number {
  return Math.max(0, Math.min(storedOffset, text.length));
}

/** The stored offset one past the last character — a full-span range's end. */
export function storedTextLength(text: string): number {
  return text.length;
}

/**
 * True when every stored range is the pre-0.19.1 doubled form.
 *
 * Deliberately narrow, because this is what licenses an automatic repair. The
 * decisive signal is `max(end) === 2 * text.length`: for any non-empty text
 * that offset is past the end as code units, so the draft cannot be a valid
 * code-unit draft, and it is exactly where the old writer's trailing block
 * landed. Every offset must also be even — the doubling writer could not emit
 * an odd one — and inside `[0, 2n]`. An app-authored draft ends at `n` and a
 * repaired one ends at `n`, so neither is ever touched twice.
 */
export function rangesLookDoubled(text: string, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  const n = text.length;
  if (n === 0 || ranges.length === 0) return false;
  let maxEnd = 0;
  for (const [start, end] of ranges) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start % 2 !== 0 || end % 2 !== 0) return false;
    if (start < 0 || end < start || end > n * 2) return false;
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd === n * 2;
}

/**
 * Halve doubled ranges back to code units. Returns null when the ranges are
 * already code units, so callers can tell "repaired" from "nothing to do".
 */
export function repairDoubledRanges(
  text: string,
  ranges: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> | null {
  if (!rangesLookDoubled(text, ranges)) return null;
  return ranges.map(([start, end]) => [start / 2, end / 2] as [number, number]);
}
