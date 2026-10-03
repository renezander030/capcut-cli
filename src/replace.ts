// `replace-media` — swap the source file behind a timeline segment while keeping
// its position, timing, effects, and keyframes. This is the canonical
// agent/placeholder workflow: assemble a draft with proxy or placeholder clips,
// then swap in the final renders without rebuilding the edit. Distinct from
// `relink`, which only *repairs broken paths* by basename — this deliberately
// points a chosen segment at a different file and refreshes its intrinsic
// metadata (duration, dimensions). Pure JSON + file copy, like `add-video`.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { type Draft, findMaterialGlobal, findSegment } from "./draft.js";
import { probeMedia } from "./probe.js";
import { draftProjectDir } from "./store.js";

export interface ReplaceMediaOptions {
  segmentId: string;
  newPath: string;
  ffprobeCmd?: string;
  // Fit the segment's source in/out to the new clip (start at 0, use its full
  // duration) instead of preserving the original in/out. Off by default so the
  // edit is preserved exactly.
  retime?: boolean;
  // Preview only: probe + compute the result but do not copy the new file in.
  dryRun?: boolean;
}

export interface ReplaceMediaResult {
  ok: boolean;
  segment_id: string;
  material_id: string;
  material_type: string;
  old_path: string;
  new_path: string;
  shared_with_segments: number;
  old_duration_us: number | null;
  new_duration_us: number | null;
  source_used_us: number;
  retimed: boolean;
  warning?: string;
}

function assetKind(materialType: string): "audio" | "video" {
  return materialType === "audios" ? "audio" : "video";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Point a segment's material at a new source file, copy that file into the
 * draft's assets directory, and refresh the material's intrinsic metadata.
 * Preserves the segment's target/source timeranges by default.
 */
export function replaceMedia(draft: Draft, filePath: string, opts: ReplaceMediaOptions): ReplaceMediaResult {
  if (!existsSync(opts.newPath)) throw new Error(`Replacement file not found: ${opts.newPath}`);

  const hit = findSegment(draft, opts.segmentId);
  if (!hit) throw new Error(`Segment not found: ${opts.segmentId}`);
  const materialId = hit.segment.material_id;
  if (!materialId) throw new Error(`Segment ${opts.segmentId} has no material_id to replace.`);

  const found = findMaterialGlobal(draft, materialId);
  if (!found) throw new Error(`Material ${materialId} for segment ${opts.segmentId} not found.`);
  const { type, material } = found;

  const oldPath = typeof material.path === "string" ? material.path : "";
  const oldDuration = num(material.duration);

  // Copy the replacement into the draft's assets dir, mirroring addVideo/addAudio.
  const kind = assetKind(type);
  const draftDir = draftProjectDir(filePath);
  const filename = basename(opts.newPath) || (kind === "audio" ? "audio" : "media");
  const assetsDir = resolve(draftDir, "assets", kind);
  mkdirSync(assetsDir, { recursive: true });
  const destPath = resolve(assetsDir, filename);
  if (!opts.dryRun && resolve(opts.newPath) !== destPath && !existsSync(destPath)) {
    copyFileSync(opts.newPath, destPath);
  }

  const probe = probeMedia(opts.newPath, opts.ffprobeCmd ?? "ffprobe");
  const newDuration = probe?.durationUs && probe.durationUs > 0 ? probe.durationUs : null;

  // Update the source pointer and the name field this material type uses.
  material.path = destPath;
  if ("material_name" in material) material.material_name = filename;
  if ("name" in material) material.name = filename;
  // Intrinsic metadata — only overwrite when we actually probed a value.
  if (newDuration !== null) material.duration = newDuration;
  if (kind === "video" && probe?.width && probe.height) {
    if ("width" in material) material.width = probe.width;
    if ("height" in material) material.height = probe.height;
  }

  // How much of the source this segment plays (in/out within the clip).
  const source = hit.segment.source_timerange;
  const sourceUsed = (source?.start ?? 0) + (source?.duration ?? 0);

  let retimed = false;
  let warning: string | undefined;
  if (opts.retime && newDuration !== null && source) {
    source.start = 0;
    source.duration = newDuration;
    retimed = true;
  } else if (newDuration !== null && newDuration < sourceUsed) {
    warning =
      `New clip is ${(newDuration / 1_000_000).toFixed(2)}s but the segment uses up to ` +
      `${(sourceUsed / 1_000_000).toFixed(2)}s of source — CapCut may show a freeze/black tail. ` +
      `Re-run with --retime to fit the segment to the new clip.`;
  }

  // Other segments that share this same material (the swap affects all of them).
  let shared = 0;
  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      if (seg.material_id === materialId && seg.id !== hit.segment.id) shared++;
    }
  }

  return {
    ok: true,
    segment_id: hit.segment.id,
    material_id: materialId,
    material_type: type,
    old_path: oldPath,
    new_path: destPath,
    shared_with_segments: shared,
    old_duration_us: oldDuration,
    new_duration_us: newDuration,
    source_used_us: sourceUsed,
    retimed,
    warning,
  };
}
