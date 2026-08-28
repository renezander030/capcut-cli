import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { stripBom } from "./bom.js";
import type { Draft } from "./draft.js";
import { assessWriteSafety, atLeast } from "./version.js";

const STANDARD_FILES = ["draft_content.json", "draft_info.json", "draft_meta_info.json", "template-2.tmp"] as const;

export type DraftCandidateName = (typeof STANDARD_FILES)[number] | string;

export interface DraftCandidate {
  name: DraftCandidateName;
  path: string;
  exists: boolean;
  size: number;
  mtime: string | null;
  sha256: string | null;
  raw: string | null;
  parseable: boolean;
  envelopePath: string[];
  draft: Draft | null;
  timelineHash: string | null;
  error?: string;
}

/** Which primary project file drives this store: draft_content.json (the
 * layout every pre-Mac-10.x build uses), draft_info.json with no
 * draft_content.json beside it (reported as the primary project file on newer
 * Mac builds — jianying-mcp#5, pyJianYingDraft#177/#194), a pre-8.7 store
 * carrying a nested Timelines/ directory (CapCut 7.x is reported to keep the
 * live document at Timelines/<main_timeline_id>/draft_info.json with the root
 * file a regenerated mirror — issue #50; DETECTION ONLY, reads and writes
 * still target the root candidates), or neither (timeline readable only from
 * a mirror such as template-2.tmp). */
export type DraftStoreLayout = "content-primary" | "info-primary" | "timelines-nested" | "unknown";

export interface DraftStore {
  projectDir: string;
  canonical: DraftCandidate;
  targets: DraftCandidate[];
  candidates: DraftCandidate[];
  version: string | null;
  modernStorage: boolean;
  diverged: boolean;
  layout: DraftStoreLayout;
  /** Project-relative paths of the nested Timelines/ documents (issue #50):
   * Timelines/project.json plus every Timelines/<id>/draft_info.json /
   * draft_content.json found. Reporting only — never read as a timeline
   * source, never part of the write set. Populated whenever the structure
   * exists, even on >= 8.7 stores where the layout value stays untouched. */
  nestedTimelines: string[];
}

export interface DraftStoreReport {
  ok: boolean;
  project_dir: string;
  canonical: string;
  version: string | null;
  modern_storage: boolean;
  diverged: boolean;
  layout: DraftStoreLayout;
  nested_timelines: string[];
  write_guard: "ok" | "warn" | "refuse";
  editor_running: string[];
  candidates: Array<{
    file: string;
    exists: boolean;
    size: number;
    mtime: string | null;
    sha256: string | null;
    parseable_timeline: boolean;
    envelope: string;
    timeline_hash: string | null;
    tracks?: number;
    segments?: number;
    app_version?: string | null;
    error?: string;
  }>;
  next_actions: string[];
  /** Present only when the timeline references local media that
   * draft_meta_info.json's `draft_materials` provably does not register —
   * see assessMediaRegistration. Informational: no exit-code change. */
  media_registration?: MediaRegistrationNote;
}

export interface MediaRegistrationNote {
  referenced_media: number;
  draft_materials: "missing-file" | "missing-key" | "all-groups-empty";
  note: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isTimeline(value: unknown): value is Draft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.tracks) && Boolean(record.materials) && typeof record.materials === "object";
}

