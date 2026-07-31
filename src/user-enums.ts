import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripBom } from "./bom.js";
import type { Draft } from "./draft.js";
import type { Category, EnumEntry } from "./enums.js";

/**
 * User enum catalogue (`harvest-enums`).
 *
 * The bundled enums.json only covers resource ids the CLI could already
 * write, and it drifts stale as the apps ship new store effects
 * (GuanYixuan/pyCapCut#12: newer effects missing entirely from ecosystem
 * tables). Instead of guessing at app internals, `harvest-enums` reads ids
 * out of drafts the app itself authored — fully evidence-based — into a
 * per-user catalogue file that the normal lookups then merge in:
 *
 * - every harvested effect_id/resource_id joins lint's known-id set, so
 *   app-authored effects stop self-flagging as unknown-effect-slug;
 * - entries from kinds that map cleanly onto an enums category (effects,
 *   filters, transitions, masks, audio effects) become writable slugs in
 *   findEnum/listEnum — point the CLI at a draft using "Snowfly" once, and
 *   `add-effect snowfly` works from then on;
 * - ambiguous kinds (animations — intro/outro/combo cannot be told apart
 *   from a draft; bubbles; nameless font ids) stay id-only: they inform
 *   lint but are never guessed into a writable category.
 *
 * The bundled table always wins on slug collisions (user entries are
 * appended after it). A hand-broken catalogue file never breaks lookups or
 * lint — it reads as empty and the error is surfaced by `harvest-enums`.
 */

export const USER_ENUMS_ENV = "CAPCUT_CLI_USER_ENUMS";

export type HarvestKind =
  | "video_effects"
  | "filters"
  | "transitions"
  | "masks"
  | "audio_effects"
  | "animations"
  | "bubbles"
  | "fonts";

export interface UserEnumEntry {
  kind: HarvestKind;
  slug: string; // "" = id-only (informs lint, not writable)
  name: string;
  effect_id?: string;
  resource_id?: string;
  resource_type?: string;
  harvested_from?: string;
  harvested_at?: string;
}

interface UserEnumsFile {
  version: 1;
  entries: UserEnumEntry[];
}

/** Kinds that map cleanly onto a bundled enums category (writable slugs). */
const KIND_TO_CATEGORY: Partial<Record<HarvestKind, Category>> = {
  video_effects: "scene_effects",
  filters: "filters",
  transitions: "transitions",
  masks: "masks",
  audio_effects: "audio_effects",
};

export function userEnumsPath(override?: string): string {
  if (override) return resolve(override);
  const env = process.env[USER_ENUMS_ENV];
  if (env) return resolve(env);
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "capcut-cli", "user-enums.json");
}

interface CacheEntry {
  mtimeMs: number;
  entries: UserEnumEntry[];
  error: string | null;
}

const cache = new Map<string, CacheEntry>();

export function clearUserEnumsCache(): void {
  cache.clear();
}

