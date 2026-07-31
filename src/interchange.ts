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
