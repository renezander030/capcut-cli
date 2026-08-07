import type { Draft } from "./draft.js";

export interface MigrationResult {
  ok: boolean;
  from: string;
  to: string;
  applied: string[];
  skipped: string[];
  warnings: string[];
}

/**
 * Migrate a draft's schema across known version jumps.
 *
 * Currently implements:
 *   - mask -> common_masks (JianYing 5.9 -> 9.6+, CapCut older -> newer),
 *     also consolidating the CapCut-variant `common_mask[]` into the target —
 *     the destination app reads exactly one mask array, so entries left in a
 *     sibling variant would silently not appear (pyJianYingDraft#160).
 *
 * Migrations are best-effort: if a field doesn't apply (e.g. no masks present),
 * we record it as skipped rather than failing. The draft is mutated in place.
 */
export function migrateDraft(draft: Draft, from: string, to: string): MigrationResult {
  const applied: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  const record = (label: string, sourceKey: string, moved: number): void => {
    if (moved > 0) applied.push(`${label} (${moved} entries)`);
    else skipped.push(`${label} (no \`${sourceKey}[]\` entries to migrate)`);
  };

  const knownJump = isJumpAcrossMaskRename(from, to);
  if (knownJump.direction === "legacy-to-new") {
    record("mask->common_masks", "masks", moveMaskEntries(draft, "masks", "common_masks"));
    record("common_mask->common_masks", "common_mask", moveMaskEntries(draft, "common_mask", "common_masks"));
  } else if (knownJump.direction === "new-to-legacy") {
    record("common_masks->mask", "common_masks", moveMaskEntries(draft, "common_masks", "masks"));
    record("common_mask->mask", "common_mask", moveMaskEntries(draft, "common_mask", "masks"));
  } else if (knownJump.direction === "none") {
    warnings.push(
      `No registered migration for ${from} -> ${to}. Only known migration so far: mask <-> common_masks across JianYing 5.9 / CapCut 9.6 boundary.`,
    );
  }

  return { ok: true, from, to, applied, skipped, warnings };
}

function isJumpAcrossMaskRename(from: string, to: string): { direction: "legacy-to-new" | "new-to-legacy" | "none" } {
  const fromN = parseVer(from);
  const toN = parseVer(to);
  if (fromN === null || toN === null) return { direction: "none" };
  const boundary = 9.6;
  if (fromN < boundary && toN >= boundary) return { direction: "legacy-to-new" };
  if (fromN >= boundary && toN < boundary) return { direction: "new-to-legacy" };
  return { direction: "none" };
}

function parseVer(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)/.exec(s);
  return m ? parseFloat(m[1]) : null;
}

function moveMaskEntries(
  draft: Draft,
  fromKey: "masks" | "common_mask" | "common_masks",
  toKey: "masks" | "common_masks",
): number {
  const source = (draft.materials[fromKey] as Array<Record<string, unknown>> | undefined) ?? [];
  if (source.length === 0) return 0;
  if (!Array.isArray(draft.materials[toKey])) draft.materials[toKey] = [];
  const target = draft.materials[toKey] as Array<Record<string, unknown>>;
  const targetIds = new Set(target.map((m) => m.id as string));
  let moved = 0;
  for (const mat of source) {
    if (typeof mat.id === "string" && targetIds.has(mat.id)) continue;
    target.push(mat);
    moved++;
  }
  draft.materials[fromKey] = [];
  return moved;
}