export function loadUserEnums(path: string = userEnumsPath()): { entries: UserEnumEntry[]; error: string | null } {
  if (!existsSync(path)) return { entries: [], error: null };
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { entries: [], error: null };
  }
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return { entries: cached.entries, error: cached.error };
  let entries: UserEnumEntry[] = [];
  let error: string | null = null;
  try {
    const parsed = JSON.parse(stripBom(readFileSync(path, "utf-8"))) as Partial<UserEnumsFile>;
    if (Array.isArray(parsed.entries)) {
      entries = parsed.entries.filter(
        (entry): entry is UserEnumEntry =>
          Boolean(entry) && typeof entry === "object" && typeof (entry as UserEnumEntry).kind === "string",
      );
    } else {
      error = "user enum catalogue has no entries[] array";
    }
  } catch (parseError) {
    error = `user enum catalogue did not parse: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
  }
  cache.set(path, { mtimeMs, entries, error });
  return { entries, error };
}

/** User entries that belong to a bundled category, as findEnum-compatible
 * EnumEntry objects. Only slug-carrying entries are returned — id-only
 * entries inform lint via allUserEnumIds(), never slug lookup. */
export function userEntriesForCategory(category: Category, path?: string): EnumEntry[] {
  const { entries } = loadUserEnums(path ?? userEnumsPath());
  const result: EnumEntry[] = [];
  for (const entry of entries) {
    if (KIND_TO_CATEGORY[entry.kind] !== category || entry.slug === "") continue;
    result.push({
      member: entry.name || entry.slug,
      slug: entry.slug,
      name: entry.name,
      effect_id: entry.effect_id,
      resource_id: entry.resource_id,
      resource_type: entry.resource_type,
    });
  }
  return result;
}

/** Every effect_id/resource_id in the user catalogue — lint's known-id feed. */
export function allUserEnumIds(path?: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of loadUserEnums(path ?? userEnumsPath()).entries) {
    if (entry.effect_id) ids.add(entry.effect_id);
    if (entry.resource_id) ids.add(entry.resource_id);
  }
  return ids;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface HarvestResult {
  found: number;
  known: number;
  candidates: UserEnumEntry[];
}

interface RawMaterial {
  id?: string;
  name?: string;
  type?: string;
  effect_id?: string;
  resource_id?: string;
  resource_type?: string;
}

/**
 * Scan a draft's effect-shaped material arrays for ids the known-id set does
 * not cover. Candidates keep the draft's own name/ids verbatim; kinds without
 * a safe category mapping come back slug-less (id-only).
 */
export function harvestDraft(draft: Draft, knownIds: Set<string>): HarvestResult {
  const candidates: UserEnumEntry[] = [];
  const seen = new Set<string>();
  let found = 0;
  let known = 0;

  const consider = (kind: HarvestKind, raw: RawMaterial, options: { slugless?: boolean } = {}): void => {
    const effectId = typeof raw.effect_id === "string" ? raw.effect_id : "";
    const resourceId = typeof raw.resource_id === "string" ? raw.resource_id : "";
    if (!effectId && !resourceId) return;
    found++;
    if (knownIds.has(effectId) || knownIds.has(resourceId)) {
      known++;
      return;
    }
    const dedupeKey = `${effectId}|${resourceId}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const name = typeof raw.name === "string" ? raw.name : "";
    candidates.push({
      kind,
      slug: options.slugless || name === "" ? "" : slugify(name),
      name,
      ...(effectId ? { effect_id: effectId } : {}),
      ...(resourceId ? { resource_id: resourceId } : {}),
      ...(typeof raw.resource_type === "string" && raw.resource_type !== ""
        ? { resource_type: raw.resource_type }
        : {}),
      harvested_from: draft.name || draft.id,
    });
  };

  const materials = draft.materials as Record<string, unknown>;
  const arrayOf = (key: string): RawMaterial[] =>
    Array.isArray(materials[key]) ? (materials[key] as RawMaterial[]) : [];

  for (const raw of arrayOf("video_effects")) consider("video_effects", raw);
  for (const raw of arrayOf("transitions")) consider("transitions", raw);
  for (const raw of arrayOf("audio_effects")) consider("audio_effects", raw);
  for (const key of ["masks", "common_mask", "common_masks"]) {
    for (const raw of arrayOf(key)) consider("masks", raw);
  }
  // materials.filters holds colour filters AND text-shape bubbles; only real
  // filters may become writable filter slugs — a bubble resolving as a
  // filter would write the wrong material shape.
  for (const raw of arrayOf("filters")) {
    if (raw.type === "text_shape") consider("bubbles", raw, { slugless: true });
    else consider("filters", raw);
  }
  // Animations: intro/outro/combo and image/text cannot be told apart from a
  // draft, so these are id-only — they inform lint, never a writable slug.
  for (const raw of arrayOf("material_animations")) {
    const container = raw as { id?: string; animations?: RawMaterial[] };
    for (const anim of container.animations ?? []) {
      consider("animations", { ...anim, effect_id: anim.effect_id ?? anim.id }, { slugless: true });
    }
  }
  // Font ids referenced by text materials (unknown-font-id feed). Nameless.
  for (const raw of arrayOf("texts")) {
    const m = raw as { font_id?: string; font_resource_id?: string };
    if (typeof m.font_id === "string" && m.font_id !== "") {
      consider("fonts", { name: "", resource_id: m.font_id }, { slugless: true });
    }
    if (typeof m.font_resource_id === "string" && m.font_resource_id !== "") {
      consider("fonts", { name: "", resource_id: m.font_resource_id }, { slugless: true });
    }
  }

  return { found, known, candidates };
}

function writeAtomicLocal(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.capcut-cli-${process.pid}-${Date.now()}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, content, undefined, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/** Merge candidates into the catalogue file (created if absent). Existing
 * entries win: a candidate whose id pair is already present is a duplicate. */
export function mergeUserEnums(
  path: string,
  candidates: UserEnumEntry[],
): { added: number; duplicates: number; total: number } {
  const { entries } = loadUserEnums(path);
  const existing = new Set(entries.map((entry) => `${entry.effect_id ?? ""}|${entry.resource_id ?? ""}`));
  const merged = [...entries];
  let added = 0;
  let duplicates = 0;
  const stamp = new Date().toISOString();
  for (const candidate of candidates) {
    const key = `${candidate.effect_id ?? ""}|${candidate.resource_id ?? ""}`;
    if (existing.has(key)) {
      duplicates++;
      continue;
    }
    existing.add(key);
    merged.push({ ...candidate, harvested_at: stamp });
    added++;
  }
  if (added > 0) {
    const file: UserEnumsFile = { version: 1, entries: merged };
    writeAtomicLocal(path, `${JSON.stringify(file, null, 2)}\n`);
    clearUserEnumsCache();
  }
  return { added, duplicates, total: merged.length };
}
