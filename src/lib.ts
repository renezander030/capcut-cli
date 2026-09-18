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

export type { ArgumentSpec, CommandName, CommandSpec, OptionSpec } from "./command-specs.js";
export { commandNames, GLOBAL_OPTION_SPECS } from "./command-specs.js";
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
  extractCodeUnitStyleRanges,
  extractStyleRanges,
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
export type { CaptionScript, LintIssue, LintOptions, ScriptLimit, ScriptLimits, Severity } from "./lint.js";
export {
  CJK_SCRIPT_LIMITS,
  captionLimits,
  captionScript,
  DEFAULT_LINT_OPTIONS,
  lintDraft,
  lintExitCode,
  scriptLimitsExcept,
  summarize,
} from "./lint.js";
export type { RunCommandRequest, RunCommandResult } from "./runner.js";
export { runCommand } from "./runner.js";
export type { GroupingDefaults } from "./script.js";
export { groupingDefaults, wordSeparator } from "./script.js";
export {
  fromStoredOffset,
  rangesLookDoubled,
  repairDoubledRanges,
  storedTextLength,
  toStoredOffset,
} from "./text-offsets.js";
export { framesFor, quantizeToFrame } from "./time.js";
export type { AppSource, VersionInfo } from "./version.js";
export { detectVersion } from "./version.js";
