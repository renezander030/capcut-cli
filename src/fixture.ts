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

function reporterReadme(version: string | null, modernStorage: boolean, nestedTimelines: string[]): string {
  const nestedLine =
    nestedTimelines.length > 0
      ? `\n- Nested Timelines/ layout captured (issue #50): ${nestedTimelines.join(", ")}`
      : "";
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
  for (const name of TIMELINE_FILES) {
    const src = join(store.projectDir, name);
    if (!existsSync(src)) continue;
    const raw = stripBom(readFileSync(src, "utf-8"));
    const { text, count } = redact(raw, tally);
    writeFileSync(join(out, name), text, "utf-8");
    files.push({ file: name, bytes_in: Buffer.byteLength(raw), bytes_out: Buffer.byteLength(text), redactions: count });
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
  }

  if (files.length === 0) {
    throw new Error(`No timeline files found to bundle in: ${store.projectDir}`);
  }

  // Diagnose report (paths inside are already <project>-relative placeholders).
  const report = diagnoseDraftStore(input);
  writeFileSync(join(out, "diagnose.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  writeFileSync(
    join(out, "README.md"),
    reporterReadme(store.version, store.modernStorage, store.nestedTimelines),
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
    notes: [
      "Binary media under assets/ was intentionally excluded — only timeline JSON files are bundled.",
      "User home paths and email addresses were redacted; review the files before sharing.",
      "Attach this folder to issue #35 (or a new issue) to move the version toward fixture-tested.",
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
