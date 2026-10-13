import type { Draft, Segment, Track } from "./draft.js";
import { findSegment } from "./draft.js";

/**
 * The segment an editing operation targets, by exact id or case-insensitive id
 * prefix (first match in track order), or the library's standard
 * `Segment not found: <id>` error.
 */
export function requireSegment(draft: Draft, id: string): { track: Track; segment: Segment; index: number } {
  const found = findSegment(draft, id);
  if (!found) throw new Error(`Segment not found: ${id}`);
  return found;
}
