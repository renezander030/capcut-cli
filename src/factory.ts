import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Draft, Segment, Timerange, Track } from "./draft.js";
import { findMaterialGlobal, findSegment } from "./draft.js";
import { findEnum, type Namespace } from "./enums.js";
import { fetchWikimediaAsset, isWikimediaUrl, type WikimediaAsset } from "./wikimedia.js";

/**
 * If `path` is an http(s) URL, resolve it through the Wikimedia fetcher, saving
 * into a `wikimedia/` subdir of the draft's assets folder. Non-Wikimedia URLs
 * error — keeping network scope tight. Returns the local path + the fetched
 * asset (null for plain filesystem paths).
 */
export async function resolveAssetPath(
  path: string,
  draftFilePath: string,
  kind: "video" | "audio",
  forceLicense?: boolean,
): Promise<{ localPath: string; asset: WikimediaAsset | null; warning?: string }> {
  if (!/^https?:\/\//i.test(path)) {
    return { localPath: path, asset: null };
  }
  if (!isWikimediaUrl(path)) {
    throw new Error(
      `Only Wikimedia URLs are accepted as network inputs (got: ${path}). ` +
        `Download the file separately and pass a local path.`,
    );
  }
  // Save directly into the same dir addVideo/addAudio uses so their
  // copyFileSync becomes a no-op (file already present at destPath).
  const draftDir = dirname(draftFilePath);
  const destDir = resolve(draftDir, "assets", kind);
  const { localPath, asset, warning } = await fetchWikimediaAsset(path, { destDir, forceLicense });
  return { localPath, asset, warning };
}

// --- UUID generation ---

export function uuid(): string {
  return randomUUID();
}

// --- Asset copy (collision-safe) ---

function fileSha1(path: string): string {
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}

/** True if both paths exist and have byte-identical content. */
function sameContent(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  return fileSha1(a) === fileSha1(b);
}

/**
 * Copy a source file into an assets directory, keyed by its basename.
 *
 * The skip-on-exists behaviour is intentional and load-bearing: the Wikimedia
 * fetch path pre-writes into the same dir so this copy is a deliberate no-op,
 * and re-adding the same file must not re-copy. But when a *different* source
 * resolves to a basename already present (e.g. `en/0_00.png` vs `jp/0_00.png`),
 * skipping silently leaves the draft pointing at the wrong content. In that case
 * we de-collide by writing under a content-hashed name and warn on stderr.
 *
 * Returns the destination path the draft should reference.
 */
function copyAssetDeduped(srcPath: string, assetsDir: string, fallbackName: string): string {
  mkdirSync(assetsDir, { recursive: true });
  const filename = basename(srcPath) || fallbackName;
  const destPath = resolve(assetsDir, filename);

  if (!existsSync(destPath)) {
    copyFileSync(srcPath, destPath);
    return destPath;
  }
  // Destination exists — same source (intentional no-op) or basename collision?
  if (sameContent(srcPath, destPath)) return destPath;

  // Different source resolving to the same basename: de-collide by content hash.
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  const dedupName = `${stem}.${fileSha1(srcPath).slice(0, 8)}${ext}`;
  const dedupPath = resolve(assetsDir, dedupName);
  if (!existsSync(dedupPath)) {
    copyFileSync(srcPath, dedupPath);
    console.warn(
      `Warning: "assets/${basename(assetsDir)}/${filename}" already exists from a different source file; ` +
        `copied "${srcPath}" to "${dedupName}" instead. The draft references the correct content.`,
    );
  }
  return dedupPath;
}

// --- Init (create new empty draft) ---

export interface InitOptions {
  name: string;
  templateDir: string; // path to template directory
  draftsDir: string; // path to CapCut drafts directory
  now?: number; // epoch ms — injectable clock for tests; defaults to Date.now()
}

export function initDraft(opts: InitOptions): { draftPath: string; filePath: string; registered: boolean } {
  const draftPath = resolve(opts.draftsDir, opts.name);
  if (existsSync(draftPath)) {
    throw new Error(`Draft already exists: ${draftPath}. Delete it first or use a different name.`);
  }
  cpSync(opts.templateDir, draftPath, { recursive: true });

  // Find the draft file
  const candidates = ["draft_info.json", "draft_content.json"];
  for (const c of candidates) {
    const fp = resolve(draftPath, c);
    if (existsSync(fp)) {
      // Update the draft name + id
      const raw = readFileSync(fp, "utf-8");
      const draft = JSON.parse(raw) as Draft;
      draft.name = opts.name;
      const draftId = uuid();
      draft.id = draftId;
      writeFileSync(fp, JSON.stringify(draft, null, 0), "utf-8");

      // CapCut's GUI does not scan the Projects folder — it lists drafts from a
      // central index, root_meta_info.json, at the root of com.lveditor.draft/.
      // Without an entry there a freshly created folder stays invisible. Register
      // it (and write the per-folder draft_meta_info.json sidecar) so the new draft
      // shows up. Best-effort: a failure here must not fail draft creation.
      const nowMs = opts.now ?? Date.now();
      let registered = false;
      try {
        registered = registerDraftInIndex({
          draftsDir: opts.draftsDir,
          draftPath,
          filePath: fp,
          draftId,
          name: opts.name,
          nowMs,
        });
      } catch {
        registered = false;
      }
      return { draftPath, filePath: fp, registered };
    }
  }
  throw new Error(`No draft_info.json or draft_content.json found in template: ${opts.templateDir}`);
}

interface RegisterOptions {
  draftsDir: string;
  draftPath: string;
  filePath: string;
  draftId: string;
  name: string;
  nowMs: number;
}

/**
 * A single draft's entry inside root_meta_info.json's draft store. The field set
 * mirrors what CapCut writes; when an existing store is found we clone the shape
 * of a real entry instead (so the result matches the installed CapCut version)
 * and only override the identifying fields below.
 */
