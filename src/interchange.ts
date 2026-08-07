import { basename } from "node:path";
import type { Draft, Segment } from "./draft.js";

/**
 * OpenTimelineIO export (`export-timeline`).
 *
 * The exit ramp for the version-compat dead ends: when an app build rejects a
 * draft (encrypted era, beyond-evidence version), the cut itself — clip
 * order, trims, speeds — should not be lost with it. This module flattens a
 * draft's video/audio tracks into an OTIO 0.14-era JSON document (Timeline.1
 * / Stack.1 / Track.1 / Clip.1 — the stable schema set every OTIO reader,
 * including DaVinci Resolve's native .otio import, still accepts; newer
 * libraries up-convert on read).
 *
 * Deliberate scope:
 * - Video and audio tracks only. Text/caption tracks are skipped with a
 *   pointer to `export-srt` (OTIO has no standard title schema); sticker /
 *   effect / filter tracks have no portable equivalent and are skipped too.
 *   Every skip is reported, never silent.
 * - `speed` maps to a LinearTimeWarp effect (time_scalar = speed), matching
 *   OTIO semantics: timeline duration = source_range.duration / time_scalar,
 *   which is exactly CapCut's source/target timerange relationship.
 * - Times are converted from CapCut microseconds to frames at the draft fps
 *   (default 30); media is assumed to share the timeline rate — the draft
 *   does not store per-file rates, and readers re-probe the media anyway.
 * - CapCut-only facts (segment/material ids, volume) ride along under
 *   metadata.capcut so a round-trip stays debuggable.
 *
 * Pure and deterministic: same draft in, byte-identical document out.
 */

interface OtioObject {
  [key: string]: unknown;
}

export interface OtioSkip {
  track: string;
  type: string;
  reason: string;
}

export interface OtioStats {
  tracks: number;
  clips: number;
  gaps: number;
  skipped: OtioSkip[];
}

function rationalTime(value: number, rate: number): OtioObject {
  return { OTIO_SCHEMA: "RationalTime.1", rate, value };
}

function timeRange(startFrames: number, durationFrames: number, rate: number): OtioObject {
  return {
    OTIO_SCHEMA: "TimeRange.1",
    duration: rationalTime(durationFrames, rate),
    start_time: rationalTime(startFrames, rate),
  };
}

function gap(durationFrames: number, rate: number): OtioObject {
  return {
    OTIO_SCHEMA: "Gap.1",
    effects: [],
    markers: [],
    metadata: {},
    name: "",
    source_range: timeRange(0, durationFrames, rate),
  };
}

const EXPORTABLE_TRACK_KINDS: Record<string, "Video" | "Audio"> = { video: "Video", audio: "Audio" };

function mediaForSegment(draft: Draft, segment: Segment): { path: string; name: string; durationUs: number } | null {
  for (const kind of ["videos", "audios"] as const) {
    for (const mat of draft.materials[kind] ?? []) {
      const m = mat as { id?: string; path?: string; material_name?: string; name?: string; duration?: number };
      if (m.id !== segment.material_id) continue;
      const path = typeof m.path === "string" ? m.path : "";
      return {
        path,
        name: m.material_name ?? m.name ?? (path ? basename(path) : segment.material_id),
        durationUs: typeof m.duration === "number" && Number.isFinite(m.duration) ? m.duration : 0,
      };
    }
  }
  return null;
}

function clipForSegment(draft: Draft, segment: Segment, rate: number, toFrames: (us: number) => number): OtioObject {
  const media = mediaForSegment(draft, segment);
  const speed = typeof segment.speed === "number" && segment.speed > 0 ? segment.speed : 1;
  const effects: OtioObject[] = [];
  if (speed !== 1) {
    effects.push({
      OTIO_SCHEMA: "LinearTimeWarp.1",
      effect_name: "LinearTimeWarp",
      metadata: {},
      name: "speed",
      time_scalar: speed,
    });
  }
  const mediaReference: OtioObject = media?.path
    ? {
        OTIO_SCHEMA: "ExternalReference.1",
        available_range: media.durationUs > 0 ? timeRange(0, toFrames(media.durationUs), rate) : null,
        metadata: {},
        name: media.name,
        target_url: media.path,
      }
    : { OTIO_SCHEMA: "MissingReference.1", metadata: {}, name: media?.name ?? segment.material_id };
  return {
    OTIO_SCHEMA: "Clip.1",
    effects,
    markers: [],
    media_reference: mediaReference,
    metadata: {
      capcut: {
        material_id: segment.material_id,
        segment_id: segment.id,
        speed,
        volume: segment.volume,
      },
    },
    name: media?.name ?? segment.material_id,
    source_range: timeRange(
      toFrames(segment.source_timerange.start),
      toFrames(segment.source_timerange.duration),
      rate,
    ),
  };
}

