import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { stripBom } from "./bom.js";
import { uuidHex } from "./decorators.js";
import type { Draft, Segment, Timerange, Track } from "./draft.js";
import { findMaterialGlobal, findSegment, makeTrack, writeAtomic } from "./draft.js";
import { findEnum, type Namespace } from "./enums.js";
import { isManagedDraftPath, parseCandidate } from "./store.js";
import { fetchWikimediaAsset, isWikimediaUrl, type WikimediaAsset } from "./wikimedia.js";

/**
 * If `path` is an http(s) URL, resolve it through the Wikimedia fetcher, saving
 * into a `wikimedia/` subdir of the draft's assets folder. Non-Wikimedia URLs
 * error — keeping network scope tight. Returns the local path + the fetched
 * asset (null for plain filesystem paths).
 */
export async function resolveAssetPath(
  path: string,
  draftFilePath: string,
  kind: "video" | "audio",
  forceLicense?: boolean,
): Promise<{ localPath: string; asset: WikimediaAsset | null; warning?: string }> {
  if (!/^https?:\/\//i.test(path)) {
    return { localPath: path, asset: null };
  }
  if (!isWikimediaUrl(path)) {
    throw new Error(
      `Only Wikimedia URLs are accepted as network inputs (got: ${path}). ` +
        `Download the file separately and pass a local path.`,
    );
  }
  // Save directly into the same dir addVideo/addAudio uses so their
  // copyFileSync becomes a no-op (file already present at destPath).
  const draftDir = dirname(draftFilePath);
  const destDir = resolve(draftDir, "assets", kind);
  const { localPath, asset, warning } = await fetchWikimediaAsset(path, { destDir, forceLicense });
  return { localPath, asset, warning };
}

// --- UUID generation ---

export function uuid(): string {
  return randomUUID();
}

// --- Asset copy (collision-safe) ---

function fileSha1(path: string): string {
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}

/** True if both paths exist and have byte-identical content. */
function sameContent(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  return fileSha1(a) === fileSha1(b);
}

/**
 * Copy a source file into an assets directory, keyed by its basename.
 *
 * The skip-on-exists behaviour is intentional and load-bearing: the Wikimedia
 * fetch path pre-writes into the same dir so this copy is a deliberate no-op,
 * and re-adding the same file must not re-copy. But when a *different* source
 * resolves to a basename already present (e.g. `en/0_00.png` vs `jp/0_00.png`),
 * skipping silently leaves the draft pointing at the wrong content. In that case
 * we de-collide by writing under a content-hashed name and warn on stderr.
 *
 * Returns the destination path the draft should reference.
 */
export function copyAssetDeduped(srcPath: string, assetsDir: string, fallbackName: string): string {
  mkdirSync(assetsDir, { recursive: true });
  const filename = basename(srcPath) || fallbackName;
  const destPath = resolve(assetsDir, filename);

  if (!existsSync(destPath)) {
    copyFileSync(srcPath, destPath);
    return destPath;
  }
  // Destination exists — same source (intentional no-op) or basename collision?
  if (sameContent(srcPath, destPath)) return destPath;

  // Different source resolving to the same basename: de-collide by content hash.
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  const dedupName = `${stem}.${fileSha1(srcPath).slice(0, 8)}${ext}`;
  const dedupPath = resolve(assetsDir, dedupName);
  if (!existsSync(dedupPath)) {
    copyFileSync(srcPath, dedupPath);
    console.warn(
      `Warning: "assets/${basename(assetsDir)}/${filename}" already exists from a different source file; ` +
        `copied "${srcPath}" to "${dedupName}" instead. The draft references the correct content.`,
    );
  }
  return dedupPath;
}

// --- Init (create new empty draft) ---

export interface InitOptions {
  name: string;
  templateDir: string; // path to template directory
  draftsDir: string; // path to CapCut drafts directory
  now?: number; // epoch ms — injectable clock for tests; defaults to Date.now()
}

export function initDraft(opts: InitOptions): { draftPath: string; filePath: string; registered: boolean } {
  const draftPath = resolve(opts.draftsDir, opts.name);
  if (existsSync(draftPath)) {
    throw new Error(`Draft already exists: ${draftPath}. Delete it first or use a different name.`);
  }
  cpSync(opts.templateDir, draftPath, { recursive: true });

  // Find the draft file
  const candidates = ["draft_info.json", "draft_content.json"];
  for (const c of candidates) {
    const fp = resolve(draftPath, c);
    if (existsSync(fp)) {
      // Update the draft name + id
      const raw = stripBom(readFileSync(fp, "utf-8"));
      const draft = JSON.parse(raw) as Draft;
      draft.name = opts.name;
      const draftId = uuid();
      draft.id = draftId;
      writeFileSync(fp, JSON.stringify(draft, null, 0), "utf-8");

      // CapCut's GUI does not scan the Projects folder — it lists drafts from a
      // central index, root_meta_info.json, at the root of com.lveditor.draft/.
      // Without an entry there a freshly created folder stays invisible. Register
      // it (and write the per-folder draft_meta_info.json sidecar) so the new draft
      // shows up. Best-effort: a failure here must not fail draft creation.
      const nowMs = opts.now ?? Date.now();
      let registered = false;
      try {
        registered = registerDraftInIndex({
          draftsDir: opts.draftsDir,
          draftPath,
          filePath: fp,
          draftId,
          name: opts.name,
          nowMs,
        });
      } catch {
        registered = false;
      }
      return { draftPath, filePath: fp, registered };
    }
  }
  throw new Error(`No draft_info.json or draft_content.json found in template: ${opts.templateDir}`);
}

interface RegisterOptions {
  draftsDir: string;
  draftPath: string;
  filePath: string;
  draftId: string;
  name: string;
  nowMs: number;
  durationUs?: number; // draft duration in microseconds (tm_duration); init drafts start at 0
}

/**
 * A single draft's entry inside root_meta_info.json's draft store. The field set
 * mirrors what CapCut writes; when an existing store is found we clone the shape
 * of a real entry instead (so the result matches the installed CapCut version)
 * and only override the identifying fields below.
 */
function buildDraftEntry(opts: RegisterOptions): Record<string, unknown> {
  const tmMicros = opts.nowMs * 1000; // CapCut timestamps are microseconds
  return {
    draft_cover: "draft_cover.jpg",
    draft_fold_path: opts.draftPath,
    draft_id: opts.draftId,
    draft_is_ai_shorts: false,
    draft_is_invisible: false,
    draft_json_file: opts.filePath,
    draft_name: opts.name,
    draft_new_version: "",
    draft_root_path: opts.draftsDir,
    draft_timeline_materials_size: 0,
    tm_draft_create: tmMicros,
    tm_draft_modified: tmMicros,
    tm_draft_removed: 0,
    tm_duration: opts.durationUs ?? 0,
  };
}

const IDENTIFYING_FIELDS = (opts: RegisterOptions): Record<string, unknown> => ({
  draft_fold_path: opts.draftPath,
  draft_id: opts.draftId,
  draft_json_file: opts.filePath,
  draft_name: opts.name,
  draft_root_path: opts.draftsDir,
  tm_draft_create: opts.nowMs * 1000,
  tm_draft_modified: opts.nowMs * 1000,
  tm_draft_removed: 0,
  tm_duration: opts.durationUs ?? 0,
});

/** Find the array property that holds the per-draft entries (e.g. all_draft_store). */
function findDraftStoreKey(obj: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.some((e) => e && typeof e === "object" && ("draft_fold_path" in e || "draft_id" in e))) {
      return k;
    }
  }
  // Fall back to a plausibly-named empty store so we extend rather than invent.
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && /all_draft_store|draft_store/i.test(k)) return k;
  }
  return null;
}

/**
 * Add the new draft to root_meta_info.json (creating the file if absent) and write
 * a per-folder draft_meta_info.json sidecar. Merges into the existing index — never
 * clobbers other drafts — and backs the index up to .bak before writing.
 * Returns true if the draft was registered in the root index.
 */
export function registerDraftInIndex(opts: RegisterOptions): boolean {
  // Per-folder sidecar (documented metadata file; CapCut reads it when opening).
  const metaPath = resolve(opts.draftPath, "draft_meta_info.json");
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, JSON.stringify(buildDraftEntry(opts), null, 0), "utf-8");
  }

  const indexPath = resolve(opts.draftsDir, "root_meta_info.json");

  if (!existsSync(indexPath)) {
    // No index yet (fresh CapCut / custom --drafts dir): create a minimal one.
    writeFileSync(indexPath, JSON.stringify({ all_draft_store: [buildDraftEntry(opts)] }, null, 0), "utf-8");
    return true;
  }

  const raw = stripBom(readFileSync(indexPath, "utf-8"));
  let index: Record<string, unknown>;
  try {
    index = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false; // unreadable index — leave it untouched rather than corrupt it
  }

  const storeKey = findDraftStoreKey(index) ?? "all_draft_store";
  const store = (Array.isArray(index[storeKey]) ? index[storeKey] : []) as Array<Record<string, unknown>>;

  // Drop any stale entry pointing at the same folder, then append a fresh one.
  const filtered = store.filter((e) => e?.draft_fold_path !== opts.draftPath);
  const template = filtered[0] ?? store[0];
  const entry =
    template && typeof template === "object"
      ? { ...structuredClone(template), ...IDENTIFYING_FIELDS(opts) }
      : buildDraftEntry(opts);
  filtered.push(entry);
  index[storeKey] = filtered;

  // Back up the user's index (it lists ALL their projects) before overwriting.
  writeFileSync(`${indexPath}.bak`, raw, "utf-8");
  writeFileSync(indexPath, JSON.stringify(index, null, 0), "utf-8");
  return true;
}

// --- Register (meta-repair for EXISTING drafts; see cmdRegister in index.ts) ---
// `init` registers a draft only at creation time (registerDraftInIndex above).
// `capcut register` covers the other half: an existing folder whose
// draft_meta_info.json sidecar or root_meta_info.json entry is missing/stale
// and therefore invisible to the CapCut app. draft_content.json is the
// read-only source of id/name/duration and is never written.

export interface RegistrationTarget {
  file: "draft_meta_info.json" | "root_meta_info.json";
  path: string | null;
  state: "ok" | "missing" | "unreadable" | "stale" | "unregistered" | "unknown-store-root";
  action: "none" | "create" | "update" | "blocked";
  detail: string;
  stale_fields: string[];
}

export interface RegistrationPlan {
  project_dir: string;
  /** Path of the identity source (draft_content.json, or draft_info.json on
   * the draft_info-primary Mac layout). Field name kept for compatibility. */
  content_path: string;
  identity_source: string;
  draft_id: string;
  draft_name: string;
  duration_us: number;
  store_root: string | null;
  store_root_source: string;
  needs_repair: boolean;
  targets: RegistrationTarget[];
  /** Files --apply would write (target action create/update). */
  repairs: string[];
  /** Targets needing attention that the CLI refuses to write (target action blocked). */
  blocked: string[];
}

interface RegistrationWrite {
  file: RegistrationTarget["file"];
  path: string;
  content: string;
  /** Raw pre-plan content, null when the file did not exist (no .bak then). */
  previous: string | null;
}

export interface RegistrationResult {
  plan: RegistrationPlan;
  writes: RegistrationWrite[];
}

/**
 * A draft's store root is its parent directory — the CapCut app lists drafts
 * from the root_meta_info.json index there (the same file `init` writes via
 * registerDraftInIndex). The parent counts as a KNOWN store root when it
 * already holds a root_meta_info.json, when --drafts names it explicitly
 * (init's custom-drafts case, where the index may not exist yet), or when the
 * draft lives under the managed com.lveditor.draft location init defaults to.
 * Anything else is reported explicitly and never written to.
 */
