// `register --materials` — the draft_materials registration write.
//
// The symptom (GuanYixuan/pyCapCut#13, CapCut International 9.1.0 on macOS):
// the app decides which media has actually been IMPORTED from
// draft_meta_info.json's `draft_materials`, not from the timeline's material
// paths. A sidecar whose groups are all empty — every tool-built draft, this
// CLI's included — opens with each clip shown as "file inaccessible" and a
// relink prompt, even though every `path` in draft_content.json is valid and
// the files exist. v0.21 taught `lint` and `diagnose` to observe the empty
// state (`media-unregistered`); this module writes the registration.
//
// Entry shape and its provenance: pyCapCut PR #14 (gingatimo, 2026-08-18),
// which registers timeline media into the type-0 group after every save and
// was verified by its author against the 9.1.0 relink prompt. The app matches
// entries to timeline materials by `file_Path`; the remaining fields carry the
// defaults CapCut writes for a manual import (`import_time: -1`, `md5: ""`,
// `item_source: 1`). Photos register with a 5 s nominal duration, audio with
// `metetype: "music"` and zero dimensions — again the PR's tested values. No
// app-authored 9.1 sidecar is committed here yet; `capcut fixture` on one
// would let the shape be confirmed byte-for-byte, and the schema docs record
// the source so the next reader knows what is measured and what is inferred.
//
// Write discipline (register's): merge, never replace. Existing entries — the
// app's own, from a draft it imported media into — are preserved untouched;
// only media the sidecar does not register is appended, one entry per distinct
// path, into the type-0 group (created when absent). Re-running is a no-op.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { stripBom } from "./bom.js";
import { type Draft, writeAtomic } from "./draft.js";

export type MetaMaterialKind = "video" | "photo" | "music";

/** draft_materials[type=0].value[] entry — field order follows CapCut's own sidecar. */
export interface MetaMaterialEntry {
  ai_group_type: string;
  create_time: number;
  duration: number;
  enter_from: number;
  extra_info: string;
  file_Path: string;
  height: number;
  id: string;
  import_time: number;
  import_time_ms: number;
  item_source: number;
  material_color_tag: string;
  md5: string;
  metetype: MetaMaterialKind;
  roughcut_time_range: { duration: number; start: number };
  sub_time_range: { duration: number; start: number };
  type: number;
  width: number;
}

/** Nominal duration CapCut records for an imported still image (pyCapCut PR #14). */
export const PHOTO_META_DURATION_US = 5_000_000;

/** The group `type` that holds imported media in `draft_materials`. */
export const IMPORTED_MEDIA_GROUP_TYPE = 0;

export interface ReferencedMedium {
  path: string;
  name: string;
  kind: MetaMaterialKind;
  durationUs: number;
  width: number;
  height: number;
}

export function buildMetaMaterialEntry(medium: ReferencedMedium): MetaMaterialEntry {
  const duration = medium.durationUs > 0 ? Math.round(medium.durationUs) : PHOTO_META_DURATION_US;
  return {
    ai_group_type: "",
    create_time: -1,
    duration,
    enter_from: 0,
    extra_info: medium.name,
    file_Path: medium.path,
    height: medium.kind === "music" ? 0 : Math.round(medium.height || 0),
    id: randomUUID(),
    import_time: -1,
    import_time_ms: -1,
    item_source: 1,
    material_color_tag: "",
    md5: "",
    metetype: medium.kind,
    roughcut_time_range: { duration: -1, start: -1 },
    sub_time_range: { duration: -1, start: -1 },
    type: 0,
    width: medium.kind === "music" ? 0 : Math.round(medium.width || 0),
  };
}

function isLocalPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !/^https?:\/\//i.test(path);
}

/**
 * Distinct local media the timeline references, in material order: video and
 * photo materials from `materials.videos`, audio from `materials.audios`. URLs
 * (Wikimedia adds resolve to local copies anyway) are skipped, and one file
 * referenced by several materials is one medium to register.
 */
