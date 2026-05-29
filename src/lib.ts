/**
 * Public library entry point for capcut-cli.
 *
 * The CLI lives in `index.ts` (it runs `main()` on import, so it is not
 * importable as a library). This module re-exports the stable, side-effect-free
 * core so other tools can read, inspect, lint, and write CapCut/JianYing drafts
 * programmatically:
 *
 *   import { loadDraft, saveDraft, lintDraft } from "capcut-cli";
 *
 *   const { draft, filePath } = loadDraft("./draft_content.json");
 *   const issues = lintDraft(draft);
 *   saveDraft(filePath, draft);
 */

export type { CheckStatus, DoctorCheck, DoctorReport } from "./doctor.js";
export { runDoctor } from "./doctor.js";
export type {
  Draft,
  MaterialAudio,
  MaterialText,
  MaterialVideo,
  Segment,
  Timerange,
  Track,
} from "./draft.js";
export {
  extractText,
  findDraft,
  findMaterial,
  findMaterialGlobal,
  findSegment,
  getMaterialTypes,
  getTracksByType,
  loadDraft,
  saveDraft,
  updateTextContent,
} from "./draft.js";
export type { LintIssue, LintOptions, Severity } from "./lint.js";
export {
  DEFAULT_LINT_OPTIONS,
  lintDraft,
  lintExitCode,
  summarize,
} from "./lint.js";
export type { AppSource, VersionInfo } from "./version.js";
export { detectVersion } from "./version.js";