function discoverStoreRoot(projectDir: string, draftsDir?: string): { root: string | null; source: string } {
  const parent = dirname(projectDir);
  if (existsSync(resolve(parent, "root_meta_info.json"))) {
    return { root: parent, source: "root_meta_info.json found in the parent directory" };
  }
  if (draftsDir && resolve(draftsDir) === parent) return { root: parent, source: "--drafts" };
  if (isManagedDraftPath(`${projectDir}/`)) return { root: parent, source: "managed com.lveditor.draft path" };
  const mismatch = draftsDir ? ` and the draft is not directly inside --drafts ${resolve(draftsDir)}` : "";
  return {
    root: null,
    source: `no root_meta_info.json in the parent directory and not a com.lveditor.draft path${mismatch}`,
  };
}

/**
 * Compare an existing sidecar/index entry against what draft_content.json says
 * and return the stale field names plus the repaired object (unknown fields
 * preserved, tm_draft_modified bumped). draft_name is CapCut's display name —
 * an existing non-empty value is user data and wins; it is only filled when
 * missing/empty.
 */
function registrationFixes(
  existing: Record<string, unknown>,
  opts: RegisterOptions,
): { stale: string[]; fixed: Record<string, unknown> } {
  const wanted: Record<string, unknown> = {
    draft_id: opts.draftId,
    draft_fold_path: opts.draftPath,
    draft_json_file: opts.filePath,
    draft_root_path: opts.draftsDir,
    tm_duration: opts.durationUs ?? 0,
  };
  const stale = Object.keys(wanted).filter((key) => existing[key] !== wanted[key]);
  if (typeof existing.draft_name !== "string" || existing.draft_name === "") {
    stale.push("draft_name");
    wanted.draft_name = opts.name;
  }
  if (stale.length === 0) return { stale, fixed: existing };
  const fixed: Record<string, unknown> = {
    ...structuredClone(existing),
    ...wanted,
    tm_draft_modified: opts.nowMs * 1000,
  };
  if (typeof fixed.tm_draft_create !== "number") fixed.tm_draft_create = opts.nowMs * 1000;
  return { stale, fixed };
}

/**
 * Plan for `capcut register`: report whether an existing draft's
 * draft_meta_info.json sidecar and root_meta_info.json entry are present and
 * agree with the identity source (draft_content.json — or draft_info.json on
 * the draft_info-primary Mac layout; read-only either way), and prepare the
 * exact writes --apply would make. Accepts a project directory or its primary
 * timeline file path; any other explicitly named file is rejected so the plan
 * and the write always cover the same target set. An unreadable
 * root_meta_info.json is never rewritten (it lists EVERY draft); it is
 * reported blocked instead — as is everything when the draft does not live
 * inside a known store root.
 */
