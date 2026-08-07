// `fixture` — automate the "attach a sanitized project folder, remove private
// media and paths first" step from docs/version-support.md. Issue #35 (CapCut
// 8.7 Windows) is blocked on a *real* app-created draft folder, but reporters
// won't (and shouldn't) paste a folder full of private media and absolute home
// paths. This produces a shareable bundle: the timeline JSON only (no binary
// media), with user home paths and emails redacted, plus a diagnose report and
// a README explaining what to do with it. That is the concrete, Linux-buildable
// half of the "compatibility proof pack" — the other half (running it in a real
// CapCut 8.7 desktop) can only happen on Windows.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stripBom } from "./bom.js";
import { keyframePropertyTypes } from "./decorators.js";
import { diagnoseDraftStore, discoverDraftStore } from "./store.js";

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
JSON files from a real project, with user home paths and email addresses
redacted. No media from \`assets/\` was copied.

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
  const report = diagnoseDraftStore(input);
  writeFileSync(join(out, "diagnose.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  writeFileSync(
    join(out, "README.md"),
    reporterReadme(store.version, store.modernStorage, store.nestedTimelines, maskEvidenceFound),
    "utf-8",
  );

  const sanitize: SanitizeReport = {
    ok: true,
    source_dir: store.projectDir,
    out_dir: out,
    version: store.version,
    modern_storage: store.modernStorage,
    files,
    redaction_kinds: tally,
    media_excluded: true,
    mask_keyframe_evidence: maskReport.summary,
    notes: [
      "Binary media under assets/ was intentionally excluded — only timeline JSON files are bundled.",
      "User home paths and email addresses were redacted; review the files before sharing.",
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