/**
 * OpenTimelineIO import (`import-timeline`) — the inverse of `draftToOtio`.
 *
 * Reads the exact schema set the exporter emits (Timeline.1 / Stack.1 /
 * Track.1 / Clip.1 / Gap.1, ExternalReference / MissingReference,
 * LinearTimeWarp) into a flat plan the command applies through the same
 * factory functions `add-video` / `add-audio` use. Everything the CLI cannot
 * represent — unknown track kinds, transitions, nested stacks, other effects,
 * generator references, markers, a non-zero global start — is REPORTED in
 * `skipped`, never silently dropped (the export-timeline house rule).
 *
 * Speed inverts the exporter's documented LinearTimeWarp relationship
 * (timeline duration = source_range.duration / time_scalar): speed =
 * time_scalar, and the clip's timeline duration is recomputed from its source
 * duration. Times convert from frames back to CapCut microseconds at each
 * RationalTime's own rate (falling back to the timeline rate).
 */

export interface ImportClipPlan {
  name: string;
  targetStartUs: number;
  targetDurationUs: number;
  sourceStartUs: number;
  sourceDurationUs: number;
  speed: number;
  volume: number | null;
  /** ExternalReference target_url; null = MissingReference (or an unsupported reference, reported). */
  mediaPath: string | null;
  /** ExternalReference available_range duration (0 = unknown). */
  mediaDurationUs: number;
}

export interface ImportTrackPlan {
  kind: "video" | "audio";
  name: string;
  clips: ImportClipPlan[];
}

export interface ImportPlan {
  name: string;
  rate: number;
  tracks: ImportTrackPlan[];
  clips: number;
  gaps: number;
  skipped: OtioSkip[];
}

function schemaOf(node: unknown): string {
  if (node && typeof node === "object" && typeof (node as OtioObject).OTIO_SCHEMA === "string") {
    return (node as { OTIO_SCHEMA: string }).OTIO_SCHEMA;
  }
  return "";
}

function usFromRationalTime(rt: unknown, fallbackRate: number, where: string): number {
  if (schemaOf(rt) !== "RationalTime.1") {
    throw new Error(`import-timeline: ${where} is not a RationalTime.1`);
  }
  const { rate, value } = rt as { rate?: unknown; value?: unknown };
  const effectiveRate = typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : fallbackRate;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`import-timeline: ${where} has no numeric value`);
  }
  return Math.round((value / effectiveRate) * 1_000_000);
}

function timeRangeUs(range: unknown, fallbackRate: number, where: string): { startUs: number; durationUs: number } {
  if (schemaOf(range) !== "TimeRange.1") {
    throw new Error(`import-timeline: ${where} is not a TimeRange.1`);
  }
  const r = range as { start_time?: unknown; duration?: unknown };
  return {
    startUs: usFromRationalTime(r.start_time, fallbackRate, `${where}.start_time`),
    durationUs: usFromRationalTime(r.duration, fallbackRate, `${where}.duration`),
  };
}

const IMPORTABLE_TRACK_KINDS: Record<string, "video" | "audio"> = { Video: "video", Audio: "audio" };