export function planDraftRegistration(
  input: string,
  options: { draftsDir?: string; now?: number } = {},
): RegistrationResult {
  const resolved = resolve(input);
  if (
    existsSync(resolved) &&
    statSync(resolved).isFile() &&
    !["draft_content.json", "draft_info.json"].includes(basename(resolved))
  ) {
    throw new Error(
      `register repairs a draft's registration metadata from the project's primary timeline file and cannot target ${basename(resolved)} directly. ` +
        `Pass the project directory instead: capcut register ${dirname(resolved)}`,
    );
  }
  const projectDir = existsSync(resolved) && statSync(resolved).isFile() ? dirname(resolved) : resolved;
  const contentPath = resolve(projectDir, "draft_content.json");
  const infoPath = resolve(projectDir, "draft_info.json");
  let identitySource = "draft_content.json";
  let identityPath = contentPath;
  let content: Record<string, unknown>;
  if (existsSync(contentPath)) {
    try {
      content = JSON.parse(stripBom(readFileSync(contentPath, "utf-8"))) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `register needs a readable draft_content.json (the id/name/duration source), but it did not parse: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  } else if (existsSync(infoPath)) {
    // draft_info-primary layout (no draft_content.json; newer Mac builds drive
    // the project from draft_info.json): derive the identity from
    // draft_info.json instead — the same read-only contract, envelope-aware.
    const candidate = parseCandidate(infoPath);
    if (!candidate.draft) {
      throw new Error(
        "register needs a readable draft_content.json or draft_info.json (the id/name/duration source), " +
          `but draft_info.json did not contain a readable timeline${candidate.error ? `: ${candidate.error}` : ""}. ` +
          "Run `capcut diagnose <project>` to inspect what is on disk.",
      );
    }
    content = candidate.draft as unknown as Record<string, unknown>;
    identitySource = "draft_info.json";
    identityPath = infoPath;
  } else {
    throw new Error(
      "register needs a readable draft_content.json or draft_info.json (the id/name/duration source). " +
        "Run `capcut diagnose <project>` to inspect what is on disk.",
    );
  }
  if (typeof content.id !== "string" || content.id === "") {
    throw new Error(
      `register cannot derive a draft id: ${identitySource} has no "id". Refusing to invent one — ` +
        "run `capcut diagnose <project>` to inspect the draft.",
    );
  }

  const name = typeof content.name === "string" && content.name !== "" ? content.name : basename(projectDir);
  const durationUs = typeof content.duration === "number" && Number.isFinite(content.duration) ? content.duration : 0;
  const { root: storeRoot, source: storeRootSource } = discoverStoreRoot(projectDir, options.draftsDir);
  const opts: RegisterOptions = {
    draftsDir: storeRoot ?? dirname(projectDir),
    draftPath: projectDir,
    filePath: identityPath,
    draftId: content.id,
    name,
    nowMs: options.now ?? Date.now(),
    durationUs,
  };

  const targets: RegistrationTarget[] = [];
  const writes: RegistrationWrite[] = [];

  // Target 1: the per-folder draft_meta_info.json sidecar.
  const metaPath = resolve(projectDir, "draft_meta_info.json");
  const metaRaw = existsSync(metaPath) ? stripBom(readFileSync(metaPath, "utf-8")) : null;
  let metaParsed: Record<string, unknown> | null = null;
  if (metaRaw !== null) {
    try {
      const parsed = JSON.parse(metaRaw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        metaParsed = parsed as Record<string, unknown>;
    } catch {
      // Unparseable sidecar: metaParsed stays null and is treated as corrupt below.
    }
  }
  if (storeRoot === null) {
    // Without a known store root there is no draft_root_path to derive and no
    // index to update — report only, never write (the contract for drafts
    // living outside any known store).
    if (metaRaw !== null && metaParsed !== null) {
      targets.push({
        file: "draft_meta_info.json",
        path: metaPath,
        state: "ok",
        action: "none",
        detail: "present and readable (store root unknown, so draft_root_path was not verified)",
        stale_fields: [],
      });
    } else {
      targets.push({
        file: "draft_meta_info.json",
        path: metaPath,
        state: metaRaw === null ? "missing" : "unreadable",
        action: "blocked",
        detail:
          "cannot be recreated without a known store root (draft_root_path). " +
          "Pass --drafts <dir> if the store root is elsewhere.",
        stale_fields: [],
      });
    }
    targets.push({
      file: "root_meta_info.json",
      path: null,
      state: "unknown-store-root",
      action: "blocked",
      detail: `${projectDir} does not live inside a known CapCut draft store (${storeRootSource}). Pass --drafts <dir> if the store root is elsewhere.`,
      stale_fields: [],
    });
  } else {
    if (metaRaw === null || metaParsed === null) {
      const entry = buildDraftEntry(opts);
      targets.push({
        file: "draft_meta_info.json",
        path: metaPath,
        state: metaRaw === null ? "missing" : "unreadable",
        action: metaRaw === null ? "create" : "update",
        detail:
          metaRaw === null
            ? `missing — the sidecar will be recreated from ${identitySource}`
            : `does not parse as JSON — the sidecar will be rewritten from ${identitySource} (.bak keeps the old bytes)`,
        stale_fields: [],
      });
      writes.push({
        file: "draft_meta_info.json",
        path: metaPath,
        content: JSON.stringify(entry, null, 0),
        previous: metaRaw,
      });
    } else {
      const { stale, fixed } = registrationFixes(metaParsed, opts);
      if (stale.length === 0) {
        targets.push({
          file: "draft_meta_info.json",
          path: metaPath,
          state: "ok",
          action: "none",
          detail: `present and agrees with ${identitySource}`,
          stale_fields: [],
        });
      } else {
        targets.push({
          file: "draft_meta_info.json",
          path: metaPath,
          state: "stale",
          action: "update",
          detail: `stale fields (${stale.join(", ")}) will be repaired from ${identitySource}; other fields are preserved`,
          stale_fields: stale,
        });
        writes.push({
          file: "draft_meta_info.json",
          path: metaPath,
          content: JSON.stringify(fixed, null, 0),
          previous: metaRaw,
        });
      }
    }

    // Target 2: the draft's entry in the store's root_meta_info.json index.
    const indexPath = resolve(storeRoot, "root_meta_info.json");
    const indexRaw = existsSync(indexPath) ? stripBom(readFileSync(indexPath, "utf-8")) : null;
    if (indexRaw === null) {
      // No index yet (fresh CapCut / custom --drafts dir): create a minimal
      // one, exactly like init's registerDraftInIndex.
      targets.push({
        file: "root_meta_info.json",
        path: indexPath,
        state: "missing",
        action: "create",
        detail: "missing — a minimal index holding this draft will be created (matches init on a fresh store)",
        stale_fields: [],
      });
      writes.push({
        file: "root_meta_info.json",
        path: indexPath,
        content: JSON.stringify({ all_draft_store: [buildDraftEntry(opts)] }, null, 0),
        previous: null,
      });
    } else {
      let index: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(indexRaw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) index = parsed as Record<string, unknown>;
      } catch {
        // Unreadable index — leave it untouched rather than corrupt it (it lists every draft).
      }
      if (index === null) {
        targets.push({
          file: "root_meta_info.json",
          path: indexPath,
          state: "unreadable",
          action: "blocked",
          detail:
            "does not parse as JSON; refusing to rewrite the index that lists every draft. " +
            "Restore it from a backup or let the CapCut app rebuild it, then re-run register.",
          stale_fields: [],
        });
      } else {
        const storeKey = findDraftStoreKey(index) ?? "all_draft_store";
        const store = (Array.isArray(index[storeKey]) ? index[storeKey] : []) as Array<Record<string, unknown>>;
        const entryIndex = store.findIndex((e) => e && typeof e === "object" && e.draft_fold_path === projectDir);
        if (entryIndex === -1) {
          // Clone the shape of a real entry (matches the installed CapCut
          // version) and override the identifying fields — same as init.
          const template = store[0];
          const entry =
            template && typeof template === "object"
              ? { ...structuredClone(template), ...IDENTIFYING_FIELDS(opts) }
              : buildDraftEntry(opts);
          const updated = { ...index, [storeKey]: [...store, entry] };
          targets.push({
            file: "root_meta_info.json",
            path: indexPath,
            state: "unregistered",
            action: "update",
            detail: `no entry for this folder in ${storeKey} — one will be appended; existing entries are preserved`,
            stale_fields: [],
          });
          writes.push({
            file: "root_meta_info.json",
            path: indexPath,
            content: JSON.stringify(updated, null, 0),
            previous: indexRaw,
          });
        } else {
          const { stale, fixed } = registrationFixes(store[entryIndex], opts);
          if (stale.length === 0) {
            targets.push({
              file: "root_meta_info.json",
              path: indexPath,
              state: "ok",
              action: "none",
              detail: `entry present in ${storeKey} and agrees with ${identitySource}`,
              stale_fields: [],
            });
          } else {
            const updatedStore = [...store];
            updatedStore[entryIndex] = fixed;
            const updated = { ...index, [storeKey]: updatedStore };
            targets.push({
              file: "root_meta_info.json",
              path: indexPath,
              state: "stale",
              action: "update",
              detail: `entry has stale fields (${stale.join(", ")}) that will be repaired from ${identitySource}; other fields and entries are preserved`,
              stale_fields: stale,
            });
            writes.push({
              file: "root_meta_info.json",
              path: indexPath,
              content: JSON.stringify(updated, null, 0),
              previous: indexRaw,
            });
          }
        }
      }
    }
  }

  const repairs = targets.filter((t) => t.action === "create" || t.action === "update").map((t) => t.file);
  const blocked = targets.filter((t) => t.action === "blocked").map((t) => t.file);
  return {
    plan: {
      project_dir: projectDir,
      content_path: identityPath,
      identity_source: identitySource,
      draft_id: content.id,
      draft_name: name,
      duration_us: durationUs,
      store_root: storeRoot,
      store_root_source: storeRootSource,
      needs_repair: repairs.length > 0,
      targets,
      repairs,
      blocked,
    },
    writes,
  };
}

/**
 * Perform the writes a registration plan prepared: temp+fsync+rename per file,
 * with a `.bak` of the pre-plan content for every file that already existed.
 * Unless forceWrite, refuses when a target changed on disk between the plan
 * read and now (the sync-timelines optimistic-concurrency rule).
 */
export function applyDraftRegistration(
  result: RegistrationResult,
  options: { forceWrite?: boolean } = {},
): { applied: string[]; backups: string[] } {
  if (!options.forceWrite) {
    for (const write of result.writes) {
      const current = existsSync(write.path) ? stripBom(readFileSync(write.path, "utf-8")) : null;
      if (current !== write.previous) {
        throw new Error(
          `Draft changed on disk after it was planned: ${write.file}. ` +
            "Re-run register, or pass --force-write to overwrite intentionally.",
        );
      }
    }
  }
  const applied: string[] = [];
  const backups: string[] = [];
  for (const write of result.writes) {
    if (write.previous !== null) {
      writeAtomic(`${write.path}.bak`, write.previous);
      backups.push(`${write.file}.bak`);
    }
    writeAtomic(write.path, write.content);
    applied.push(write.file);
  }
  return { applied, backups };
}

// --- Rename (folder + registration metadata; see cmdRename in index.ts) ---
// `register`'s thin sibling: the same store-root discovery and the same
// temp+fsync+rename writes, but instead of repairing metadata to match the
// draft, it moves the draft folder and rewrites the name and every
// self-referential path recorded about it. Timeline files (draft_content.json
// / draft_info.json) are never written.

export interface RenameTarget {
  file: "draft_meta_info.json" | "root_meta_info.json";
  path: string | null;
  state: "present" | "missing" | "unregistered" | "unknown-store-root";
  action: "update" | "none";
  detail: string;
  updated_fields: string[];
}

export interface RenamePlan {
  old_name: string;
  new_name: string;
  old_path: string;
  new_path: string;
  store_root: string | null;
  store_root_source: string;
  targets: RenameTarget[];
  /** Absolute paths the rename rewrites, as they will exist AFTER the folder rename. */
  updates: string[];
  /** Old-folder-path references left inside timeline files (read-only there; `relink` repairs them). */
  stale_media_refs: number;
}

interface RenameWrite {
  file: RenameTarget["file"];
  /** Where the file lives BEFORE the folder rename (concurrency check + rollback source). */
  readPath: string;
  /** Where the rewritten file lands AFTER the folder rename. */
  writePath: string;
  content: string;
  /** Raw pre-plan content. Rename only rewrites files that exist, so never null. */
  previous: string;
}

export interface RenameResult {
  plan: RenamePlan;
  writes: RenameWrite[];
}

/**
 * Rewrite a registration entry (sidecar or index) for a renamed draft folder:
 * `draft_name` becomes the new name, and every top-level string field whose
 * value points at or under the old folder gets the new folder prefix — which
 * covers draft_fold_path / draft_json_file plus any version-specific absolute
 * path an app build stores — with tm_draft_modified bumped when anything
 * changed. Every other field is preserved. Returns the changed field names.
 */
function renameEntryFields(
  existing: Record<string, unknown>,
  oldDir: string,
  newDir: string,
  newName: string,
  nowMs: number,
): { changed: string[]; fixed: Record<string, unknown> } {
  const fixed = structuredClone(existing);
  const changed: string[] = [];
  for (const [key, value] of Object.entries(fixed)) {
    if (typeof value !== "string") continue;
    if (value === oldDir) {
      fixed[key] = newDir;
      changed.push(key);
    } else if (value.startsWith(`${oldDir}/`) || value.startsWith(`${oldDir}\\`)) {
      fixed[key] = `${newDir}${value.slice(oldDir.length)}`;
      changed.push(key);
    }
  }
  if (fixed.draft_name !== newName) {
    fixed.draft_name = newName;
    changed.push("draft_name");
  }
  if (changed.length > 0) fixed.tm_draft_modified = nowMs * 1000;
  return { changed, fixed };
}

/**
 * Plan for `capcut rename`: move the draft folder to `<parent>/<newName>` and
 * rewrite the draft's registration metadata (draft_meta_info.json sidecar +
 * the entry in the store's root_meta_info.json) to match. Accepts the project
 * directory or its primary timeline file path, like register. Refuses invalid
 * names, an existing target folder, and metadata that exists but cannot be
 * parsed — rename never renames around a file it cannot update. A missing
 * sidecar or index entry is only reported (register recreates those); the
 * folder is renamed anyway. Timeline files are read only to count references
 * to the old folder path (stale_media_refs — relink repairs them after).
 */
export function planDraftRename(
  input: string,
  newName: string,
  options: { draftsDir?: string; now?: number } = {},
): RenameResult {
  const resolved = resolve(input);
  if (
    existsSync(resolved) &&
    statSync(resolved).isFile() &&
    !["draft_content.json", "draft_info.json"].includes(basename(resolved))
  ) {
    throw new Error(
      `rename moves the whole draft folder and cannot target ${basename(resolved)} directly. ` +
        `Pass the project directory instead: capcut rename ${dirname(resolved)} <new-name>`,
    );
  }
  const projectDir = existsSync(resolved) && statSync(resolved).isFile() ? dirname(resolved) : resolved;
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`Draft folder not found: ${projectDir}`);
  }
  if (newName.trim() === "" || newName === "." || newName === "..") {
    throw new Error(`rename needs a non-empty folder name (got "${newName}").`);
  }
  if (/[/\\]/.test(newName)) {
    throw new Error(
      `rename takes a plain folder name, not a path (got "${newName}"). The draft stays in ${dirname(projectDir)}.`,
    );
  }
  const newDir = resolve(dirname(projectDir), newName);
  if (newDir === projectDir) {
    throw new Error(`Draft is already named "${newName}" — nothing to rename.`);
  }
  if (existsSync(newDir)) {
    throw new Error(`Refusing to rename: the target folder already exists: ${newDir}`);
  }
  const nowMs = options.now ?? Date.now();

  // The per-folder sidecar. Present-but-unparseable refuses the whole rename:
  // proceeding would leave the app a sidecar whose recorded name/paths can
  // never be updated. register --apply repairs it (with a .bak) first.
  const metaPath = resolve(projectDir, "draft_meta_info.json");
  const metaRaw = existsSync(metaPath) ? stripBom(readFileSync(metaPath, "utf-8")) : null;
  let metaParsed: Record<string, unknown> | null = null;
  if (metaRaw !== null) {
    try {
      const parsed = JSON.parse(metaRaw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        metaParsed = parsed as Record<string, unknown>;
    } catch {
      // metaParsed stays null → refused below.
    }
    if (metaParsed === null) {
      throw new Error(
        "rename must update draft_meta_info.json but it does not parse as JSON. " +
          `Repair it first — capcut register ${projectDir} --apply rewrites the sidecar with a .bak — then re-run rename.`,
      );
    }
  }

  const oldName =
    metaParsed && typeof metaParsed.draft_name === "string" && metaParsed.draft_name !== ""
      ? metaParsed.draft_name
      : basename(projectDir);
  const { root: storeRoot, source: storeRootSource } = discoverStoreRoot(projectDir, options.draftsDir);

  const targets: RenameTarget[] = [];
  const writes: RenameWrite[] = [];

  // Target 1: the per-folder draft_meta_info.json sidecar.
  if (metaParsed === null) {
    targets.push({
      file: "draft_meta_info.json",
      path: metaPath,
      state: "missing",
      action: "none",
      detail:
        "missing — the folder is renamed anyway; run `capcut register <project> --apply` afterwards to recreate the sidecar.",
      updated_fields: [],
    });
  } else {
    const { changed, fixed } = renameEntryFields(metaParsed, projectDir, newDir, newName, nowMs);
    targets.push({
      file: "draft_meta_info.json",
      path: metaPath,
      state: "present",
      action: changed.length > 0 ? "update" : "none",
      detail:
        changed.length > 0
          ? `fields (${changed.join(", ")}) will be rewritten for the new name and folder path; other fields are preserved`
          : "already consistent with the new name and folder path",
      updated_fields: changed,
    });
    if (changed.length > 0) {
      writes.push({
        file: "draft_meta_info.json",
        readPath: metaPath,
        writePath: resolve(newDir, "draft_meta_info.json"),
        content: JSON.stringify(fixed, null, 0),
        previous: metaRaw as string,
      });
    }
  }

  // Target 2: the draft's entry in the store's root_meta_info.json index.
  if (storeRoot === null) {
    targets.push({
      file: "root_meta_info.json",
      path: null,
      state: "unknown-store-root",
      action: "none",
      detail: `${projectDir} does not live inside a known CapCut draft store (${storeRootSource}); no index entry to update. Pass --drafts <dir> if the store root is elsewhere.`,
      updated_fields: [],
    });
  } else {
    const indexPath = resolve(storeRoot, "root_meta_info.json");
    const indexRaw = existsSync(indexPath) ? stripBom(readFileSync(indexPath, "utf-8")) : null;
    if (indexRaw === null) {
      targets.push({
        file: "root_meta_info.json",
        path: indexPath,
        state: "missing",
        action: "none",
        detail: "missing — nothing to update; run `capcut register <project> --apply` after the rename to create it.",
        updated_fields: [],
      });
    } else {
      let index: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(indexRaw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) index = parsed as Record<string, unknown>;
      } catch {
        // Unreadable index — refused below rather than renamed around (it lists every draft).
      }
      if (index === null) {
        throw new Error(
          "rename must update the draft's entry in root_meta_info.json, but the index does not parse as JSON; " +
            "refusing to rename around the file that lists every draft. Restore it from a backup or let the " +
            "CapCut app rebuild it, then re-run rename.",
        );
      }
      const storeKey = findDraftStoreKey(index) ?? "all_draft_store";
      const store = (Array.isArray(index[storeKey]) ? index[storeKey] : []) as Array<Record<string, unknown>>;
      const entryIndex = store.findIndex((e) => e && typeof e === "object" && e.draft_fold_path === projectDir);
      if (entryIndex === -1) {
        targets.push({
          file: "root_meta_info.json",
          path: indexPath,
          state: "unregistered",
          action: "none",
          detail: `no entry for this folder in ${storeKey} — nothing to update; run \`capcut register <project> --apply\` after the rename to add one.`,
          updated_fields: [],
        });
      } else {
        const { changed, fixed } = renameEntryFields(store[entryIndex], projectDir, newDir, newName, nowMs);
        targets.push({
          file: "root_meta_info.json",
          path: indexPath,
          state: "present",
          action: changed.length > 0 ? "update" : "none",
          detail:
            changed.length > 0
              ? `entry fields (${changed.join(", ")}) will be rewritten for the new name and folder path; other fields and entries are preserved`
              : "entry already consistent with the new name and folder path",
          updated_fields: changed,
        });
        if (changed.length > 0) {
          const updatedStore = [...store];
          updatedStore[entryIndex] = fixed;
          writes.push({
            file: "root_meta_info.json",
            readPath: indexPath,
            writePath: indexPath,
            content: JSON.stringify({ ...index, [storeKey]: updatedStore }, null, 0),
            previous: indexRaw,
          });
        }
      }
    }
  }

  // Read-only scan: absolute media/asset references under the old folder path
  // inside the timeline files go stale after the rename. Counted and reported
  // (relink repairs them); never rewritten here — timeline files are not
  // rename's to touch. The needle is JSON-escaped so Windows-style paths match.
  let staleMediaRefs = 0;
  const needle = JSON.stringify(projectDir).slice(1, -1);
  for (const timeline of ["draft_content.json", "draft_info.json"]) {
    const timelinePath = resolve(projectDir, timeline);
    if (!existsSync(timelinePath)) continue;
    staleMediaRefs += readFileSync(timelinePath, "utf-8").split(needle).length - 1;
  }

  return {
    plan: {
      old_name: oldName,
      new_name: newName,
      old_path: projectDir,
      new_path: newDir,
      store_root: storeRoot,
      store_root_source: storeRootSource,
      targets,
      updates: writes.map((write) => write.writePath),
      stale_media_refs: staleMediaRefs,
    },
    writes,
  };
}

