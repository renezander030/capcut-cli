import type { Draft } from "./draft.js";
import { atLeast } from "./version.js";

/**
 * Where mask materials live. Three array variants exist on disk: `masks`
 * (legacy JianYing 5.9 era), `common_mask` (the struct this CLI writes,
 * verified against CapCut) and `common_masks` (JianYing 9.6+ — masks left in
 * the legacy array silently no-op there, pyJianYingDraft#160).
 */
export type MaskFieldName = "masks" | "common_mask" | "common_masks";

/** The variants in on-disk era order, oldest first (report and listing order). */
export const MASK_FIELD_NAMES: readonly MaskFieldName[] = ["masks", "common_mask", "common_masks"];

// Priority newest-first: when consistency-following has to pick between
// multiple populated variants, prefer the newest-era array.
export const MASK_FIELDS: readonly MaskFieldName[] = ["common_masks", "common_mask", "masks"];

export function maskEntries(draft: Draft, field: MaskFieldName): Array<Record<string, unknown>> {
  const arr = (draft.materials as Record<string, unknown>)[field];
  return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
}

/** The variants holding at least one entry, in on-disk era order. */
export function populatedMaskFields(draft: Draft): MaskFieldName[] {
  return MASK_FIELD_NAMES.filter((field) => maskEntries(draft, field).length > 0);
}

/** The one array a JianYing build reads masks from: 9.6 renamed masks[] -> common_masks[]. */
export function jianyingMaskField(version: string): "common_masks" | "masks" {
  return atLeast(version, "9.6") ? "common_masks" : "masks";
}