function clipPlan(node: OtioObject, rate: number, trackLabel: string, skipped: OtioSkip[]): ImportClipPlan | null {
  const meta = (node.metadata as { capcut?: Record<string, unknown> } | undefined)?.capcut;
  const fallbackName = typeof node.name === "string" && node.name ? node.name : "clip";

  if (node.source_range === null || node.source_range === undefined) {
    skipped.push({ track: trackLabel, type: "Clip.1", reason: `clip "${fallbackName}" has no source_range — skipped` });
    return null;
  }
  const source = timeRangeUs(node.source_range, rate, `clip "${fallbackName}" source_range`);

  // Speed: invert the exporter's LinearTimeWarp contract (time_scalar = speed;
  // timeline duration = source duration / time_scalar). Only the first valid
  // LinearTimeWarp counts; everything else on the effects list is reported.
  let speed = 1;
  let sawTimeWarp = false;
  for (const effect of Array.isArray(node.effects) ? node.effects : []) {
    const schema = schemaOf(effect);
    const scalar = (effect as { time_scalar?: unknown }).time_scalar;
    if (schema === "LinearTimeWarp.1" && !sawTimeWarp && typeof scalar === "number" && scalar > 0) {
      speed = scalar;
      sawTimeWarp = true;
    } else {
      skipped.push({
        track: trackLabel,
        type: schema || "effect",
        reason: `unsupported effect on clip "${fallbackName}" — only one LinearTimeWarp with a positive time_scalar maps to speed`,
      });
    }
  }

  let mediaPath: string | null = null;
  let mediaName = "";
  let mediaDurationUs = 0;
  const ref = node.media_reference;
  const refSchema = schemaOf(ref);
  if (refSchema === "ExternalReference.1") {
    const r = ref as { target_url?: unknown; name?: unknown; available_range?: unknown };
    mediaPath = typeof r.target_url === "string" && r.target_url ? r.target_url : null;
    mediaName = typeof r.name === "string" ? r.name : "";
    if (r.available_range !== null && r.available_range !== undefined) {
      mediaDurationUs = timeRangeUs(r.available_range, rate, `clip "${fallbackName}" available_range`).durationUs;
    }
  } else if (refSchema === "MissingReference.1") {
    mediaName = typeof (ref as { name?: unknown }).name === "string" ? (ref as { name: string }).name : "";
  } else {
    skipped.push({
      track: trackLabel,
      type: refSchema || "media_reference",
      reason: `unsupported media reference on clip "${fallbackName}" — imported as a placeholder for replace-media`,
    });
  }

  if (Array.isArray(node.markers) && node.markers.length > 0) {
    skipped.push({
      track: trackLabel,
      type: "markers",
      reason: `markers on clip "${fallbackName}" have no CapCut equivalent`,
    });
  }

  const metaVolume = meta && typeof meta.volume === "number" && Number.isFinite(meta.volume) ? meta.volume : null;
  return {
    name: (typeof node.name === "string" && node.name) || mediaName || "clip",
    targetStartUs: 0, // stamped by the track walk
    targetDurationUs: Math.round(source.durationUs / speed),
    sourceStartUs: source.startUs,
    sourceDurationUs: source.durationUs,
    speed,
    volume: metaVolume,
    mediaPath,
    mediaDurationUs,
  };
}

