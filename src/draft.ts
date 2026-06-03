import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface Timerange {
  start: number;
  duration: number;
}

export interface Segment {
  id: string;
  material_id: string;
  target_timerange: Timerange;
  source_timerange: Timerange;
  speed: number;
  volume: number;
  visible: boolean;
  clip: {
    alpha: number;
    rotation: number;
    scale: { x: number; y: number };
    transform: { x: number; y: number };
  } | null;
  extra_material_refs: string[];
  render_index: number;
  [key: string]: unknown;
}

export interface Track {
  id: string;
  type: string;
  name: string;
  attribute: number;
  segments: Segment[];
}

export interface MaterialText {
  id: string;
  type: string;
  content: string;
  font_size: number;
  text_color: string;
  alignment: number;
  [key: string]: unknown;
}

export interface MaterialVideo {
  id: string;
  path: string;
  material_name: string;
  type: string;
  duration: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface MaterialAudio {
  id: string;
  path: string;
  name: string;
  duration: number;
  type: string;
  [key: string]: unknown;
}

export interface Draft {
  id: string;
  name: string;
  duration: number;
  fps: number;
  canvas_config: {
    width: number;
    height: number;
    ratio: string;
  };
  tracks: Track[];
  materials: {
    videos: MaterialVideo[];
    audios: MaterialAudio[];
    texts: MaterialText[];
    speeds: Array<{ id: string; speed: number; [key: string]: unknown }>;
    material_animations: Array<Record<string, unknown>>;
    audio_fades: Array<Record<string, unknown>>;
    transitions: Array<Record<string, unknown>>;
    [key: string]: Array<Record<string, unknown>>;
  };
  platform?: {
    app_source: string;
    app_version: string;
    os: string;
  };
  [key: string]: unknown;
}

export function findDraft(input: string): string {
  const resolved = resolve(input);
  if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
  const candidates = [resolve(resolved, "draft_content.json"), resolve(resolved, "draft_info.json")];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  throw new Error(`No draft found at: ${input}\nExpected draft_content.json or draft_info.json`);
}

let rawOriginal: string | null = null;

export function loadDraft(path: string): { draft: Draft; filePath: string } {
  const filePath = findDraft(path);
  rawOriginal = readFileSync(filePath, "utf-8");
  const draft = JSON.parse(rawOriginal) as Draft;
  return { draft, filePath };
}

// Canonical bottom->top layer order CapCut expects in the tracks array.
// Derived from a real CapCut-authored draft: [video, audio, text].
// Tracks are pushed in command-call order as content is added, so without
// this normalization the array order (which drives CapCut's timeline layout)
// ends up scrambled. Unknown types are kept after the known ones.
const TRACK_RANK: Record<string, number> = {
  video: 0,
  audio: 1,
  sticker: 2,
  effect: 3,
  filter: 4,
  text: 5,
};

// Sort tracks into the canonical layer order. Stable: tracks of the same type
// keep their authored order (tiebreak on original index).
export function sortTracks(draft: Draft): void {
  draft.tracks = draft.tracks
    .map((track, index) => ({ track, index }))
    .sort((a, b) => (TRACK_RANK[a.track.type] ?? 99) - (TRACK_RANK[b.track.type] ?? 99) || a.index - b.index)
    .map(({ track }) => track);
}

// --dry-run state. When set, saveDraft computes the in-memory change but skips
// both the on-disk write and the .bak snapshot, so the draft is left untouched.
// All ~35 mutating commands funnel through saveDraft, so gating here covers them.
let dryRun = false;

export function setDryRun(value: boolean): void {
  dryRun = value;
}

export function isDryRun(): boolean {
  return dryRun;
}

// Multi-step undo history. Alongside the single `.bak`, every write also keeps
// a rolling stack of the pre-write content under `<draftdir>/.capcut-cli-history/`,
// capped at HISTORY_MAX. `restore --step N` rolls back N writes; CapCut ignores
// the hidden dir. snapshots are named `<draftbase>.NNNNNN.snap` (zero-padded,
// monotonically increasing) so the newest is the lexicographically last.
const HISTORY_DIR = ".capcut-cli-history";
const HISTORY_MAX = 20;

function historyDir(filePath: string): string {
  return join(dirname(filePath), HISTORY_DIR);
}

function snapshotFiles(filePath: string): string[] {
  const dir = historyDir(filePath);
  if (!existsSync(dir)) return [];
  const prefix = `${basename(filePath)}.`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".snap"))
    .sort(); // zero-padded indices => lexicographic === numeric order, oldest first
}

