import { randomUUID } from "node:crypto";
import type { Draft, Segment, Track, Timerange } from "./draft.js";

// --- UUID generation ---

export function uuid(): string {
  return randomUUID();
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
