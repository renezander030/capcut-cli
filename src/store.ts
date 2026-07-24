import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
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

export interface DraftStore {
  projectDir: string;
  canonical: DraftCandidate;
  targets: DraftCandidate[];
  candidates: DraftCandidate[];
  version: string | null;
  modernStorage: boolean;
  diverged: boolean;
}

export interface DraftStoreReport {
  ok: boolean;
  project_dir: string;
  canonical: string;
  version: string | null;
  modern_storage: boolean;
  diverged: boolean;
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

function parseCandidate(path: string): DraftCandidate {
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

  const versions = parseable
    .map((candidate) => candidate.draft?.platform?.app_version)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const version = versions.sort((a, b) => (atLeast(a, b) ? -1 : 1))[0] ?? null;
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

  const timelineHashes = new Set(parseable.map((candidate) => candidate.timelineHash).filter(Boolean));
  return {
    projectDir,
    canonical,
    targets: parseable,
    candidates,
    version,
    modernStorage,
    diverged: timelineHashes.size > 1,
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
 * Plan for `sync-timelines` (issue #39, symptom #35): draft_content.json is
 * canonical; every other readable timeline target is compared against it by
 * timeline hash. Direction is always draft_content.json -> mirror, but each
 * target's mtime is surfaced: CapCut >= 8.7 writes the mirrors on save, so a
 * drifted mirror NEWER than draft_content.json may hold app edits that the
 * repair would roll back (canonical_stale / newer_mirrors flag this; --apply
 * refuses without --force-write). A mirror file that exists but holds no
 * readable timeline (binary/encrypted template-2.tmp) cannot be reconciled
 * and is reported as such instead of being silently skipped. Accepts a
 * project directory or its draft_content.json path; any other explicitly
 * named file is rejected so the plan and the write always cover the same
 * target set.
 */
export function planTimelineSync(input: string): TimelineSyncResult {
  const resolved = resolve(input);
  if (existsSync(resolved) && statSync(resolved).isFile() && basename(resolved) !== "draft_content.json") {
    throw new Error(
      `sync-timelines reconciles a project's mirror files from draft_content.json and cannot target ${basename(resolved)} directly. ` +
        `Pass the project directory instead: capcut sync-timelines ${dirname(resolved)}`,
    );
  }
  const store = discoverDraftStore(input);
  const canonical = store.targets.find((candidate) => candidate.name === "draft_content.json");
  if (!canonical?.draft) {
    // draft_info-primary layout: reported as the primary project file on newer
    // Mac builds. Messaging only — promoting draft_info.json to a first-class
    // sync canonical needs a real fixture first.
    if (store.targets.some((candidate) => candidate.name === "draft_info.json" && candidate.draft)) {
      throw new Error(
        "This project has no readable draft_content.json; its timeline lives in draft_info.json " +
          "(reported as the primary project file on newer Mac builds). sync-timelines reconciles mirrors " +
          "FROM draft_content.json and cannot run here. Normal edit commands can target the draft_info.json " +
          "directly; run `capcut diagnose <project>` and consider contributing a fixture: " +
          "`capcut fixture <project> --out <dir>`.",
      );
    }
    throw new Error(
      "sync-timelines needs a readable draft_content.json (the canonical timeline source). " +
        "Run `capcut diagnose <project>` to inspect what is on disk.",
    );
  }
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

  return {
    plan: {
      project_dir: store.projectDir,
      canonical: canonical.name,
      canonical_path: canonical.path,
      version: store.version,
      modern_storage: store.modernStorage,
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