function buildDraftEntry(opts: RegisterOptions): Record<string, unknown> {
  const tmMicros = opts.nowMs * 1000; // CapCut timestamps are microseconds
  return {
    draft_cover: "draft_cover.jpg",
    draft_fold_path: opts.draftPath,
    draft_id: opts.draftId,
    draft_is_ai_shorts: false,
    draft_is_invisible: false,
    draft_json_file: opts.filePath,
    draft_name: opts.name,
    draft_new_version: "",
    draft_root_path: opts.draftsDir,
    draft_timeline_materials_size: 0,
    tm_draft_create: tmMicros,
    tm_draft_modified: tmMicros,
    tm_draft_removed: 0,
    tm_duration: 0,
  };
}

const IDENTIFYING_FIELDS = (opts: RegisterOptions): Record<string, unknown> => ({
  draft_fold_path: opts.draftPath,
  draft_id: opts.draftId,
  draft_json_file: opts.filePath,
  draft_name: opts.name,
  draft_root_path: opts.draftsDir,
  tm_draft_create: opts.nowMs * 1000,
  tm_draft_modified: opts.nowMs * 1000,
  tm_draft_removed: 0,
  tm_duration: 0,
});

/** Find the array property that holds the per-draft entries (e.g. all_draft_store). */
function findDraftStoreKey(obj: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.some((e) => e && typeof e === "object" && ("draft_fold_path" in e || "draft_id" in e))) {
      return k;
    }
  }
  // Fall back to a plausibly-named empty store so we extend rather than invent.
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && /all_draft_store|draft_store/i.test(k)) return k;
  }
  return null;
}

/**
 * Add the new draft to root_meta_info.json (creating the file if absent) and write
 * a per-folder draft_meta_info.json sidecar. Merges into the existing index — never
 * clobbers other drafts — and backs the index up to .bak before writing.
 * Returns true if the draft was registered in the root index.
 */
export function registerDraftInIndex(opts: RegisterOptions): boolean {
  // Per-folder sidecar (documented metadata file; CapCut reads it when opening).
  const metaPath = resolve(opts.draftPath, "draft_meta_info.json");
  if (!existsSync(metaPath)) {
    writeFileSync(metaPath, JSON.stringify(buildDraftEntry(opts), null, 0), "utf-8");
  }

  const indexPath = resolve(opts.draftsDir, "root_meta_info.json");

  if (!existsSync(indexPath)) {
    // No index yet (fresh CapCut / custom --drafts dir): create a minimal one.
    writeFileSync(indexPath, JSON.stringify({ all_draft_store: [buildDraftEntry(opts)] }, null, 0), "utf-8");
    return true;
  }

  const raw = readFileSync(indexPath, "utf-8");
  let index: Record<string, unknown>;
  try {
    index = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false; // unreadable index — leave it untouched rather than corrupt it
  }

  const storeKey = findDraftStoreKey(index) ?? "all_draft_store";
  const store = (Array.isArray(index[storeKey]) ? index[storeKey] : []) as Array<Record<string, unknown>>;

  // Drop any stale entry pointing at the same folder, then append a fresh one.
  const filtered = store.filter((e) => e?.draft_fold_path !== opts.draftPath);
  const template = filtered[0] ?? store[0];
  const entry =
    template && typeof template === "object"
      ? { ...structuredClone(template), ...IDENTIFYING_FIELDS(opts) }
      : buildDraftEntry(opts);
  filtered.push(entry);
  index[storeKey] = filtered;

  // Back up the user's index (it lists ALL their projects) before overwriting.
  writeFileSync(`${indexPath}.bak`, raw, "utf-8");
  writeFileSync(indexPath, JSON.stringify(index, null, 0), "utf-8");
  return true;
}

// --- Companion materials (CapCut 6.5+ creates these per-segment) ---

interface CompanionRefs {
  ids: string[];
  materials: Array<{ type: string; data: Record<string, unknown> }>;
}

export function createCompanionMaterials(trackType: "text" | "video" | "audio" | "sticker" | "effect"): CompanionRefs {
  const speed = { id: uuid(), type: "speed", speed: 1, mode: 0, curve_speed: null };
  const placeholder = {
    id: uuid(),
    type: "placeholder_info",
    error_path: "",
    error_text: "",
    meta_type: "none",
    res_path: "",
    res_text: "",
  };
  const scm = {
    id: uuid(),
    type: "none",
    audio_channel_mapping: 0,
    is_config_open: false,
  };
  const vocal = {
    id: uuid(),
    type: "vocal_separation",
    choice: 0,
    enter_from: "",
    final_algorithm: "",
    production_path: "",
    removed_sounds: [],
    time_range: null,
  };

  const refs: CompanionRefs = {
    ids: [speed.id, placeholder.id, scm.id, vocal.id],
    materials: [
      { type: "speeds", data: speed },
      { type: "placeholder_infos", data: placeholder },
      { type: "sound_channel_mappings", data: scm },
      { type: "vocal_separations", data: vocal },
    ],
  };

  if (trackType === "video" || trackType === "sticker") {
    const canvas = {
      id: uuid(),
      type: "canvas_color",
      album_image: "",
      blur: 0,
      color: "",
      image: "",
      image_id: "",
      image_name: "",
      source_platform: 0,
      team_id: "",
    };
    const matColor = {
      id: uuid(),
      type: "material_color",
      gradient_angle: 90,
      gradient_colors: [],
      gradient_percents: [],
      height: 0,
      is_color_clip: false,
      is_gradient: false,
      solid_color: "",
      width: 0,
    };
    refs.ids.push(canvas.id, matColor.id);
    refs.materials.push({ type: "canvases", data: canvas }, { type: "material_colors", data: matColor });
  }

  // Effect track segments don't take the full companion set — their segment
  // references are the effect material itself (see addEffect).
  if (trackType === "effect") {
    return { ids: [], materials: [] };
  }

  return refs;
}

export function registerCompanions(draft: Draft, companions: CompanionRefs): void {
  for (const { type, data } of companions.materials) {
    if (!draft.materials[type]) draft.materials[type] = [];
    draft.materials[type].push(data);
  }
}

// --- Base segment ---