/**
 * Perform a rename plan as one transaction: rename the draft folder, then
 * rewrite the planned metadata files with the same temp+fsync+rename pattern
 * register uses, a `.bak` beside every rewritten file. A failed step restores
 * the already-rewritten files and puts the folder back under its old name
 * before rethrowing. Unless forceWrite, refuses when a target changed on disk
 * between the plan read and now (the sync-timelines optimistic-concurrency
 * rule) — and re-checks that the target folder is still free.
 */
export function applyDraftRename(
  result: RenameResult,
  options: { forceWrite?: boolean } = {},
): { renamed: boolean; applied: string[]; backups: string[] } {
  const { plan, writes } = result;
  if (!options.forceWrite) {
    for (const write of writes) {
      const current = existsSync(write.readPath) ? stripBom(readFileSync(write.readPath, "utf-8")) : null;
      if (current !== write.previous) {
        throw new Error(
          `Draft changed on disk after it was planned: ${write.file}. ` +
            "Re-run rename, or pass --force-write to overwrite intentionally.",
        );
      }
    }
  }
  if (existsSync(plan.new_path)) {
    throw new Error(`Refusing to rename: the target folder already exists: ${plan.new_path}`);
  }
  renameSync(plan.old_path, plan.new_path);
  const applied: string[] = [];
  const backups: string[] = [];
  try {
    for (const write of writes) {
      writeAtomic(`${write.writePath}.bak`, write.previous);
      backups.push(`${write.file}.bak`);
      writeAtomic(write.writePath, write.content);
      applied.push(write.file);
    }
  } catch (error) {
    // Roll the transaction back: restore every file already rewritten, then
    // rename the folder back. Best-effort — the .bak files written above
    // survive as the manual recovery path if even this fails.
    try {
      for (const write of writes) {
        if (applied.includes(write.file)) writeAtomic(write.writePath, write.previous);
      }
      renameSync(plan.new_path, plan.old_path);
    } catch {
      // Deliberate: the original error is the actionable one.
    }
    throw error;
  }
  return { renamed: true, applied, backups };
}

// --- Companion materials (CapCut 6.5+ creates these per-segment) ---

interface CompanionRefs {
  ids: string[];
  materials: Array<{ type: string; data: Record<string, unknown> }>;
}

export function createCompanionMaterials(trackType: "text" | "video" | "audio" | "sticker" | "effect"): CompanionRefs {
  const speed = { id: uuid(), type: "speed", speed: 1, mode: 0, curve_speed: null };
  const placeholder = {
    id: uuid(),
    type: "placeholder_info",
    error_path: "",
    error_text: "",
    meta_type: "none",
    res_path: "",
    res_text: "",
  };
  const scm = {
    id: uuid(),
    type: "none",
    audio_channel_mapping: 0,
    is_config_open: false,
  };
  const vocal = {
    id: uuid(),
    type: "vocal_separation",
    choice: 0,
    enter_from: "",
    final_algorithm: "",
    production_path: "",
    removed_sounds: [],
    time_range: null,
  };

  const refs: CompanionRefs = {
    ids: [speed.id, placeholder.id, scm.id, vocal.id],
    materials: [
      { type: "speeds", data: speed },
      { type: "placeholder_infos", data: placeholder },
      { type: "sound_channel_mappings", data: scm },
      { type: "vocal_separations", data: vocal },
    ],
  };

  if (trackType === "video" || trackType === "sticker") {
    const canvas = {
      id: uuid(),
      type: "canvas_color",
      album_image: "",
      blur: 0,
      color: "",
      image: "",
      image_id: "",
      image_name: "",
      source_platform: 0,
      team_id: "",
    };
    const matColor = {
      id: uuid(),
      type: "material_color",
      gradient_angle: 90,
      gradient_colors: [],
      gradient_percents: [],
      height: 0,
      is_color_clip: false,
      is_gradient: false,
      solid_color: "",
      width: 0,
    };
    refs.ids.push(canvas.id, matColor.id);
    refs.materials.push({ type: "canvases", data: canvas }, { type: "material_colors", data: matColor });
  }

  // Effect track segments don't take the full companion set — their segment
  // references are the effect material itself (see addEffect).
  if (trackType === "effect") {
    return { ids: [], materials: [] };
  }

  return refs;
}

export function registerCompanions(draft: Draft, companions: CompanionRefs): void {
  for (const { type, data } of companions.materials) {
    if (!draft.materials[type]) draft.materials[type] = [];
    draft.materials[type].push(data);
  }
}

// --- Base segment ---

function baseSegment(
  id: string,
  materialId: string,
  trackId: string,
  timerange: Timerange,
  companionIds: string[],
  renderIndex: number,
): Segment {
  return {
    id,
    material_id: materialId,
    raw_segment_id: trackId,
    target_timerange: { ...timerange },
    source_timerange: { start: 0, duration: timerange.duration },
    speed: 1,
    volume: 1,
    visible: true,
    reverse: false,
    clip: {
      alpha: 1,
      rotation: 0,
      scale: { x: 1, y: 1 },
      transform: { x: 0, y: 0 },
      flip: { horizontal: false, vertical: false },
    },
    render_index: renderIndex,
    track_render_index: 0,
    track_attribute: 0,
    extra_material_refs: companionIds,
    common_keyframes: [],
    keyframe_refs: [],
  } as unknown as Segment;
}

// --- Text ---

