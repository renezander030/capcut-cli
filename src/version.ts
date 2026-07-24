import type { Draft } from "./draft.js";

export type AppSource = "cc" | "lv" | "unknown";

/** Evidence labels, aligned with the taxonomy in docs/version-support.md. */
export type SupportEvidence = "fixture-tested" | "synthetic-tested" | "reported" | "expected-compatible" | "none";

export interface VersionInfo {
  app: "CapCut" | "JianYing" | "unknown";
  app_source: AppSource;
  app_version: string | null;
  os: string | null;
  schema: {
    mask_field: "mask" | "common_masks" | "both" | "none";
    has_text_ranges: boolean;
    has_audio_fades: boolean;
    new_version_field: unknown;
    last_modified_platform: unknown;
    /** Top-level `version` schema integer, when present (the field real
     * app-created drafts carry; CLI-created drafts legitimately lack it). */
    schema_int: number | null;
  };
  support: {
    status: "supported" | "untested" | "known-broken";
    notes: string[];
    /** How the status claim is backed — see docs/version-support.md. */
    evidence: SupportEvidence;
    /** True when a detected version/schema marker is newer than anything this
     * CLI has evidence for. */
    beyond_known_range: boolean;
    /** What saveDraft would do on a write: ok, warn (write + stderr WARNING),
     * or refuse (needs --force-write). */
    write_guard: "ok" | "warn" | "refuse";
  };
}

interface VersionRegistryEntry {
  range: string;
  /** Newest version generation there is any evidence for. Effective versions
   * beyond it refuse at write time (null = no ceiling knowledge). */
  ceiling: string | null;
  /** Versions the CLI round-trips with a committed fixture or a reproducible
   * report, each carrying its honest evidence label. */
  supported: Array<{ version: string; evidence: SupportEvidence }>;
  /** Schema inspection suggests compatibility; no committed fixture. */
  expected_compatible: string[];
  /** Structured known-broken boundaries: any version >= min matches. */
  broken: Array<{ min: string; reason: string }>;
}

const SUPPORTED_APP_VERSIONS: Record<AppSource, VersionRegistryEntry> = {
  cc: {
    range: "6.x — 9.x",
    ceiling: "9.99",
    supported: [
      { version: "6.2.8", evidence: "fixture-tested" },
      // Committed synthetic fixture (test/fixtures/capcut-8.7-windows). A real
      // app-created bundle is still wanted before this moves to fixture-tested.
      { version: "8.7.0", evidence: "synthetic-tested" },
    ],
    expected_compatible: ["6.5.0", "7.0.0", "8.0.0", "9.0.0"],
    broken: [],
  },
  lv: {
    range: "5.9.x (auto-update destroys pinning — see docs/version-support.md)",
    ceiling: "5.99",
    supported: [{ version: "5.9.0", evidence: "reported" }],
    expected_compatible: [],
    broken: [{ min: "6.0", reason: "encrypted draft_content.json era — see `capcut decrypt`" }],
  },
  unknown: {
    range: "unknown",
    ceiling: null,
    supported: [],
    expected_compatible: [],
    broken: [],
  },
};

// Highest top-level `version` schema integer observed in any real draft corpus
// (constant across all known CapCut 8.x fixtures). Evidence level: reported —
// the observing fixtures are not committed in this repo. A larger value means
// a schema generation nothing here has evidence for.
export const KNOWN_SCHEMA_INT_MAX = 360000;