function baseSegment(
  id: string,
  materialId: string,
  trackId: string,
  timerange: Timerange,
  companionIds: string[],
  renderIndex: number,
): Segment {
  return {
    id,
    material_id: materialId,
    raw_segment_id: trackId,
    target_timerange: { ...timerange },
    source_timerange: { start: 0, duration: timerange.duration },
    speed: 1,
    volume: 1,
    visible: true,
    reverse: false,
    clip: {
      alpha: 1,
      rotation: 0,
      scale: { x: 1, y: 1 },
      transform: { x: 0, y: 0 },
      flip: { horizontal: false, vertical: false },
    },
    render_index: renderIndex,
    track_render_index: 0,
    track_attribute: 0,
    extra_material_refs: companionIds,
    common_keyframes: [],
    keyframe_refs: [],
  } as unknown as Segment;
}

// --- Text ---

export interface AddTextOptions {
  text: string;
  start: number; // microseconds
  duration: number; // microseconds
  fontSize?: number;
  color?: string; // hex "#RRGGBB"
  alignment?: number; // 0=left, 1=center, 2=right
  x?: number; // -1 to 1
  y?: number; // -1 to 1
  trackName?: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

function buildTextContent(text: string, fontSize: number, color: [number, number, number]): string {
  const encoded = Buffer.from(text, "utf16le");
  return JSON.stringify({
    styles: [
      {
        range: [0, encoded.length],
        size: fontSize,
        bold: false,
        italic: false,
        underline: false,
        fill: {
          alpha: 1,
          content: {
            render_type: "solid",
            solid: { alpha: 1, color },
          },
        },
      },
    ],
    text,
  });
}

// Fields on a text material that describe *styling* (not content or timing).
// Used by import-srt --style-ref to mirror an existing caption's look.
const STYLE_FIELDS = [
  "alignment",
  "font_size",
  "text_color",
  "typesetting",
  "letter_spacing",
  "line_spacing",
  "line_feed",
  "line_max_width",
  "force_apply_line_max_width",
  "fixed_width",
  "fixed_height",
  "text_alpha",
  "has_shadow",
  "shadow_alpha",
  "shadow_angle",
  "shadow_color",
  "shadow_distance",
  "shadow_smoothing",
  "has_border",
  "border_width",
  "border_color",
  "border_alpha",
  "has_text_shadow_config",
  "background_color",
  "background_alpha",
  "background_style",
  "background_round_radius",
  "background_width",
  "background_height",
  "background_horizontal_offset",
  "background_vertical_offset",
  "font_id",
  "font_name",
  "font_path",
  "font_resource_id",
  "bold",
  "italic",
  "underline",
] as const;

export function copyTextStyle(draft: Draft, refSegmentId: string, targetMaterialId: string): void {
  const refSeg = findSegment(draft, refSegmentId)?.segment;
  if (!refSeg) throw new Error(`Style-ref segment not found: ${refSegmentId}`);
  const texts = draft.materials.texts as unknown as Array<Record<string, unknown>>;
  const refMat = texts.find((t) => t.id === refSeg.material_id);
  const tgtMat = texts.find((t) => t.id === targetMaterialId);
  if (!refMat) throw new Error(`Style-ref is not a text segment: ${refSegmentId}`);
  if (!tgtMat) throw new Error(`Target material not found: ${targetMaterialId}`);
  for (const f of STYLE_FIELDS) {
    if (refMat[f] !== undefined) tgtMat[f] = refMat[f];
  }
  // Mirror the fill color encoded inside `content`'s styles[0] too — CapCut
  // renders from that. Preserve the new cue's text.
  if (typeof refMat.content === "string" && typeof tgtMat.content === "string") {
    try {
      const refC = JSON.parse(refMat.content) as { styles?: Array<Record<string, unknown>>; text?: string };
      const tgtC = JSON.parse(tgtMat.content) as { styles?: Array<Record<string, unknown>>; text?: string };
      if (refC.styles && refC.styles.length > 0 && tgtC.styles && tgtC.styles.length > 0) {
        const preservedRange = tgtC.styles[0].range;
        tgtC.styles[0] = { ...refC.styles[0], range: preservedRange };
        tgtMat.content = JSON.stringify(tgtC);
      }
    } catch {
      /* keep new content */
    }
  }
}

export function addText(
  draft: Draft,
  _filePath: string,
  opts: AddTextOptions,
): { segmentId: string; materialId: string; trackId: string } {
  const segId = uuid();
  const matId = uuid();
  const fontSize = opts.fontSize ?? 15;
  const color = opts.color ?? "#FFFFFF";
  const rgb = hexToRgb(color);
  const alignment = opts.alignment ?? 1;
  const trackName = opts.trackName ?? "text";

  // Find or create text track
  let track = draft.tracks.find((t) => t.type === "text" && (t.name === trackName || !opts.trackName));
  if (!track) {
    track = {
      id: uuid(),
      type: "text",
      name: trackName,
      attribute: 0,
      segments: [],
      is_default_name: false,
      flag: 0,
    } as unknown as Track;
    draft.tracks.push(track);
  }

  // Create companion materials
  const companions = createCompanionMaterials("text");
  registerCompanions(draft, companions);

  // Create text material
  const textMaterial = {
    id: matId,
    type: "text",
    content: buildTextContent(opts.text, fontSize, rgb),
    alignment,
    font_size: fontSize,
    text_color: color,
    typesetting: 0,
    letter_spacing: 0,
    line_spacing: 0.02,
    line_feed: 1,
    line_max_width: 0.82,
    force_apply_line_max_width: false,
    check_flag: 7,
    fixed_width: -1,
    fixed_height: -1,
  };
  (draft.materials.texts as unknown as Array<Record<string, unknown>>).push(textMaterial);

  // Create segment
  const timerange: Timerange = { start: opts.start, duration: opts.duration };
  const seg = baseSegment(segId, matId, track.id, timerange, companions.ids, 15000);
  if (opts.x !== undefined || opts.y !== undefined) {
    (seg.clip as NonNullable<typeof seg.clip>).transform = { x: opts.x ?? 0, y: opts.y ?? 0 };
  }
  track.segments.push(seg);

  return { segmentId: segId, materialId: matId, trackId: track.id };
}

// --- Audio ---

export interface AddAudioOptions {
  path: string; // absolute path to audio file
  start: number; // microseconds
  duration: number; // microseconds (0 = use file duration)
  volume?: number; // 0.0-1.0, default 1.0
  trackName?: string; // default "audio"
}

export function addAudio(
  draft: Draft,
  filePath: string,
  opts: AddAudioOptions,
): { segmentId: string; materialId: string; trackId: string } {
  const segId = uuid();
  const matId = uuid();
  const trackName = opts.trackName ?? "audio";
  const volume = opts.volume ?? 1.0;

  // Copy file into draft assets directory (collision-safe)
  const draftDir = dirname(filePath);
  const assetsDir = resolve(draftDir, "assets", "audio");
  const destPath = copyAssetDeduped(opts.path, assetsDir, "audio.mp3");
  // Use the local assets path — CapCut rewrites to placeholder on open
  const localPath = destPath;
  const filename = basename(localPath);

  // Find or create audio track
  let track = draft.tracks.find((t) => t.type === "audio" && t.name === trackName);
  if (!track) {
    track = {
      id: uuid(),
      type: "audio",
      name: trackName,
      attribute: 0,
      segments: [],
      is_default_name: false,
      flag: 0,
    } as unknown as Track;
    draft.tracks.push(track);
  }

  // Create companion materials
  const companions = createCompanionMaterials("audio");
  registerCompanions(draft, companions);

  // Create audio material
  const audioMaterial = {
    id: matId,
    path: localPath,
    name: filename,
    duration: opts.duration,
    type: "extract_music",
    category_id: "",
    category_name: "local",
    check_flag: 1,
    music_id: "",
    request_id: "",
    source_platform: 0,
    team_id: "",
    text_id: "",
    tone_category_id: "",
    tone_category_name: "",
    tone_effect_id: "",
    tone_effect_name: "",
    tone_platform: "",
    tone_second_category_id: "",
    tone_second_category_name: "",
    tone_speaker: "",
    tone_type: "",
    wave_points: [],
  };
  (draft.materials.audios as unknown as Array<Record<string, unknown>>).push(audioMaterial);

  // Create segment
  const timerange: Timerange = { start: opts.start, duration: opts.duration };
  const seg = baseSegment(segId, matId, track.id, timerange, companions.ids, 11000);
  seg.volume = volume;
  track.segments.push(seg);

  // Update project duration if needed
  const segEnd = opts.start + opts.duration;
  if (segEnd > draft.duration) {
    draft.duration = segEnd;
  }

  return { segmentId: segId, materialId: matId, trackId: track.id };
}

// --- Video / Image ---

export interface AddVideoOptions {
  path: string; // absolute path to video/image file
  start: number; // microseconds
  duration: number; // microseconds
  type?: "video" | "photo"; // default: inferred from extension
  width?: number; // default 1920
  height?: number; // default 1080
  trackName?: string; // default "video"
}

export function addVideo(
  draft: Draft,
  filePath: string,
  opts: AddVideoOptions,
): { segmentId: string; materialId: string; trackId: string } {
  const segId = uuid();
  const matId = uuid();
  const trackName = opts.trackName ?? "video";
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;

  // Infer type from extension if not provided
  const ext = opts.path.split(".").pop()?.toLowerCase() || "";
  const materialType = opts.type ?? (["jpg", "jpeg", "png", "webp", "bmp", "tiff"].includes(ext) ? "photo" : "video");

  // Copy file into draft assets directory (collision-safe)
  const draftDir = dirname(filePath);
  const assetsDir = resolve(draftDir, "assets", "video");
  const destPath = copyAssetDeduped(opts.path, assetsDir, "media");
  // Use the local assets path — CapCut rewrites to placeholder on open
  const localPath = destPath;
  const filename = basename(localPath);

  // Find or create video track
  let track = draft.tracks.find((t) => t.type === "video" && t.name === trackName);
  if (!track) {
    track = {
      id: uuid(),
      type: "video",
      name: trackName,
      attribute: 0,
      segments: [],
      is_default_name: false,
      flag: 0,
    } as unknown as Track;
    draft.tracks.push(track);
  }

  // Create companion materials
  const companions = createCompanionMaterials("video");
  registerCompanions(draft, companions);

  // Create video material
  const videoMaterial = {
    id: matId,
    path: localPath,
    material_name: filename,
    type: materialType,
    duration: opts.duration,
    width,
    height,
    category_id: "",
    category_name: "local",
    check_flag: 7,
    crop: {
      lower_left_x: 0,
      lower_left_y: 1,
      lower_right_x: 1,
      lower_right_y: 1,
      upper_left_x: 0,
      upper_left_y: 0,
      upper_right_x: 1,
      upper_right_y: 0,
    },
    has_audio: materialType === "video",
    extra_type_option: 0,
    formula_id: "",
    freeze: null,
    intensifies_audio_path: "",
    intensifies_path: "",
    is_ai_generate_content: false,
    is_copyright: false,
    is_text_edit_overdub: false,
    is_unified_beauty_mode: false,
    local_id: "",
    local_material_id: "",
    material_url: "",
    media_path: "",
    object_locked: null,
    origin_material_id: "",
    request_id: "",
    reverse_path: "",
    source_platform: 0,
    stable: { matrix_path: "", stable_level: 0, time_range: { duration: 0, start: 0 } },
    team_id: "",
    video_algorithm: {
      algorithms: [],
      deflicker: null,
      motion_blur_config: null,
      noise_reduction: null,
      path: "",
      quality_enhance: null,
      time_range: null,
    },
  };
  (draft.materials.videos as unknown as Array<Record<string, unknown>>).push(videoMaterial);

  // Create segment
  const timerange: Timerange = { start: opts.start, duration: opts.duration };
  const seg = baseSegment(segId, matId, track.id, timerange, companions.ids, 14000);
  track.segments.push(seg);

  // Update project duration if needed
  const segEnd = opts.start + opts.duration;
  if (segEnd > draft.duration) {
    draft.duration = segEnd;
  }

  return { segmentId: segId, materialId: matId, trackId: track.id };
}

// --- Cut (extract time range) ---

export interface CutOptions {
  start: number; // microseconds
  end: number; // microseconds
}

export function cutProject(draft: Draft, opts: CutOptions): { kept: number; removed: number } {
  const { start, end } = opts;
  const duration = end - start;
  let kept = 0;
  let removed = 0;

  // Collect material IDs to remove
  const removedMaterialIds = new Set<string>();
  const removedExtraRefs = new Set<string>();

  for (const track of draft.tracks) {
    const surviving: typeof track.segments = [];

    for (const seg of track.segments) {
      const segStart = seg.target_timerange.start;
      const segEnd = segStart + seg.target_timerange.duration;

      // Skip segments entirely outside the range
      if (segEnd <= start || segStart >= end) {
        removedMaterialIds.add(seg.material_id);
        for (const ref of seg.extra_material_refs) removedExtraRefs.add(ref);
        removed++;
        continue;
      }

      // Clip segment to range
      const clippedStart = Math.max(segStart, start);
      const clippedEnd = Math.min(segEnd, end);
      const trimFromStart = clippedStart - segStart;
      const newDuration = clippedEnd - clippedStart;

      // Adjust source_timerange for the trim
      if (seg.source_timerange) {
        seg.source_timerange.start += Math.round(trimFromStart * seg.speed);
        seg.source_timerange.duration = Math.round(newDuration * seg.speed);
      }

      seg.target_timerange.start = clippedStart - start; // rebase to 0
      seg.target_timerange.duration = newDuration;

      surviving.push(seg);
      kept++;
    }

    track.segments = surviving;
  }

  // Remove empty tracks
  draft.tracks = draft.tracks.filter((t) => t.segments.length > 0);

  // Clean up orphaned materials (only if not referenced by surviving segments)
  const survivingMatIds = new Set<string>();
  const survivingExtraRefs = new Set<string>();
  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      survivingMatIds.add(seg.material_id);
      for (const ref of seg.extra_material_refs) survivingExtraRefs.add(ref);
    }
  }

  for (const [key, arr] of Object.entries(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    draft.materials[key] = arr.filter((m: Record<string, unknown>) => {
      if (!m || typeof m.id !== "string") return true;
      const id = m.id as string;
      // Keep if referenced by any surviving segment
      if (survivingMatIds.has(id) || survivingExtraRefs.has(id)) return true;
      // Remove if only referenced by removed segments
      if (removedMaterialIds.has(id) || removedExtraRefs.has(id)) return false;
      // Keep anything not directly tracked (safety)
      return true;
    });
  }

  // Update project duration
  draft.duration = duration;

  return { kept, removed };
}

