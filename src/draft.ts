import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { appVersionEvidence, formatAppVersionDriftWarning, trackAppVersion } from "./app-versions.js";
import { stripBom } from "./bom.js";
import {
  type DraftCandidate,
  type DraftStore,
  discoverDraftStore,
  editorProcesses,
  isManagedDraftPath,
  NESTED_TIMELINES_WRITE_WARNING,
  serializeDraftCandidate,
} from "./store.js";
import { assessWriteSafety } from "./version.js";

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

// Fresh empty track. Key order is load-bearing: it is the order CapCut writes,
// and drafts are compared byte-for-byte. Callers append or splice it themselves.
export function makeTrack(type: string, name: string, isDefaultName: boolean): Track {
  return {
    id: randomUUID(),
    type,
    name,
    attribute: 0,
    segments: [],
    is_default_name: isDefaultName,
    flag: 0,
  } as unknown as Track;
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
  return discoverDraftStore(input).canonical.path;
}

interface LoadContext {
  store: DraftStore;
}

const loadContexts = new Map<string, LoadContext>();

export function loadDraft(path: string): { draft: Draft; filePath: string } {
  const store = discoverDraftStore(path);
  const filePath = store.canonical.path;
  const draft = structuredClone(store.canonical.draft) as Draft;
  loadContexts.set(resolve(filePath), { store });
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
let forceWrite = false;

export function setDryRun(value: boolean): void {
  dryRun = value;
}

export function isDryRun(): boolean {
  return dryRun;
}

export function setForceWrite(value: boolean): void {
  forceWrite = value;
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

// Optimistic concurrency check: never silently overwrite a file changed by
// CapCut, another CLI process, or a sync client since the candidates were read.
export function assertTargetsUnchangedOnDisk(targets: DraftCandidate[]): void {
  for (const target of targets) {
    if (!target.exists || target.raw === null) continue;
    // `target.raw` was BOM-stripped at load; strip here too so a BOM'd file
    // that is otherwise untouched does not read as a concurrent change.
    const current = stripBom(readFileSync(target.path, "utf-8"));
    if (current !== target.raw) {
      throw new Error(
        `Draft changed on disk after it was loaded: ${target.name}. ` +
          "Reload and retry, or pass --force-write to overwrite intentionally.",
      );
    }
  }
}

// Transactional multi-target write: serialize `draft` into each target's own
// envelope, then temp+fsync+rename with a `.bak` (and history snapshot) per
// file actually written, rolling back on a partial commit. Writes EXACTLY the
// given targets — callers decide the write set (saveDraft: every readable
// sibling; sync-timelines: only the drifted mirrors). No-ops under --dry-run.
export function commitDraftTargets(targets: DraftCandidate[], draft: Draft, options: { backup?: boolean } = {}): void {
  if (dryRun) return;

  // Prepare every replacement before renaming any target. This keeps the
  // multi-file write as close to a transaction as the filesystem allows.
  const prepared = targets.map((target) => {
    const content = serializeDraftCandidate(target, draft);
    return { target, temp: writeTemp(target.path, content), content };
  });

  const committed: typeof prepared = [];
  try {
    for (const item of prepared) {
      if (options.backup !== false && item.target.raw !== null) {
        writeAtomic(`${item.target.path}.bak`, item.target.raw);
        writeHistorySnapshot(item.target.path, item.target.raw);
      }
    }
    for (const item of prepared) {
      renameSync(item.temp, item.target.path);
      committed.push(item);
    }
  } catch (error) {
    // Roll back targets already renamed during a partial commit.
    for (const item of committed.reverse()) {
      if (item.target.raw !== null) writeAtomic(item.target.path, item.target.raw);
    }
    for (const item of prepared) {
      if (existsSync(item.temp)) unlinkSync(item.temp);
    }
    throw error;
  }
}

export function saveDraft(
  filePath: string,
  draft: Draft,
  options: { backup?: boolean; skipVersionGuard?: boolean } = {},
): void {
  if (dryRun) {
    // Version guard, warning only: dry-run writes nothing, so it never blocks,
    // but the WARNING still previews what a real write would do. Draft-only
    // assessment (no store discovery) keeps dry-run free of extra I/O.
    if (options.skipVersionGuard !== true) {
      const safety = assessWriteSafety(draft, null);
      if (safety.action !== "ok") process.stderr.write(`WARNING: ${safety.reasons.join(" ")}\n`);
    }
    // Normalize in memory (so any read-back is consistent) but write nothing.
    sortTracks(draft);
    return;
  }

  const resolved = resolve(filePath);
  const context = loadContexts.get(resolved) ?? { store: discoverDraftStore(filePath) };
  const { store } = context;

  if (!forceWrite && isManagedDraftPath(filePath)) {
    const running = editorProcesses();
    if (running.length > 0) {
      throw new Error(
        `${running.join(" / ")} is running. Close the editor before writing this managed draft, ` +
          "or pass --force-write if you accept that the app may overwrite the change.",
      );
    }
  }

  // Write-time version boundary: refuse when the draft's detected version or
  // schema generation is beyond the registry's evidence or known-broken (new
  // app builds are reported to reject tool-written drafts as corrupted).
  // store.version covers every readable sibling, so a mirror written by a
  // newer app build trips the guard too. Markerless drafts (capcut create
  // output) never trigger. --force-write overrides, but the WARNING still
  // lands on stderr so a forced write is never silent.
  // skipVersionGuard is for `restore`'s mirror re-sync ONLY: restoring a
  // backup is the escape hatch, not the hazard (docs/version-support.md), and
  // a mid-restore refusal would leave the canonical rolled back but the
  // mirrors diverged.
  if (options.skipVersionGuard !== true) {
    const safety = assessWriteSafety(draft, store.version);
    if (safety.action === "refuse" && !forceWrite) throw new Error(safety.reasons.join("\n"));
    if (safety.action === "warn" || (safety.action === "refuse" && forceWrite)) {
      process.stderr.write(`WARNING: ${safety.reasons.join(" ")}\n`);
    }
  }

  // CapCut 7.x nested Timelines/ layout (issue #50): the live document is
  // reported to be Timelines/<id>/draft_info.json, with the root file a
  // regenerated mirror the app rebuilds on open. Detection-only guard — the
  // write below still targets the root candidates byte-identically (PR #51's
  // canonical flip was rejected pending a field artifact) — but the edit is
  // no longer silent: warn, never refuse. Shares skipVersionGuard with the
  // version guard: restore's mirror re-sync is the escape hatch, not a new
  // sighting of the hazard.
  if (options.skipVersionGuard !== true && store.layout === "timelines-nested") {
    process.stderr.write(`WARNING: ${NESTED_TIMELINES_WRITE_WARNING}\n`);
  }

  if (!forceWrite) assertTargetsUnchangedOnDisk(store.targets);

  sortTracks(draft);
  commitDraftTargets(store.targets, draft, options);

  // App auto-upgrade tripwire (pyJianYingDraft#115, #178): warn-only. Compares
  // this store's version evidence against the CLI's last-seen record in
  // ~/.config/capcut-cli/app-versions.json and names old -> new on stderr when
  // the app moved underneath the pipeline; the guard above stays the only
  // refusal. The drift is also remembered for the command's JSON result (see
  // out() / takeAppVersionDrift). Shares skipVersionGuard with the guard:
  // restore's mirror re-sync is the escape hatch, not a sighting.
  if (options.skipVersionGuard !== true) {
    const { drift, error } = trackAppVersion(store.projectDir, appVersionEvidence(draft, store.version));
    if (error) process.stderr.write(`WARNING: ${error}\n`);
    if (drift) process.stderr.write(`WARNING: ${formatAppVersionDriftWarning(drift)}\n`);
  }

  // Refresh hashes/raw snapshots so a library caller can save the same loaded
  // draft more than once without tripping its own conflict guard.
  // Rediscover from the canonical file, not only the parent directory. The
  // latter would lose explicitly addressed custom filenames such as A.json.
  loadContexts.set(resolved, { store: discoverDraftStore(store.canonical.path) });
}

function writeAndSync(path: string, content: string): void {
  // "wx" is O_CREAT|O_EXCL: it creates the file or fails, and never follows an
  // existing symlink. See writeTemp for why that matters.
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, content, undefined, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Create the scratch file a temp+fsync+rename write stages into, next to its
 * target, and return its path.
 *
 * The name carries crypto randomness and the open is exclusive. A predictable
 * name (pid + clock alone) is a write-through primitive: anyone able to create
 * files in the draft folder can pre-place a symlink at the path we are about
 * to open and redirect every draft save to a file of their choosing. O_EXCL is
 * the guarantee — it refuses a path that already exists, symlink included —
 * and the randomness keeps a legitimate concurrent writer from colliding with
 * us in the first place. A collision just draws another name; the bytes
 * written are unchanged.
 */
function writeTemp(target: string, content: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const temp = `${target}.capcut-cli-${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeAndSync(temp, content);
      return temp;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not create a temp file next to ${target} after 8 attempts.`);
}

// Exported for factory.ts (register): the same temp+fsync+rename write the
// draft save path uses, for metadata files outside commitDraftTargets.
export function writeAtomic(path: string, content: string): void {
  renameSync(writeTemp(path, content), path);
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

// Style `range` entries are UTF-16LE byte offsets (see setTextRanges).
export function extractStyleRanges(content: string): Array<[number, number]> {
  try {
    const parsed = JSON.parse(content) as { styles?: Array<{ range?: unknown }> };
    if (!Array.isArray(parsed.styles)) return [];
    const ranges: Array<[number, number]> = [];
    for (const style of parsed.styles) {
      const r = style.range;
      if (Array.isArray(r) && r.length === 2 && typeof r[0] === "number" && typeof r[1] === "number") {
        ranges.push([r[0], r[1]]);
      }
    }
    return ranges;
  } catch {
    return [];
  }
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
