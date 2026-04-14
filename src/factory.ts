import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Draft, Segment, Track, Timerange } from "./draft.js";
import { findMaterialGlobal } from "./draft.js";

// --- UUID generation ---

export function uuid(): string {
  return randomUUID();
}

// --- Init (create new empty draft) ---

export interface InitOptions {
  name: string;
  templateDir: string;  // path to template directory
  draftsDir: string;    // path to CapCut drafts directory
}

export function initDraft(opts: InitOptions): { draftPath: string; filePath: string } {
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
      // Update the draft name
      const raw = readFileSync(fp, "utf-8");
      const draft = JSON.parse(raw) as Draft;
      draft.name = opts.name;
      draft.id = uuid();
      writeFileSync(fp, JSON.stringify(draft, null, 0), "utf-8");
      return { draftPath, filePath: fp };
    }
  }
  throw new Error(`No draft_info.json or draft_content.json found in template: ${opts.templateDir}`);
}

// --- Companion materials (CapCut 6.5+ creates these per-segment) ---

interface CompanionRefs {
  ids: string[];
  materials: Array<{ type: string; data: Record<string, unknown> }>;
}

export function createCompanionMaterials(trackType: "text" | "video" | "audio"): CompanionRefs {
  const speed = { id: uuid(), type: "speed", speed: 1, mode: 0, curve_speed: null };
  const placeholder = {
    id: uuid(), type: "placeholder_info",
    error_path: "", error_text: "", meta_type: "none", res_path: "", res_text: "",
  };
  const scm = {
    id: uuid(), type: "none",
    audio_channel_mapping: 0, is_config_open: false,
  };
  const vocal = {
    id: uuid(), type: "vocal_separation",
    choice: 0, enter_from: "", final_algorithm: "",
    production_path: "", removed_sounds: [], time_range: null,
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

  if (trackType === "video") {
    const canvas = {
      id: uuid(), type: "canvas_color",
      album_image: "", blur: 0, color: "", image: "",
      image_id: "", image_name: "", source_platform: 0, team_id: "",
    };
    const matColor = {
      id: uuid(), type: "material_color",
      gradient_angle: 90, gradient_colors: [], gradient_percents: [],
      height: 0, is_color_clip: false, is_gradient: false, solid_color: "", width: 0,
    };
    refs.ids.push(canvas.id, matColor.id);
    refs.materials.push(
      { type: "canvases", data: canvas },
      { type: "material_colors", data: matColor },
    );
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

function baseSegment(id: string, materialId: string, trackId: string, timerange: Timerange, companionIds: string[], renderIndex: number): Segment {
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
  start: number;       // microseconds
  duration: number;    // microseconds
  fontSize?: number;
  color?: string;      // hex "#RRGGBB"
  alignment?: number;  // 0=left, 1=center, 2=right
  x?: number;          // -1 to 1
  y?: number;          // -1 to 1
  trackName?: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function buildTextContent(text: string, fontSize: number, color: [number, number, number]): string {
  const encoded = Buffer.from(text, "utf16le");
  return JSON.stringify({
    styles: [{
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
    }],
    text,
  });
}

export function addText(draft: Draft, filePath: string, opts: AddTextOptions): { segmentId: string; materialId: string; trackId: string } {
  const segId = uuid();
  const matId = uuid();
  const fontSize = opts.fontSize ?? 15;
  const color = opts.color ?? "#FFFFFF";
  const rgb = hexToRgb(color);
  const alignment = opts.alignment ?? 1;
  const trackName = opts.trackName ?? "text";

  // Find or create text track
  let track = draft.tracks.find(t => t.type === "text" && (t.name === trackName || !opts.trackName));
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
  path: string;         // absolute path to audio file
  start: number;        // microseconds
  duration: number;     // microseconds (0 = use file duration)
  volume?: number;      // 0.0-1.0, default 1.0
  trackName?: string;   // default "audio"
}

export function addAudio(draft: Draft, filePath: string, opts: AddAudioOptions): { segmentId: string; materialId: string; trackId: string } {
  const segId = uuid();
  const matId = uuid();
  const trackName = opts.trackName ?? "audio";
  const volume = opts.volume ?? 1.0;

  // Find or create audio track
  let track = draft.tracks.find(t => t.type === "audio" && t.name === trackName);
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
    path: opts.path,
    name: opts.path.split("/").pop() || "audio",
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
  path: string;         // absolute path to video/image file
  start: number;        // microseconds
  duration: number;     // microseconds
  type?: "video" | "photo";  // default: inferred from extension
  width?: number;       // default 1920
  height?: number;      // default 1080
  trackName?: string;   // default "video"
}

export function addVideo(draft: Draft, filePath: string, opts: AddVideoOptions): { segmentId: string; materialId: string; trackId: string } {
  const segId = uuid();
  const matId = uuid();
  const trackName = opts.trackName ?? "video";
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;

  // Infer type from extension if not provided
  const ext = opts.path.split(".").pop()?.toLowerCase() || "";
  const materialType = opts.type ?? (["jpg", "jpeg", "png", "webp", "bmp", "tiff"].includes(ext) ? "photo" : "video");

  // Find or create video track
  let track = draft.tracks.find(t => t.type === "video" && t.name === trackName);
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
    path: opts.path,
    material_name: opts.path.split("/").pop() || "media",
    type: materialType,
    duration: opts.duration,
    width,
    height,
    category_id: "",
    category_name: "local",
    check_flag: 7,
    crop: { lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1, upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0 },
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
    video_algorithm: { algorithms: [], deflicker: null, motion_blur_config: null, noise_reduction: null, path: "", quality_enhance: null, time_range: null },
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
  start: number;   // microseconds
  end: number;     // microseconds
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
  draft.tracks = draft.tracks.filter(t => t.segments.length > 0);

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
  type: string;            // track type: "text", "sticker", "video", "audio"
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
    } catch { /* keep original content */ }
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
  let track = draft.tracks.find(t => t.type === template.type);
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

function deepCloneWithIdRemap(
  obj: Record<string, unknown>,
  remapId: (old: string) => string,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  // Remap the id field
  if (typeof clone.id === "string") {
    clone.id = remapId(clone.id as string);
  }
  return clone;
}