function findTimeline(value: unknown, path: string[] = [], depth = 0): { draft: Draft; path: string[] } | null {
  if (isTimeline(value)) return { draft: value, path };
  if (depth >= 3 || !value || typeof value !== "object" || Array.isArray(value)) return null;

  const preferred = ["draft_content", "draft_info", "timeline", "content", "data", "draft"];
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  for (const [key, child] of entries) {
    if (typeof child === "string" && child.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(child) as unknown;
        const found = findTimeline(parsed, [...path, `${key}:json`], depth + 1);
        if (found) return found;
      } catch {
        // Not a JSON envelope. Continue looking at other fields.
      }
    } else if (child && typeof child === "object") {
      const found = findTimeline(child, [...path, key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Exported for factory.ts (register): read one file into a DraftCandidate —
// BOM-stripped, envelope-aware — without the sibling discovery a full
// discoverDraftStore would do.
export function parseCandidate(path: string): DraftCandidate {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (!existsSync(path)) {
    return {
      name,
      path,
      exists: false,
      size: 0,
      mtime: null,
      sha256: null,
      raw: null,
      parseable: false,
      envelopePath: [],
      draft: null,
      timelineHash: null,
    };
  }

  const stat = statSync(path);
  // BOM-strip once at load: `raw` is what gets parsed, hashed, backed up, and
  // re-serialized, so a PowerShell-written BOM never survives a CLI write.
  const raw = stripBom(readFileSync(path, "utf-8"));
  const base = {
    name,
    path,
    exists: true,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    sha256: hash(raw),
    raw,
  };
  try {
    const parsed = JSON.parse(raw) as unknown;
    const found = findTimeline(parsed);
    if (!found) {
      return {
        ...base,
        parseable: false,
        envelopePath: [],
        draft: null,
        timelineHash: null,
        error: "JSON file does not contain a recognizable timeline",
      };
    }
    // Lazy: hashing the timeline means a full JSON.stringify plus a sha256 of
    // the whole draft, for EVERY readable sibling, on EVERY discovery — and
    // only three things ever read it (the `diverged` flag, `sync-timelines`'
    // plan, `diagnose`'s candidate table). Every read command and every write
    // paid for a value it never looked at. Memoized on first access; a
    // candidate is a discovery snapshot, so the timeline it hashes is the one
    // discovery found.
    let timelineHash: string | null = null;
    return {
      ...base,
      parseable: true,
      envelopePath: found.path,
      draft: found.draft,
      get timelineHash(): string {
        if (timelineHash === null) timelineHash = hash(JSON.stringify(found.draft));
        return timelineHash;
      },
    };
  } catch (error) {
    return {
      ...base,
      parseable: false,
      envelopePath: [],
      draft: null,
      timelineHash: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Nested timeline document names probed inside each Timelines/<id>/ directory.
const NESTED_TIMELINE_FILES = ["draft_info.json", "draft_content.json"] as const;

/**
 * CapCut 7.x nested Timelines/ layout (issue #50): the app is reported to keep
 * the live document at Timelines/<main_timeline_id>/draft_info.json (pointer:
 * Timelines/project.json) and to regenerate the project-root file from it on
 * open. DETECTION ONLY — PR #51 flipped canonical reads to the nested file for
 * every pre-8.7 project and was rejected pending a field artifact, so
 * discovery keeps reading and writing the root candidates unchanged and this
 * structure is merely reported (layout "timelines-nested") so mutating
 * commands can warn instead of staying silent. The layout counts as present
 * when Timelines/ holds a project.json and/or a <id>/draft_info.json (or
 * draft_content.json); project.json is never parsed here.
 */
function detectNestedTimelines(projectDir: string): { present: boolean; files: string[] } {
  const none = { present: false, files: [] };
  const timelinesDir = join(projectDir, "Timelines");
  try {
    if (!statSync(timelinesDir).isDirectory()) return none;
  } catch {
    return none;
  }
  const files: string[] = [];
  if (existsSync(join(timelinesDir, "project.json"))) files.push("Timelines/project.json");
  let entries: string[];
  try {
    entries = readdirSync(timelinesDir).sort();
  } catch {
    return none;
  }
  for (const entry of entries) {
    const entryDir = join(timelinesDir, entry);
    try {
      if (!statSync(entryDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of NESTED_TIMELINE_FILES) {
      if (existsSync(join(entryDir, name))) files.push(`Timelines/${entry}/${name}`);
    }
  }
  return { present: files.length > 0, files };
}

/** Warning every mutating write prints on a `timelines-nested` project (issue
 * #50). Warn, never refuse: the nested-live-document claim has no committed
 * field artifact yet, and the write itself still targets the root files. */
export const NESTED_TIMELINES_WRITE_WARNING =
  "Nested Timelines/ layout detected (CapCut 7.x — issue #50): the app is reported to keep the live document at " +
  "Timelines/<id>/draft_info.json and to regenerate the project-root files from it, so this root-mirror edit may " +
  "be discarded the next time the project opens. The CLI still writes the root files only — no verified fixture " +
  "for the nested layout exists yet. If you have such a project, contribute a bundle: " +
  "`capcut fixture <project> --out <dir>`. To copy this edit into the nested documents explicitly, run " +
  "`capcut sync-timelines <project> --nested --apply` (opt-in repair).";

/** The `diagnose` next_action / `version` note naming the layout — same shape
 * as the draft_info-primary action below (name the layout, state the risk,
 * end with the fixture CTA). */
export const NESTED_TIMELINES_ACTION =
  "Timelines/ directory with a nested timeline document: CapCut 7.x is reported to keep the live document at " +
  "Timelines/<id>/draft_info.json, with the project-root file a regenerated mirror (issue #50). Edit commands " +
  "still read and write the project-root files, so CapCut 7.x may discard those edits on the next open. " +
  "`capcut sync-timelines <project> --nested --apply` copies the root timeline into the nested documents as an " +
  "explicit opt-in repair. Evidence for this layout is report-only — if you have such a project, contribute a " +
  "bundle: `capcut fixture <project> --out <dir>`.";

/**
 * The same structure on >= 8.7 storage, where `layout` deliberately stays at its
 * content-/info-primary value so the 7.x claim never relabels a modern store.
 *
 * `diagnose` already attaches the redacted nested evidence on these stores
 * (index.ts `cmdDiagnose`, gated on `nested_timelines.length`), and `fixture`
 * already bundles it, but the human-readable action and the `version` note were
 * gated on the layout value alone — so a >= 8.7 user got a report carrying
 * Timelines/ evidence with no line of text saying why it was collected. This is
 * that line, and it asserts nothing: neither #50's 7.x discard risk nor #68's
 * 8.5.0 survival observation transfers across the 8.7 storage change.
 */
export const NESTED_TIMELINES_MODERN_ACTION =
  "Timelines/ directory with a nested timeline document, on CapCut >= 8.7 storage. No discard risk is claimed " +
  "here and none is ruled out: the 7.x report in issue #50 and the 8.5.0 open/close round trip in issue #68 both " +
  "predate this storage generation, so what the app does with the nested document on >= 8.7 is unevidenced in " +
  "either direction. Edit commands read and write the project-root files only; " +
  "`capcut sync-timelines <project> --nested --apply` copies the root timeline into the nested documents as an " +
  "explicit opt-in repair. If this project opens in your app " +
  "with a CLI edit intact — or without it — that is the artifact issue #50 has been blocked on: " +
  "`capcut fixture <project> --out <dir>`.";

/**
 * First app version reported to regenerate the nested mirror FROM the root file
 * rather than the other way round (issue #68).
 *
 * #50 reports CapCut 7.x keeping the live document at Timelines/<id>/draft_info.json
 * and rebuilding the project-root files from it, so a root-mirror edit may be lost.
 * #68 reports the opposite on 8.5.0: a CLI-written draft with 14 segments was opened
 * and closed, and afterwards the nested file and the root file were byte-identical
 * (SHA compared) with every segment intact.
 *
 * Both reports stand. The 7.x caution is deliberately NOT softened — the 8.5.0
 * reporter states they did not test 7.x, which is what #50 actually covers. What was
 * wrong is that the warning fired on layout alone, so 8.5.0 users saw 7.x text their
 * own evidence contradicts. An unknown version keeps the cautious wording.
 */
const NESTED_MIRROR_FROM_ROOT_SINCE = "8.5.0";

function nestedMirrorIsSafe(appVersion: string | null): boolean {
  return appVersion !== null && atLeast(appVersion, NESTED_MIRROR_FROM_ROOT_SINCE);
}

/** Version-gated form of NESTED_TIMELINES_WRITE_WARNING (issue #68). */
export function nestedTimelinesWriteWarning(appVersion: string | null): string {
  if (!nestedMirrorIsSafe(appVersion)) return NESTED_TIMELINES_WRITE_WARNING;
  return (
    `Nested Timelines/ layout detected on CapCut ${appVersion} (issue #68): on this version the app is reported ` +
    "to regenerate Timelines/<id>/draft_info.json from the project-root file, so this root-mirror edit should " +
    "survive the next open. The CLI writes the root files only."
  );
}

/** Version-gated form of NESTED_TIMELINES_ACTION (issue #68). */
export function nestedTimelinesAction(appVersion: string | null): string {
  if (!nestedMirrorIsSafe(appVersion)) return NESTED_TIMELINES_ACTION;
  return (
    `Timelines/ directory with a nested timeline document, on CapCut ${appVersion}: this version is reported to ` +
    "regenerate the nested document from the project-root file (issue #68 — byte-identical after an open/close " +
    "round trip), so the root-file writes the edit commands perform are the ones the app keeps. The 7.x caution " +
    "in issue #50 still applies to older builds."
  );
}

function candidatePaths(input: string): { projectDir: string; requested: string | null; paths: string[] } {
  const resolved = resolve(input);
  const isFile = existsSync(resolved) && statSync(resolved).isFile();
  const projectDir = isFile ? dirname(resolved) : resolved;
  const requested = isFile ? resolved : null;
  const paths = requested ? [requested] : [];
  for (const name of STANDARD_FILES) {
    const path = join(projectDir, name);
    if (!paths.includes(path)) paths.push(path);
  }
  return { projectDir, requested, paths };
}

/** Newest app version any readable timeline in the set declares, or null when
 * none carries a marker. The store's version evidence covers every sibling, so
 * a mirror written by a newer build raises it. */
function highestVersion(parseable: DraftCandidate[]): string | null {
  const versions = parseable
    .map((candidate) => candidate.draft?.platform?.app_version)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return versions.sort((a, b) => (atLeast(a, b) ? -1 : 1))[0] ?? null;
}

export function discoverDraftStore(input: string): DraftStore {
  const { projectDir, requested, paths } = candidatePaths(input);
  const candidates = paths.map(parseCandidate);
  const parseable = candidates.filter((candidate) => candidate.parseable && candidate.draft);
  if (parseable.length === 0) {
    const found = candidates.filter((candidate) => candidate.exists).map((candidate) => candidate.name);
    const detail = found.length > 0 ? `Found ${found.join(", ")}, but none contained a readable timeline.` : "";
    throw new Error(
      `No draft found at: ${input}\nExpected draft_content.json, draft_info.json, draft_meta_info.json, or template-2.tmp. ${detail}`.trim(),
    );
  }

  const version = highestVersion(parseable);
  const modernStorage = atLeast(version, "8.7");

  let canonical: DraftCandidate | undefined;
  if (requested) canonical = parseable.find((candidate) => candidate.path === requested);
  const preference = modernStorage
    ? ["template-2.tmp", "draft_meta_info.json", "draft_content.json", "draft_info.json"]
    : ["draft_content.json", "draft_info.json", "template-2.tmp", "draft_meta_info.json"];
  canonical ??= preference
    .map((name) => parseable.find((candidate) => candidate.name === name))
    .find((candidate): candidate is DraftCandidate => Boolean(candidate));
  canonical ??= parseable[0];

  const contentReadable = parseable.some((candidate) => candidate.name === "draft_content.json");
  const infoReadable = parseable.some((candidate) => candidate.name === "draft_info.json");
  // Issue #50 detection only: the nested layout changes NOTHING about
  // canonical, targets, or divergence — mutating commands read store.layout
  // to warn that a root-mirror edit may be discarded by the app. Gated to
  // pre-8.7 stores: the claim is specific to CapCut 7.x, and >= 8.7 storage
  // keeps its established template-2.tmp selection and layout value.
  const nested = detectNestedTimelines(projectDir);
  return {
    projectDir,
    canonical,
    targets: parseable,
    candidates,
    version,
    modernStorage,
    // Getter so the timeline hashes it compares stay unforced: only `diagnose`
    // reads this, and forcing them here would put the cost straight back on
    // every command discovery runs for.
    get diverged(): boolean {
      return new Set(parseable.map((candidate) => candidate.timelineHash).filter(Boolean)).size > 1;
    },
    layout:
      nested.present && !modernStorage
        ? "timelines-nested"
        : contentReadable
          ? "content-primary"
          : infoReadable
            ? "info-primary"
            : "unknown",
    nestedTimelines: nested.files,
  };
}

/**
 * The store as a fresh discovery would find it immediately after a write,
 * built from what the write already produced instead of re-reading the project.
 *
 * `saveDraft` keeps a per-path store so a library caller can save the same
 * loaded draft twice without tripping its own changed-on-disk guard, and used
 * to refresh that cache by calling `discoverDraftStore` again — re-reading,
 * re-parsing, and re-hashing every sibling to learn one thing the write
 * already knew: each target now holds exactly the bytes it was just handed.
 * `written` maps target path -> the content committed there; candidates
 * outside it are carried over untouched, so a partial write set stays honest.
 *
 * Everything a re-discovery would recompute is recomputed: `size` and `mtime`
 * come from a `stat` of the file that was just renamed into place, `version`
 * (and with it `modernStorage` and `layout`) is re-derived from the timelines
 * the targets now hold — which is how a mirror that used to carry a newer app
 * version stops raising the store's version once it has been overwritten — and
 * `diverged` collapses to false on its own, because every written target now
 * exposes the same timeline.
 */
export function storeAfterWrite(store: DraftStore, draft: Draft, written: Map<string, string>): DraftStore {
  const refresh = (candidate: DraftCandidate): DraftCandidate => {
    const content = written.get(candidate.path);
    if (content === undefined) return candidate;
    let size = Buffer.byteLength(content, "utf-8");
    let mtime = candidate.mtime;
    try {
      const stat = statSync(candidate.path);
      size = stat.size;
      mtime = stat.mtime.toISOString();
    } catch {
      // The file is there — it was just renamed into place — but a stat can
      // still fail on a racing sync client. Fall back to what we wrote.
    }
    let timelineHash: string | null = null;
    return {
      name: candidate.name,
      path: candidate.path,
      exists: true,
      size,
      mtime,
      sha256: hash(content),
      raw: content,
      parseable: true,
      envelopePath: candidate.envelopePath,
      draft,
      get timelineHash(): string {
        if (timelineHash === null) timelineHash = hash(JSON.stringify(draft));
        return timelineHash;
      },
    };
  };

  // The re-discovery this replaces was keyed on the canonical FILE, not the
  // project directory — deliberately, so an explicitly addressed custom
  // filename such as A.json is not lost — and that puts the canonical first in
  // the candidate list. Keep that order: it is the order targets are written
  // in and the order a changed-on-disk report names them in.
  const order = candidatePaths(store.canonical.path).paths;
  const rank = (candidate: DraftCandidate): number => {
    const index = order.indexOf(candidate.path);
    return index < 0 ? order.length : index;
  };
  const candidates = [...store.candidates].sort((a, b) => rank(a) - rank(b)).map(refresh);
  // Same derivation discovery uses, so a target and its candidate stay one object.
  const targets = candidates.filter((candidate) => candidate.parseable && candidate.draft);
  const version = highestVersion(targets);
  const modernStorage = atLeast(version, "8.7");
  const contentReadable = targets.some((candidate) => candidate.name === "draft_content.json");
  const infoReadable = targets.some((candidate) => candidate.name === "draft_info.json");
  return {
    projectDir: store.projectDir,
    canonical: targets.find((candidate) => candidate.path === store.canonical.path) ?? refresh(store.canonical),
    targets,
    candidates,
    version,
    modernStorage,
    get diverged(): boolean {
      return new Set(targets.map((candidate) => candidate.timelineHash).filter(Boolean)).size > 1;
    },
    layout:
      store.nestedTimelines.length > 0 && !modernStorage
        ? "timelines-nested"
        : contentReadable
          ? "content-primary"
          : infoReadable
            ? "info-primary"
            : "unknown",
    nestedTimelines: store.nestedTimelines,
  };
}

function replaceAtPath(root: unknown, path: string[], draft: Draft): unknown {
  if (path.length === 0) return draft;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error(`Cannot update draft envelope at ${path.join(".")}`);
  }
  const cloned = structuredClone(root) as Record<string, unknown>;
  const [part, ...rest] = path;
  const jsonString = part.endsWith(":json");
  const key = jsonString ? part.slice(0, -5) : part;
  if (jsonString) {
    if (typeof cloned[key] !== "string") throw new Error(`Cannot update JSON envelope field ${key}`);
    const parsed = JSON.parse(cloned[key] as string) as unknown;
    cloned[key] = JSON.stringify(replaceAtPath(parsed, rest, draft));
  } else {
    cloned[key] = replaceAtPath(cloned[key], rest, draft);
  }
  return cloned;
}

function indentOf(raw: string | null): string | number {
  if (!raw) return 0;
  const match = raw.match(/\n(\s+)/);
  if (!match) return 0;
  return match[1].includes("\t") ? "\t" : match[1].length;
}

export function serializeDraftCandidate(candidate: DraftCandidate, draft: Draft): string {
  if (!candidate.raw || candidate.envelopePath.length === 0) {
    return JSON.stringify(draft, null, indentOf(candidate.raw));
  }
  const root = JSON.parse(candidate.raw) as unknown;
  const updated = replaceAtPath(root, candidate.envelopePath, draft);
  return JSON.stringify(updated, null, indentOf(candidate.raw));
}

export function editorProcesses(): string[] {
  try {
    if (platform() === "win32") {
      const result = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf-8", timeout: 3000 });
      const output = result.stdout ?? "";
      return ["CapCut.exe", "JianyingPro.exe"].filter((name) => output.toLowerCase().includes(name.toLowerCase()));
    }
    const result = spawnSync("ps", ["-axo", "comm="], { encoding: "utf-8", timeout: 3000 });
    const output = result.stdout ?? "";
    return ["CapCut", "JianyingPro"].filter((name) => output.toLowerCase().includes(name.toLowerCase()));
  } catch {
    return [];
  }
}

export function isManagedDraftPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().includes("/com.lveditor.draft/");
}

/**
 * Per-OS CapCut/JianYing draft stores, in preference order. Empty on platforms
 * with no desktop editor (Linux), where the caller must be told to pass a path.
 */
export function draftDirCandidates(): { label: string; path: string }[] {
  const home = homedir();
  if (platform() === "darwin") {
    return [
      { label: "CapCut (macOS)", path: join(home, "Movies/CapCut/User Data/Projects/com.lveditor.draft") },
      { label: "JianYing (macOS)", path: join(home, "Movies/JianyingPro/User Data/Projects/com.lveditor.draft") },
    ];
  }
  if (platform() === "win32") {
    // HOME is usually unset on Windows, so never derive the store from it.
    const local = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? home, "AppData/Local");
    return [
      { label: "CapCut (Windows)", path: join(local, "CapCut/User Data/Projects/com.lveditor.draft") },
      { label: "JianYing (Windows)", path: join(local, "JianyingPro/User Data/Projects/com.lveditor.draft") },
    ];
  }
  return [];
}

/**
 * Where a draft-creating command writes when the caller passed no --drafts.
 * CAPCUT_DRAFT_DIR wins, then the first store that exists, then the first
 * candidate. Null means this platform has no known store: callers must fail
 * loudly rather than guess, because a draft outside the app's store opens as
 * "this draft comes from an unconventional path" (issue #52).
 */
export function defaultDraftsDir(): string | null {
  const override = process.env.CAPCUT_DRAFT_DIR?.trim();
  if (override) return resolve(override);
  const candidates = draftDirCandidates();
  return candidates.find((c) => existsSync(c.path))?.path ?? candidates[0]?.path ?? null;
}

// Files CapCut may read as its timeline source instead of draft_content.json:
// template-2.tmp (>= 8.7 storage) and draft_info.json (the pre-open mirror of a
// CLI-built draft). draft_meta_info.json without a timeline is normal
// registration metadata, not a mirror, so it is never flagged unreconcilable.
const MIRROR_FILES = new Set<string>(["draft_info.json", "template-2.tmp"]);

export interface TimelineSyncTarget {
  file: string;
  state: "canonical" | "in_sync" | "drifted";
  envelope: string;
  mtime: string | null;
  timeline_hash: string | null;
  guid: string | null;
  guid_drifted: boolean;
  /** Set on Timelines/<id>/ documents included by the --nested opt-in. These
   * keep their own GUID on repair: the verified 9.2.8 workaround in issue #50
   * writes the timeline id into the nested document, not the root draft id. */
  nested?: boolean;
  tracks?: number;
  segments?: number;
}

export interface TimelineSyncUnreconcilable {
  file: string;
  reason: string;
  workaround: string;
}

export interface TimelineSyncPlan {
  project_dir: string;
  canonical: string;
  canonical_path: string;
  version: string | null;
  modern_storage: boolean;
  layout: DraftStoreLayout;
  /** Set when the canonical is not draft_content.json (draft_info-primary
   * layout): names the promotion and carries the fixture CTA. */
  canonical_note: string | null;
  in_sync: boolean;
  /** Drifted mirrors whose mtime is newer than draft_content.json's. CapCut
   * >= 8.7 writes the mirrors on save, so a newer drifted mirror may hold app
   * edits that a canonical -> mirror repair would roll back. */
  newer_mirrors: string[];
  canonical_stale: boolean;
  targets: TimelineSyncTarget[];
  drifted: string[];
  unreconcilable: TimelineSyncUnreconcilable[];
  /** Count of Timelines/<id>/ documents on disk that --nested would cover —
   * reported even when the run did not include them, so the plan can point at
   * the opt-in instead of silently ignoring the nested layout (issue #50). */
  nested_available: number;
  /** Whether this plan was computed with the --nested opt-in. */
  nested_included: boolean;
}

export interface TimelineSyncResult {
  plan: TimelineSyncPlan;
  canonicalDraft: Draft;
  canonicalCandidate: DraftCandidate;
  driftedCandidates: DraftCandidate[];
  /** Drifted Timelines/<id>/ documents (--nested only). Each carries the GUID
   * the rewrite must keep: the nested document's own timeline id, per the
   * verified issue-#50 workaround — never the canonical root draft id. */
  nestedDriftedCandidates: Array<{ candidate: DraftCandidate; keepGuid: string | null }>;
}

function syncTarget(candidate: DraftCandidate, state: TimelineSyncTarget["state"], guidDrifted: boolean) {
  return {
    file: candidate.name,
    state,
    envelope: candidate.envelopePath.length === 0 ? "root" : candidate.envelopePath.join("."),
    mtime: candidate.mtime,
    timeline_hash: candidate.timelineHash,
    guid: candidate.draft?.id ?? null,
    guid_drifted: guidDrifted,
    tracks: candidate.draft?.tracks.length,
    segments: candidate.draft?.tracks.reduce((sum, track) => sum + track.segments.length, 0),
  };
}

// Nested sync targets probed inside each Timelines/<id>/ directory: the
// timeline documents detection already knows, plus the same-directory
// template-2.tmp mirror the 9.2.8 report names (issue #50). project.json is
// the pointer file and is never a sync target — the repair must not rewrite
// which timeline the app considers active.
const NESTED_SYNC_FILES = [...NESTED_TIMELINE_FILES, "template-2.tmp"] as const;

function nestedSyncDocPaths(projectDir: string): string[] {
  const timelinesDir = join(projectDir, "Timelines");
  let entries: string[];
  try {
    if (!statSync(timelinesDir).isDirectory()) return [];
    entries = readdirSync(timelinesDir).sort();
  } catch {
    return [];
  }
  const rel: string[] = [];
  for (const entry of entries) {
    const entryDir = join(timelinesDir, entry);
    try {
      if (!statSync(entryDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of NESTED_SYNC_FILES) {
      if (existsSync(join(entryDir, name))) rel.push(`Timelines/${entry}/${name}`);
    }
  }
  return rel;
}

/** Timeline hash with the draft id normalized away. Nested Timelines/<id>/
 * documents keep their own GUID on repair (issue #50's verified workaround
 * writes the timeline id), so their sync state must compare timeline content,
 * not identity — otherwise a correctly repaired nested document would report
 * drifted forever. */
function timelineHashWithoutId(draft: Draft): string {
  return hash(JSON.stringify({ ...draft, id: "" }));
}

/**
 * Plan for `sync-timelines` (issue #39, symptom #35): draft_content.json is
 * canonical (draft_info.json on the draft_info-primary Mac layout — see
 * DraftStoreLayout); every other readable timeline target is compared against
 * it by timeline hash. Direction is always draft_content.json -> mirror, but each
 * target's mtime is surfaced: CapCut >= 8.7 writes the mirrors on save, so a
 * drifted mirror NEWER than draft_content.json may hold app edits that the
 * repair would roll back (canonical_stale / newer_mirrors flag this; --apply
 * refuses without --force-write). A mirror file that exists but holds no
 * readable timeline (binary/encrypted template-2.tmp) cannot be reconciled
 * and is reported as such instead of being silently skipped. Accepts a
 * project directory or its draft_content.json path; any other explicitly
 * named file is rejected so the plan and the write always cover the same
 * target set.
 *
 * With `nested: true` (the --nested opt-in, issue #50) the plan additionally
 * covers every Timelines/<id>/ timeline document plus its template-2.tmp
 * mirror, in the same canonical -> mirror direction and behind the same
 * newer-mirror refusal. Nested documents keep their own GUID on rewrite and
 * compare by id-normalized timeline hash; Timelines/project.json is never a
 * target. This is the 9.2.8 workaround verified in issue #50, mechanized —
 * it does not change which file any command reads (PR #51's canonical flip
 * stays rejected pending a field artifact).
 */
export function planTimelineSync(input: string, opts: { nested?: boolean } = {}): TimelineSyncResult {
  const resolved = resolve(input);
  if (existsSync(resolved) && statSync(resolved).isFile() && basename(resolved) !== "draft_content.json") {
    throw new Error(
      `sync-timelines reconciles a project's mirror files from draft_content.json and cannot target ${basename(resolved)} directly. ` +
        `Pass the project directory instead: capcut sync-timelines ${dirname(resolved)}`,
    );
  }
  const store = discoverDraftStore(input);
  // draft_content.json is the sync canonical. On the draft_info-primary layout
  // (no draft_content.json; newer Mac builds drive the project from
  // draft_info.json — jianying-mcp#5, pyJianYingDraft#177/#194) draft_info.json
  // is promoted to canonical so the repair works there too instead of refusing
  // (pre-v0.16 behaviour). Round-trip evidence for that layout is
  // synthetic-only, so the plan carries a canonical_note with the fixture CTA.
  // The promotion is presence-based (no readable draft_content.json), not
  // keyed on store.layout, so the detection-only timelines-nested value
  // (issue #50) cannot change which file the repair reads from.
  const canonical =
    store.targets.find((candidate) => candidate.name === "draft_content.json") ??
    store.targets.find((candidate) => candidate.name === "draft_info.json");
  if (!canonical?.draft) {
    throw new Error(
      "sync-timelines needs a readable draft_content.json or draft_info.json (the canonical timeline source). " +
        "Run `capcut diagnose <project>` to inspect what is on disk.",
    );
  }
  const canonicalNote =
    canonical.name === "draft_info.json"
      ? "draft_info.json is the canonical source: this project has no draft_content.json (draft_info-primary " +
        "layout, reported as the primary project file on newer Mac builds). Round-trip evidence for this layout " +
        "is synthetic-only — if this project opens fine in your app, contribute a bundle: " +
        "`capcut fixture <project> --out <dir>`."
      : null;
  const canonicalDraft = canonical.draft;
  const canonicalMtime = canonical.mtime ? Date.parse(canonical.mtime) : Number.NaN;

  const targets: TimelineSyncTarget[] = [syncTarget(canonical, "canonical", false)];
  const drifted: string[] = [];
  const driftedCandidates: DraftCandidate[] = [];
  const newerMirrors: string[] = [];
  const unreconcilable: TimelineSyncUnreconcilable[] = [];
  for (const candidate of store.candidates) {
    if (!candidate.exists || candidate.path === canonical.path) continue;
    if (!candidate.parseable || !candidate.draft) {
      if (MIRROR_FILES.has(candidate.name)) {
        unreconcilable.push({
          file: candidate.name,
          reason: candidate.error ?? "no readable timeline",
          workaround:
            "The CLI cannot reconcile this file. Build a redacted bundle with `capcut fixture <project> --out <dir>` " +
            "and attach it to issue #35 so support for this storage layout can be added.",
        });
      }
      continue;
    }
    const inSync = candidate.timelineHash === canonical.timelineHash;
    targets.push(syncTarget(candidate, inSync ? "in_sync" : "drifted", candidate.draft.id !== canonicalDraft.id));
    if (!inSync) {
      drifted.push(candidate.name);
      driftedCandidates.push(candidate);
      const mirrorMtime = candidate.mtime ? Date.parse(candidate.mtime) : Number.NaN;
      if (Number.isFinite(canonicalMtime) && Number.isFinite(mirrorMtime) && mirrorMtime > canonicalMtime) {
        newerMirrors.push(candidate.name);
      }
    }
  }

  // Nested Timelines/<id>/ documents (issue #50), behind the --nested opt-in.
  // Same direction (canonical -> mirror) and same newer-mirror hazard gate as
  // the root mirrors; the differences are that nested documents keep their own
  // GUID on rewrite (the verified 9.2.8 workaround writes the timeline id) and
  // therefore compare by id-normalized timeline hash.
  const nestedDocs = nestedSyncDocPaths(store.projectDir);
  const nestedDriftedCandidates: TimelineSyncResult["nestedDriftedCandidates"] = [];
  if (opts.nested === true) {
    const canonicalContentHash = timelineHashWithoutId(canonicalDraft);
    for (const rel of nestedDocs) {
      const parsed = parseCandidate(join(store.projectDir, rel));
      if (!parsed.exists) continue;
      // Display and write under the project-relative name so nested rows never
      // collide with the root files they mirror.
      const candidate = { ...parsed, name: rel } as DraftCandidate;
      if (!parsed.parseable || !parsed.draft) {
        unreconcilable.push({
          file: rel,
          reason: parsed.error ?? "no readable timeline",
          workaround:
            "The CLI cannot reconcile this nested document. Build a redacted bundle with `capcut fixture <project> --out <dir>` " +
            "and attach it to issue #50 so support for this storage layout can be added.",
        });
        continue;
      }
      const inSync = timelineHashWithoutId(parsed.draft) === canonicalContentHash;
      targets.push({
        ...syncTarget(candidate, inSync ? "in_sync" : "drifted", parsed.draft.id !== canonicalDraft.id),
        nested: true,
      });
      if (!inSync) {
        drifted.push(rel);
        nestedDriftedCandidates.push({ candidate, keepGuid: parsed.draft.id ?? null });
        const mirrorMtime = parsed.mtime ? Date.parse(parsed.mtime) : Number.NaN;
        if (Number.isFinite(canonicalMtime) && Number.isFinite(mirrorMtime) && mirrorMtime > canonicalMtime) {
          newerMirrors.push(rel);
        }
      }
    }
  }

  return {
    plan: {
      project_dir: store.projectDir,
      canonical: canonical.name,
      canonical_path: canonical.path,
      version: store.version,
      modern_storage: store.modernStorage,
      layout: store.layout,
      canonical_note: canonicalNote,
      in_sync: drifted.length === 0,
      newer_mirrors: newerMirrors,
      canonical_stale: newerMirrors.length > 0,
      targets,
      drifted,
      unreconcilable,
      nested_available: nestedDocs.length,
      nested_included: opts.nested === true,
    },
    canonicalDraft,
    canonicalCandidate: canonical,
    driftedCandidates,
    nestedDriftedCandidates,
  };
}

/** Distinct local file paths the timeline's video/audio materials reference —
 * URLs never need registration, and repeated references to one file are one
 * file to relink. */
function referencedLocalMedia(draft: Draft): number {
  const paths = new Set<string>();
  for (const group of [draft.materials.videos ?? [], draft.materials.audios ?? []]) {
    for (const mat of group) {
      const path = (mat as Record<string, unknown>).path;
      if (typeof path === "string" && path.length > 0 && !/^https?:\/\//i.test(path)) paths.add(path);
    }
  }
  return paths.size;
}

/** True when `draft_materials` provably registers nothing: an empty array, an
 * array whose every group has an empty `value` array, or an object of empty
 * arrays. Any shape not provably empty counts as populated — the note must
 * never fire on a shape this repo has no evidence for. */
function draftMaterialsAllEmpty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every((group) => {
      if (group === null || typeof group !== "object" || Array.isArray(group)) return false;
      const inner = (group as Record<string, unknown>).value;
      return Array.isArray(inner) && inner.length === 0;
    });
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).every((entry) => Array.isArray(entry) && entry.length === 0);
  }
  return false;
}

/**
 * Unregistered-media sidecar note (read-only). Newer CapCut builds (reported
 * on CapCut International 9.1.0, macOS) are reported to show timeline media as
 * "file inaccessible" and prompt per-clip relinking when draft_meta_info.json's
 * `draft_materials` does not register the media, even with valid paths in
 * draft_content.json. This CLI never writes `draft_materials` and the entry
 * shape has never been captured from a real draft, so the registration write
 * is deliberately out of scope — diagnose only observes and asks for the one
 * artifact it can be built from. Null (no note) whenever the timeline
 * references no local media, the sidecar is unreadable, or `draft_materials`
 * is not provably empty.
 */
function assessMediaRegistration(store: DraftStore): MediaRegistrationNote | null {
  const referenced = store.canonical.draft ? referencedLocalMedia(store.canonical.draft) : 0;
  if (referenced === 0) return null;
  const meta = store.candidates.find((candidate) => candidate.name === "draft_meta_info.json");
  let state: MediaRegistrationNote["draft_materials"];
  if (!meta?.exists) {
    state = "missing-file";
  } else {
    if (meta.raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(meta.raw);
    } catch {
      return null; // unreadable sidecar — the candidate row already reports that
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!("draft_materials" in record)) state = "missing-key";
    else if (draftMaterialsAllEmpty(record.draft_materials)) state = "all-groups-empty";
    else return null;
  }
  const observed =
    state === "missing-file"
      ? "this draft has no draft_meta_info.json, so nothing registers them in `draft_materials`"
      : state === "missing-key"
        ? "draft_meta_info.json carries no `draft_materials` key"
        : "draft_meta_info.json carries `draft_materials`, but every group in it is empty";
  return {
    referenced_media: referenced,
    draft_materials: state,
    note:
      `${referenced} local media file(s) are referenced by the timeline, and ${observed}. ` +
      "Newer builds (reported on CapCut International 9.1.0, macOS) are reported to show such media as " +
      '"file inaccessible" and to prompt per-clip relinking even when the timeline file carries valid paths. ' +
      "This CLI does not write `draft_materials` — no real entry shape has been captured yet. If you see that " +
      "symptom: save a draft with the same media in the CapCut app itself on such a build, then run " +
      "`capcut fixture <project> --out <dir>` on it. The sanitized bundle includes draft_meta_info.json and is " +
      "the evidence a registration write can be built from.",
  };
}

export function diagnoseDraftStore(input: string): DraftStoreReport {
  const store = discoverDraftStore(input);
  const running = editorProcesses();
  const safety = store.canonical.draft ? assessWriteSafety(store.canonical.draft, store.version) : null;
  const actions: string[] = [];
  if (safety?.action === "refuse") {
    actions.push(`Version boundary: mutating commands will refuse without --force-write. ${safety.reasons.join(" ")}`);
  }
  if (store.diverged)
    actions.push(
      "Timeline files diverge. Close CapCut and back up the project folder, then run `capcut sync-timelines <project>` " +
        "(plan only) to review each file's mtime and the write targets before deciding whether to --apply.",
    );
  if (store.modernStorage && !store.targets.some((candidate) => candidate.name === "template-2.tmp")) {
    actions.push(
      "CapCut >= 8.7 detected without a readable template-2.tmp timeline; run `capcut sync-timelines <project>` to see which targets can be reconciled.",
    );
  }
  if (store.candidates.some((candidate) => candidate.name === "draft_meta_info.json" && !candidate.exists)) {
    actions.push(
      "draft_meta_info.json is missing, so the CapCut app may not list this draft. Run `capcut register <project>` " +
        "(plan only) to review the repair before deciding whether to --apply.",
    );
  }
  // Presence-based, not `layout === "info-primary"`: a timelines-nested store
  // without a readable draft_content.json still drives edits from
  // draft_info.json, and that promotion must stay named.
  const contentReadable = store.targets.some((candidate) => candidate.name === "draft_content.json");
  const infoReadable = store.targets.some((candidate) => candidate.name === "draft_info.json");
  if (!contentReadable && infoReadable) {
    actions.push(
      "No draft_content.json: the timeline lives in draft_info.json (draft_info-primary layout, reported as the " +
        "primary project file on newer Mac builds). Edit commands, register, and sync-timelines treat it as " +
        "canonical, but round-trip evidence for this layout is synthetic-only — if this project opens fine in " +
        "your app, contribute a bundle: `capcut fixture <project> --out <dir>`.",
    );
  }
  if (store.layout === "timelines-nested") actions.push(nestedTimelinesAction(store.version));
  else if (store.nestedTimelines.length > 0) actions.push(NESTED_TIMELINES_MODERN_ACTION);
  if (running.length > 0) actions.push(`Close ${running.join(" / ")} before editing this managed draft.`);
  if (actions.length === 0)
    actions.push("Storage targets are readable and agree. A normal CLI write will synchronize them.");

  // Attached only when it fires, so a draft without the condition keeps a
  // byte-identical report.
  const mediaRegistration = assessMediaRegistration(store);

  return {
    ok: !store.diverged,
    project_dir: "<project>",
    canonical: store.canonical.name,
    version: store.version,
    modern_storage: store.modernStorage,
    diverged: store.diverged,
    layout: store.layout,
    nested_timelines: store.nestedTimelines,
    write_guard: safety?.action ?? "ok",
    editor_running: running,
    candidates: store.candidates.map((candidate) => ({
      file: candidate.name,
      exists: candidate.exists,
      size: candidate.size,
      mtime: candidate.mtime,
      sha256: candidate.sha256,
      parseable_timeline: candidate.parseable,
      envelope: candidate.envelopePath.length === 0 ? "root" : candidate.envelopePath.join("."),
      timeline_hash: candidate.timelineHash,
      tracks: candidate.draft?.tracks.length,
      segments: candidate.draft?.tracks.reduce((sum, track) => sum + track.segments.length, 0),
      app_version: candidate.draft?.platform?.app_version ?? null,
      error: candidate.error,
    })),
    next_actions: actions,
    ...(mediaRegistration ? { media_registration: mediaRegistration } : {}),
  };
}