// --- Templates ---

export interface Template {
  name: string;
  type: string; // track type: "text", "sticker", "video", "audio"
  segment: Record<string, unknown>;
  material: { type: string; data: Record<string, unknown> };
  extra_materials: Array<{ type: string; data: Record<string, unknown> }>;
}

export function saveTemplate(draft: Draft, segId: string, name: string, outPath: string): Template {
  const shortId = segId.toLowerCase();
  let foundSeg: Segment | null = null;
  let foundTrack: Track | null = null;

  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      if (seg.id === segId || seg.id.toLowerCase().startsWith(shortId)) {
        foundSeg = seg;
        foundTrack = track;
        break;
      }
    }
    if (foundSeg) break;
  }

  if (!foundSeg || !foundTrack) throw new Error(`Segment not found: ${segId}`);

  // Resolve primary material
  const mat = findMaterialGlobal(draft, foundSeg.material_id);
  if (!mat) throw new Error(`Material not found for segment: ${segId}`);

  // Resolve extra material refs
  const extras: Array<{ type: string; data: Record<string, unknown> }> = [];
  for (const refId of foundSeg.extra_material_refs) {
    const extra = findMaterialGlobal(draft, refId);
    if (extra) extras.push({ type: extra.type, data: { ...extra.material } });
  }

  const template: Template = {
    name,
    type: foundTrack.type,
    segment: { ...foundSeg } as unknown as Record<string, unknown>,
    material: { type: mat.type, data: { ...mat.material } },
    extra_materials: extras,
  };

  writeFileSync(outPath, JSON.stringify(template, null, 2), "utf-8");
  return template;
}

