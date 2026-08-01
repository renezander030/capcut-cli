import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripBom } from "./bom.js";
import type { Draft } from "./draft.js";
import { assessWriteSafety, atLeast } from "./version.js";

const STANDARD_FILES = ["draft_content.json", "draft_info.json", "draft_meta_info.json", "template-2.tmp"] as const;
const ACTIVE_TIMELINE_FILES = ["draft_info.json", "draft_content.json"] as const;

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

/** Which primary project file drives this store: an active draft beneath
 * Timelines/<main_timeline_id> (CapCut 7.x), root draft_content.json, root
 * draft_info.json with no draft_content.json beside it (reported on newer Mac
 * builds — jianying-mcp#5, pyJianYingDraft#177/#194), or neither (timeline
 * readable only from a mirror such as template-2.tmp). */
export type DraftStoreLayout = "timelines-primary" | "content-primary" | "info-primary" | "unknown";

export interface DraftStore {
  projectDir: string;
  canonical: DraftCandidate;
  activeTimeline: DraftCandidate | null;
  targets: DraftCandidate[];
  candidates: DraftCandidate[];
  version: string | null;
  modernStorage: boolean;
  diverged: boolean;
  layout: DraftStoreLayout;
}

export interface DraftStoreReport {
  ok: boolean;
  project_dir: string;
  canonical: string;
  version: string | null;
  modern_storage: boolean;
  diverged: boolean;
  layout: DraftStoreLayout;
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
export function parseCandidate(path: string, displayName?: string): DraftCandidate {
  const name = displayName ?? path.split(/[\\/]/).pop() ?? path;
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
    return {
      ...base,
      parseable: true,
      envelopePath: found.path,
      draft: found.draft,
      timelineHash: hash(JSON.stringify(found.draft)),
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

interface CandidatePath {
  path: string;
  name?: string;
}

interface CandidatePaths {
  projectDir: string;
  requested: string | null;
  candidates: CandidatePath[];
  activeTimelinePaths: string[];
}

function nestedTimelineProjectDir(path: string): string | null {
  const timelineDir = dirname(path);
  const timelinesDir = dirname(timelineDir);
  return basename(timelinesDir).toLowerCase() === "timelines" ? dirname(timelinesDir) : null;
}

function displayPath(projectDir: string, path: string): string {
  return relative(projectDir, path).split(sep).join("/");
}

function isContainedPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function activeTimelineCandidates(projectDir: string): CandidatePath[] {
  const timelinesDir = resolve(projectDir, "Timelines");
  const projectJson = join(timelinesDir, "project.json");
  if (!existsSync(projectJson)) return [];

  let timelineId: unknown;
  try {
    const project = JSON.parse(stripBom(readFileSync(projectJson, "utf-8"))) as Record<string, unknown>;
    timelineId = project.main_timeline_id ?? project.id;
  } catch {
    return [];
  }
  if (typeof timelineId !== "string" || timelineId.length === 0) return [];

  // project.json is app-authored but still untrusted input. Keep a malformed id
  // from escaping the project's Timelines directory through `..` or an absolute
  // path before probing candidate files.
  const activeDir = resolve(timelinesDir, timelineId);
  if (!isContainedPath(timelinesDir, activeDir) || !existsSync(activeDir) || !statSync(activeDir).isDirectory()) {
    return [];
  }

  let realTimelinesDir: string;
  try {
    realTimelinesDir = realpathSync(timelinesDir);
    if (!isContainedPath(realTimelinesDir, realpathSync(activeDir))) return [];
  } catch {
    return [];
  }

  return ACTIVE_TIMELINE_FILES.flatMap((name) => {
    const path = join(activeDir, name);
    if (existsSync(path)) {
      try {
        if (!isContainedPath(realTimelinesDir, realpathSync(path))) return [];
      } catch {
        return [];
      }
    }
    return [{ path, name: displayPath(projectDir, path) }];
  });
}

function candidatePaths(input: string): CandidatePaths {
  const resolved = resolve(input);
  const isFile = existsSync(resolved) && statSync(resolved).isFile();
  let projectDir = isFile ? dirname(resolved) : resolved;
  let activeCandidates: CandidatePath[] = [];
  if (isFile) {
    const nestedProjectDir = nestedTimelineProjectDir(resolved);
    if (nestedProjectDir) {
      const nestedProjectCandidates = activeTimelineCandidates(nestedProjectDir);
      if (nestedProjectCandidates.some((candidate) => candidate.path === resolved)) {
        projectDir = nestedProjectDir;
        activeCandidates = nestedProjectCandidates;
      }
    }
  }
  const requested = isFile ? resolved : null;
  const candidates: CandidatePath[] = [];
  const add = (candidate: CandidatePath): void => {
    const existing = candidates.find((item) => item.path === candidate.path);
    if (existing) {
      // Prefer the project-relative label for an active nested timeline over
      // its otherwise ambiguous basename when the same path was requested.
      if (candidate.name?.includes("/")) existing.name = candidate.name;
      return;
    }
    candidates.push(candidate);
  };
  if (requested) add({ path: requested });
  for (const name of STANDARD_FILES) {
    const path = join(projectDir, name);
    add({ path });
  }
  if (activeCandidates.length === 0) activeCandidates = activeTimelineCandidates(projectDir);
  for (const candidate of activeCandidates) add(candidate);
  return {
    projectDir,
    requested,
    candidates,
    activeTimelinePaths: activeCandidates.map((candidate) => candidate.path),
  };
}

export function discoverDraftStore(input: string): DraftStore {
  const { projectDir, requested, candidates: candidateSpecs, activeTimelinePaths } = candidatePaths(input);
  const candidates = candidateSpecs.map((candidate) => parseCandidate(candidate.path, candidate.name));
  const parseable = candidates.filter((candidate) => candidate.parseable && candidate.draft);
  if (parseable.length === 0) {
    const found = candidates.filter((candidate) => candidate.exists).map((candidate) => candidate.name);
    const detail = found.length > 0 ? `Found ${found.join(", ")}, but none contained a readable timeline.` : "";
    throw new Error(
      `No draft found at: ${input}\nExpected draft_content.json, draft_info.json, draft_meta_info.json, or template-2.tmp. ${detail}`.trim(),
    );
  }

  const versions = parseable
    .map((candidate) => candidate.draft?.platform?.app_version)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const version = versions.sort((a, b) => (atLeast(a, b) ? -1 : 1))[0] ?? null;
  const modernStorage = atLeast(version, "8.7");
  const discoveredActiveTimeline = activeTimelinePaths
    .map((path) => parseable.find((candidate) => candidate.path === path))
    .find((candidate): candidate is DraftCandidate => Boolean(candidate));
  // Preserve the established >=8.7 storage rule: those projects can carry
  // readable legacy/nested mirrors while template-2.tmp remains app-canonical.
  // The nested source-of-truth behavior is verified for pre-8.7 CapCut only.
  const activeTimeline = modernStorage ? undefined : discoveredActiveTimeline;
  const activeTimelinePathSet = new Set(activeTimelinePaths);
  const requestedCandidate = requested ? parseable.find((candidate) => candidate.path === requested) : undefined;
  const explicitlyRequestedActiveTimeline = Boolean(
    requestedCandidate && activeTimelinePathSet.has(requestedCandidate.path),
  );
  const targets = modernStorage
    ? explicitlyRequestedActiveTimeline
      ? parseable.filter((candidate) => candidate.path === requested)
      : parseable.filter((candidate) => !activeTimelinePathSet.has(candidate.path))
    : requestedCandidate && activeTimelinePathSet.size > 0 && !explicitlyRequestedActiveTimeline
      ? parseable.filter((candidate) => !activeTimelinePathSet.has(candidate.path))
      : parseable;

  let canonical = requestedCandidate;
  canonical ??= activeTimeline;
  const preference = modernStorage
    ? ["template-2.tmp", "draft_meta_info.json", "draft_content.json", "draft_info.json"]
    : ["draft_content.json", "draft_info.json", "template-2.tmp", "draft_meta_info.json"];
  canonical ??= preference
    .map((name) => parseable.find((candidate) => candidate.name === name))
    .find((candidate): candidate is DraftCandidate => Boolean(candidate));
  canonical ??= parseable[0];

  const timelineHashes = new Set(targets.map((candidate) => candidate.timelineHash).filter(Boolean));
  const contentReadable = parseable.some((candidate) => candidate.name === "draft_content.json");
  const infoReadable = parseable.some((candidate) => candidate.name === "draft_info.json");
  return {
    projectDir,
    canonical,
    activeTimeline: activeTimeline ?? null,
    targets,
    candidates,
    version,
    modernStorage,
    diverged: timelineHashes.size > 1,
    layout: activeTimeline
      ? "timelines-primary"
      : contentReadable
        ? "content-primary"
        : infoReadable
          ? "info-primary"
          : "unknown",
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

// Files CapCut may read as its timeline source instead of draft_content.json:
// template-2.tmp (>= 8.7 storage) and draft_info.json (the pre-open mirror of a
// CLI-built draft). draft_meta_info.json without a timeline is normal
// registration metadata, not a mirror, so it is never flagged unreconcilable.
const MIRROR_FILES = new Set<string>(["draft_info.json", "template-2.tmp"]);

function candidateFileName(candidate: DraftCandidate): string {
  return basename(candidate.path);
}

function isNestedTimelineCandidate(candidate: DraftCandidate): boolean {
  return candidate.name.startsWith("Timelines/");
}

export interface TimelineSyncTarget {
  file: string;
  state: "canonical" | "in_sync" | "drifted";
  envelope: string;
  mtime: string | null;
  timeline_hash: string | null;
  guid: string | null;
  guid_drifted: boolean;
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
  /** Set when the canonical is not root draft_content.json: explains which
   * storage layout selected the canonical source. */
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
}

export interface TimelineSyncResult {
  plan: TimelineSyncPlan;
  canonicalDraft: Draft;
  canonicalCandidate: DraftCandidate;
  driftedCandidates: DraftCandidate[];
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

/**
 * Plan for `sync-timelines` (issue #39, symptom #35): the storage layout picks
 * the authoritative timeline, then every other readable target is compared
 * against it by timeline hash. CapCut 7.x's Timelines/project.json pointer wins
 * over project-root mirrors; otherwise root draft_content.json is canonical,
 * with root draft_info.json promoted for the draft_info-primary Mac layout.
 * Target mtimes are surfaced because a newer mirror may hold app edits that a
 * repair would roll back (canonical_stale / newer_mirrors flag this; --apply
 * refuses without --force-write). Timelines/project.json is an explicit source
 * of authority, so a newer derived root mirror does not reverse that direction.
 * A mirror file that exists but holds no readable timeline cannot be reconciled
 * and is reported instead of being silently skipped.
 */
export function planTimelineSync(input: string): TimelineSyncResult {
  const resolved = resolve(input);
  const inputIsFile = existsSync(resolved) && statSync(resolved).isFile();
  const store = discoverDraftStore(input);
  const acceptedPrimaryFile =
    !inputIsFile ||
    (store.layout === "timelines-primary"
      ? store.activeTimeline?.path === resolved
      : basename(resolved) === "draft_content.json");
  if (!acceptedPrimaryFile) {
    throw new Error(
      `sync-timelines reconciles a project's mirror files from its primary timeline and cannot target ${basename(resolved)} directly. ` +
        `Pass the project directory instead: capcut sync-timelines ${dirname(resolved)}`,
    );
  }

  // The active Timelines/<id> draft is authoritative when project.json names
  // it. Otherwise retain the existing root-primary selection rules.
  const canonical =
    store.activeTimeline ??
    store.targets.find((candidate) => candidate.name === "draft_content.json") ??
    (store.layout === "info-primary"
      ? store.targets.find((candidate) => candidate.name === "draft_info.json")
      : undefined);
  if (!canonical?.draft) {
    throw new Error(
      "sync-timelines needs a readable draft_content.json or draft_info.json, or an active Timelines draft " +
        "(the canonical timeline source). " +
        "Run `capcut diagnose <project>` to inspect what is on disk.",
    );
  }
  const canonicalNote =
    store.layout === "timelines-primary"
      ? `${canonical.name} is the canonical source: Timelines/project.json identifies it as the active ` +
        "CapCut 7.x timeline; project-root timeline files are derived mirrors."
      : canonical.name === "draft_info.json"
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
    if (store.modernStorage && isNestedTimelineCandidate(candidate)) continue;
    if (!candidate.parseable || !candidate.draft) {
      if (MIRROR_FILES.has(candidateFileName(candidate))) {
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
      if (
        store.layout !== "timelines-primary" &&
        Number.isFinite(canonicalMtime) &&
        Number.isFinite(mirrorMtime) &&
        mirrorMtime > canonicalMtime
      ) {
        newerMirrors.push(candidate.name);
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
    },
    canonicalDraft,
    canonicalCandidate: canonical,
    driftedCandidates,
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
  if (store.layout === "info-primary") {
    actions.push(
      "No draft_content.json: the timeline lives in draft_info.json (draft_info-primary layout, reported as the " +
        "primary project file on newer Mac builds). Edit commands, register, and sync-timelines treat it as " +
        "canonical, but round-trip evidence for this layout is synthetic-only — if this project opens fine in " +
        "your app, contribute a bundle: `capcut fixture <project> --out <dir>`.",
    );
  }
  if (store.layout === "timelines-primary") {
    actions.push(
      `${store.activeTimeline?.name ?? "The active Timelines draft"} is authoritative because ` +
        "Timelines/project.json selects it. Edit commands synchronize its readable project-root mirrors.",
    );
  }
  if (running.length > 0) actions.push(`Close ${running.join(" / ")} before editing this managed draft.`);
  if (actions.length === 0)
    actions.push("Storage targets are readable and agree. A normal CLI write will synchronize them.");

  return {
    ok: !store.diverged,
    project_dir: "<project>",
    canonical: store.canonical.name,
    version: store.version,
    modern_storage: store.modernStorage,
    diverged: store.diverged,
    layout: store.layout,
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
  };
}