export function referencedMedia(draft: Draft): ReferencedMedium[] {
  const seen = new Set<string>();
  const out: ReferencedMedium[] = [];
  for (const mat of draft.materials.videos ?? []) {
    const m = mat as Record<string, unknown>;
    if (!isLocalPath(m.path) || seen.has(m.path)) continue;
    seen.add(m.path);
    const photo = m.type === "photo";
    out.push({
      path: m.path,
      name: typeof m.material_name === "string" && m.material_name !== "" ? m.material_name : basename(m.path),
      kind: photo ? "photo" : "video",
      durationUs: photo ? PHOTO_META_DURATION_US : typeof m.duration === "number" ? m.duration : 0,
      width: typeof m.width === "number" ? m.width : 0,
      height: typeof m.height === "number" ? m.height : 0,
    });
  }
  for (const mat of draft.materials.audios ?? []) {
    const m = mat as Record<string, unknown>;
    if (!isLocalPath(m.path) || seen.has(m.path)) continue;
    seen.add(m.path);
    out.push({
      path: m.path,
      name: typeof m.name === "string" && m.name !== "" ? m.name : basename(m.path),
      kind: "music",
      durationUs: typeof m.duration === "number" ? m.duration : 0,
      width: 0,
      height: 0,
    });
  }
  return out;
}

export interface MaterialsRegistrationTarget {
  file: "draft_meta_info.json";
  field: "draft_materials";
  path: string;
  state: "ok" | "no-media" | "unregistered" | "sidecar-unavailable";
  action: "none" | "update" | "blocked";
  detail: string;
  /** Distinct local media files the timeline references. */
  referenced: number;
  /** Of those, already present in draft_materials (matched by file_Path). */
  registered: number;
  /** Paths this plan registers (empty when nothing is missing). */
  to_register: string[];
  /** Entries already in the sidecar that no timeline material references — preserved, never removed. */
  unreferenced_entries: number;
  /** Timeline materials whose `local_material_id` does not name their entry (after this plan's registration). */
  unlinked_materials: number;
}

function normalise(path: string, projectDir: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(projectDir, path);
}

/** The project's draft_meta_info.json parsed as an object, or null when absent or unreadable. */
export function readSidecar(projectDir: string): Record<string, unknown> | null {
  const sidecarPath = resolve(projectDir, "draft_meta_info.json");
  if (!existsSync(sidecarPath)) return null;
  try {
    const parsed = JSON.parse(stripBom(readFileSync(sidecarPath, "utf-8"))) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Every registered entry (`file_Path` + `id`) across ALL groups. */
export function registeredEntries(groups: unknown): Array<{ path: string; id: string }> {
  const entries: Array<{ path: string; id: string }> = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.file_Path === "string")
        entries.push({ path: e.file_Path, id: typeof e.id === "string" ? e.id : "" });
    }
  };
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (group && typeof group === "object" && !Array.isArray(group))
        collect((group as Record<string, unknown>).value);
    }
  } else if (groups && typeof groups === "object") {
    for (const value of Object.values(groups)) collect(value);
  }
  return entries;
}

// Merge into the type-0 group, creating the group (and the array) when the
// sidecar carries no usable draft_materials; other groups and every existing
// entry are preserved as they are.
function appendToImportedGroup(sidecar: Record<string, unknown>, entries: MetaMaterialEntry[]): void {
  const groupsRaw = sidecar.draft_materials;
  const groups: Array<Record<string, unknown>> = Array.isArray(groupsRaw)
    ? (groupsRaw.filter((g) => g && typeof g === "object" && !Array.isArray(g)) as Array<Record<string, unknown>>)
    : [];
  let group0 = groups.find((g) => g.type === IMPORTED_MEDIA_GROUP_TYPE);
  if (!group0) {
    group0 = { type: IMPORTED_MEDIA_GROUP_TYPE, value: [] };
    groups.unshift(group0);
  }
  if (!Array.isArray(group0.value)) group0.value = [];
  for (const entry of entries) (group0.value as unknown[]).push(entry);
  sidecar.draft_materials = groups;
}