export interface AddTextOptions {
  text: string;
  start: number; // microseconds
  duration: number; // microseconds
  fontSize?: number;
  color?: string; // hex "#RRGGBB"
  alignment?: number; // 0=left, 1=center, 2=right
  x?: number; // -1 to 1
  y?: number; // -1 to 1
  trackName?: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

function buildTextContent(text: string, fontSize: number, color: [number, number, number]): string {
  const encoded = Buffer.from(text, "utf16le");
  return JSON.stringify({
    styles: [
      {
        range: [0, encoded.length],
        size: fontSize,
        bold: false,
        italic: false,
        underline: false,
        fill: {
          alpha: 1,
          content: {
            render_type: "solid",
            solid: { alpha: 1, color },
          },
        },
      },
    ],
    text,
  });
}

// Fields on a text material that describe *styling* (not content or timing).
// Used by import-srt --style-ref to mirror an existing caption's look, and by
// make-preset (src/preset.ts) as the set of material fields a preset carries.
export const STYLE_FIELDS = [
  "alignment",
  "font_size",
  "text_color",
  "typesetting",
  "letter_spacing",
  "line_spacing",
  "line_feed",
  "line_max_width",
  "force_apply_line_max_width",
  "fixed_width",
  "fixed_height",
  "text_alpha",
  "has_shadow",
  "shadow_alpha",
  "shadow_angle",
  "shadow_color",
  "shadow_distance",
  "shadow_smoothing",
  "has_border",
  "border_width",
  "border_color",
  "border_alpha",
  "has_text_shadow_config",
  "background_color",
  "background_alpha",
  "background_style",
  "background_round_radius",
  "background_width",
  "background_height",
  "background_horizontal_offset",
  "background_vertical_offset",
  "font_id",
  "font_name",
  "font_path",
  "font_resource_id",
  "bold",
  "italic",
  "underline",
] as const;

export function copyTextStyle(
  draft: Draft,
  refSegmentId: string,
  targetMaterialId: string,
  opts: { keepFillColor?: boolean } = {},
): void {
  const refSeg = findSegment(draft, refSegmentId)?.segment;
  if (!refSeg) throw new Error(`Style-ref segment not found: ${refSegmentId}`);
  const texts = draft.materials.texts as unknown as Array<Record<string, unknown>>;
  const refMat = texts.find((t) => t.id === refSeg.material_id);
  const tgtMat = texts.find((t) => t.id === targetMaterialId);
  if (!refMat) throw new Error(`Style-ref is not a text segment: ${refSegmentId}`);
  if (!tgtMat) throw new Error(`Target material not found: ${targetMaterialId}`);
  for (const f of STYLE_FIELDS) {
    if (opts.keepFillColor && f === "text_color") continue;
    if (refMat[f] !== undefined) tgtMat[f] = refMat[f];
  }
  // Mirror the fill color encoded inside `content`'s styles[0] too — CapCut
  // renders from that. Preserve the new cue's text, and with keepFillColor
  // (import-srt --color-cycle) the cue's already-written fill colour.
  if (typeof refMat.content === "string" && typeof tgtMat.content === "string") {
    try {
      const refC = JSON.parse(refMat.content) as { styles?: Array<Record<string, unknown>>; text?: string };
      const tgtC = JSON.parse(tgtMat.content) as { styles?: Array<Record<string, unknown>>; text?: string };
      if (refC.styles && refC.styles.length > 0 && tgtC.styles && tgtC.styles.length > 0) {
        const preservedRange = tgtC.styles[0].range;
        const preservedFill = opts.keepFillColor ? tgtC.styles[0].fill : undefined;
        tgtC.styles[0] = { ...refC.styles[0], range: preservedRange };
        if (preservedFill !== undefined) tgtC.styles[0].fill = preservedFill;
        tgtMat.content = JSON.stringify(tgtC);
      }
    } catch {
      /* keep new content */
    }
  }
}

export function addText(
  draft: Draft,
  _filePath: string,
  opts: AddTextOptions,
): { segmentId: string; materialId: string; trackId: string } {
  const segId = uuid();
  const matId = uuid();
  const fontSize = opts.fontSize ?? 15;
  const color = opts.color ?? "#FFFFFF";
  const rgb = hexToRgb(color);
  const alignment = opts.alignment ?? 1;
  const trackName = opts.trackName ?? "text";

  // Find or create text track
  let track = draft.tracks.find((t) => t.type === "text" && (t.name === trackName || !opts.trackName));
  if (!track) {
    track = makeTrack("text", trackName, false);
    draft.tracks.push(track);
  }

  // Create companion materials
  const companions = createCompanionMaterials("text");
  registerCompanions(draft, companions);

  // Create text material
  const textMaterial = {
    id: matId,
    type: "text",
    content: buildTextContent(opts.text, fontSize, rgb),
    alignment,
    font_size: fontSize,
    text_color: color,
    typesetting: 0,
    letter_spacing: 0,
    line_spacing: 0.02,
    line_feed: 1,
    line_max_width: 0.82,
    force_apply_line_max_width: false,
    check_flag: 7,
    fixed_width: -1,
    fixed_height: -1,
  };
  (draft.materials.texts as unknown as Array<Record<string, unknown>>).push(textMaterial);

  // Create segment
  const timerange: Timerange = { start: opts.start, duration: opts.duration };
  const seg = baseSegment(segId, matId, track.id, timerange, companions.ids, 15000);
  if (opts.x !== undefined || opts.y !== undefined) {
    (seg.clip as NonNullable<typeof seg.clip>).transform = { x: opts.x ?? 0, y: opts.y ?? 0 };
  }
  track.segments.push(seg);

  return { segmentId: segId, materialId: matId, trackId: track.id };
}

// --- Audio ---

export interface AddAudioOptions {
  path: string; // absolute path to audio file
  start: number; // microseconds
  duration: number; // microseconds (0 = use file duration)
  volume?: number; // 0.0-1.0, default 1.0
  trackName?: string; // default "audio"
  // Placeholder clip (import-timeline: MissingReference / media not on disk):
  // skip the assets copy and reference `path` verbatim ("" or a broken path),
  // with `name` as the display name — the replace-media workflow swaps it later.
  placeholder?: { path: string; name: string };
}

export function addAudio(
  draft: Draft,
  filePath: string,
  opts: AddAudioOptions,
): { segmentId: string; materialId: string; trackId: string } {
  const segId = uuid();
  const matId = uuid();
  const trackName = opts.trackName ?? "audio";
  const volume = opts.volume ?? 1.0;

  // Copy file into draft assets directory (collision-safe). Placeholder clips
  // reference their (possibly empty/broken) path verbatim — nothing to copy.
  const draftDir = dirname(filePath);
  const assetsDir = resolve(draftDir, "assets", "audio");
  const destPath = opts.placeholder ? opts.placeholder.path : copyAssetDeduped(opts.path, assetsDir, "audio.mp3");
  // Use the local assets path — CapCut rewrites to placeholder on open
  const localPath = destPath;
  const filename = opts.placeholder ? opts.placeholder.name : basename(localPath);

  // Find or create audio track
  let track = draft.tracks.find((t) => t.type === "audio" && t.name === trackName);
  if (!track) {
    track = makeTrack("audio", trackName, false);
    draft.tracks.push(track);
  }

  // Create companion materials
  const companions = createCompanionMaterials("audio");
  registerCompanions(draft, companions);

  // Create audio material
  const audioMaterial = {
    id: matId,
    path: localPath,
    name: filename,
    duration: opts.duration,
    type: "extract_music",
    category_id: "",
    category_name: "local",
    check_flag: 1,
    music_id: "",
    request_id: "",
    source_platform: 0,
    team_id: "",
    text_id: "",
    tone_category_id: "",
    tone_category_name: "",
    tone_effect_id: "",
    tone_effect_name: "",
    tone_platform: "",
    tone_second_category_id: "",
    tone_second_category_name: "",
    tone_speaker: "",
    tone_type: "",
    wave_points: [],
  };
  (draft.materials.audios as unknown as Array<Record<string, unknown>>).push(audioMaterial);

  // Create segment
  const timerange: Timerange = { start: opts.start, duration: opts.duration };
  const seg = baseSegment(segId, matId, track.id, timerange, companions.ids, 11000);
  seg.volume = volume;
  track.segments.push(seg);

  // Update project duration if needed
  const segEnd = opts.start + opts.duration;
  if (segEnd > draft.duration) {
    draft.duration = segEnd;
  }

  return { segmentId: segId, materialId: matId, trackId: track.id };
}

// --- Video / Image ---

export interface AddVideoOptions {
  path: string; // absolute path to video/image file
  start: number; // microseconds
  duration: number; // microseconds
  type?: "video" | "photo"; // default: inferred from extension
  width?: number; // default 1920
  height?: number; // default 1080
  trackName?: string; // default "video"
  // Placeholder clip (import-timeline: MissingReference / media not on disk):
  // skip the assets copy and reference `path` verbatim ("" or a broken path),
  // with `name` as the display name — the replace-media workflow swaps it later.
  placeholder?: { path: string; name: string };
}

export function addVideo(
  draft: Draft,
  filePath: string,
  opts: AddVideoOptions,
): { segmentId: string; materialId: string; trackId: string } {
  const segId = uuid();
  const matId = uuid();
  const trackName = opts.trackName ?? "video";
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;

  // Infer type from extension if not provided
  const ext = opts.path.split(".").pop()?.toLowerCase() || "";
  const materialType = opts.type ?? (["jpg", "jpeg", "png", "webp", "bmp", "tiff"].includes(ext) ? "photo" : "video");

  // Copy file into draft assets directory (collision-safe). Placeholder clips
  // reference their (possibly empty/broken) path verbatim — nothing to copy.
  const draftDir = dirname(filePath);
  const assetsDir = resolve(draftDir, "assets", "video");
  const destPath = opts.placeholder ? opts.placeholder.path : copyAssetDeduped(opts.path, assetsDir, "media");
  // Use the local assets path — CapCut rewrites to placeholder on open
  const localPath = destPath;
  const filename = opts.placeholder ? opts.placeholder.name : basename(localPath);

  // Find or create video track
  let track = draft.tracks.find((t) => t.type === "video" && t.name === trackName);
  if (!track) {
    track = makeTrack("video", trackName, false);
    draft.tracks.push(track);
  }

  // Create companion materials
  const companions = createCompanionMaterials("video");
  registerCompanions(draft, companions);

  // Create video material
  const videoMaterial = {
    id: matId,
    path: localPath,
    material_name: filename,
    type: materialType,
    duration: opts.duration,
    width,
    height,
    category_id: "",
    category_name: "local",
    check_flag: 7,
    crop: {
      lower_left_x: 0,
      lower_left_y: 1,
      lower_right_x: 1,
      lower_right_y: 1,
      upper_left_x: 0,
      upper_left_y: 0,
      upper_right_x: 1,
      upper_right_y: 0,
    },
    has_audio: materialType === "video",
    extra_type_option: 0,
    formula_id: "",
    freeze: null,
    intensifies_audio_path: "",
    intensifies_path: "",
    is_ai_generate_content: false,
    is_copyright: false,
    is_text_edit_overdub: false,
    is_unified_beauty_mode: false,
    local_id: "",
    local_material_id: "",
    material_url: "",
    media_path: "",
    object_locked: null,
    origin_material_id: "",
    request_id: "",
    reverse_path: "",
    source_platform: 0,
    stable: { matrix_path: "", stable_level: 0, time_range: { duration: 0, start: 0 } },
    team_id: "",
    video_algorithm: {
      algorithms: [],
      deflicker: null,
      motion_blur_config: null,
      noise_reduction: null,
      path: "",
      quality_enhance: null,
      time_range: null,
    },
  };
  (draft.materials.videos as unknown as Array<Record<string, unknown>>).push(videoMaterial);

  // Create segment
  const timerange: Timerange = { start: opts.start, duration: opts.duration };
  const seg = baseSegment(segId, matId, track.id, timerange, companions.ids, 14000);
  track.segments.push(seg);

  // Update project duration if needed
  const segEnd = opts.start + opts.duration;
  if (segEnd > draft.duration) {
    draft.duration = segEnd;
  }

  return { segmentId: segId, materialId: matId, trackId: track.id };
}

// --- Cut (extract time range) ---

export interface CutOptions {
  start: number; // microseconds
  end: number; // microseconds
}

export function cutProject(draft: Draft, opts: CutOptions): { kept: number; removed: number } {
  const { start, end } = opts;
  const duration = end - start;
  let kept = 0;
  let removed = 0;

  // Collect material IDs to remove
  const removedMaterialIds = new Set<string>();
  const removedExtraRefs = new Set<string>();

  for (const track of draft.tracks) {
    const surviving: typeof track.segments = [];

    for (const seg of track.segments) {
      const segStart = seg.target_timerange.start;
      const segEnd = segStart + seg.target_timerange.duration;

      // Skip segments entirely outside the range
      if (segEnd <= start || segStart >= end) {
        removedMaterialIds.add(seg.material_id);
        for (const ref of seg.extra_material_refs) removedExtraRefs.add(ref);
        removed++;
        continue;
      }

      // Clip segment to range
      const clippedStart = Math.max(segStart, start);
      const clippedEnd = Math.min(segEnd, end);
      const trimFromStart = clippedStart - segStart;
      const newDuration = clippedEnd - clippedStart;

      // Adjust source_timerange for the trim
      if (seg.source_timerange) {
        seg.source_timerange.start += Math.round(trimFromStart * seg.speed);
        seg.source_timerange.duration = Math.round(newDuration * seg.speed);
      }

      seg.target_timerange.start = clippedStart - start; // rebase to 0
      seg.target_timerange.duration = newDuration;

      surviving.push(seg);
      kept++;
    }

    track.segments = surviving;
  }

  // Remove empty tracks
  draft.tracks = draft.tracks.filter((t) => t.segments.length > 0);

  // Clean up orphaned materials (only if not referenced by surviving segments)
  const survivingMatIds = new Set<string>();
  const survivingExtraRefs = new Set<string>();
  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      survivingMatIds.add(seg.material_id);
      for (const ref of seg.extra_material_refs) survivingExtraRefs.add(ref);
    }
  }

  for (const [key, arr] of Object.entries(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    draft.materials[key] = arr.filter((m: Record<string, unknown>) => {
      if (!m || typeof m.id !== "string") return true;
      const id = m.id as string;
      // Keep if referenced by any surviving segment
      if (survivingMatIds.has(id) || survivingExtraRefs.has(id)) return true;
      // Remove if only referenced by removed segments
      if (removedMaterialIds.has(id) || removedExtraRefs.has(id)) return false;
      // Keep anything not directly tracked (safety)
      return true;
    });
  }

  // Update project duration
  draft.duration = duration;

  return { kept, removed };
}

// --- Remove (single segment) ---

/**
 * Orphan-material GC shared by `prune` and `remove`: drop every material entry
 * that no surviving segment references via material_id or extra_material_refs
 * (the latter is what keeps masks/effects/animations/fades from being wrongly
 * deleted). Entries without a string id are kept (can't prove they're
 * orphaned). Behavior-identical extraction of the original cmdPrune loop; the
 * caller decides whether a nonzero `removed` warrants a save.
 */
export function pruneOrphanMaterials(draft: Draft): {
  removed: number;
  byType: Record<string, { removed: number; kept: number }>;
} {
  const referenced = new Set<string>();
  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      if (seg.material_id) referenced.add(seg.material_id);
      for (const ref of seg.extra_material_refs ?? []) referenced.add(ref);
    }
  }
  const byType: Record<string, { removed: number; kept: number }> = {};
  let removedTotal = 0;
  for (const [type, arr] of Object.entries(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    const before = arr.length;
    const kept = arr.filter((m) => {
      const id = (m as { id?: unknown }).id;
      // Keep anything without a string id (can't prove it's orphaned) or that is referenced.
      return typeof id !== "string" || referenced.has(id);
    });
    const removed = before - kept.length;
    if (removed > 0) (draft.materials as Record<string, unknown[]>)[type] = kept;
    byType[type] = { removed, kept: kept.length };
    removedTotal += removed;
  }
  return { removed: removedTotal, byType };
}

export interface RemoveSegmentOptions {
  keepTrack?: boolean;
  keepMaterials?: boolean;
}

export interface RemoveSegmentResult {
  segmentId: string;
  trackId: string;
  trackName: string;
  trackType: string;
  trackRemoved: boolean;
  materialsRemoved: number;
  materialsByType: Record<string, { removed: number; kept: number }>;
  durationBefore: number;
  durationAfter: number;
}

/**
 * Remove one segment in place: splice it out of its track, drop the track when
 * it becomes empty (unless keepTrack — cutProject already removes empty tracks
 * wholesale, so CapCut tolerates it), GC newly-orphaned materials with the same
 * conservative sweep prune uses (unless keepMaterials; a material any surviving
 * segment still references is never deleted), and recompute draft.duration as
 * the max segment end across ALL tracks (0 when no segments remain, same as a
 * fresh init draft).
 */
