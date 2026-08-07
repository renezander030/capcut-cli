import { randomUUID as uuid } from "node:crypto";
import type { Draft, Segment } from "./draft.js";
import { makeTrack } from "./draft.js";
import { findEnum, type Namespace } from "./enums.js";

export interface AddSfxOptions {
  slug: string;
  start: number; // microseconds
  duration: number; // microseconds
  trackName?: string;
  namespace?: Namespace;
  volume?: number;
}

export function addSfx(
  draft: Draft,
  opts: AddSfxOptions,
): { segmentId: string; materialId: string; trackId: string; name: string; slug: string } {
  const ns: Namespace = opts.namespace ?? "capcut";
  const hit = findEnum("audio_effects", opts.slug, ns);
  if (!hit?.name || !hit.effect_id || !hit.resource_id) {
    const hint = ns === "jianying" ? " --jianying" : "";
    throw new Error(`Unknown SFX slug: ${opts.slug}. Run 'capcut enums --audio-effects${hint}' for the full list.`);
  }

  const segId = uuid();
  const matId = uuid();
  const trackName = opts.trackName ?? "sfx";

  let track = draft.tracks.find((t) => t.type === "audio" && t.name === trackName);
  if (!track) {
    track = makeTrack("audio", trackName, !opts.trackName);
    draft.tracks.push(track);
  }

  const sfxMaterial = {
    id: matId,
    name: hit.name,
    effect_id: hit.effect_id,
    resource_id: hit.resource_id,
    formula_id: "",
    is_vip: !!hit.is_vip,
    md5: hit.md5 ?? "",
    type: "sound_effect",
    category_id: "",
    category_name: "",
    path: "",
    platform: "all",
    source_platform: 0,
    version: "",
  };
  if (!Array.isArray(draft.materials.audio_effects)) draft.materials.audio_effects = [];
  (draft.materials.audio_effects as Array<Record<string, unknown>>).push(sfxMaterial);

  const seg: Segment = {
    id: segId,
    material_id: matId,
    target_timerange: { start: opts.start, duration: opts.duration },
    source_timerange: { start: 0, duration: opts.duration },
    speed: 1,
    volume: opts.volume ?? 1,
    visible: true,
    clip: null,
    extra_material_refs: [],
    render_index: 0,
  } as unknown as Segment;
  track.segments.push(seg);

  return { segmentId: segId, materialId: matId, trackId: track.id, name: hit.name, slug: opts.slug };
}