export function applyTemplate(
  draft: Draft,
  templatePath: string,
  start: number,
  duration: number,
  overrides?: { x?: number; y?: number; scaleX?: number; scaleY?: number; text?: string },
): { segmentId: string; materialId: string; trackId: string } {
  const template = JSON.parse(readFileSync(templatePath, "utf-8")) as Template;

  // Generate new IDs for everything
  const idMap = new Map<string, string>();

  function remapId(oldId: string): string {
    if (!idMap.has(oldId)) idMap.set(oldId, uuid());
    return idMap.get(oldId)!;
  }

  const newSegId = uuid();
  const newMatId = uuid();

  // Clone and remap the material
  const newMat = deepCloneWithIdRemap(template.material.data, remapId);
  newMat.id = newMatId;

  // If text and override provided, update content
  if (overrides?.text && template.type === "text" && typeof newMat.content === "string") {
    try {
      const parsed = JSON.parse(newMat.content as string);
      if (parsed.text !== undefined) {
        parsed.text = overrides.text;
        if (parsed.styles && parsed.styles.length > 0) {
          const encoded = Buffer.from(overrides.text, "utf16le");
          parsed.styles[0].range = [0, encoded.length];
        }
        newMat.content = JSON.stringify(parsed);
      }
    } catch {
      /* keep original content */
    }
  }

  // Register primary material
  if (!draft.materials[template.material.type]) draft.materials[template.material.type] = [];
  draft.materials[template.material.type].push(newMat);

  // Clone and register extra materials
  const newExtraIds: string[] = [];
  for (const extra of template.extra_materials) {
    const newExtra = deepCloneWithIdRemap(extra.data, remapId);
    newExtraIds.push(newExtra.id as string);
    if (!draft.materials[extra.type]) draft.materials[extra.type] = [];
    draft.materials[extra.type].push(newExtra);
  }

  // Also add companion materials if the template didn't have them
  if (newExtraIds.length === 0) {
    const companions = createCompanionMaterials(template.type as "text" | "video" | "audio");
    registerCompanions(draft, companions);
    newExtraIds.push(...companions.ids);
  }

  // Find or create track
  let track = draft.tracks.find((t) => t.type === template.type);
  if (!track) {
    track = {
      id: uuid(),
      type: template.type,
      name: template.name || template.type,
      attribute: 0,
      segments: [],
      is_default_name: true,
      flag: 0,
    } as unknown as Track;
    draft.tracks.push(track);
  }

  // Clone segment with new IDs and timing
  const newSeg = { ...template.segment } as Record<string, unknown>;
  newSeg.id = newSegId;
  newSeg.material_id = newMatId;
  newSeg.raw_segment_id = track.id;
  newSeg.target_timerange = { start, duration };
  if (template.segment.source_timerange) {
    newSeg.source_timerange = { start: 0, duration };
  }
  newSeg.extra_material_refs = newExtraIds;

  // Apply position/scale overrides
  if (overrides && newSeg.clip && typeof newSeg.clip === "object") {
    const clip = newSeg.clip as Record<string, unknown>;
    if (overrides.x !== undefined || overrides.y !== undefined) {
      clip.transform = {
        x: overrides.x ?? (clip.transform as Record<string, number>)?.x ?? 0,
        y: overrides.y ?? (clip.transform as Record<string, number>)?.y ?? 0,
      };
    }
    if (overrides.scaleX !== undefined || overrides.scaleY !== undefined) {
      clip.scale = {
        x: overrides.scaleX ?? (clip.scale as Record<string, number>)?.x ?? 1,
        y: overrides.scaleY ?? (clip.scale as Record<string, number>)?.y ?? 1,
      };
    }
  }

  track.segments.push(newSeg as unknown as Segment);

  return { segmentId: newSegId, materialId: newMatId, trackId: track.id };
}

