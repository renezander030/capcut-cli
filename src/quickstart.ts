// `quickstart` — the one-command path from "I have a file" to "an editable
// draft CapCut will open." It composes the primitives the individual commands
// already use (initDraft + addVideo/addAudio/addText + lintDraft +
// diagnoseDraftStore) so a first-time user does not have to chain five commands
// and guess the open-in-CapCut step. Issue context: the repo has 50+ commands;
// the missing utility was first-run friction, not another feature.

import { existsSync, readFileSync } from "node:fs";
import { stripBom } from "./bom.js";
import { loadDraft, saveDraft } from "./draft.js";
import { addAudio, addText, addVideo, type CanvasConfig, initDraft } from "./factory.js";
import { lintDraft, summarize } from "./lint.js";
import { probeMedia } from "./probe.js";
import { parseSrt } from "./srt.js";
import { diagnoseDraftStore } from "./store.js";

// Fallback when ffprobe is unavailable or the input has no readable duration.
// A first draft only needs to be *editable*; the user trims to taste in CapCut.
export const QUICKSTART_FALLBACK_DURATION_US = 5_000_000; // 5s
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

export interface QuickstartOptions {
  name: string;
  templateDir: string;
  draftsDir: string;
  video?: string;
  audio?: string;
  srt?: string;
  ffprobeCmd?: string;
  now?: number;
  /** Canvas override from --ratio / --width / --height (factory.resolveCanvas); template canvas when absent. */
  canvas?: CanvasConfig;
}

export interface QuickstartStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface QuickstartResult {
  ok: boolean;
  name: string;
  draft_path: string;
  file_path: string;
  registered: boolean;
  canvas: CanvasConfig | null;
  added: { video: boolean; audio: boolean; captions: number };
  steps: QuickstartStep[];
  lint: { errors: number; warnings: number; info: number; total: number };
  store: { canonical: string; version: string | null; modern_storage: boolean; next_actions: string[] };
  open_hint: string[];
}

function probedDuration(path: string, ffprobeCmd?: string): number {
  const probe = probeMedia(path, ffprobeCmd ?? "ffprobe");
  if (probe?.durationUs && probe.durationUs > 0) return probe.durationUs;
  return QUICKSTART_FALLBACK_DURATION_US;
}

/**
 * Create a minimal editable draft from a single video, audio, and/or SRT input,
 * verify it with the same lint the `lint` command runs, inspect its storage
 * layout the way `diagnose` does, and return an explicit "open in CapCut" hint.
 *
 * Pure orchestration of exported primitives — no new draft-mutation logic — so
 * its output stays identical to running the commands by hand.
 */
export function runQuickstart(opts: QuickstartOptions): QuickstartResult {
  if (!opts.video && !opts.audio && !opts.srt) {
    throw new Error("quickstart needs at least one input: --video, --audio, or --srt.");
  }
  for (const [flag, p] of [
    ["--video", opts.video],
    ["--audio", opts.audio],
    ["--srt", opts.srt],
  ] as const) {
    if (p && !existsSync(p)) throw new Error(`Input for ${flag} not found: ${p}`);
  }

  const steps: QuickstartStep[] = [];

  const init = initDraft({
    name: opts.name,
    templateDir: opts.templateDir,
    draftsDir: opts.draftsDir,
    now: opts.now,
    canvas: opts.canvas,
  });
  const canvasNote = init.canvas ? ` Canvas ${init.canvas.width}x${init.canvas.height} (${init.canvas.ratio}).` : "";
  steps.push({
    step: "create",
    ok: true,
    detail:
      (init.registered
        ? "Draft created and registered in CapCut's project index."
        : "Draft created (could not update root_meta_info.json — may not be listed).") + canvasNote,
  });

  const { draft, filePath } = loadDraft(init.draftPath);

  const added = { video: false, audio: false, captions: 0 };

  if (opts.video) {
    const probe = probeMedia(opts.video, opts.ffprobeCmd ?? "ffprobe");
    const duration = probe?.durationUs && probe.durationUs > 0 ? probe.durationUs : QUICKSTART_FALLBACK_DURATION_US;
    addVideo(draft, filePath, {
      path: opts.video,
      start: 0,
      duration,
      width: probe?.width ?? DEFAULT_WIDTH,
      height: probe?.height ?? DEFAULT_HEIGHT,
    });
    added.video = true;
    steps.push({
      step: "add-video",
      ok: true,
      detail: probe?.durationUs
        ? `Added video (${(duration / 1_000_000).toFixed(2)}s, ${probe.width ?? DEFAULT_WIDTH}x${probe.height ?? DEFAULT_HEIGHT}).`
        : `Added video (no readable duration — used ${(duration / 1_000_000).toFixed(0)}s placeholder; trim in CapCut).`,
    });
  }

  if (opts.audio) {
    const duration = probedDuration(opts.audio, opts.ffprobeCmd);
    addAudio(draft, filePath, { path: opts.audio, start: 0, duration });
    added.audio = true;
    steps.push({ step: "add-audio", ok: true, detail: `Added audio (${(duration / 1_000_000).toFixed(2)}s).` });
  }

  if (opts.srt) {
    const cues = parseSrt(stripBom(readFileSync(opts.srt, "utf-8")));
    if (cues.length === 0) throw new Error(`SRT produced 0 cues: ${opts.srt}`);
    for (const cue of cues) {
      addText(draft, filePath, { text: cue.text, start: cue.startUs, duration: cue.endUs - cue.startUs });
    }
    added.captions = cues.length;
    steps.push({ step: "import-srt", ok: true, detail: `Added ${cues.length} caption segment(s).` });
  }

  saveDraft(filePath, draft);

  const issues = lintDraft(draft);
  const lint = summarize(issues);
  steps.push({
    step: "lint",
    ok: lint.errors === 0,
    detail:
      lint.errors === 0 ? `Clean (${lint.warnings} warning(s)).` : `${lint.errors} error(s) — see \`capcut lint\`.`,
  });

  const store = diagnoseDraftStore(init.draftPath);

  const open_hint = buildOpenHint(opts.name, init.draftPath, init.registered, store.modern_storage, store.next_actions);

  return {
    ok: lint.errors === 0,
    name: opts.name,
    draft_path: init.draftPath,
    file_path: filePath,
    registered: init.registered,
    canvas: init.canvas,
    added,
    steps,
    lint,
    store: {
      canonical: store.canonical,
      version: store.version,
      modern_storage: store.modern_storage,
      next_actions: store.next_actions,
    },
    open_hint,
  };
}

function buildOpenHint(
  name: string,
  draftPath: string,
  registered: boolean,
  modernStorage: boolean,
  nextActions: string[],
): string[] {
  const hint: string[] = [`Draft folder: ${draftPath}`];
  if (registered) {
    hint.push(`Restart CapCut — your project "${name}" is now in the project list. Open it and edit.`);
  } else {
    hint.push(
      `CapCut may not list this draft automatically. Open CapCut, then drag the folder above into your Projects directory and restart.`,
    );
  }
  if (modernStorage) {
    hint.push("Detected CapCut >= 8.7 storage layout; the CLI wrote the modern timeline files for this version.");
  }
  // Surface diagnose's actionable warnings (e.g. editor running) without dumping the full report.
  for (const action of nextActions) {
    if (!action.startsWith("Storage targets are readable")) hint.push(action);
  }
  return hint;
}
