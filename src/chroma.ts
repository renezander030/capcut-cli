import { randomUUID as uuid } from "node:crypto";
import type { Draft, Segment } from "./draft.js";
import { requireSegment } from "./segment-lookup.js";

export interface ChromaOptions {
  color: string; // hex like "#00FF00"
  intensity?: number; // 0-1, default 0.5 (CapCut's UI default)
  shadow?: number; // 0-1, default 0
}

export function setChroma(
  draft: Draft,
  segId: string,
  opts: ChromaOptions,
): { ok: true; segmentId: string; materialId: string; color: string; intensity: number; shadow: number } {
  const found = requireSegment(draft, segId);
  if (found.track.type !== "video") {
    throw new Error(
      `Chroma key can only be applied to video segments (segment ${segId} is on a ${found.track.type} track)`,
    );
  }
  const rgb = parseHex(opts.color);
  if (!rgb) throw new Error(`Invalid color: ${opts.color}. Expected #RRGGBB.`);

  const intensity = clamp01(opts.intensity ?? 0.5);
  const shadow = clamp01(opts.shadow ?? 0);

  const matId = uuid();
  const chromaMaterial = {
    id: matId,
    type: "chromas",
    color: opts.color,
    intensity,
    shadow,
    path: "",
  };
  if (!Array.isArray(draft.materials.chromas)) draft.materials.chromas = [];
  (draft.materials.chromas as Array<Record<string, unknown>>).push(chromaMaterial);

  const seg = found.segment as Segment & { extra_material_refs?: string[] };
  if (!Array.isArray(seg.extra_material_refs)) seg.extra_material_refs = [];
  seg.extra_material_refs.push(matId);

  return { ok: true, segmentId: seg.id, materialId: matId, color: opts.color, intensity, shadow };
}

export function removeChroma(draft: Draft, segId: string): { ok: true; segmentId: string; removed: string[] } {
  const found = requireSegment(draft, segId);
  const seg = found.segment as Segment & { extra_material_refs?: string[] };
  const removed: string[] = [];
  const chromas = (draft.materials.chromas as Array<{ id: string }> | undefined) ?? [];
  const chromaIds = new Set(chromas.map((c) => c.id));
  if (Array.isArray(seg.extra_material_refs)) {
    seg.extra_material_refs = seg.extra_material_refs.filter((ref) => {
      if (chromaIds.has(ref)) {
        removed.push(ref);
        return false;
      }
      return true;
    });
  }
  draft.materials.chromas = chromas.filter((c) => !removed.includes(c.id));
  return { ok: true, segmentId: seg.id, removed };
}

function parseHex(s: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
