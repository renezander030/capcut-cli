// `fixture` — automate the "attach a sanitized project folder, remove private
// media and paths first" step from docs/version-support.md. Issue #35 (CapCut
// 8.7 Windows) is blocked on a *real* app-created draft folder, but reporters
// won't (and shouldn't) paste a folder full of private media and absolute home
// paths. This produces a shareable bundle: the timeline JSON only (no binary
// media), with user home paths and emails redacted, plus a diagnose report and
// a README explaining what to do with it. That is the concrete, Linux-buildable
// half of the "compatibility proof pack" — the other half (running it in a real
// CapCut 8.7 desktop) can only happen on Windows.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stripBom } from "./bom.js";
import { keyframePropertyTypes } from "./decorators.js";
import type { Draft } from "./draft.js";
import { diagnoseDraftStore, discoverDraftStore, parseCandidate } from "./store.js";
import { detectVersion } from "./version.js";

// Only the timeline envelopes are bundled — never assets/ media.
const TIMELINE_FILES = ["draft_content.json", "draft_info.json", "draft_meta_info.json", "template-2.tmp"];

interface Redactor {
  kind: string;
  pattern: RegExp;
  // Replacement string; may reference $1 (the captured path prefix).
  replace: string;
}

// Applied to the raw file text so it works regardless of envelope shape
// (root JSON, nested object, or the string-JSON used by template-2.tmp).
const REDACTORS: Redactor[] = [
  { kind: "windows_user", pattern: /([A-Za-z]:\\Users\\)[^\\/"<>:|?*]+/g, replace: "$1USER" },
  { kind: "windows_user_fwd", pattern: /([A-Za-z]:\/Users\/)[^/"<>:|?*]+/g, replace: "$1USER" },
  { kind: "macos_user", pattern: /(\/Users\/)[^/"]+/g, replace: "$1USER" },
  { kind: "linux_user", pattern: /(\/home\/)[^/"]+/g, replace: "$1USER" },
  { kind: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: "redacted@example.com" },
  // Device identifiers (#59). CapCut stamps these into the `platform` and
  // `last_modified_platform` blocks, so they ride along in draft_info.json,
  // template-2.tmp and every nested timeline copy. Keyed on the field NAME and
  // never on the value shape: device_id and mac_address are plain 32-hex, and a
  // bare /[0-9a-f]{32}/ would also blank legitimate material and segment UUIDs.
  // The optional backslashes match the escaped-quote form that template-2.tmp
  // uses for its string-JSON. Only a non-empty value matches, so an already
  // blank hard_disk_id is not counted as something this removed.
  {
    kind: "device_ids",
    pattern: /(\\?"(?:device_id|mac_address|hard_disk_id)\\?"\s*:\s*\\?")[^"\\]+(\\?")/g,
    replace: "$1$2",
  },
];

export interface SanitizeFileResult {
  file: string;
  bytes_in: number;
  bytes_out: number;
  redactions: number;
}

export interface SanitizeReport {
  ok: boolean;
  source_dir: string;
  out_dir: string;
  version: string | null;
  modern_storage: boolean;
  files: SanitizeFileResult[];
  redaction_kinds: Record<string, number>;
  media_excluded: boolean;
  mask_keyframe_evidence: MaskKeyframeSummary;
  notes: string[];
}

function redact(raw: string, tally: Record<string, number>): { text: string; count: number } {
  let text = raw;
  let count = 0;
  // Paths first (they never contain '@'), then emails.
  for (const r of REDACTORS) {
    const matches = text.match(r.pattern);
    const n = matches ? matches.length : 0;
    if (n === 0) continue;
    tally[r.kind] = (tally[r.kind] ?? 0) + n;
    count += n;
    text = text.replace(r.pattern, r.replace);
  }
  return { text, count };
}

// --- Mask-keyframe evidence harvest (#44) -----------------------------------
// The mask-geometry keyframe encoding has NO public ground truth: no KFTypeMask*
// property_type has ever been captured from an app-authored draft, and it is
// unknown whether the app keyframes masks via segment.common_keyframes or via a
// container inside the mask material itself. An invented encoding would save
// fine and silently no-op in the app (the pyJianYingDraft#160 failure class),
// so the CLI deliberately does not write mask keyframes. Instead, every fixture
// bundle maps the mask + keyframe structures the draft actually contains, so a
// reporter who animated a mask in the desktop app can hand issue #44 exactly
// the missing encoding. Extraction runs on the REDACTED text — nothing the
// redactors scrubbed can re-enter through this report.

/** The three mask material array variants seen in the wild (see decorators.ts). */
const MASK_ARRAY_KEYS = new Set(["masks", "common_mask", "common_masks"]);

// Keys addMask() itself writes. Anything beyond these on an app-authored mask
// entry is surfaced — one of them may be the keyframe container #44 needs.
const CLI_MASK_ENTRY_KEYS = new Set([
  "config",
  "category",
  "category_id",
  "category_name",
  "id",
  "name",
  "platform",
  "position_info",
  "resource_type",
  "resource_id",
  "type",
]);

export interface MaskEvidence {
  json_path: string;
  id: string | null;
  name: string | null;
  resource_type: string | null;
  config_keys: string[];
  /** Keys on the mask entry beyond what this CLI writes — worth a human look. */
  unrecognized_keys: string[];
  /** Paths under this mask entry that look like keyframes (time_offset / keyframe_list / property_type). */
  keyframe_shaped_nodes: string[];
}

export interface MaskedSegmentEvidence {
  segment_id: string | null;
  mask_material_ids: string[];
  property_types: string[];
}

export interface MaskKeyframeFileEvidence {
  file: string;
  parsed: boolean;
  masks: MaskEvidence[];
  property_types: { known: string[]; unknown: string[] };
  /** Segments carrying BOTH a mask ref and common_keyframes entries. */
  segments_with_mask_and_keyframes: MaskedSegmentEvidence[];
}

export type MaskKeyframeVerdict = "mask-keyframe-evidence-found" | "no-mask-keyframe-evidence";

export interface MaskKeyframeSummary {
  verdict: MaskKeyframeVerdict;
  masks_found: number;
  unknown_property_types_on_masked_segments: string[];
}

export interface MaskKeyframeReport {
  issue: string;
  looking_for: string[];
  verdict: MaskKeyframeVerdict;
  summary: MaskKeyframeSummary;
  files: MaskKeyframeFileEvidence[];
}

function tryParseEmbeddedJson(s: string): unknown {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === "object" && v !== null ? v : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function harvestFileEvidence(
  file: string,
  text: string,
  knownPropertyTypes: ReadonlySet<string>,
): MaskKeyframeFileEvidence {
  const none: MaskKeyframeFileEvidence = {
    file,
    parsed: false,
    masks: [],
    property_types: { known: [], unknown: [] },
    segments_with_mask_and_keyframes: [],
  };
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return none;
  }

  const masks: MaskEvidence[] = [];
  const maskIds = new Set<string>();
  const propertyTypes = new Set<string>();
  const segments: Array<{ id: string | null; refs: string[]; props: string[] }> = [];
  const seenMasks = new Set<object>();

  const recordMask = (obj: Record<string, unknown>, path: string): MaskEvidence => {
    seenMasks.add(obj);
    const rec: MaskEvidence = {
      json_path: path,
      id: typeof obj.id === "string" ? obj.id : null,
      name: typeof obj.name === "string" ? obj.name : null,
      resource_type: typeof obj.resource_type === "string" ? obj.resource_type : null,
      config_keys: isPlainObject(obj.config) ? Object.keys(obj.config).sort() : [],
      unrecognized_keys: Object.keys(obj)
        .filter((k) => !CLI_MASK_ENTRY_KEYS.has(k))
        .sort(),
      keyframe_shaped_nodes: [],
    };
    masks.push(rec);
    if (rec.id) maskIds.add(rec.id);
    return rec;
  };

  const visit = (node: unknown, path: string, maskCtx: MaskEvidence | null, isMaskArrayElement: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        visit(v, `${path}[${i}]`, maskCtx, false);
      });
      return;
    }
    if (typeof node === "string") {
      // template-2.tmp nests whole timeline documents as string-JSON values.
      const embedded = tryParseEmbeddedJson(node);
      if (embedded !== undefined) visit(embedded, `${path}<embedded-json>`, maskCtx, false);
      return;
    }
    if (!isPlainObject(node)) return;
    const obj = node;

    let ctx = maskCtx;
    if ((obj.type === "mask" || isMaskArrayElement) && !seenMasks.has(obj)) {
      ctx = recordMask(obj, path);
    }
    if (typeof obj.property_type === "string") propertyTypes.add(obj.property_type);
    if (ctx && ("time_offset" in obj || "keyframe_list" in obj || typeof obj.property_type === "string")) {
      ctx.keyframe_shaped_nodes.push(path);
    }
    if (Array.isArray(obj.common_keyframes) && Array.isArray(obj.extra_material_refs)) {
      const props = obj.common_keyframes
        .filter(isPlainObject)
        .map((k) => k.property_type)
        .filter((p): p is string => typeof p === "string");
      if (props.length > 0) {
        segments.push({
          id: typeof obj.id === "string" ? obj.id : null,
          refs: obj.extra_material_refs.filter((r): r is string => typeof r === "string"),
          props,
        });
      }
    }

    for (const [k, v] of Object.entries(obj)) {
      if (MASK_ARRAY_KEYS.has(k) && Array.isArray(v)) {
        v.forEach((el, i) => {
          visit(el, `${path}.${k}[${i}]`, ctx, true);
        });
      } else {
        visit(v, `${path}.${k}`, ctx, false);
      }
    }
  };

  visit(root, "$", null, false);

  const found = [...propertyTypes].sort();
  return {
    file,
    parsed: true,
    masks,
    property_types: {
      known: found.filter((p) => knownPropertyTypes.has(p)),
      unknown: found.filter((p) => !knownPropertyTypes.has(p)),
    },
    segments_with_mask_and_keyframes: segments
      .map((s) => ({
        segment_id: s.id,
        mask_material_ids: s.refs.filter((r) => maskIds.has(r)),
        property_types: [...new Set(s.props)].sort(),
      }))
      .filter((s) => s.mask_material_ids.length > 0),
  };
}

/** Build the #44 harvest report from the redacted timeline texts of a bundle. */
export function buildMaskKeyframeReport(files: Array<{ file: string; text: string }>): MaskKeyframeReport {
  const known: ReadonlySet<string> = new Set(keyframePropertyTypes());
  const evidence = files.map((f) => harvestFileEvidence(f.file, f.text, known));

  const keyframesInsideMasks = evidence.some((f) => f.masks.some((m) => m.keyframe_shaped_nodes.length > 0));
  const unknownOnMasked = [
    ...new Set(
      evidence.flatMap((f) =>
        f.segments_with_mask_and_keyframes.flatMap((s) => s.property_types.filter((p) => !known.has(p))),
      ),
    ),
  ].sort();
  const verdict: MaskKeyframeVerdict =
    keyframesInsideMasks || unknownOnMasked.length > 0 ? "mask-keyframe-evidence-found" : "no-mask-keyframe-evidence";

  return {
    issue: "https://github.com/renezander030/capcut-cli/issues/44",
    looking_for: [
      "property_type identifiers for mask geometry (a KFTypeMask* family?) in segment.common_keyframes",
      "OR a keyframe container inside the mask material entry itself (masks/common_mask/common_masks)",
      "from a draft where the desktop app itself animated a mask — no such capture exists publicly yet",
    ],
    verdict,
    summary: {
      verdict,
      masks_found: evidence.reduce((n, f) => n + f.masks.length, 0),
      unknown_property_types_on_masked_segments: unknownOnMasked,
    },
    files: evidence,
  };
}

function reporterReadme(
  version: string | null,
  modernStorage: boolean,
  nestedTimelines: string[],
  maskEvidenceFound: boolean,
): string {
  const nestedLine =
    nestedTimelines.length > 0
      ? `\n- Nested Timelines/ layout captured (issue #50): ${nestedTimelines.join(", ")}`
      : "";
  const maskSection = maskEvidenceFound
    ? `This draft appears to CONTAIN mask-keyframe structures. Attaching this bundle
to issue #44 supplies exactly the ground truth that feature is blocked on.`
    : `No mask-keyframe structures were found in this draft. To help #44: animate a
mask in the desktop app (two position keyframes are enough), save, and re-run
\`capcut fixture\` on that draft.`;
  return `# Sanitized CapCut draft bundle

This folder was produced by \`capcut fixture\`. It contains **only** the timeline
JSON files from a real project, with user home paths, email addresses and the
device identifiers CapCut stamps into every draft (\`device_id\`,
\`mac_address\`, \`hard_disk_id\`) redacted. No media from \`assets/\` was copied.

- Detected app version: ${version ?? "unknown"}
- Modern storage layout (CapCut >= 8.7): ${modernStorage ? "yes" : "no"}${nestedLine}

## What to do with it

1. Open the files and confirm nothing private remains (names in titles, custom
   absolute paths the redactor may not know about, etc.). Edit freely — only the
   storage *structure* matters for the bug, not the content.
2. Attach this folder to the relevant issue (CapCut 8.7 Windows: issue #35).
3. With a real app-created bundle committed as a fixture, the version can move
   from "synthetic-tested" to "fixture-tested" in docs/version-support.md.

## Mask-keyframe harvest (issue #44)

\`mask-keyframe-report.json\` maps every mask material and keyframe structure
found in this bundle. The mask-geometry keyframe encoding has no public ground
truth, so the CLI cannot write mask keyframes yet — a real app-authored capture
is the missing artifact.

${maskSection}

## What this does NOT prove

A sanitized bundle proves the *on-disk shape*. It does not prove the CLI's
edits open correctly in the CapCut desktop app on your version — that still
needs a manual open-in-CapCut check on the real machine.
`;
}

/**
 * Build a shareable, redacted fixture bundle from a real draft folder.
 * Reuses the same storage discovery the `diagnose` command uses, so the
 * reported version/canonical-file analysis matches.
 */
export function sanitizeDraftBundle(input: string, outDir: string): SanitizeReport {
  const store = discoverDraftStore(input); // throws if no readable draft
  const out = resolve(outDir);
  mkdirSync(out, { recursive: true });

  const tally: Record<string, number> = {};
  const files: SanitizeFileResult[] = [];
  const bundledTexts: Array<{ file: string; text: string }> = [];
  for (const name of TIMELINE_FILES) {
    const src = join(store.projectDir, name);
    if (!existsSync(src)) continue;
    const raw = stripBom(readFileSync(src, "utf-8"));
    const { text, count } = redact(raw, tally);
    writeFileSync(join(out, name), text, "utf-8");
    files.push({ file: name, bytes_in: Buffer.byteLength(raw), bytes_out: Buffer.byteLength(text), redactions: count });
    bundledTexts.push({ file: name, text });
  }

  // Nested Timelines/ layout (issue #50): the structural artifact that issue
  // is blocked on is exactly Timelines/project.json plus the nested timeline
  // documents, so bundle them (redacted, relative paths preserved) whenever
  // discovery reported them. Still JSON only — nothing else under Timelines/
  // is copied.
  for (const rel of store.nestedTimelines) {
    const src = join(store.projectDir, ...rel.split("/"));
    if (!existsSync(src)) continue;
    const raw = stripBom(readFileSync(src, "utf-8"));
    const { text, count } = redact(raw, tally);
    const dest = join(out, ...rel.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text, "utf-8");
    files.push({ file: rel, bytes_in: Buffer.byteLength(raw), bytes_out: Buffer.byteLength(text), redactions: count });
    bundledTexts.push({ file: rel, text });
  }

  if (files.length === 0) {
    throw new Error(`No timeline files found to bundle in: ${store.projectDir}`);
  }

  // Mask-keyframe harvest (#44) — built from the redacted texts only.
  const maskReport = buildMaskKeyframeReport(bundledTexts);
  writeFileSync(join(out, "mask-keyframe-report.json"), `${JSON.stringify(maskReport, null, 2)}\n`, "utf-8");
  const maskEvidenceFound = maskReport.verdict === "mask-keyframe-evidence-found";

  // Diagnose report (paths inside are already <project>-relative placeholders).
  // The #50 nested-Timelines evidence `diagnose` attaches rides along, so one
  // bundle carries every item that issue asks for.
  const report = diagnoseDraftStore(input);
  const nestedEvidence = buildNestedTimelinesEvidence(input);
  const reportOut = nestedEvidence ? { ...report, nested_evidence: nestedEvidence } : report;
  writeFileSync(join(out, "diagnose.json"), `${JSON.stringify(reportOut, null, 2)}\n`, "utf-8");
  writeFileSync(
    join(out, "README.md"),
    reporterReadme(store.version, store.modernStorage, store.nestedTimelines, maskEvidenceFound),
    "utf-8",
  );

  // The report ships inside the bundle, so its own path fields go through the
  // redactor too (#59). Written raw, they reintroduce the username that every
  // bundled timeline file just had scrubbed.
  const { text: safeSourceDir } = redact(store.projectDir, tally);
  const { text: safeOutDir } = redact(out, tally);

  const sanitize: SanitizeReport = {
    ok: true,
    source_dir: safeSourceDir,
    out_dir: safeOutDir,
    version: store.version,
    modern_storage: store.modernStorage,
    files,
    redaction_kinds: tally,
    media_excluded: true,
    mask_keyframe_evidence: maskReport.summary,
    notes: [
      "Binary media under assets/ was intentionally excluded — only timeline JSON files are bundled.",
      "User home paths, email addresses and device identifiers (device_id, mac_address, hard_disk_id) " +
        "were redacted; review the files before sharing.",
      "Attach this folder to issue #35 (or a new issue) to move the version toward fixture-tested.",
      "mask-keyframe-report.json maps the draft's mask + keyframe structures — the #44 harvest " +
        "(the mask-geometry keyframe encoding has no public ground truth).",
      ...(maskEvidenceFound
        ? [
            "Mask-keyframe structures detected — attach this bundle to issue #44, which is blocked on exactly this artifact.",
          ]
        : []),
      ...(store.nestedTimelines.length > 0
        ? [
            "The nested Timelines/ layout was captured (Timelines/project.json + nested timeline documents) — " +
              "attach this bundle to issue #50, which is blocked on exactly this artifact.",
          ]
        : []),
    ],
  };
  writeFileSync(join(out, "SANITIZE_REPORT.json"), `${JSON.stringify(sanitize, null, 2)}\n`, "utf-8");
  return sanitize;
}

// --- Nested-Timelines evidence (issue #50) ----------------------------------
// #50 (CapCut 7.x is reported to keep the live document at
// Timelines/<id>/draft_info.json) is stalled on four evidence items:
// Timelines/project.json, the draft/template/project file tree, the exact app
// version + OS marker the draft carries, and a root-vs-nested before/after
// showing whether a successful root write leaves the nested document stale.
// `diagnose` attaches all four here, read-only. Timeline content enters only
// as counts and hashes, and the one raw text included (the project.json
// pointer) goes through the same REDACTORS the bundle files do — the section
// is privacy-safe by construction, not by review.

export interface NestedFileTreeEntry {
  path: string;
  size: number;
  mtime: string | null;
}

export interface NestedTrackSummary {
  type: string;
  segments: number;
  texts: number;
  /** Hash over the track's ordered text contents — proves a text changed
   * without carrying what it says. */
  text_hash: string | null;
}

export interface NestedTrackDelta {
  track: number;
  root: NestedTrackSummary | null;
  nested: NestedTrackSummary | null;
}

export interface NestedRootComparison {
  root_file: string;
  nested_file: string;
  identical: boolean;
  root_sha256: string | null;
  nested_sha256: string | null;
  root_timeline_hash: string | null;
  nested_timeline_hash: string | null;
  /** Which side is mtime-newer when the documents differ; null when identical. */
  mtime_newer: "root" | "nested" | "equal" | "unknown" | null;
  root_mtime: string | null;
  nested_mtime: string | null;
  track_deltas: NestedTrackDelta[];
  verdict: string;
}

export interface NestedTimelinesEvidence {
  issue: string;
  note: string;
  app_version: string | null;
  os: string | null;
  /** Raw Timelines/project.json text, passed through the bundle redactors. */
  timelines_project_json: string | null;
  redaction_kinds: Record<string, number>;
  file_tree: NestedFileTreeEntry[];
  root_vs_nested: NestedRootComparison[];
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const EVIDENCE_TREE_NAMES = /^(?:draft_.*\.json|template-2\.tmp|project\.json)$/;

/** Every draft_*.json / template-2.tmp / project.json under the project, with
 * sizes and mtimes. Symlinks are skipped — nothing outside the project may
 * enter the report. */
function collectEvidenceTree(rootDir: string): NestedFileTreeEntry[] {
  const entries: NestedFileTreeEntry[] = [];
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const relPath = rel === "" ? name : `${rel}/${name}`;
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full, relPath);
      } else if (EVIDENCE_TREE_NAMES.test(name)) {
        entries.push({ path: relPath, size: stat.size, mtime: stat.mtime.toISOString() });
      }
    }
  };
  walk(rootDir, "");
  return entries.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function summarizeTracks(draft: Draft): NestedTrackSummary[] {
  const texts = new Map<string, string>();
  for (const mat of draft.materials.texts ?? []) {
    if (typeof mat.content === "string") texts.set(mat.id, mat.content);
  }
  return draft.tracks.map((track) => {
    const contents = track.segments
      .map((segment) => texts.get(segment.material_id))
      .filter((content): content is string => content !== undefined);
    return {
      type: track.type,
      segments: track.segments.length,
      texts: contents.length,
      text_hash: contents.length > 0 ? sha256(JSON.stringify(contents)) : null,
    };
  });
}

function trackDeltas(root: Draft, nested: Draft): NestedTrackDelta[] {
  const rootTracks = summarizeTracks(root);
  const nestedTracks = summarizeTracks(nested);
  const deltas: NestedTrackDelta[] = [];
  for (let i = 0; i < Math.max(rootTracks.length, nestedTracks.length); i++) {
    const a = rootTracks[i] ?? null;
    const b = nestedTracks[i] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) deltas.push({ track: i, root: a, nested: b });
  }
  return deltas;
}

/**
 * Build the #50 evidence section for `diagnose` / `diagnose --bundle`, or null
 * when neither the timelines-nested layout nor any nested Timelines/ document
 * exists — a normal draft's diagnose report must stay byte-identical.
 */
export function buildNestedTimelinesEvidence(input: string): NestedTimelinesEvidence | null {
  const store = discoverDraftStore(input);
  if (store.layout !== "timelines-nested" && store.nestedTimelines.length === 0) return null;

  const tally: Record<string, number> = {};
  const pointerPath = join(store.projectDir, "Timelines", "project.json");
  let pointer: string | null = null;
  if (existsSync(pointerPath)) {
    try {
      pointer = redact(stripBom(readFileSync(pointerPath, "utf-8")), tally).text;
    } catch {
      pointer = null;
    }
  }

  const root = store.canonical;
  const comparisons: NestedRootComparison[] = [];
  for (const rel of store.nestedTimelines) {
    if (!/^Timelines\/[^/]+\/draft_(?:info|content)\.json$/.test(rel)) continue;
    const nested = parseCandidate(join(store.projectDir, ...rel.split("/")));
    if (!nested.exists) continue;
    const bothParsed = Boolean(root.draft && nested.draft);
    const identical = bothParsed ? root.timelineHash === nested.timelineHash : root.sha256 === nested.sha256;
    const rootMs = root.mtime ? Date.parse(root.mtime) : Number.NaN;
    const nestedMs = nested.mtime ? Date.parse(nested.mtime) : Number.NaN;
    const newer = identical
      ? null
      : !Number.isFinite(rootMs) || !Number.isFinite(nestedMs)
        ? "unknown"
        : rootMs === nestedMs
          ? "equal"
          : rootMs > nestedMs
            ? "root"
            : "nested";
    const newerPhrase =
      newer === "root"
        ? "the root file is mtime-newer"
        : newer === "nested"
          ? "the nested file is mtime-newer"
          : newer === "equal"
            ? "their mtimes are equal"
            : "the mtime order is unknown";
    comparisons.push({
      root_file: root.name,
      nested_file: rel,
      identical,
      root_sha256: root.sha256,
      nested_sha256: nested.sha256,
      root_timeline_hash: root.draft ? root.timelineHash : null,
      nested_timeline_hash: nested.draft ? nested.timelineHash : null,
      mtime_newer: newer,
      root_mtime: root.mtime,
      nested_mtime: nested.mtime,
      track_deltas: !identical && root.draft && nested.draft ? trackDeltas(root.draft, nested.draft) : [],
      verdict: identical
        ? `The nested document and the root ${root.name} carry the same timeline. Capture this again immediately ` +
          "after a CLI write reports success — if they still match, no root-mirror discard can be shown from this project."
        : `The nested document and the root ${root.name} diverge (${newerPhrase}). Captured immediately after a ` +
          "root write that reported success, this is the before/after issue #50 needs: a nested document still " +
          "hashing to the pre-write content that CapCut then opens means the nested pointer is authoritative; a " +
          "nested document that is only an older snapshot the app never reads means following it would be the regression.",
    });
  }

  const info = store.canonical.draft ? detectVersion(store.canonical.draft) : null;
  return {
    issue: "https://github.com/renezander030/capcut-cli/issues/50",
    note:
      "Nested Timelines/ layout evidence for issue #50, captured read-only: the redacted Timelines/project.json " +
      "pointer, the draft/template/project file tree with sizes and mtimes, the app version and OS marker the " +
      "draft carries, and a root-vs-nested content comparison (counts and hashes only). To produce the deciding " +
      "before/after: run an edit command that reports success, then run `capcut diagnose <project> --bundle " +
      "<report.json>` again and compare the nested document's hashes.",
    app_version: info?.app_version ?? null,
    os: info?.os ?? null,
    timelines_project_json: pointer,
    redaction_kinds: tally,
    file_tree: collectEvidenceTree(store.projectDir),
    root_vs_nested: comparisons,
  };
}

import { userInfo } from "node:os";

// --- `fixture --check`: mechanical redaction verification -------------------
//
// The bundle README has always said "review the files yourself before
// attaching" — and that manual burden is exactly what stalls contributions:
// the 9.2.8 reporter in issue #50 held the bundle back until confident nothing
// private leaked. This pass turns the review into a checkable gate: scan every
// text file in the finished bundle (SANITIZE_REPORT.json and README included —
// #59's lesson was that scrubbed values re-entered through the report) for the
// shapes the redactor exists to remove, and fail loudly with file:line
// pointers. A finding is not proof of a leak — it is a place a human must
// look — so the excerpt itself is never echoed, only the location and kind.

export interface RedactionFinding {
  file: string;
  line: number;
  kind: "home-path" | "email" | "device-key" | "username";
}

export interface RedactionCheck {
  ok: boolean;
  bundle_dir: string;
  files_scanned: number;
  findings: RedactionFinding[];
}

const CHECK_ALLOWED_EMAIL = "redacted@example.com";
const CHECK_HOME_PATH =
  /(?:\/Users\/[A-Za-z0-9._-]{2,}|\/home\/[A-Za-z0-9._-]{2,}|[A-Za-z]:\\+Users\\+[A-Za-z0-9._-]{2,})/;
const CHECK_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A device key whose value is a non-empty string other than the redactor's
// "redacted" marker. Numeric tallies in SANITIZE_REPORT.json ("device_id": 2)
// carry no string value and never match.
const CHECK_DEVICE_KEY = /"(?:device_id|mac_address|hard_disk_id)"\s*:\s*"(?!redacted")[^"]{4,}"/;

function checkTextFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = prefix.length === 0 ? entry : `${prefix}/${entry}`;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...checkTextFiles(full, rel));
      continue;
    }
    if (/\.(json|md|txt|tmp)$/i.test(entry)) files.push(rel);
  }
  return files;
}