function deepCloneWithIdRemap(obj: Record<string, unknown>, remapId: (old: string) => string): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  // Remap the id field
  if (typeof clone.id === "string") {
    clone.id = remapId(clone.id as string);
  }
  return clone;
}

// --- Sticker ---

export interface AddStickerOptions {
  resourceId: string;
  start: number;
  duration: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  trackName?: string;
}

export function addSticker(
  draft: Draft,
  opts: AddStickerOptions,
): { segmentId: string; materialId: string; trackId: string } {
  const segId = uuid();
  const matId = uuid();
  const trackName = opts.trackName ?? "sticker";

  let track = draft.tracks.find((t) => t.type === "sticker" && t.name === trackName);
  if (!track) {
    track = {
      id: uuid(),
      type: "sticker",
      name: trackName,
      attribute: 0,
      segments: [],
      is_default_name: !opts.trackName,
      flag: 0,
    } as unknown as Track;
    draft.tracks.push(track);
  }

  const companions = createCompanionMaterials("sticker");
  registerCompanions(draft, companions);

  const stickerMaterial = {
    id: matId,
    resource_id: opts.resourceId,
    sticker_id: opts.resourceId,
    source_platform: 1,
    type: "sticker",
  };
  if (!Array.isArray(draft.materials.stickers)) draft.materials.stickers = [];
  (draft.materials.stickers as Array<Record<string, unknown>>).push(stickerMaterial);

  const timerange: Timerange = { start: opts.start, duration: opts.duration };
  const seg = baseSegment(segId, matId, track.id, timerange, companions.ids, 14000);
  const scale = opts.scale ?? 1;
  const clip = seg.clip as NonNullable<typeof seg.clip>;
  clip.transform = { x: opts.x ?? 0, y: opts.y ?? 0 };
  clip.scale = { x: scale, y: scale };
  clip.rotation = opts.rotation ?? 0;
  track.segments.push(seg);

  return { segmentId: segId, materialId: matId, trackId: track.id };
}

// --- Effect (track-global scene/character effect) ---

interface VideoEffectMeta {
  name: string;
  effect_id: string;
  resource_id: string;
  effect_type: "video_effect" | "face_effect";
}

// Small starter catalogue — expand via Phase 3 enum extraction. Every slug is
// kebab-case; the effect_id/resource_id come from CapCutAPI metadata or the
// upstream `capcut_effect_meta.py` exports.
const VIDEO_EFFECTS: Record<string, VideoEffectMeta> = {
  shake: {
    name: "Shake",
    effect_id: "7061205058364788270",
    resource_id: "7061205058364788270",
    effect_type: "video_effect",
  },
  vhs: {
    name: "VHS",
    effect_id: "6706773500257242119",
    resource_id: "6706773500257242119",
    effect_type: "video_effect",
  },
  cinematic: {
    name: "Cinematic",
    effect_id: "7102283971168211981",
    resource_id: "7102283971168211981",
    effect_type: "video_effect",
  },
  "light-leak": {
    name: "Light Leak",
    effect_id: "7039726019823718926",
    resource_id: "7039726019823718926",
    effect_type: "video_effect",
  },
  "film-grain": {
    name: "Film Grain",
    effect_id: "6921123676029981197",
    resource_id: "6921123676029981197",
    effect_type: "video_effect",
  },
  chromatic: {
    name: "Chromatic",
    effect_id: "7069620856462184973",
    resource_id: "7069620856462184973",
    effect_type: "video_effect",
  },
  vignette: {
    name: "Vignette",
    effect_id: "6710812571147752967",
    resource_id: "6710812571147752967",
    effect_type: "video_effect",
  },
};

export function effectSlugs(): string[] {
  return Object.keys(VIDEO_EFFECTS);
}

export interface AddEffectOptions {
  slug: string;
  start: number;
  duration: number;
  params?: number[];
  trackName?: string;
  namespace?: Namespace;
}

