import type { Draft } from "./draft.js";

/**
 * The top-level markers that tell an app build which schema generation wrote a
 * draft. A draft built from the pre-0.23 bundled template carries only
 * `platform` (app_version 6.5.0, os mac) and none of the rest, which is what
 * CapCut 8.4 / 8.5 / 8.7 Windows / 9.3 refuse with "Current project is from an
 * unusual path" (#67, #111). Restamping copies exactly these from a project the
 * installed app wrote; nothing in `tracks` or `materials` is touched.
 */
export const RESTAMP_FIELDS = [
  "version",
  "new_version",
  "platform",
  "last_modified_platform",
  "color_space",
  "render_index_track_mode_on",
  "free_render_index_mode_on",
  "source",
] as const;

/** Settings copied only when the draft has none of its own (per-project user values stay). */
const RESTAMP_FILL_FIELDS = ["config"] as const;

export interface RestampResult {
  ok: true;
  donor: string;
  donor_app_version: string | null;
  /** Markers rewritten to the donor's value. */
  restamped: string[];
  /** Markers the draft lacked entirely and now carries. */
  added: string[];
  /** Markers already equal to the donor's. */
  unchanged: string[];
  /** Markers the donor does not carry either. */
  unavailable: string[];
}

/**
 * `migrate --like <project>` / `--from-store`: rewrite a draft's schema
 * markers from a donor draft the app itself wrote, so a draft an older
 * template stamped opens in the installed build without being recreated
 * (#111: "multiple drafts", each one a full re-compile otherwise).
 */
export function restampDraft(draft: Draft, donor: Draft, donorLabel: string): RestampResult {
  const target = draft as unknown as Record<string, unknown>;
  const source = donor as unknown as Record<string, unknown>;
  const restamped: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];
  const unavailable: string[] = [];
  for (const field of RESTAMP_FIELDS) {
    if (source[field] === undefined) {
      unavailable.push(field);
      continue;
    }
    const wanted = structuredClone(source[field]);
    if (target[field] === undefined) {
      target[field] = wanted;
      added.push(field);
    } else if (JSON.stringify(target[field]) !== JSON.stringify(wanted)) {
      target[field] = wanted;
      restamped.push(field);
    } else {
      unchanged.push(field);
    }
  }
  for (const field of RESTAMP_FILL_FIELDS) {
    if (source[field] !== undefined && target[field] === undefined) {
      target[field] = structuredClone(source[field]);
      added.push(field);
    }
  }
  return {
    ok: true,
    donor: donorLabel,
    donor_app_version: donor.platform?.app_version ?? null,
    restamped,
    added,
    unchanged,
    unavailable,
  };
}

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