export function removeSegment(draft: Draft, segId: string, opts: RemoveSegmentOptions = {}): RemoveSegmentResult {
  const found = findSegment(draft, segId);
  if (!found) throw new Error(`Segment not found: ${segId}`);
  const { track, segment, index } = found;
  const durationBefore = draft.duration;

  track.segments.splice(index, 1);
  let trackRemoved = false;
  if (track.segments.length === 0 && !opts.keepTrack) {
    draft.tracks = draft.tracks.filter((t) => t !== track);
    trackRemoved = true;
  }

  let materialsRemoved = 0;
  let materialsByType: Record<string, { removed: number; kept: number }> = {};
  if (!opts.keepMaterials) {
    const swept = pruneOrphanMaterials(draft);
    materialsRemoved = swept.removed;
    materialsByType = swept.byType;
  }

  let maxEnd = 0;
  for (const t of draft.tracks) {
    for (const seg of t.segments) {
      const end = seg.target_timerange.start + seg.target_timerange.duration;
      if (end > maxEnd) maxEnd = end;
    }
  }
  draft.duration = maxEnd;

  return {
    segmentId: segment.id,
    trackId: track.id,
    trackName: track.name,
    trackType: track.type,
    trackRemoved,
    materialsRemoved,
    materialsByType,
    durationBefore,
    durationAfter: maxEnd,
  };
}

// --- Templates ---

export interface Template {
  name: string;
  type: string; // track type: "text", "sticker", "video", "audio"
  segment: Record<string, unknown>;
  material: { type: string; data: Record<string, unknown> };
  extra_materials: Array<{ type: string; data: Record<string, unknown> }>;
}

export function saveTemplate(draft: Draft, segId: string, name: string, outPath: string): Template {
  const shortId = segId.toLowerCase();
  let foundSeg: Segment | null = null;
  let foundTrack: Track | null = null;

  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      if (seg.id === segId || seg.id.toLowerCase().startsWith(shortId)) {
        foundSeg = seg;
        foundTrack = track;
        break;
      }
    }
    if (foundSeg) break;
  }

  if (!foundSeg || !foundTrack) throw new Error(`Segment not found: ${segId}`);

  // Resolve primary material
  const mat = findMaterialGlobal(draft, foundSeg.material_id);
  if (!mat) throw new Error(`Material not found for segment: ${segId}`);

  // Resolve extra material refs
  const extras: Array<{ type: string; data: Record<string, unknown> }> = [];
  for (const refId of foundSeg.extra_material_refs) {
    const extra = findMaterialGlobal(draft, refId);
    if (extra) extras.push({ type: extra.type, data: { ...extra.material } });
  }

  const template: Template = {
    name,
    type: foundTrack.type,
    segment: { ...foundSeg } as unknown as Record<string, unknown>,
    material: { type: mat.type, data: { ...mat.material } },
    extra_materials: extras,
  };

  writeFileSync(outPath, JSON.stringify(template, null, 2), "utf-8");
  return template;
}

export function applyTemplate(
  draft: Draft,
  templatePath: string,
  start: number,
  duration: number,
  overrides?: { x?: number; y?: number; scaleX?: number; scaleY?: number; text?: string },
): { segmentId: string; materialId: string; trackId: string } {
  const template = JSON.parse(stripBom(readFileSync(templatePath, "utf-8"))) as Template;

  // Generate new IDs for everything
  const idMap = new Map<string, string>();

  function remapId(oldId: string): string {
    if (!idMap.has(oldId)) idMap.set(oldId, uuid());
    return idMap.get(oldId)!;
  }

  const newSegId = uuid();
  const newMatId = uuid();

  // Clone and remap the material
  const newMat = deepCloneWithIdRemap(template.material.data, remapId);
  newMat.id = newMatId;

  // If text and override provided, update content
  if (overrides?.text && template.type === "text" && typeof newMat.content === "string") {
    try {
      const parsed = JSON.parse(newMat.content as string);
      if (parsed.text !== undefined) {
        parsed.text = overrides.text;
        if (parsed.styles && parsed.styles.length > 0) {
          const encoded = Buffer.from(overrides.text, "utf16le");
          parsed.styles[0].range = [0, encoded.length];
        }
        newMat.content = JSON.stringify(parsed);
      }
    } catch {
      /* keep original content */
    }
  }

  // Register primary material
  if (!draft.materials[template.material.type]) draft.materials[template.material.type] = [];
  draft.materials[template.material.type].push(newMat);

  // Clone and register extra materials
  const newExtraIds: string[] = [];
  for (const extra of template.extra_materials) {
    const newExtra = deepCloneWithIdRemap(extra.data, remapId);
    newExtraIds.push(newExtra.id as string);
    if (!draft.materials[extra.type]) draft.materials[extra.type] = [];
    draft.materials[extra.type].push(newExtra);
  }

  // Also add companion materials if the template didn't have them
  if (newExtraIds.length === 0) {
    const companions = createCompanionMaterials(template.type as "text" | "video" | "audio");
    registerCompanions(draft, companions);
    newExtraIds.push(...companions.ids);
  }

  // Find or create track
  let track = draft.tracks.find((t) => t.type === template.type);
  if (!track) {
    track = makeTrack(template.type, template.name || template.type, true);
    draft.tracks.push(track);
  }

  // Clone segment with new IDs and timing
  const newSeg = { ...template.segment } as Record<string, unknown>;
  newSeg.id = newSegId;
  newSeg.material_id = newMatId;
  newSeg.raw_segment_id = track.id;
  newSeg.target_timerange = { start, duration };
  if (template.segment.source_timerange) {
    newSeg.source_timerange = { start: 0, duration };
  }
  newSeg.extra_material_refs = newExtraIds;

  // Apply position/scale overrides
  if (overrides && newSeg.clip && typeof newSeg.clip === "object") {
    const clip = newSeg.clip as Record<string, unknown>;
    if (overrides.x !== undefined || overrides.y !== undefined) {
      clip.transform = {
        x: overrides.x ?? (clip.transform as Record<string, number>)?.x ?? 0,
        y: overrides.y ?? (clip.transform as Record<string, number>)?.y ?? 0,
      };
    }
    if (overrides.scaleX !== undefined || overrides.scaleY !== undefined) {
      clip.scale = {
        x: overrides.scaleX ?? (clip.scale as Record<string, number>)?.x ?? 1,
        y: overrides.scaleY ?? (clip.scale as Record<string, number>)?.y ?? 1,
      };
    }
  }

  track.segments.push(newSeg as unknown as Segment);

  return { segmentId: newSegId, materialId: newMatId, trackId: track.id };
}

function deepCloneWithIdRemap(obj: Record<string, unknown>, remapId: (old: string) => string): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  // Remap the id field
  if (typeof clone.id === "string") {
    clone.id = remapId(clone.id as string);
  }
  return clone;
}

// --- Duplicate (issue #44: PIP local retouch — copy a clip above itself) ---

export interface DuplicateSegmentOptions {
  /** Place the copy onto this existing same-type track instead of creating one. */
  trackName?: string;
}

export interface DuplicateSegmentResult {
  segmentId: string;
  sourceSegmentId: string;
  materialId: string;
  trackId: string;
  trackName: string;
  createdTrack: boolean;
  clonedMaterials: Array<{ type: string; id: string; source_id: string }>;
}

// Every material entry is per-segment state, including videos/audios: the
// media FILE on disk stays shared, but the entry must be cloned so
// material-level edits (crop, mix-mode, replace-media) on the copy never
// leak to the source segment underneath it.

/**
 * Duplicate a segment at the SAME timeline position/duration onto a track that
 * renders above the source. Default: a fresh same-type track inserted directly
 * after the source track — sortTracks is stable within a type and a later
 * same-type track renders ABOVE, so the copy sits exactly on top of its
 * source. With `trackName`, the copy goes onto that existing same-type track
 * instead; occupied target range / missing track / type mismatch all throw.
 */
export function duplicateSegment(
  draft: Draft,
  segId: string,
  opts: DuplicateSegmentOptions = {},
): DuplicateSegmentResult {
  const found = findSegment(draft, segId);
  if (!found) throw new Error(`Segment not found: ${segId}`);
  const { track: sourceTrack, segment: sourceSeg } = found;
  const { start, duration } = sourceSeg.target_timerange;

  const primary = findMaterialGlobal(draft, sourceSeg.material_id);
  if (!primary) throw new Error(`Material not found for segment: ${segId}`);

  let track: Track;
  let createdTrack = false;
  if (opts.trackName !== undefined) {
    const target = draft.tracks.find((t) => t.name === opts.trackName);
    if (!target) throw new Error(`Track not found: ${opts.trackName}`);
    if (target.type !== sourceTrack.type) {
      throw new Error(
        `Track "${opts.trackName}" is a ${target.type} track; the copy of a ${sourceTrack.type} segment needs a ${sourceTrack.type} track.`,
      );
    }
    const end = start + duration;
    const blocking = target.segments.find(
      (s) => s.target_timerange.start < end && s.target_timerange.start + s.target_timerange.duration > start,
    );
    if (blocking) {
      throw new Error(
        `Track "${opts.trackName}" is occupied over ${start}us-${end}us (segment ${blocking.id}). ` +
          "Pick a track that is free at that range, or omit --track to create a new one above the source.",
      );
    }
    track = target;
  } else {
    const names = new Set(draft.tracks.map((t) => t.name));
    let name = `${sourceTrack.name}-copy`;
    for (let n = 2; names.has(name); n++) name = `${sourceTrack.name}-copy-${n}`;
    track = makeTrack(sourceTrack.type, name, false);
    draft.tracks.splice(draft.tracks.indexOf(sourceTrack) + 1, 0, track);
    createdTrack = true;
  }

  const newSeg = structuredClone(sourceSeg);
  newSeg.id = uuid();
  newSeg.raw_segment_id = track.id;
  const clonedMaterials: DuplicateSegmentResult["clonedMaterials"] = [];

  const primaryClone = structuredClone(primary.material);
  primaryClone.id = uuid();
  draft.materials[primary.type].push(primaryClone);
  newSeg.material_id = primaryClone.id as string;
  clonedMaterials.push({ type: primary.type, id: primaryClone.id as string, source_id: sourceSeg.material_id });

  // Per-segment companions referenced via extra_material_refs (speed,
  // placeholder_info, sound_channel_mapping, vocal_separation, canvas,
  // material_color, masks, animations, ...) are cloned with fresh ids —
  // mirroring createCompanionMaterials, which never shares one instance
  // between two segments. Dangling refs are dropped, not copied.
  const newRefs: string[] = [];
  for (const refId of sourceSeg.extra_material_refs ?? []) {
    const extra = findMaterialGlobal(draft, refId);
    if (!extra) continue;
    const clone = structuredClone(extra.material);
    clone.id = uuid();
    draft.materials[extra.type].push(clone);
    newRefs.push(clone.id as string);
    clonedMaterials.push({ type: extra.type, id: clone.id as string, source_id: refId });
  }
  newSeg.extra_material_refs = newRefs;

  // Keyframe lists/entries live embedded in the segment; re-mint their ids on
  // the copy with the same uuidHex scheme addKeyframes writes.
  if (Array.isArray(newSeg.common_keyframes)) {
    for (const list of newSeg.common_keyframes as Array<Record<string, unknown>>) {
      if (typeof list.id === "string") list.id = uuidHex();
      if (Array.isArray(list.keyframe_list)) {
        for (const kf of list.keyframe_list as Array<Record<string, unknown>>) {
          if (typeof kf.id === "string") kf.id = uuidHex();
        }
      }
    }
  }

  track.segments.push(newSeg);

  return {
    segmentId: newSeg.id,
    sourceSegmentId: sourceSeg.id,
    materialId: newSeg.material_id,
    trackId: track.id,
    trackName: track.name,
    createdTrack,
    clonedMaterials,
  };
}

// --- Sticker ---

export interface AddStickerOptions {
  resourceId: string;
  start: number;
  duration: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  trackName?: string;
}