export function verifyBundleRedaction(bundleDir: string): RedactionCheck {
  const root = resolve(bundleDir);
  const findings: RedactionFinding[] = [];
  // The account name only matters when it is distinctive enough to identify —
  // short names ("a", "dev") would flood the check with coincidences.
  let username: string | null = null;
  try {
    const name = userInfo().username;
    if (name.length >= 5) username = name;
  } catch {
    username = null;
  }
  const usernameRe = username
    ? new RegExp(`(?<![A-Za-z0-9_])${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "i")
    : null;

  const files = checkTextFiles(root);
  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf-8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (CHECK_HOME_PATH.test(line)) {
        findings.push({ file: rel, line: i + 1, kind: "home-path" });
      } else if (usernameRe?.test(line)) {
        findings.push({ file: rel, line: i + 1, kind: "username" });
      }
      const emails = line.match(CHECK_EMAIL) ?? [];
      if (emails.some((email) => email.toLowerCase() !== CHECK_ALLOWED_EMAIL)) {
        findings.push({ file: rel, line: i + 1, kind: "email" });
      }
      if (CHECK_DEVICE_KEY.test(line)) {
        findings.push({ file: rel, line: i + 1, kind: "device-key" });
      }
    }
  }
  return { ok: findings.length === 0, bundle_dir: root, files_scanned: files.length, findings };
}