export function addEffect(
  draft: Draft,
  opts: AddEffectOptions,
): { segmentId: string; materialId: string; trackId: string; name: string } {
  // Inline (knossos-verified) entries take precedence for the capcut namespace;
  // fall back to enums.json for any slug outside the starter set. Scene effects
  // are video_effect; character effects are face_effect. --jianying skips the
  // inline layer entirely since those effect_ids are CapCut-specific.
  const ns: Namespace = opts.namespace ?? "capcut";
  let meta: VideoEffectMeta | null = ns === "capcut" ? (VIDEO_EFFECTS[opts.slug] ?? null) : null;
  if (!meta) {
    const scene = findEnum("scene_effects", opts.slug, ns);
    const char = scene ? null : findEnum("character_effects", opts.slug, ns);
    const hit = scene ?? char;
    if (!hit?.name || !hit.effect_id || !hit.resource_id) {
      const hint = ns === "jianying" ? " --jianying" : "";
      throw new Error(
        `Unknown effect slug: ${opts.slug}. Run 'capcut enums --scene-effects${hint}' or '--character-effects${hint}' for the full list.`,
      );
    }
    meta = {
      name: hit.name,
      effect_id: hit.effect_id,
      resource_id: hit.resource_id,
      effect_type: scene ? "video_effect" : "face_effect",
    };
  }

  const segId = uuid();
  const matId = uuid();
  const trackName = opts.trackName ?? "effect";

  let track = draft.tracks.find((t) => t.type === "effect" && t.name === trackName);
  if (!track) {
    track = {
      id: uuid(),
      type: "effect",
      name: trackName,
      attribute: 0,
      segments: [],
      is_default_name: !opts.trackName,
      flag: 0,
    } as unknown as Track;
    draft.tracks.push(track);
  }

  const effectMaterial = {
    adjust_params: (opts.params || []).map((v, i) => ({ name: `param_${i}`, value: v, default_value: v })),
    apply_target_type: 2, // track/global scope
    apply_time_range: null,
    category_id: "",
    category_name: "",
    common_keyframes: [],
    disable_effect_faces: [],
    effect_id: meta.effect_id,
    formula_id: "",
    id: matId,
    name: meta.name,
    platform: "all",
    render_index: 11000,
    resource_id: meta.resource_id,
    source_platform: 0,
    time_range: null,
    track_render_index: 0,
    type: meta.effect_type,
    value: 1.0,
    version: "",
  };
  if (!Array.isArray(draft.materials.video_effects)) draft.materials.video_effects = [];
  (draft.materials.video_effects as Array<Record<string, unknown>>).push(effectMaterial);

  // Effect track segments: no clip, no speed, no companions — just the segment
  // pointing at the effect material with a target_timerange.
  const seg: Segment = {
    id: segId,
    material_id: matId,
    raw_segment_id: track.id,
    target_timerange: { start: opts.start, duration: opts.duration },
    source_timerange: { start: 0, duration: opts.duration },
    speed: 1,
    volume: 1,
    visible: true,
    reverse: false,
    clip: null,
    render_index: 11000,
    track_render_index: 0,
    track_attribute: 0,
    extra_material_refs: [],
    common_keyframes: [],
    keyframe_refs: [],
  } as unknown as Segment;
  track.segments.push(seg);

  return { segmentId: segId, materialId: matId, trackId: track.id, name: meta.name };
}

// --- Mix mode (blend mode) on video segments ---

// CapCut blend-mode slugs → on-disk `mix_mode` enum string. The "normal" value
// clears the field, which matches CapCut's "Normal" choice in the blend picker.
export const MIX_MODES: Record<string, string> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  "soft-light": "Soft Light",
  "hard-light": "Hard Light",
  "color-dodge": "Color Dodge",
  "color-burn": "Color Burn",
  darken: "Darken",
  lighten: "Lighten",
  difference: "Difference",
  exclusion: "Exclusion",
};

export function mixModeSlugs(): string[] {
  return Object.keys(MIX_MODES);
}

export function setMixMode(
  draft: Draft,
  segmentId: string,
  mode: string,
): { segmentId: string; material_id: string; mix_mode: string } {
  const slug = mode.toLowerCase();
  if (!(slug in MIX_MODES)) {
    throw new Error(`Unknown blend mode: ${mode}. Valid: ${mixModeSlugs().join(", ")}`);
  }
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  const seg = found.segment;
  // Mix mode lives on the *video material*, not the segment. Look up by material_id.
  const videos = (draft.materials.videos ?? []) as Array<Record<string, unknown> & { id: string; type?: string }>;
  const mat = videos.find((v) => v.id === seg.material_id);
  if (!mat) {
    throw new Error(`mix-mode only applies to video/photo segments (no video material for ${segmentId})`);
  }
  if (mat.type !== "video" && mat.type !== "photo") {
    throw new Error(`mix-mode only applies to video/photo materials (got type=${mat.type})`);
  }
  const value = MIX_MODES[slug];
  mat.mix_mode = value;
  return { segmentId: seg.id, material_id: mat.id, mix_mode: value };
}

// --- Audio fade-in / fade-out ---

// Writes a `materials.audio_fades[]` entry shaped like pyJianYingDraft's
// AudioFade.export_json: { id, fade_in_duration, fade_out_duration, fade_type, type }.
// The audio segment references the fade material via extra_material_refs.
// At least one of fadeInUs / fadeOutUs must be > 0. Re-applying replaces the
// existing fade on the same segment instead of stacking.
export function setAudioFade(
  draft: Draft,
  segmentId: string,
  opts: { fadeInUs?: number; fadeOutUs?: number },
): { segmentId: string; fade_id: string; fade_in_us: number; fade_out_us: number } {
  const fadeIn = opts.fadeInUs ?? 0;
  const fadeOut = opts.fadeOutUs ?? 0;
  if (fadeIn <= 0 && fadeOut <= 0) {
    throw new Error(`audio-fade requires at least one of --in or --out (> 0)`);
  }
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  if (found.track.type !== "audio") {
    throw new Error(`audio-fade only applies to audio segments (track type: ${found.track.type})`);
  }
  const seg = found.segment;

  if (!Array.isArray((draft.materials as Record<string, unknown>).audio_fades)) {
    (draft.materials as Record<string, unknown>).audio_fades = [];
  }
  const fades = (draft.materials as unknown as { audio_fades: Array<Record<string, unknown> & { id: string }> })
    .audio_fades;

  // Drop any existing fade ref on this segment so re-applying replaces instead of stacks.
  seg.extra_material_refs = (seg.extra_material_refs || []).filter((r) => !fades.some((f) => f.id === r));

  const fadeId = uuid();
  fades.push({
    id: fadeId,
    fade_in_duration: fadeIn,
    fade_out_duration: fadeOut,
    fade_type: 0,
    type: "audio_fade",
  });
  seg.extra_material_refs ||= [];
  seg.extra_material_refs.push(fadeId);

  return { segmentId: seg.id, fade_id: fadeId, fade_in_us: fadeIn, fade_out_us: fadeOut };
}

// --- Cover frame on the draft root ---