export function addSticker(
  draft: Draft,
  opts: AddStickerOptions,
): { segmentId: string; materialId: string; trackId: string } {
  const segId = uuid();
  const matId = uuid();
  const trackName = opts.trackName ?? "sticker";

  let track = draft.tracks.find((t) => t.type === "sticker" && t.name === trackName);
  if (!track) {
    track = makeTrack("sticker", trackName, !opts.trackName);
    draft.tracks.push(track);
  }

  const companions = createCompanionMaterials("sticker");
  registerCompanions(draft, companions);

  const stickerMaterial = {
    id: matId,
    resource_id: opts.resourceId,
    sticker_id: opts.resourceId,
    source_platform: 1,
    type: "sticker",
  };
  if (!Array.isArray(draft.materials.stickers)) draft.materials.stickers = [];
  (draft.materials.stickers as Array<Record<string, unknown>>).push(stickerMaterial);

  const timerange: Timerange = { start: opts.start, duration: opts.duration };
  const seg = baseSegment(segId, matId, track.id, timerange, companions.ids, 14000);
  const scale = opts.scale ?? 1;
  const clip = seg.clip as NonNullable<typeof seg.clip>;
  clip.transform = { x: opts.x ?? 0, y: opts.y ?? 0 };
  clip.scale = { x: scale, y: scale };
  clip.rotation = opts.rotation ?? 0;
  track.segments.push(seg);

  return { segmentId: segId, materialId: matId, trackId: track.id };
}

// --- Effect (track-global scene/character effect) ---

interface VideoEffectMeta {
  name: string;
  effect_id: string;
  resource_id: string;
  effect_type: "video_effect" | "face_effect";
}

// Small starter catalogue — expand via Phase 3 enum extraction. Every slug is
// kebab-case; the effect_id/resource_id come from CapCutAPI metadata or the
// upstream `capcut_effect_meta.py` exports.
const VIDEO_EFFECTS: Record<string, VideoEffectMeta> = {
  shake: {
    name: "Shake",
    effect_id: "7061205058364788270",
    resource_id: "7061205058364788270",
    effect_type: "video_effect",
  },
  vhs: {
    name: "VHS",
    effect_id: "6706773500257242119",
    resource_id: "6706773500257242119",
    effect_type: "video_effect",
  },
  cinematic: {
    name: "Cinematic",
    effect_id: "7102283971168211981",
    resource_id: "7102283971168211981",
    effect_type: "video_effect",
  },
  "light-leak": {
    name: "Light Leak",
    effect_id: "7039726019823718926",
    resource_id: "7039726019823718926",
    effect_type: "video_effect",
  },
  "film-grain": {
    name: "Film Grain",
    effect_id: "6921123676029981197",
    resource_id: "6921123676029981197",
    effect_type: "video_effect",
  },
  chromatic: {
    name: "Chromatic",
    effect_id: "7069620856462184973",
    resource_id: "7069620856462184973",
    effect_type: "video_effect",
  },
  vignette: {
    name: "Vignette",
    effect_id: "6710812571147752967",
    resource_id: "6710812571147752967",
    effect_type: "video_effect",
  },
};

export function effectSlugs(): string[] {
  return Object.keys(VIDEO_EFFECTS);
}

// Exposed so lint's unknown-effect-slug check recognises the inline starter
// catalogue: these effect_ids are knossos-verified but absent from enums.json.
export function effectCatalogue(): Array<{
  slug: string;
  member: string;
  name: string;
  effect_id: string;
  resource_id: string;
}> {
  return Object.entries(VIDEO_EFFECTS).map(([slug, meta]) => ({
    slug,
    member: meta.name,
    name: meta.name,
    effect_id: meta.effect_id,
    resource_id: meta.resource_id,
  }));
}

export interface AddEffectOptions {
  slug: string;
  start: number;
  duration: number;
  params?: number[];
  trackName?: string;
  namespace?: Namespace;
  /** Raw store/catalogue resource ID — skips slug lookup; `slug` becomes the display name. */
  resourceId?: string;
  /** Raw effect ID; defaults to `resourceId`. Only meaningful with `resourceId`. */
  effectId?: string;
  /** Effect strength 0..1 (material `value`); default 1. */
  intensity?: number;
  /** Experimental: bind the effect to one segment (`apply_target_type: 0`) instead of the whole frame. */
  bindSegmentId?: string;
}

// addEffect/addFilter share their track plumbing. The uuid() order is
// load-bearing — segment, then material, then track — because drafts are
// compared byte-for-byte.
function effectTrackSlot(
  draft: Draft,
  type: "effect" | "filter",
  trackNameOpt: string | undefined,
): { segId: string; matId: string; track: Track } {
  const segId = uuid();
  const matId = uuid();
  const trackName = trackNameOpt ?? type;

  let track = draft.tracks.find((t) => t.type === type && t.name === trackName);
  if (!track) {
    track = makeTrack(type, trackName, !trackNameOpt);
    draft.tracks.push(track);
  }
  return { segId, matId, track };
}

// Effect/filter track segments: no clip, no speed, no companions — just the
// segment pointing at the material with a target_timerange. Registers the
// material first, so both land in the same order addEffect always wrote them.
function pushEffectSegment(
  draft: Draft,
  slot: { segId: string; matId: string; track: Track },
  material: Record<string, unknown>,
  range: { start: number; duration: number },
  name: string,
): { segmentId: string; materialId: string; trackId: string; name: string } {
  if (!Array.isArray(draft.materials.video_effects)) draft.materials.video_effects = [];
  (draft.materials.video_effects as Array<Record<string, unknown>>).push(material);

  const seg: Segment = {
    id: slot.segId,
    material_id: slot.matId,
    raw_segment_id: slot.track.id,
    target_timerange: { start: range.start, duration: range.duration },
    source_timerange: { start: 0, duration: range.duration },
    speed: 1,
    volume: 1,
    visible: true,
    reverse: false,
    clip: null,
    render_index: 11000,
    track_render_index: 0,
    track_attribute: 0,
    extra_material_refs: [],
    common_keyframes: [],
    keyframe_refs: [],
  } as unknown as Segment;
  slot.track.segments.push(seg);

  return { segmentId: slot.segId, materialId: slot.matId, trackId: slot.track.id, name };
}

export function addEffect(
  draft: Draft,
  opts: AddEffectOptions,
): { segmentId: string; materialId: string; trackId: string; name: string } {
  // Inline (knossos-verified) entries take precedence for the capcut namespace;
  // fall back to enums.json for any slug outside the starter set. Scene effects
  // are video_effect; character effects are face_effect. --jianying skips the
  // inline layer entirely since those effect_ids are CapCut-specific.
  const ns: Namespace = opts.namespace ?? "capcut";
  // Raw-resource-id escape hatch: skip catalogue lookup entirely (explicit
  // beats implicit — a raw id wins even when the slug also exists). Raw ids
  // are scene effects (video_effect); face effects stay slug-only.
  let meta: VideoEffectMeta | null = opts.resourceId
    ? {
        name: opts.slug,
        effect_id: opts.effectId ?? opts.resourceId,
        resource_id: opts.resourceId,
        effect_type: "video_effect",
      }
    : ns === "capcut"
      ? (VIDEO_EFFECTS[opts.slug] ?? null)
      : null;
  if (!meta) {
    const scene = findEnum("scene_effects", opts.slug, ns);
    const char = scene ? null : findEnum("character_effects", opts.slug, ns);
    const hit = scene ?? char;
    if (!hit?.name || !hit.effect_id || !hit.resource_id) {
      const hint = ns === "jianying" ? " --jianying" : "";
      throw new Error(
        `Unknown effect slug: ${opts.slug}. Run 'capcut enums --scene-effects${hint}' or '--character-effects${hint}' for the full list.`,
      );
    }
    meta = {
      name: hit.name,
      effect_id: hit.effect_id,
      resource_id: hit.resource_id,
      effect_type: scene ? "video_effect" : "face_effect",
    };
  }

  // Validate --bind before mutating the draft; resolve short-prefix ids to the
  // full segment id so the written reference never dangles.
  let bindSegmentId = "";
  if (opts.bindSegmentId) {
    const bound = findSegment(draft, opts.bindSegmentId);
    if (!bound) throw new Error(`Segment not found: ${opts.bindSegmentId}`);
    bindSegmentId = bound.segment.id;
  }

  const slot = effectTrackSlot(draft, "effect", opts.trackName);

  const effectMaterial = {
    adjust_params: (opts.params || []).map((v, i) => ({ name: `param_${i}`, value: v, default_value: v })),
    // 2 = track/global scope; 0 = segment-scoped when --bind is given (fork
    // evidence only — same value upstream writes for segment-scoped bubbles).
    apply_target_type: bindSegmentId ? 0 : 2,
    apply_time_range: null,
    // Only present when bound, so the unbound path stays byte-identical.
    ...(bindSegmentId ? { bind_segment_id: bindSegmentId } : {}),
    category_id: "",
    category_name: "",
    common_keyframes: [],
    disable_effect_faces: [],
    effect_id: meta.effect_id,
    formula_id: "",
    id: slot.matId,
    name: meta.name,
    platform: "all",
    render_index: 11000,
    resource_id: meta.resource_id,
    // 1 marks store-downloaded resources (addSticker precedent); slug path
    // keeps 0 byte-for-byte.
    source_platform: opts.resourceId ? 1 : 0,
    time_range: null,
    track_render_index: 0,
    type: meta.effect_type,
    value: opts.intensity ?? 1.0,
    version: "",
  };
  return pushEffectSegment(draft, slot, effectMaterial, opts, meta.name);
}

// --- Mix mode (blend mode) on video segments ---

// CapCut blend-mode slugs → on-disk `mix_mode` enum string. The "normal" value
// clears the field, which matches CapCut's "Normal" choice in the blend picker.
export const MIX_MODES: Record<string, string> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  "soft-light": "Soft Light",
  "hard-light": "Hard Light",
  "color-dodge": "Color Dodge",
  "color-burn": "Color Burn",
  darken: "Darken",
  lighten: "Lighten",
  difference: "Difference",
  exclusion: "Exclusion",
};

export function mixModeSlugs(): string[] {
  return Object.keys(MIX_MODES);
}

export function setMixMode(
  draft: Draft,
  segmentId: string,
  mode: string,
): { segmentId: string; material_id: string; mix_mode: string } {
  const slug = mode.toLowerCase();
  if (!(slug in MIX_MODES)) {
    throw new Error(`Unknown blend mode: ${mode}. Valid: ${mixModeSlugs().join(", ")}`);
  }
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  const seg = found.segment;
  // Mix mode lives on the *video material*, not the segment. Look up by material_id.
  const videos = (draft.materials.videos ?? []) as Array<Record<string, unknown> & { id: string; type?: string }>;
  const mat = videos.find((v) => v.id === seg.material_id);
  if (!mat) {
    throw new Error(`mix-mode only applies to video/photo segments (no video material for ${segmentId})`);
  }
  if (mat.type !== "video" && mat.type !== "photo") {
    throw new Error(`mix-mode only applies to video/photo materials (got type=${mat.type})`);
  }
  const value = MIX_MODES[slug];
  mat.mix_mode = value;
  return { segmentId: seg.id, material_id: mat.id, mix_mode: value };
}

// --- Material crop ---

// Normalized crop rect in source-material space: x/y = top-left corner,
// w/h = extent, all 0..1 fractions of the source frame.
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Preset aspect ratios for `crop --ratio`. "free" restores the full frame.
const CROP_RATIOS: Record<string, number> = {
  "1:1": 1,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "4:3": 4 / 3,
  "3:4": 3 / 4,
};

export function cropPresets(): string[] {
  return ["free", ...Object.keys(CROP_RATIOS)];
}