export function versionTuple(version: string | null): number[] {
  return (version ?? "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);
}

export function atLeast(version: string | null, wanted: string): boolean {
  const a = versionTuple(version);
  const b = versionTuple(wanted);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/** Top-level `version` integer: absent in CLI-created and both committed
 * fixtures, so absence is normal and never penalized. */
function schemaInt(draft: Draft): number | null {
  const raw = (draft as Record<string, unknown>).version;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export interface WriteSafety {
  action: "ok" | "warn" | "refuse";
  /** Human sentences, one per trigger; ends with the fixture-collection CTA
   * whenever action is not "ok". */
  reasons: string[];
  detected: {
    app_source: AppSource;
    app_version: string | null;
    schema_int: number | null;
    beyond_known_range: boolean;
  };
}

const FIXTURE_CTA =
  "If this project opens fine in your app, run `capcut fixture <project> --out <dir>` to build a redacted bundle " +
  "and attach it to an issue so this version can move to fixture-tested; or pass --force-write to write anyway.";

/**
 * Write-time version boundary (mined pain: NEW app builds reject tool-written
 * drafts as "content corrupted" / 内容已损坏, and no version marker was checked
 * at write time). Refuses when the draft's detected version or schema
 * generation is beyond the registry's evidence or known-broken; warns on
 * unrecognized-but-marked sources and old schema generations. Markerless
 * drafts (`capcut create` output has no platform and no top-level `version`)
 * never trigger — every marker is optional.
 *
 * `storeVersion` is the max app_version across the project's readable sibling
 * files, so a mirror written by a newer app build trips the guard too. Pass
 * null when no store has been discovered (dry-run, single-draft assessment).
 */
export function assessWriteSafety(draft: Draft, storeVersion: string | null): WriteSafety {
  const platform = draft.platform;
  const rawSource = platform?.app_source;
  const app_source: AppSource = rawSource === "cc" ? "cc" : rawSource === "lv" ? "lv" : "unknown";
  const last = (draft as Record<string, unknown>).last_modified_platform as
    | { app_version?: unknown }
    | null
    | undefined;
  const lastVersion = typeof last?.app_version === "string" ? last.app_version : null;
  const schema_int = schemaInt(draft);

  // Effective version = numeric max of every marker in reach: the draft's own
  // platform, whoever wrote it last, and the newest sibling file.
  const candidates = [platform?.app_version ?? null, lastVersion, storeVersion].filter(
    (value): value is string => typeof value === "string" && versionTuple(value).length > 0,
  );
  const app_version = candidates.sort((a, b) => (atLeast(a, b) ? -1 : 1))[0] ?? null;

  const registry = SUPPORTED_APP_VERSIONS[app_source];
  const beyondCeiling = app_version !== null && registry.ceiling !== null && !atLeast(registry.ceiling, app_version);
  const beyond_known_range = beyondCeiling || (schema_int !== null && schema_int > KNOWN_SCHEMA_INT_MAX);
  const detected = { app_source, app_version, schema_int, beyond_known_range };

  const brokenMatch = app_version !== null ? registry.broken.find((entry) => atLeast(app_version, entry.min)) : null;
  if (brokenMatch) {
    return {
      action: "refuse",
      reasons: [
        `${app_source === "lv" ? "JianYing" : "CapCut"} ${app_version} is known-broken (>= ${brokenMatch.min}: ${brokenMatch.reason}). ` +
          'A plaintext write may be ignored or shown as corrupted ("内容已损坏") by the app. See docs/version-support.md.',
        FIXTURE_CTA,
      ],
      detected,
    };
  }
  if (beyondCeiling) {
    return {
      action: "refuse",
      reasons: [
        `${app_source === "cc" ? "CapCut" : "JianYing"} ${app_version} is newer than any version this CLI has evidence for ` +
          `(supported range ${registry.range}). New builds are reported to reject tool-written drafts as corrupted.`,
        FIXTURE_CTA,
      ],
      detected,
    };
  }
  if (schema_int !== null && schema_int > KNOWN_SCHEMA_INT_MAX) {
    return {
      action: "refuse",
      reasons: [
        `Draft schema integer ${schema_int} is newer than the newest known generation (${KNOWN_SCHEMA_INT_MAX}), ` +
          "so a round-trip through this CLI is unverified and the app may reject the written draft.",
        FIXTURE_CTA,
      ],
      detected,
    };
  }

  const reasons: string[] = [];
  if (app_source === "unknown" && rawSource !== undefined && (app_version !== null || schema_int !== null)) {
    reasons.push(`Unrecognized app source "${String(rawSource)}" — proceeding, but round-trip is unverified.`);
  } else if (app_source === "unknown" && app_version !== null) {
    // Markerless canonical (no `platform` block at all) whose effective app
    // version comes from `last_modified_platform` or a newer readable sibling:
    // an app build wrote part of this store, so a silent overwrite would hide
    // that. (A markerless draft with no version marker anywhere stays silent —
    // that is exactly what `capcut create` emits.)
    reasons.push(
      `Draft has no app-source marker but carries app version ${app_version} ` +
        "(from last_modified_platform or a sibling file) — proceeding, but round-trip is unverified.",
    );
  }
  if (schema_int !== null && schema_int < KNOWN_SCHEMA_INT_MAX) {
    reasons.push(`Older schema generation ${schema_int} — round-trip untested.`);
  }
  if (reasons.length > 0) {
    return { action: "warn", reasons: [...reasons, FIXTURE_CTA], detected };
  }
  return { action: "ok", reasons: [], detected };
}

export function detectVersion(draft: Draft): VersionInfo {
  const platform = draft.platform;
  const app_source: AppSource = platform?.app_source === "cc" ? "cc" : platform?.app_source === "lv" ? "lv" : "unknown";
  const app = app_source === "cc" ? "CapCut" : app_source === "lv" ? "JianYing" : "unknown";
  const app_version = platform?.app_version ?? null;
  const os = platform?.os ?? null;

  const mask_field = detectMaskField(draft);
  const has_text_ranges = detectTextRanges(draft);
  const has_audio_fades = Array.isArray((draft.materials as Record<string, unknown>).audio_fades);
  const new_version_field = (draft as Record<string, unknown>).new_version ?? null;
  const last_modified_platform = (draft as Record<string, unknown>).last_modified_platform ?? null;
  const schema_int = schemaInt(draft);

  const support = assessSupport(app_source, app_version);
  if (mask_field === "common_masks") {
    support.notes.push(
      "Draft uses `common_masks` (JianYing 9.6+ / CapCut newer) — `mask` command writes legacy field; use `capcut migrate --to common_masks` once shipped",
    );
  }
  if (app_source === "lv" && app_version && !app_version.startsWith("5.9")) {
    // Never downgrade a structured known-broken verdict to untested.
    if (support.status !== "known-broken") support.status = "untested";
    support.notes.push(`JianYing ${app_version} is post-5.9 — likely encrypted; pinning to 5.9 strongly recommended`);
  }

  // Write-guard preview (draft-only; no store discovery here), so
  // `capcut version` answers "will a write be allowed?" without attempting one.
  const safety = assessWriteSafety(draft, null);
  for (const reason of safety.reasons) support.notes.push(reason);

  return {
    app,
    app_source,
    app_version,
    os,
    schema: { mask_field, has_text_ranges, has_audio_fades, new_version_field, last_modified_platform, schema_int },
    support: {
      status: support.status,
      notes: support.notes,
      evidence: support.evidence,
      beyond_known_range: safety.detected.beyond_known_range,
      write_guard: safety.action,
    },
  };
}

function detectMaskField(draft: Draft): VersionInfo["schema"]["mask_field"] {
  const mats = draft.materials as Record<string, unknown>;
  const hasMask = Array.isArray(mats.masks) && (mats.masks as unknown[]).length > 0;
  const hasCommon = Array.isArray(mats.common_masks) && (mats.common_masks as unknown[]).length > 0;
  if (hasMask && hasCommon) return "both";
  if (hasCommon) return "common_masks";
  if (hasMask) return "mask";
  return "none";
}

function detectTextRanges(draft: Draft): boolean {
  for (const mat of draft.materials.texts ?? []) {
    if (typeof mat.content !== "string") continue;
    try {
      const parsed = JSON.parse(mat.content) as { styles?: unknown[] };
      if (Array.isArray(parsed.styles) && parsed.styles.length > 1) return true;
    } catch {
      /* not parseable, skip */
    }
  }
  return false;
}

function assessSupport(
  app_source: AppSource,
  app_version: string | null,
): { status: VersionInfo["support"]["status"]; notes: string[]; evidence: SupportEvidence } {
  const notes: string[] = [];
  const matrix = SUPPORTED_APP_VERSIONS[app_source];
  notes.push(
    `${app_source === "cc" ? "CapCut" : app_source === "lv" ? "JianYing" : "Unknown app"} supported range: ${matrix.range}`,
  );
  if (!app_version) {
    return {
      status: "untested",
      evidence: "none",
      notes: [...notes, "No `platform.app_version` field — cannot assess compatibility"],
    };
  }
  const brokenMatch = matrix.broken.find((entry) => atLeast(app_version, entry.min));
  if (brokenMatch) {
    notes.push(`Version ${app_version} listed as known-broken (>= ${brokenMatch.min}: ${brokenMatch.reason})`);
    return { status: "known-broken", evidence: "reported", notes };
  }
  const supportedMatch = matrix.supported.find((entry) => entry.version === app_version);
  if (supportedMatch) {
    return { status: "supported", evidence: supportedMatch.evidence, notes };
  }
  if (matrix.expected_compatible.includes(app_version)) {
    notes.push(
      `Version ${app_version} is expected-compatible (schema inspection only; no committed fixture — see docs/version-support.md)`,
    );
    return { status: "untested", evidence: "expected-compatible", notes };
  }
  if (matrix.ceiling !== null && !atLeast(matrix.ceiling, app_version)) {
    notes.push(
      `Version ${app_version} is beyond the known range (${matrix.range}) — no evidence this CLI can round-trip it`,
    );
    return { status: "untested", evidence: "none", notes };
  }
  notes.push(
    `Version ${app_version} not in the evidence-backed list (${matrix.supported.map((entry) => entry.version).join(", ") || "none yet"}) — may work`,
  );
  return { status: "untested", evidence: "none", notes };
}