/**
 * Add-time registration (add-video / add-audio / quickstart / compile): put one
 * medium into the project's sidecar and return the entry id the timeline
 * material must carry as `local_material_id`. An entry already registered for
 * the file (the app's own, or an earlier add) is reused — merge, never
 * replace. Null when the project has no readable sidecar (a bare timeline
 * file, a draft the CLI never registered): nothing is written and
 * `register --materials` remains the repair.
 *
 * The write keeps register's discipline: a `.bak` of the sidecar as found,
 * then an atomic replace.
 */
export function registerMediumInSidecar(
  projectDir: string,
  medium: ReferencedMedium,
): { entryId: string; created: boolean } | null {
  const sidecarPath = resolve(projectDir, "draft_meta_info.json");
  const sidecar = readSidecar(projectDir);
  if (sidecar === null) return null;
  const wanted = normalise(medium.path, projectDir);
  for (const entry of registeredEntries(sidecar.draft_materials)) {
    if (entry.id !== "" && normalise(entry.path, projectDir) === wanted) return { entryId: entry.id, created: false };
  }
  const entry = buildMetaMaterialEntry(medium);
  appendToImportedGroup(sidecar, [entry]);
  writeFileSync(`${sidecarPath}.bak`, readFileSync(sidecarPath, "utf-8"), "utf-8");
  writeAtomic(sidecarPath, JSON.stringify(sidecar, null, 0));
  return { entryId: entry.id, created: true };
}

export interface UnlinkedMaterial {
  materialId: string;
  kind: "videos" | "audios";
  path: string;
  /** What the material carries today ("" when blank). */
  current: string;
  /** The sidecar entry id the material should carry — null when the file is not registered at all. */
  entryId: string | null;
}

/**
 * Timeline materials (video, photo, audio with a local path) whose
 * `local_material_id` does not name the sidecar entry registered for their
 * file. JianYing 5.9+ and CapCut 9.3 resolve local media through this key
 * (luoluoluo22/jianying-editor-skill#23, JmsLdrn/capcut-mcp#1): blank, the
 * clip shows as missing / inaccessible and the app's own Link-media dialog
 * cannot repair it. `sidecar === null` means every local material is unlinked
 * with no entry to link to.
 */
export function unlinkedMaterials(
  draft: Draft,
  sidecar: Record<string, unknown> | null,
  projectDir: string,
): UnlinkedMaterial[] {
  const byPath = new Map<string, string>();
  if (sidecar) {
    for (const entry of registeredEntries(sidecar.draft_materials)) {
      if (entry.id !== "" && !byPath.has(normalise(entry.path, projectDir)))
        byPath.set(normalise(entry.path, projectDir), entry.id);
    }
  }
  const out: UnlinkedMaterial[] = [];
  for (const kind of ["videos", "audios"] as const) {
    for (const mat of draft.materials?.[kind] ?? []) {
      const m = mat as Record<string, unknown>;
      if (!isLocalPath(m.path) || typeof m.id !== "string") continue;
      const entryId = byPath.get(normalise(m.path, projectDir)) ?? null;
      const current = typeof m.local_material_id === "string" ? m.local_material_id : "";
      if (entryId !== null && current === entryId) continue;
      if (entryId === null && current !== "") continue; // linked to something the sidecar does not list — the app's business, not a blank
      out.push({ materialId: m.id, kind, path: m.path, current, entryId });
    }
  }
  return out;
}

/** Write `local_material_id` on every unlinked material whose file has an entry; returns the material ids linked. */
export function linkLocalMaterialIds(
  draft: Draft,
  sidecar: Record<string, unknown> | null,
  projectDir: string,
): string[] {
  const linked: string[] = [];
  for (const u of unlinkedMaterials(draft, sidecar, projectDir)) {
    if (u.entryId === null) continue;
    const mat = (draft.materials[u.kind] as Array<Record<string, unknown>>).find((m) => m.id === u.materialId);
    if (!mat) continue;
    mat.local_material_id = u.entryId;
    linked.push(u.materialId);
  }
  return linked;
}

/** Every file_Path already registered across ALL groups (the app may have put media in a non-zero group). */
function registeredPaths(groups: unknown): string[] {
  const paths: string[] = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).file_Path === "string") {
        paths.push((entry as Record<string, unknown>).file_Path as string);
      }
    }
  };
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (group && typeof group === "object" && !Array.isArray(group))
        collect((group as Record<string, unknown>).value);
    }
  } else if (groups && typeof groups === "object") {
    for (const value of Object.values(groups)) collect(value);
  }
  return paths;
}