export function otioToImportPlan(doc: unknown): ImportPlan {
  if (schemaOf(doc) !== "Timeline.1") {
    throw new Error(
      `import-timeline: not an OpenTimelineIO Timeline.1 document (OTIO_SCHEMA: ${schemaOf(doc) || "missing"})`,
    );
  }
  const timeline = doc as OtioObject;
  const skipped: OtioSkip[] = [];

  const globalStart = timeline.global_start_time as { rate?: unknown; value?: unknown } | null | undefined;
  const rate =
    globalStart && typeof globalStart.rate === "number" && Number.isFinite(globalStart.rate) && globalStart.rate > 0
      ? globalStart.rate
      : 30;
  if (globalStart && typeof globalStart.value === "number" && globalStart.value !== 0) {
    skipped.push({
      track: "(timeline)",
      type: "global_start_time",
      reason: "non-zero timeline start is ignored — CapCut drafts start at 0",
    });
  }

  const stack = timeline.tracks;
  if (schemaOf(stack) !== "Stack.1" || !Array.isArray((stack as OtioObject).children)) {
    throw new Error("import-timeline: timeline has no Stack.1 tracks container");
  }

  const plan: ImportPlan = {
    name: typeof timeline.name === "string" ? timeline.name : "",
    rate,
    tracks: [],
    clips: 0,
    gaps: 0,
    skipped,
  };

  for (const child of (stack as { children: unknown[] }).children) {
    const schema = schemaOf(child);
    const track = child as OtioObject;
    const label = typeof track.name === "string" && track.name ? track.name : schema || "(unnamed)";
    if (schema !== "Track.1") {
      skipped.push({
        track: label,
        type: schema || "unknown",
        reason: "unsupported stack child — only Track.1 imports",
      });
      continue;
    }
    const kind = IMPORTABLE_TRACK_KINDS[String(track.kind)];
    if (!kind) {
      skipped.push({
        track: label,
        type: String(track.kind ?? "unknown"),
        reason: "unsupported track kind — only Video and Audio tracks import",
      });
      continue;
    }
    if (Array.isArray(track.effects) && track.effects.length > 0) {
      skipped.push({ track: label, type: "effects", reason: "track-level effects have no CapCut equivalent" });
    }
    if (Array.isArray(track.markers) && track.markers.length > 0) {
      skipped.push({ track: label, type: "markers", reason: "track-level markers have no CapCut equivalent" });
    }

    const clips: ImportClipPlan[] = [];
    let cursorUs = 0;
    for (const item of Array.isArray(track.children) ? (track.children as unknown[]) : []) {
      const itemSchema = schemaOf(item);
      if (itemSchema === "Gap.1") {
        cursorUs += timeRangeUs((item as OtioObject).source_range, rate, `gap in track "${label}"`).durationUs;
        plan.gaps++;
        continue;
      }
      if (itemSchema !== "Clip.1") {
        skipped.push({
          track: label,
          type: itemSchema || "unknown",
          reason:
            "unsupported timeline item — only Clip.1 and Gap.1 import (transitions overlap, they consume no time)",
        });
        continue;
      }
      const clip = clipPlan(item as OtioObject, rate, label, skipped);
      if (!clip) continue;
      clip.targetStartUs = cursorUs;
      cursorUs += clip.targetDurationUs;
      clips.push(clip);
      plan.clips++;
    }
    plan.tracks.push({ kind, name: typeof track.name === "string" ? track.name : "", clips });
  }

  return plan;
}

export function draftToOtio(draft: Draft): { doc: OtioObject; stats: OtioStats } {
  const rate = typeof draft.fps === "number" && draft.fps > 0 ? draft.fps : 30;
  const toFrames = (us: number) => Math.round((us / 1_000_000) * rate);

  const children: OtioObject[] = [];
  const stats: OtioStats = { tracks: 0, clips: 0, gaps: 0, skipped: [] };

  for (const track of draft.tracks) {
    const kind = EXPORTABLE_TRACK_KINDS[track.type];
    if (!kind) {
      stats.skipped.push({
        track: track.name,
        type: track.type,
        reason:
          track.type === "text"
            ? "OTIO has no standard title schema — export captions with `capcut export-srt` and re-attach them in the NLE"
            : "no portable OTIO equivalent for this track type",
      });
      continue;
    }
    if (track.segments.length === 0) continue;

    const segments = [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    const items: OtioObject[] = [];
    let cursorUs = 0;
    for (const segment of segments) {
      const gapUs = segment.target_timerange.start - cursorUs;
      const gapFrames = toFrames(gapUs);
      if (gapFrames > 0) {
        items.push(gap(gapFrames, rate));
        stats.gaps++;
      }
      items.push(clipForSegment(draft, segment, rate, toFrames));
      stats.clips++;
      cursorUs = segment.target_timerange.start + segment.target_timerange.duration;
    }

    children.push({
      OTIO_SCHEMA: "Track.1",
      children: items,
      effects: [],
      kind,
      markers: [],
      metadata: { capcut: { track_id: track.id } },
      name: track.name,
      source_range: null,
    });
    stats.tracks++;
  }

  const doc: OtioObject = {
    OTIO_SCHEMA: "Timeline.1",
    global_start_time: rationalTime(0, rate),
    metadata: {
      capcut: {
        draft_id: draft.id,
        duration_us: draft.duration,
        exported_by: "capcut-cli export-timeline",
      },
    },
    name: draft.name || "capcut draft",
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      children,
      effects: [],
      markers: [],
      metadata: {},
      name: "tracks",
      source_range: null,
    },
  };
  return { doc, stats };
}
