// Smart matting — "Remove background" in CapCut, 智能抠像 in JianYing — is a
// property of the VIDEO MATERIAL, not the segment: `materials.videos[].matting`.
//
// Ground truth, and its provenance:
// - The OFF shape is the object every app-authored video material carries
//   (docs/draft-schema/02-materials.md): `{ flag: 0, has_use_quick_brush: false,
//   interactiveTime: [], path: "", strokes: [] }`. CLI-created materials
//   (add-video, compile) have never written the key at all — the app tolerates
//   both, so `matting --off` writes the documented object rather than deleting.
// - The ON shape comes from the pyJianYingDraft contributor PRs #183/#184
//   (KyonXuu, 2026-05): `flag: 3` is "smart portrait matting"; `path` is the
//   app's matting cache and `strokes`/`interactiveTime` are the manual
//   brush/eraser corrections, all of which the app fills in itself on first
//   open. A fresh request therefore writes flag 3 and leaves every cache field
//   at its empty default — exactly the PR's `add_smart_matting()` default. Newer
//   builds also carry `has_use_quick_eraser`; it is written alongside the brush
//   flag so the object matches what those builds emit.
//
// Neither PR merged and no app-authored flag-3 fixture is committed here, so
// this is an evidence-gated write in the same sense as the rest of the schema
// docs: the shape is recorded with its source, and `fixture` will capture the
// real thing the moment a matted app draft is shared.

import type { Draft, MaterialVideo, Segment } from "./draft.js";
import { findSegment } from "./draft.js";

export const MATTING_OFF = 0;
export const MATTING_SMART_PORTRAIT = 3;

export interface MattingObject {
  flag: number;
  has_use_quick_brush: boolean;
  has_use_quick_eraser: boolean;
  interactiveTime: unknown[];
  path: string;
  strokes: unknown[];
  [key: string]: unknown;
}

export interface MattingResult {
  ok: true;
  segmentId: string;
  materialId: string;
  flag: number;
  enabled: boolean;
  /** Other segments that reference the same material — matting is per material, so they change too. */
  shared_segments: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The matting object with `flag` set. Existing cache fields (the app's `path`,
 * brush strokes) are preserved so toggling never destroys app-authored state;
 * missing fields are filled from the documented off-shape defaults.
 */
export function mattingObject(flag: number, existing?: unknown): MattingObject {
  const current = isRecord(existing) ? existing : {};
  return {
    has_use_quick_brush: false,
    has_use_quick_eraser: false,
    interactiveTime: [],
    path: "",
    strokes: [],
    ...current,
    flag,
  };
}

function resolveVideoMaterial(
  draft: Draft,
  segId: string,
): { segment: Segment; material: MaterialVideo; shared: string[] } {
  const found = findSegment(draft, segId);
  if (!found) throw new Error(`Segment not found: ${segId}`);
  if (found.track.type !== "video") {
    throw new Error(
      `Smart matting only applies to video/photo segments (segment ${segId} is on a ${found.track.type} track)`,
    );
  }
  const material = (draft.materials.videos ?? []).find((m) => m.id === found.segment.material_id);
  if (!material) throw new Error(`Segment ${segId} references a missing video material: ${found.segment.material_id}`);
  const shared: string[] = [];
  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      if (seg.id !== found.segment.id && seg.material_id === material.id) shared.push(seg.id);
    }
  }
  return { segment: found.segment, material, shared };
}

/** Turn smart portrait matting on for the segment's video material. */
export function setMatting(draft: Draft, segId: string): MattingResult {
  const { segment, material, shared } = resolveVideoMaterial(draft, segId);
  material.matting = mattingObject(MATTING_SMART_PORTRAIT, material.matting);
  return {
    ok: true,
    segmentId: segment.id,
    materialId: material.id,
    flag: MATTING_SMART_PORTRAIT,
    enabled: true,
    shared_segments: shared,
  };
}

/** Turn matting off, writing the documented flag-0 object (cache fields kept). */
export function clearMatting(draft: Draft, segId: string): MattingResult {
  const { segment, material, shared } = resolveVideoMaterial(draft, segId);
  material.matting = mattingObject(MATTING_OFF, material.matting);
  return {
    ok: true,
    segmentId: segment.id,
    materialId: material.id,
    flag: MATTING_OFF,
    enabled: false,
    shared_segments: shared,
  };
}

/** Read the matting state of a segment's material without writing. */
export function mattingState(draft: Draft, segId: string): { segmentId: string; materialId: string; flag: number } {
  const { segment, material } = resolveVideoMaterial(draft, segId);
  const flag = isRecord(material.matting) && typeof material.matting.flag === "number" ? material.matting.flag : 0;
  return { segmentId: segment.id, materialId: material.id, flag };
}