function writeHistorySnapshot(filePath: string, content: string): void {
  const dir = historyDir(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existing = snapshotFiles(filePath);
  const last = existing[existing.length - 1];
  const lastIndex = last ? Number.parseInt(last.match(/\.(\d+)\.snap$/)?.[1] ?? "0", 10) : 0;
  const name = `${basename(filePath)}.${String(lastIndex + 1).padStart(6, "0")}.snap`;
  writeFileSync(join(dir, name), content, "utf-8");
  // Trim oldest beyond the cap.
  const all = snapshotFiles(filePath);
  while (all.length > HISTORY_MAX) {
    const oldest = all.shift();
    if (oldest) rmSync(join(dir, oldest));
  }
}

// Snapshots newest-first, step 1 = most recent write (equivalent to `.bak`).
export function listSnapshots(filePath: string): Array<{ step: number; index: number; path: string }> {
  const dir = historyDir(filePath);
  return snapshotFiles(filePath)
    .map((f) => ({ index: Number.parseInt(f.match(/\.(\d+)\.snap$/)?.[1] ?? "0", 10), path: join(dir, f) }))
    .sort((a, b) => b.index - a.index)
    .map((s, i) => ({ step: i + 1, index: s.index, path: s.path }));
}

export function saveDraft(filePath: string, draft: Draft): void {
  if (dryRun) {
    // Normalize in memory (so any read-back is consistent) but write nothing.
    sortTracks(draft);
    return;
  }
  const bakPath = `${filePath}.bak`;
  if (existsSync(filePath)) {
    const original = rawOriginal ?? readFileSync(filePath, "utf-8");
    writeFileSync(bakPath, original, "utf-8");
    writeHistorySnapshot(filePath, original);
  }
  sortTracks(draft);
  // Detect original indent: if first line after { starts with tab use tab, else count spaces
  const indent = detectIndent(rawOriginal);
  writeFileSync(filePath, JSON.stringify(draft, null, indent), "utf-8");
}

function detectIndent(raw: string | null): string | number {
  if (!raw) return 0;
  const match = raw.match(/\n(\s+)/);
  if (!match) return 0;
  const ws = match[1];
  if (ws.includes("\t")) return "\t";
  return ws.length;
}

export function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed.text) return parsed.text;
  } catch {
    return content
      .replace(/<[^>]*>/g, "")
      .replace(/\[|\]/g, "")
      .trim();
  }
  return content;
}

export function updateTextContent(content: string, newText: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed.text !== undefined) {
      parsed.text = newText;
      if (parsed.styles && parsed.styles.length > 0) {
        const encoded = Buffer.from(newText, "utf16le");
        parsed.styles[0].range = [0, encoded.length];
      }
      return JSON.stringify(parsed);
    }
  } catch {
    const match = content.match(/^(.*\])?(.*?)(\[.*)?$/s);
    if (match) {
      return content.replace(/\[[^\]]*\]/, `[${newText}]`);
    }
  }
  return newText;
}

export function findSegment(draft: Draft, id: string): { track: Track; segment: Segment; index: number } | null {
  const shortId = id.toLowerCase();
  for (const track of draft.tracks) {
    for (let i = 0; i < track.segments.length; i++) {
      const seg = track.segments[i];
      if (seg.id === id || seg.id.toLowerCase().startsWith(shortId)) {
        return { track, segment: seg, index: i };
      }
    }
  }
  return null;
}

export function findMaterial<T extends { id: string }>(arr: T[], id: string): T | undefined {
  return arr.find((m) => m.id === id);
}

export function getTracksByType(draft: Draft, type: string): Track[] {
  return draft.tracks.filter((t) => t.type === type);
}

export function getMaterialTypes(draft: Draft): Array<{ type: string; count: number }> {
  return Object.entries(draft.materials)
    .filter(([, v]) => Array.isArray(v))
    .map(([type, arr]) => ({ type, count: arr.length }))
    .sort((a, b) => b.count - a.count);
}

export function findMaterialGlobal(
  draft: Draft,
  id: string,
): { type: string; material: Record<string, unknown> } | null {
  const shortId = id.toLowerCase();
  for (const [type, arr] of Object.entries(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    for (const mat of arr) {
      if (mat && typeof mat === "object" && typeof (mat as Record<string, unknown>).id === "string") {
        const m = mat as Record<string, unknown>;
        const matId = m.id as string;
        if (matId === id || matId.toLowerCase().startsWith(shortId)) {
          return { type, material: m };
        }
      }
    }
  }
  return null;
}
