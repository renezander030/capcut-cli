import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripBom } from "./bom.js";
import type { Draft } from "./draft.js";
import { discoverDraftStore } from "./store.js";
import type { AppSource } from "./version.js";
import { assessWriteSafety } from "./version.js";

/**
 * App auto-upgrade tripwire (`app-versions.json`).
 *
 * The desktop apps update themselves, and an updated build silently rewrites
 * the drafts it opens — a pipeline validated against 8.x wakes up to a 10.x
 * store and drafts that have crossed a support boundary, with nothing in the
 * toolchain saying so (GuanYixuan/pyJianYingDraft#115, #178). This module
 * remembers the last version evidence the CLI saw per draft store — in the
 * CLI's own config area, following the `harvest-enums` per-user catalogue
 * pattern (~/.config/capcut-cli/, env override, never state inside a draft) —
 * and compares on every mutating write:
 *
 * - first sighting records silently;
 * - a difference prints a stderr WARNING naming old -> new and adds an
 *   `app_version_drift` field to the command's JSON result — warn only,
 *   NEVER a refusal (the v0.15 write guard remains the sole gate on
 *   beyond-evidence writes);
 * - `capcut version` reports the drift read-only (it never updates the
 *   record) and `capcut doctor` re-inspects every tracked store.
 *
 * The evidence tuple is the write guard's own detection (`assessWriteSafety`
 * `.detected`): effective app version (max across platform,
 * last_modified_platform, and the newest readable sibling), app source, and
 * the top-level schema integer. Markerless CLI-created drafts carry no
 * evidence and are never tracked. A hand-broken state file never breaks a
 * write — it reads as empty with a WARNING and the next mutating write
 * rebuilds it (the `user-enums.json` robustness rule).
 */

export const APP_VERSIONS_ENV = "CAPCUT_CLI_APP_VERSIONS";

export interface AppVersionEvidence {
  app_source: AppSource;
  app_version: string | null;
  schema_int: number | null;
}

export interface AppVersionRecord extends AppVersionEvidence {
  seen_at: string;
}

export interface AppVersionDrift {
  store_dir: string;
  from: AppVersionRecord;
  to: AppVersionEvidence;
  /** Human fragments, one per changed marker: "app version 8.7.0 -> 10.5.0". */
  changes: string[];
}

interface AppVersionsFile {
  version: 1;
  stores: Record<string, AppVersionRecord>;
}

export function appVersionsPath(override?: string): string {
  if (override) return resolve(override);
  const env = process.env[APP_VERSIONS_ENV];
  if (env) return resolve(env);
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "capcut-cli", "app-versions.json");
}

function isRecord(value: unknown): value is AppVersionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<AppVersionRecord>;
  return typeof record.app_source === "string" && typeof record.seen_at === "string";
}

export function loadAppVersions(path: string = appVersionsPath()): {
  stores: Record<string, AppVersionRecord>;
  error: string | null;
} {
  if (!existsSync(path)) return { stores: {}, error: null };
  try {
    const parsed = JSON.parse(stripBom(readFileSync(path, "utf-8"))) as Partial<AppVersionsFile>;
    if (!parsed.stores || typeof parsed.stores !== "object" || Array.isArray(parsed.stores)) {
      return { stores: {}, error: `app-version state has no stores{} object (${path})` };
    }
    const stores: Record<string, AppVersionRecord> = {};
    for (const [dir, record] of Object.entries(parsed.stores)) {
      if (isRecord(record)) stores[dir] = record;
    }
    return { stores, error: null };
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    return { stores: {}, error: `app-version state did not parse: ${message} (${path})` };
  }
}

/** The tripwire's evidence tuple for a draft: exactly what the write guard
 * detects. Null when the draft carries no version evidence at all (markerless
 * `capcut create` output) — such stores are never tracked. */
export function appVersionEvidence(draft: Draft, storeVersion: string | null): AppVersionEvidence | null {
  const detected = assessWriteSafety(draft, storeVersion).detected;
  if (detected.app_version === null && detected.schema_int === null) return null;
  return { app_source: detected.app_source, app_version: detected.app_version, schema_int: detected.schema_int };
}

function describeChanges(last: AppVersionEvidence, current: AppVersionEvidence): string[] {
  const changes: string[] = [];
  const label = (value: string | number | null) => (value === null ? "(none)" : String(value));
  if (last.app_version !== current.app_version) {
    changes.push(`app version ${label(last.app_version)} -> ${label(current.app_version)}`);
  }
  if (last.app_source !== current.app_source) {
    changes.push(`app source ${last.app_source} -> ${current.app_source}`);
  }
  if (last.schema_int !== current.schema_int) {
    changes.push(`schema generation ${label(last.schema_int)} -> ${label(current.schema_int)}`);
  }
  return changes;
}

