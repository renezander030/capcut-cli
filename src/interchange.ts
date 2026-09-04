import { basename } from "node:path";
import type { Draft, Segment } from "./draft.js";
import { extractText } from "./draft.js";
import { framesFor } from "./time.js";

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
 *   pointer to `export-srt` (OTIO has no standard title schema — the request
 *   has been open since 2017, OpenTimelineIO#62), UNLESS `captions: "markers"`
 *   is asked for: then every caption cue becomes a timeline marker on the
 *   Stack (name = cue text, marked_range = cue timing), which is what NLEs
 *   already round-trip — Resolve and Premiere import Stack markers as timeline
 *   markers — so the captions at least survive the handoff as positioned notes
 *   and `import-timeline` can rebuild the text track from them. Sticker /
 *   effect / filter tracks have no portable equivalent and are skipped.
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
  /** Caption cues written as timeline markers (`captions: "markers"`); 0 otherwise. */
  captions: number;
  skipped: OtioSkip[];
}

export interface OtioExportOptions {
  /** How text/caption tracks travel: dropped with a note (default) or as Stack markers. */
  captions?: "skip" | "markers";
}

/** The marker colour every caption marker carries — one colour, so an NLE user can filter them. */
export const CAPTION_MARKER_COLOR = "YELLOW";

/**
 * One caption cue as an OTIO Marker.1 (the 0.14-era schema, which every
 * reader still accepts and newer libraries upgrade on read). The cue text is
 * the marker name; it is repeated under metadata.capcut.text because some
 * NLEs shorten or rewrite marker names on import, and `import-timeline` needs
 * the exact text back. metadata.Resolve_OTIO.Note is DaVinci Resolve's own
 * marker-note field (it writes and reads it on its .otio round trips); harmless
 * elsewhere, it makes the cue text show in Resolve's marker panel too.
 */
function captionMarker(
  text: string,
  startFrames: number,
  durationFrames: number,
  rate: number,
  capcut: Record<string, unknown>,
): OtioObject {
  return {
    OTIO_SCHEMA: "Marker.1",
    color: CAPTION_MARKER_COLOR,
    marked_range: timeRange(startFrames, durationFrames, rate),
    metadata: {
      Resolve_OTIO: { Keywords: [], Note: text },
      capcut: { kind: "caption", text, ...capcut },
    },
    name: text,
  };
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

export interface ImportCaptionPlan {
  text: string;
  startUs: number;
  durationUs: number;
  /** Text track name recorded at export (falls back to "captions"). */
  track: string;
}

export interface ImportPlan {
  name: string;
  rate: number;
  tracks: ImportTrackPlan[];
  clips: number;
  gaps: number;
  /** Caption cues recovered from Stack markers that export-timeline --captions markers wrote. */
  captions: ImportCaptionPlan[];
  skipped: OtioSkip[];
}

/**
 * Timeline (Stack) markers: the ones export-timeline wrote for captions carry
 * metadata.capcut.kind === "caption" and come back as caption cues; any other
 * timeline marker (an editor's own notes) has no CapCut equivalent and is
 * reported once, with the count, like every other skip.
 */
function captionsFromStackMarkers(markers: unknown, rate: number, skipped: OtioSkip[]): ImportCaptionPlan[] {
  const captions: ImportCaptionPlan[] = [];
  if (!Array.isArray(markers)) return captions;
  let foreign = 0;
  for (const marker of markers) {
    const m = marker as OtioObject;
    const capcut = (m.metadata as { capcut?: Record<string, unknown> } | undefined)?.capcut;
    if (!capcut || capcut.kind !== "caption") {
      foreign++;
      continue;
    }
    const range = timeRangeUs(m.marked_range, rate, "caption marker marked_range");
    const text =
      typeof capcut.text === "string" && capcut.text ? capcut.text : typeof m.name === "string" ? m.name : "";
    if (!text) {
      skipped.push({ track: "(timeline)", type: "markers", reason: "a caption marker carries no text — skipped" });
      continue;
    }
    captions.push({
      text,
      startUs: range.startUs,
      durationUs: Math.max(1, range.durationUs),
      track: typeof capcut.track === "string" && capcut.track ? capcut.track : "captions",
    });
  }
  if (foreign > 0) {
    skipped.push({
      track: "(timeline)",
      type: "markers",
      reason: `${foreign} timeline marker(s) without capcut caption metadata have no CapCut equivalent`,
    });
  }
  return captions;
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
    captions: captionsFromStackMarkers((stack as OtioObject).markers, rate, skipped),
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

export function draftToOtio(draft: Draft, options: OtioExportOptions = {}): { doc: OtioObject; stats: OtioStats } {
  const rate = typeof draft.fps === "number" && draft.fps > 0 ? draft.fps : 30;
  const captionMode = options.captions ?? "skip";
  // Issue #82: this used to be a local `Math.round((us / 1e6) * rate)`, a second
  // frame grid alongside time.ts. It differed in two ways that both reached the
  // exported file: a clip shorter than half a frame rounded to a zero-length OTIO
  // clip (an NLE either drops it or refuses the timeline), and small negative
  // gaps rounded to -0, which serialises as `-0` in JSON. framesFor keeps a
  // positive duration at one frame and returns a plain 0 for the zero case.
  const toFrames = (us: number) => framesFor(us, rate);

  const children: OtioObject[] = [];
  const stackMarkers: OtioObject[] = [];
  const stats: OtioStats = { tracks: 0, clips: 0, gaps: 0, captions: 0, skipped: [] };

  for (const track of draft.tracks) {
    const kind = EXPORTABLE_TRACK_KINDS[track.type];
    if (!kind) {
      if (track.type === "text" && captionMode === "markers") {
        const segments = [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
        for (const segment of segments) {
          const material = (draft.materials.texts ?? []).find((m) => m.id === segment.material_id);
          const text = material && typeof material.content === "string" ? extractText(material.content) : "";
          if (!text) continue;
          stackMarkers.push(
            captionMarker(
              text,
              toFrames(segment.target_timerange.start),
              Math.max(1, toFrames(segment.target_timerange.duration)),
              rate,
              { track: track.name, track_id: track.id, segment_id: segment.id, material_id: segment.material_id },
            ),
          );
          stats.captions++;
        }
        continue;
      }
      stats.skipped.push({
        track: track.name,
        type: track.type,
        reason:
          track.type === "text"
            ? "OTIO has no standard title schema — pass --captions markers to carry cues as timeline markers, or export them with `capcut export-srt` and re-attach them in the NLE"
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
      markers: stackMarkers,
      metadata: {},
      name: "tracks",
      source_range: null,
    },
  };
  return { doc, stats };
}