/**
 * Plan the draft_materials registration against a parsed sidecar object (the
 * one on disk, or the one `register`'s own sidecar repair is about to write —
 * so a missing/corrupt sidecar and its media registration land in ONE write).
 * `sidecar === null` means no readable sidecar exists and none is planned:
 * blocked, with the register step that unblocks it named in `detail`.
 * Returns the repaired sidecar object when there is something to write.
 */
export function planDraftMaterials(
  draft: Draft,
  sidecar: Record<string, unknown> | null,
  options: { sidecarPath: string; projectDir: string },
): { target: MaterialsRegistrationTarget; fixed: Record<string, unknown> | null } {
  const media = referencedMedia(draft);
  const base = {
    file: "draft_meta_info.json" as const,
    field: "draft_materials" as const,
    path: options.sidecarPath,
    referenced: media.length,
  };
  if (media.length === 0) {
    return {
      target: {
        ...base,
        state: "no-media",
        action: "none",
        detail: "the timeline references no local media, so there is nothing to register",
        registered: 0,
        to_register: [],
        unreferenced_entries: 0,
        unlinked_materials: 0,
      },
      fixed: null,
    };
  }
  if (sidecar === null) {
    return {
      target: {
        ...base,
        state: "sidecar-unavailable",
        action: "blocked",
        detail:
          "draft_meta_info.json is missing or unreadable and this run does not recreate it; " +
          "run `capcut register <project> --apply` (which recreates the sidecar) together with --materials",
        registered: 0,
        to_register: media.map((m) => m.path),
        unreferenced_entries: 0,
        unlinked_materials: unlinkedMaterials(draft, null, options.projectDir).length,
      },
      fixed: null,
    };
  }

  const existing = registeredPaths(sidecar.draft_materials);
  const existingNormalised = new Set(existing.map((p) => normalise(p, options.projectDir)));
  const referencedNormalised = new Set(media.map((m) => normalise(m.path, options.projectDir)));
  const missing = media.filter((m) => !existingNormalised.has(normalise(m.path, options.projectDir)));
  const unreferenced = existing.filter((p) => !referencedNormalised.has(normalise(p, options.projectDir))).length;

  // The link check runs against the sidecar this plan leaves behind: a
  // material whose file gets registered by this very plan still needs its
  // local_material_id written, which is a timeline write — register never
  // touches the timeline, so `lint --fix` owns that half and the count names it.
  const linkNote = (unlinked: number): string =>
    unlinked > 0
      ? `; ${unlinked} timeline material(s) carry no local_material_id link to their entry (JianYing 5.9+ / CapCut 9.3 ` +
        "resolve local media by it) — `capcut lint <project> --fix` writes the link"
      : "";

  if (missing.length === 0) {
    const unlinked = unlinkedMaterials(draft, sidecar, options.projectDir).length;
    return {
      target: {
        ...base,
        state: "ok",
        action: "none",
        detail: `every referenced media file (${media.length}) is registered in draft_materials${linkNote(unlinked)}`,
        registered: media.length,
        to_register: [],
        unreferenced_entries: unreferenced,
        unlinked_materials: unlinked,
      },
      fixed: null,
    };
  }

  const fixed = structuredClone(sidecar);
  appendToImportedGroup(
    fixed,
    missing.map((medium) => buildMetaMaterialEntry(medium)),
  );
  const unlinked = unlinkedMaterials(draft, fixed, options.projectDir).length;

  return {
    target: {
      ...base,
      state: "unregistered",
      action: "update",
      detail:
        `${missing.length} of ${media.length} referenced media file(s) are not registered in draft_materials ` +
        `(CapCut 9.1 shows them as "file inaccessible"); entries will be appended to the type-0 group, ` +
        `existing entries preserved${linkNote(unlinked)}`,
      registered: media.length - missing.length,
      to_register: missing.map((m) => m.path),
      unreferenced_entries: unreferenced,
      unlinked_materials: unlinked,
    },
    fixed,
  };
}