function driftBetween(
  storeDir: string,
  last: AppVersionRecord | undefined,
  current: AppVersionEvidence | null,
): AppVersionDrift | null {
  if (!last || !current) return null;
  const changes = describeChanges(last, current);
  if (changes.length === 0) return null;
  return { store_dir: storeDir, from: last, to: current, changes };
}

/** Read-only comparison for `version` and `doctor` — never records. */
export function assessAppVersionDrift(
  projectDir: string,
  evidence: AppVersionEvidence | null,
  statePath: string = appVersionsPath(),
): { drift: AppVersionDrift | null; error: string | null } {
  const { stores, error } = loadAppVersions(statePath);
  const storeDir = resolve(projectDir);
  return { drift: driftBetween(storeDir, stores[storeDir], evidence), error };
}

// Same atomic write the user-enums catalogue uses: temp + fsync + rename,
// 0600, parent dir created on demand.
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

// Drift found by the most recent mutating write, for the CLI layer to stamp
// into the command's JSON result (the isDryRun/out pattern). Consumed once.
let pendingDrift: AppVersionDrift | null = null;

export function takeAppVersionDrift(): AppVersionDrift | null {
  const drift = pendingDrift;
  pendingDrift = null;
  return drift;
}

/**
 * Mutating-write tripwire: compare the store's current evidence against the
 * last-seen record, remember any drift for the JSON result, and update the
 * record. Only a change touches the file (first sighting or drift); a corrupt
 * state file is treated as empty — the caller surfaces `error` as a WARNING —
 * and is rebuilt here. Warn only: this function never throws on state
 * problems and never blocks the write it accompanies.
 */
export function trackAppVersion(
  projectDir: string,
  evidence: AppVersionEvidence | null,
  statePath: string = appVersionsPath(),
): { drift: AppVersionDrift | null; error: string | null } {
  const { stores, error } = loadAppVersions(statePath);
  if (!evidence) return { drift: null, error };
  const storeDir = resolve(projectDir);
  const last = stores[storeDir];
  const drift = driftBetween(storeDir, last, evidence);
  if (drift) pendingDrift = drift;
  if (!last || drift) {
    const file: AppVersionsFile = {
      version: 1,
      stores: { ...stores, [storeDir]: { ...evidence, seen_at: new Date().toISOString() } },
    };
    try {
      writeAtomicLocal(statePath, `${JSON.stringify(file, null, 2)}\n`);
    } catch (writeError) {
      const message = writeError instanceof Error ? writeError.message : String(writeError);
      return { drift, error: error ?? `app-version state could not be written: ${message} (${statePath})` };
    }
  }
  return { drift, error };
}

export function formatAppVersionDriftWarning(drift: AppVersionDrift): string {
  const app = drift.to.app_source === "lv" ? "JianYing" : drift.to.app_source === "cc" ? "CapCut" : "The app";
  return (
    `App version drift in this draft store: ${drift.changes.join(", ")} (recorded ${drift.from.seen_at}). ` +
    `${app} may have auto-updated since the CLI last wrote here and drafts may have crossed a support boundary. ` +
    'Warning only — writes stay gated by the version guard. See "Pinning app updates" in docs/version-support.md.'
  );
}

/** `doctor` sweep: re-inspect every tracked store dir that still holds a
 * readable draft and report the ones whose evidence moved. */
export function scanTrackedStores(statePath: string = appVersionsPath()): {
  tracked: number;
  drifts: AppVersionDrift[];
  error: string | null;
} {
  const { stores, error } = loadAppVersions(statePath);
  const drifts: AppVersionDrift[] = [];
  for (const [dir, last] of Object.entries(stores)) {
    if (!existsSync(dir)) continue; // deleted project — not drift
    let evidence: AppVersionEvidence | null = null;
    try {
      const store = discoverDraftStore(dir);
      if (!store.canonical.draft) continue;
      evidence = appVersionEvidence(store.canonical.draft, store.version);
    } catch {
      continue; // no readable timeline anymore — diagnose covers that story
    }
    const drift = driftBetween(dir, last, evidence);
    if (drift) drifts.push(drift);
  }
  return { tracked: Object.keys(stores).length, drifts, error };
}