// Centered maximal crop of `preset` aspect against a width x height source.
export function cropRectForRatio(width: number, height: number, preset: string): CropRect {
  if (preset === "free") return { x: 0, y: 0, w: 1, h: 1 };
  const ratio = CROP_RATIOS[preset];
  if (!ratio) throw new Error(`Unknown ratio: ${preset}. Valid: ${cropPresets().join(", ")}`);
  if (!(width > 0) || !(height > 0)) {
    throw new Error(
      `Source material has no stored width/height, so --ratio cannot be computed. Pass an explicit --rect <x,y,w,h> instead.`,
    );
  }
  const source = width / height;
  // Target wider than the source: keep full width, shrink height. Else inverse.
  const w = ratio >= source ? 1 : ratio / source;
  const h = ratio >= source ? source / ratio : 1;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

// The crop lives on the *video material*, not the segment (same as mix-mode).
function findCropMaterial(
  draft: Draft,
  segmentId: string,
): { seg: Segment; mat: Record<string, unknown> & { id: string; type?: string } } {
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  const seg = found.segment;
  const videos = (draft.materials.videos ?? []) as Array<Record<string, unknown> & { id: string; type?: string }>;
  const mat = videos.find((v) => v.id === seg.material_id);
  if (!mat) {
    throw new Error(`crop only applies to video/photo segments (no video material for ${segmentId})`);
  }
  if (mat.type !== "video" && mat.type !== "photo") {
    throw new Error(`crop only applies to video/photo materials (got type=${mat.type})`);
  }
  return { seg, mat };
}

export function getCrop(
  draft: Draft,
  segmentId: string,
): {
  segmentId: string;
  material_id: string;
  width: number | null;
  height: number | null;
  crop: Record<string, number> | null;
} {
  const { seg, mat } = findCropMaterial(draft, segmentId);
  return {
    segmentId: seg.id,
    material_id: mat.id,
    width: typeof mat.width === "number" ? mat.width : null,
    height: typeof mat.height === "number" ? mat.height : null,
    crop: (mat.crop as Record<string, number> | undefined) ?? null,
  };
}

// Tolerance for x+w / y+h sums that land a float ulp past 1 (e.g. 0.3 + 0.7).
const CROP_EPSILON = 1e-9;

export function setCrop(
  draft: Draft,
  segmentId: string,
  rect: CropRect,
): { segmentId: string; material_id: string; rect: CropRect; crop: Record<string, number>; crop_ratio?: string } {
  const { x, y, w, h } = rect;
  for (const [name, value] of Object.entries(rect)) {
    if (!Number.isFinite(value)) throw new Error(`Crop rect ${name} must be a finite number (got ${value})`);
  }
  if (x < 0 || y < 0) throw new Error(`Crop rect x/y must be >= 0 (got x=${x}, y=${y})`);
  if (w <= 0 || h <= 0) throw new Error(`Crop rect w/h must be > 0 (got w=${w}, h=${h})`);
  if (x + w > 1 + CROP_EPSILON || y + h > 1 + CROP_EPSILON) {
    throw new Error(`Crop rect must stay inside the frame: x+w <= 1 and y+h <= 1 (got x+w=${x + w}, y+h=${y + h})`);
  }
  const { seg, mat } = findCropMaterial(draft, segmentId);
  const right = Math.min(1, x + w);
  const bottom = Math.min(1, y + h);
  // Same 8-corner struct the factory writes at creation: y grows downward,
  // upper_left = (x, y) ... lower_right = (x+w, y+h).
  const crop = {
    lower_left_x: x,
    lower_left_y: bottom,
    lower_right_x: right,
    lower_right_y: bottom,
    upper_left_x: x,
    upper_left_y: y,
    upper_right_x: right,
    upper_right_y: y,
  };
  mat.crop = crop;
  const result: {
    segmentId: string;
    material_id: string;
    rect: CropRect;
    crop: Record<string, number>;
    crop_ratio?: string;
  } = { segmentId: seg.id, material_id: mat.id, rect, crop };
  // CapCut's preset enum values for crop_ratio are not published, so when the
  // material carries the field we stamp the safe "free" value and let the app
  // recompute from the corner points (stated in --help).
  if ("crop_ratio" in mat) {
    mat.crop_ratio = "free";
    result.crop_ratio = "free";
  }
  return result;
}

// --- Audio fade-in / fade-out ---

// Writes a `materials.audio_fades[]` entry shaped like pyJianYingDraft's
// AudioFade.export_json: { id, fade_in_duration, fade_out_duration, fade_type, type }.
// The audio segment references the fade material via extra_material_refs.
// At least one of fadeInUs / fadeOutUs must be > 0. Re-applying replaces the
// existing fade on the same segment instead of stacking.
export function setAudioFade(
  draft: Draft,
  segmentId: string,
  opts: { fadeInUs?: number; fadeOutUs?: number },
): { segmentId: string; fade_id: string; fade_in_us: number; fade_out_us: number } {
  const fadeIn = opts.fadeInUs ?? 0;
  const fadeOut = opts.fadeOutUs ?? 0;
  if (fadeIn <= 0 && fadeOut <= 0) {
    throw new Error(`audio-fade requires at least one of --in or --out (> 0)`);
  }
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  if (found.track.type !== "audio") {
    throw new Error(`audio-fade only applies to audio segments (track type: ${found.track.type})`);
  }
  const seg = found.segment;

  if (!Array.isArray((draft.materials as Record<string, unknown>).audio_fades)) {
    (draft.materials as Record<string, unknown>).audio_fades = [];
  }
  const fades = (draft.materials as unknown as { audio_fades: Array<Record<string, unknown> & { id: string }> })
    .audio_fades;

  // Drop any existing fade ref on this segment so re-applying replaces instead of stacks.
  seg.extra_material_refs = (seg.extra_material_refs || []).filter((r) => !fades.some((f) => f.id === r));

  const fadeId = uuid();
  fades.push({
    id: fadeId,
    fade_in_duration: fadeIn,
    fade_out_duration: fadeOut,
    fade_type: 0,
    type: "audio_fade",
  });
  seg.extra_material_refs ||= [];
  seg.extra_material_refs.push(fadeId);

  return { segmentId: seg.id, fade_id: fadeId, fade_in_us: fadeIn, fade_out_us: fadeOut };
}

// --- Cover frame on the draft root ---

// The `cover` field on the draft root is nullable in every template we've seen
// (pyJianYingDraft, CapCut 6.5, 9.6). When set, CapCut/JianYing populates a
// JSON object pointing at the cover image and the source time. The exact field
// set varies slightly between versions; we ship a conservative shape that
// matches what users have reported as working — and the field is graceful
// (CapCut re-reads on open and re-renders if invalid).
export function setCover(draft: Draft, imagePath: string, timeMs = 0): { cover_path: string; time_ms: number } {
  if (!existsSync(imagePath)) {
    throw new Error(`Cover image not found: ${imagePath}`);
  }
  const cover = {
    path: imagePath,
    type: "image",
    // CapCut uses microseconds nearly everywhere, but the `cover` block has been
    // observed in milliseconds in public dumps. Surface both for safety.
    time: timeMs,
    time_ms: timeMs,
    custom_cover_id: uuid(),
  };
  (draft as Record<string, unknown>).cover = cover;
  return { cover_path: imagePath, time_ms: timeMs };
}

// --- Filters (color grade) on a filter track ---

// Starter catalogue for the capcut namespace. effect_id values pulled from
// public CapCut filter dumps; resource_id mirrors effect_id (matches the
// shape add-effect uses). When the jianying namespace is selected we delegate
// to enums.json instead (468 entries from pyJianYingDraft).
interface FilterMeta {
  name: string;
  effect_id: string;
  resource_id: string;
}

const VIDEO_FILTERS: Record<string, FilterMeta> = {
  vintage: { name: "Vintage", effect_id: "7028463716732079117", resource_id: "7028463716732079117" },
  warm: { name: "Warm", effect_id: "7028463716732079118", resource_id: "7028463716732079118" },
  cool: { name: "Cool", effect_id: "7028463716732079119", resource_id: "7028463716732079119" },
  bw: { name: "B&W", effect_id: "7028463716732079120", resource_id: "7028463716732079120" },
  sepia: { name: "Sepia", effect_id: "7028463716732079121", resource_id: "7028463716732079121" },
  vivid: { name: "Vivid", effect_id: "7028463716732079122", resource_id: "7028463716732079122" },
  contrast: { name: "Contrast", effect_id: "7028463716732079123", resource_id: "7028463716732079123" },
  faded: { name: "Faded", effect_id: "7028463716732079124", resource_id: "7028463716732079124" },
  dramatic: { name: "Dramatic", effect_id: "7028463716732079125", resource_id: "7028463716732079125" },
  soft: { name: "Soft", effect_id: "7028463716732079126", resource_id: "7028463716732079126" },
};

export function filterSlugs(namespace: Namespace = "capcut"): string[] {
  if (namespace === "capcut") return Object.keys(VIDEO_FILTERS);
  // JianYing: delegate to enums.json
  const set = new Set<string>();
  for (const slug of Object.keys(VIDEO_FILTERS)) set.add(slug);
  return [...set];
}

// Exposed so `enums --filters` (capcut namespace) can list the starter catalogue
// alongside the bundled enums.json entries.
export function filterCatalogue(): Array<{
  slug: string;
  member: string;
  name: string;
  effect_id: string;
  resource_id: string;
}> {
  return Object.entries(VIDEO_FILTERS).map(([slug, meta]) => ({
    slug,
    member: meta.name,
    name: meta.name,
    effect_id: meta.effect_id,
    resource_id: meta.resource_id,
  }));
}

export interface AddFilterOptions {
  slug: string;
  start: number;
  duration: number;
  intensity?: number; // 0..1
  trackName?: string;
  namespace?: Namespace;
  /** Raw store/catalogue resource ID — skips slug lookup; `slug` becomes the display name. */
  resourceId?: string;
  /** Raw effect ID; defaults to `resourceId`. Only meaningful with `resourceId`. */
  effectId?: string;
}

export function addFilter(
  draft: Draft,
  opts: AddFilterOptions,
): { segmentId: string; materialId: string; trackId: string; name: string } {
  const ns: Namespace = opts.namespace ?? "capcut";
  // Raw-resource-id escape hatch: skip catalogue lookup entirely (explicit
  // beats implicit — a raw id wins even when the slug also exists).
  // effect_id defaulting to resource_id matches the inline registry, where
  // every filter's effect_id mirrors its resource_id.
  let meta: FilterMeta | null = opts.resourceId
    ? { name: opts.slug, effect_id: opts.effectId ?? opts.resourceId, resource_id: opts.resourceId }
    : ns === "capcut"
      ? (VIDEO_FILTERS[opts.slug.toLowerCase()] ?? null)
      : null;
  if (!meta) {
    const hit = findEnum("filters", opts.slug, ns);
    if (!hit?.name || !hit.effect_id || !hit.resource_id) {
      const hint = ns === "jianying" ? " --jianying" : "";
      throw new Error(`Unknown filter slug: ${opts.slug}. Run 'capcut enums --filters${hint}' for the full list.`);
    }
    meta = { name: hit.name, effect_id: hit.effect_id, resource_id: hit.resource_id };
  }

  const slot = effectTrackSlot(draft, "filter", opts.trackName);

  const value = opts.intensity ?? 1.0;
  const filterMaterial = {
    adjust_params: [],
    apply_target_type: 2,
    apply_time_range: null,
    category_id: "",
    category_name: "Filter",
    common_keyframes: [],
    effect_id: meta.effect_id,
    formula_id: "",
    id: slot.matId,
    name: meta.name,
    platform: "all",
    render_index: 11000,
    resource_id: meta.resource_id,
    // 1 marks store-downloaded resources (addSticker precedent); slug path
    // keeps 0 byte-for-byte.
    source_platform: opts.resourceId ? 1 : 0,
    time_range: null,
    track_render_index: 0,
    type: "filter",
    value,
    version: "",
  };
  return pushEffectSegment(draft, slot, filterMaterial, opts, meta.name);
}