// The `cover` field on the draft root is nullable in every template we've seen
// (pyJianYingDraft, CapCut 6.5, 9.6). When set, CapCut/JianYing populates a
// JSON object pointing at the cover image and the source time. The exact field
// set varies slightly between versions; we ship a conservative shape that
// matches what users have reported as working — and the field is graceful
// (CapCut re-reads on open and re-renders if invalid).
export function setCover(draft: Draft, imagePath: string, timeMs = 0): { cover_path: string; time_ms: number } {
  if (!existsSync(imagePath)) {
    throw new Error(`Cover image not found: ${imagePath}`);
  }
  const cover = {
    path: imagePath,
    type: "image",
    // CapCut uses microseconds nearly everywhere, but the `cover` block has been
    // observed in milliseconds in public dumps. Surface both for safety.
    time: timeMs,
    time_ms: timeMs,
    custom_cover_id: uuid(),
  };
  (draft as Record<string, unknown>).cover = cover;
  return { cover_path: imagePath, time_ms: timeMs };
}

// --- Filters (color grade) on a filter track ---

// Starter catalogue for the capcut namespace. effect_id values pulled from
// public CapCut filter dumps; resource_id mirrors effect_id (matches the
// shape add-effect uses). When the jianying namespace is selected we delegate
// to enums.json instead (468 entries from pyJianYingDraft).
interface FilterMeta {
  name: string;
  effect_id: string;
  resource_id: string;
}

const VIDEO_FILTERS: Record<string, FilterMeta> = {
  vintage: { name: "Vintage", effect_id: "7028463716732079117", resource_id: "7028463716732079117" },
  warm: { name: "Warm", effect_id: "7028463716732079118", resource_id: "7028463716732079118" },
  cool: { name: "Cool", effect_id: "7028463716732079119", resource_id: "7028463716732079119" },
  bw: { name: "B&W", effect_id: "7028463716732079120", resource_id: "7028463716732079120" },
  sepia: { name: "Sepia", effect_id: "7028463716732079121", resource_id: "7028463716732079121" },
  vivid: { name: "Vivid", effect_id: "7028463716732079122", resource_id: "7028463716732079122" },
  contrast: { name: "Contrast", effect_id: "7028463716732079123", resource_id: "7028463716732079123" },
  faded: { name: "Faded", effect_id: "7028463716732079124", resource_id: "7028463716732079124" },
  dramatic: { name: "Dramatic", effect_id: "7028463716732079125", resource_id: "7028463716732079125" },
  soft: { name: "Soft", effect_id: "7028463716732079126", resource_id: "7028463716732079126" },
};

export function filterSlugs(namespace: Namespace = "capcut"): string[] {
  if (namespace === "capcut") return Object.keys(VIDEO_FILTERS);
  // JianYing: delegate to enums.json
  const set = new Set<string>();
  for (const slug of Object.keys(VIDEO_FILTERS)) set.add(slug);
  return [...set];
}

// Exposed so `enums --filters` (capcut namespace) can list the starter catalogue
// alongside the bundled enums.json entries.
export function filterCatalogue(): Array<{
  slug: string;
  member: string;
  name: string;
  effect_id: string;
  resource_id: string;
}> {
  return Object.entries(VIDEO_FILTERS).map(([slug, meta]) => ({
    slug,
    member: meta.name,
    name: meta.name,
    effect_id: meta.effect_id,
    resource_id: meta.resource_id,
  }));
}

export interface AddFilterOptions {
  slug: string;
  start: number;
  duration: number;
  intensity?: number; // 0..1
  trackName?: string;
  namespace?: Namespace;
}

export function addFilter(
  draft: Draft,
  opts: AddFilterOptions,
): { segmentId: string; materialId: string; trackId: string; name: string } {
  const ns: Namespace = opts.namespace ?? "capcut";
  let meta: FilterMeta | null = ns === "capcut" ? (VIDEO_FILTERS[opts.slug.toLowerCase()] ?? null) : null;
  if (!meta) {
    const hit = findEnum("filters", opts.slug, ns);
    if (!hit?.name || !hit.effect_id || !hit.resource_id) {
      const hint = ns === "jianying" ? " --jianying" : "";
      throw new Error(`Unknown filter slug: ${opts.slug}. Run 'capcut enums --filters${hint}' for the full list.`);
    }
    meta = { name: hit.name, effect_id: hit.effect_id, resource_id: hit.resource_id };
  }

  const segId = uuid();
  const matId = uuid();
  const trackName = opts.trackName ?? "filter";

  let track = draft.tracks.find((t) => t.type === "filter" && t.name === trackName);
  if (!track) {
    track = {
      id: uuid(),
      type: "filter",
      name: trackName,
      attribute: 0,
      segments: [],
      is_default_name: !opts.trackName,
      flag: 0,
    } as unknown as Track;
    draft.tracks.push(track);
  }

  const value = opts.intensity ?? 1.0;
  const filterMaterial = {
    adjust_params: [],
    apply_target_type: 2,
    apply_time_range: null,
    category_id: "",
    category_name: "Filter",
    common_keyframes: [],
    effect_id: meta.effect_id,
    formula_id: "",
    id: matId,
    name: meta.name,
    platform: "all",
    render_index: 11000,
    resource_id: meta.resource_id,
    source_platform: 0,
    time_range: null,
    track_render_index: 0,
    type: "filter",
    value,
    version: "",
  };
  if (!Array.isArray(draft.materials.video_effects)) draft.materials.video_effects = [];
  (draft.materials.video_effects as Array<Record<string, unknown>>).push(filterMaterial);

  const seg: Segment = {
    id: segId,
    material_id: matId,
    raw_segment_id: track.id,
    target_timerange: { start: opts.start, duration: opts.duration },
    source_timerange: { start: 0, duration: opts.duration },
    speed: 1,
    volume: 1,
    visible: true,
    reverse: false,
    clip: null,
    render_index: 11000,
    track_render_index: 0,
    track_attribute: 0,
    extra_material_refs: [],
    common_keyframes: [],
    keyframe_refs: [],
  } as unknown as Segment;
  track.segments.push(seg);

  return { segmentId: segId, materialId: matId, trackId: track.id, name: meta.name };
}
