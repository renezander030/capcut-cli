import { existsSync, statSync } from "node:fs";
import type { Draft, Segment, Track } from "./draft.js";
import { extractText, findMaterial, getTracksByType } from "./draft.js";

export type Severity = "error" | "warning" | "info";

export interface LintIssue {
  severity: Severity;
  code: string;
  message: string;
  fixable: boolean;
  location?: {
    track?: string;
    segment_id?: string;
    material_id?: string;
    path?: string;
  };
}

// Codes that lintDraft can mechanically repair via fixDraft. Any issue whose
// code appears here is emitted with fixable:true.
const FIXABLE_CODES = new Set<string>(["cue-too-long", "caption-overlap"]);

export interface LintOptions {
  maxCharsPerLine: number;
  maxCueDurationUs: number;
  minGapBetweenCaptionsUs: number;
  checkLocalPaths: boolean;
}

export const DEFAULT_LINT_OPTIONS: LintOptions = {
  maxCharsPerLine: 42, // BBC subtitle standard
  maxCueDurationUs: 7_000_000, // 7s; longer caps are hard to read
  minGapBetweenCaptionsUs: 0, // overlap = error; gap = no rule by default
  checkLocalPaths: true,
};

export function lintDraft(draft: Draft, opts: LintOptions = DEFAULT_LINT_OPTIONS): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const seg of allSegments(draft)) {
    const s = seg.segment;
    if (!draft.materials || !s.material_id) continue;
    if (!materialExistsAnywhere(draft, s.material_id)) {
      issues.push({
        severity: "error",
        code: "missing-material",
        message: `Segment ${shortId(s.id)} references material ${shortId(s.material_id)} that does not exist in any materials.*`,
        fixable: FIXABLE_CODES.has("missing-material"),
        location: { track: seg.track.name, segment_id: s.id, material_id: s.material_id },
      });
    }
  }

  for (const track of getTracksByType(draft, "text")) {
    const segs = [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const mat = findMaterial(draft.materials.texts, s.material_id);
      const text = mat ? extractText(mat.content) : "";

      if (s.target_timerange.duration > opts.maxCueDurationUs) {
        issues.push({
          severity: "warning",
          code: "cue-too-long",
          message: `Caption ${shortId(s.id)} runs ${Math.round(s.target_timerange.duration / 1000)}ms (>${opts.maxCueDurationUs / 1_000_000}s)`,
          fixable: FIXABLE_CODES.has("cue-too-long"),
          location: { track: track.name, segment_id: s.id },
        });
      }

      for (const line of text.split(/\r?\n/)) {
        if (line.length > opts.maxCharsPerLine) {
          issues.push({
            severity: "warning",
            code: "line-too-long",
            message: `Caption ${shortId(s.id)} has ${line.length}-char line (>${opts.maxCharsPerLine}): "${line.slice(0, 50)}…"`,
            fixable: FIXABLE_CODES.has("line-too-long"),
            location: { track: track.name, segment_id: s.id },
          });
          break;
        }
      }

      const next = segs[i + 1];
      if (next) {
        const end = s.target_timerange.start + s.target_timerange.duration;
        const gap = next.target_timerange.start - end;
        if (gap < 0) {
          issues.push({
            severity: "error",
            code: "caption-overlap",
            message: `Captions ${shortId(s.id)} and ${shortId(next.id)} overlap by ${Math.round(-gap / 1000)}ms on track "${track.name}"`,
            fixable: FIXABLE_CODES.has("caption-overlap"),
            location: { track: track.name, segment_id: s.id },
          });
        } else if (gap > 0 && gap < opts.minGapBetweenCaptionsUs) {
          issues.push({
            severity: "warning",
            code: "caption-gap-too-small",
            message: `Captions ${shortId(s.id)} and ${shortId(next.id)} are ${Math.round(gap / 1000)}ms apart (<${opts.minGapBetweenCaptionsUs / 1000}ms)`,
            fixable: FIXABLE_CODES.has("caption-gap-too-small"),
            location: { track: track.name, segment_id: s.id },
          });
        }
      }
    }
  }

  if (opts.checkLocalPaths) {
    for (const kind of ["videos", "audios"] as const) {
      for (const mat of draft.materials[kind] ?? []) {
        const m = mat as { id: string; path?: string };
        if (typeof m.path !== "string" || m.path.length === 0) continue;
        if (m.path.startsWith("http://") || m.path.startsWith("https://")) continue;
        if (!fileExists(m.path)) {
          issues.push({
            severity: "error",
            code: "missing-file",
            message: `Material ${shortId(m.id)} (${kind}) references file that doesn't exist: ${m.path}`,
            fixable: FIXABLE_CODES.has("missing-file"),
            location: { material_id: m.id, path: m.path },
          });
        }
      }
    }
  }

  return issues;
}

export function summarize(issues: LintIssue[]): { errors: number; warnings: number; info: number; total: number } {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const i of issues) {
    if (i.severity === "error") errors++;
    else if (i.severity === "warning") warnings++;
    else info++;
  }
  return { errors, warnings, info, total: issues.length };
}

export function lintExitCode(summary: { errors: number; warnings: number }): number {
  if (summary.errors > 0) return 2;
  if (summary.warnings > 0) return 1;
  return 0;
}

export interface FixResult {
  fixed: LintIssue[];
  remaining: LintIssue[];
}

// Mechanically repair fixable issues on `draft` in place. Only issues whose
// code is in FIXABLE_CODES are touched — everything else is returned in
// `remaining` for the caller to report. Repairs are ordered so that earlier
// passes can uncover issues the next pass would fix (e.g. shortening an
// overlong cue may resolve an overlap on the same track).
export function fixDraft(draft: Draft, opts: LintOptions = DEFAULT_LINT_OPTIONS): FixResult {
  const before = lintDraft(draft, opts);
  const fixed: LintIssue[] = [];

  // Pass 1: cap over-long cues. Shrinking these first can also close overlaps.
  for (const track of getTracksByType(draft, "text")) {
    for (const s of track.segments) {
      if (s.target_timerange.duration > opts.maxCueDurationUs) {
        const before = s.target_timerange.duration;
        s.target_timerange.duration = opts.maxCueDurationUs;
        if (s.source_timerange && s.source_timerange.duration === before) {
          s.source_timerange.duration = opts.maxCueDurationUs;
        }
      }
    }
  }

  // Pass 2: trim overlapping captions so each ends where the next begins.
  for (const track of getTracksByType(draft, "text")) {
    const segs = [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      const next = segs[i + 1];
      const end = s.target_timerange.start + s.target_timerange.duration;
      const overlap = end - next.target_timerange.start;
      if (overlap > 0) {
        const newDuration = Math.max(0, s.target_timerange.duration - overlap);
        const oldDuration = s.target_timerange.duration;
        s.target_timerange.duration = newDuration;
        if (s.source_timerange && s.source_timerange.duration === oldDuration) {
          s.source_timerange.duration = newDuration;
        }
      }
    }
  }

  const after = lintDraft(draft, opts);
  const remaining: LintIssue[] = [];
  const afterKeys = new Set(after.map(issueKey));
  for (const issue of before) {
    if (!afterKeys.has(issueKey(issue))) fixed.push(issue);
  }
  for (const issue of after) remaining.push(issue);
  return { fixed, remaining };
}

function issueKey(i: LintIssue): string {
  return `${i.code}|${i.location?.segment_id ?? ""}|${i.location?.material_id ?? ""}|${i.location?.path ?? ""}`;
}

function allSegments(draft: Draft): Array<{ track: Track; segment: Segment }> {
  const result: Array<{ track: Track; segment: Segment }> = [];
  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      result.push({ track, segment: seg });
    }
  }
  return result;
}

function materialExistsAnywhere(draft: Draft, id: string): boolean {
  for (const arr of Object.values(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    for (const m of arr) {
      if (m && typeof m === "object" && (m as { id?: string }).id === id) return true;
    }
  }
  return false;
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
