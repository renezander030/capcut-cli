#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { loadDraft, saveDraft, extractText, updateTextContent, findSegment, findMaterial, findMaterialGlobal, getMaterialTypes, getTracksByType } from "./draft.js";
import { formatTime, formatDuration, parseTimeInput, srtTime } from "./time.js";
import type { Draft, Track, Segment } from "./draft.js";

const HELP = `capcut-cli -- fast edits to CapCut projects

Usage: capcut <command> <project> [options]

  <project> = path to draft_content.json, draft_info.json, or their parent directory

Global flags:
  -H, --human     Human-readable table output (default: JSON)
  -q, --quiet     No output on success, exit code only (write commands)

Overview (start here):
  info       <project>                          Project overview + material summary
  tracks     <project>                          List all tracks
  materials  <project>                          List all material types + counts
  materials  <project> --type <type>            List items of one material type

Browse:
  segments   <project> [--track <type>]         List segments with timing
  texts      <project>                          List all text/subtitle content

Detail (drill into one item):
  segment    <project> <id>                     Full detail for one segment + its material
  material   <project> <id>                     Full detail for one material

Edit:
  set-text   <project> <id> <text>              Change text content
  shift      <project> <id> <offset>            Shift segment timing (e.g. +0.5s, -1s)
  shift-all  <project> <offset> [--track <type>] Shift all segments on a track
  speed      <project> <id> <multiplier>        Set playback speed
  volume     <project> <id> <level>             Set volume (0.0-1.0)
  trim       <project> <id> <start> <duration>  Trim segment (times in seconds)
  opacity    <project> <id> <alpha>             Set opacity (0.0-1.0)
  export-srt <project>                          Export subtitles to SRT
  batch      <project>                          Run multiple edits from stdin (JSONL)

Navigation: info → tracks/materials → segments → segment <id>
            info → materials --type X → material <id>
Time formats: 1.5s, 500ms, 1:30, +0.5s, -200ms
IDs: first 6+ chars of segment/material ID (prefix match)`;

// --- Flag parsing ---

interface Flags {
  human: boolean;
  quiet: boolean;
  track?: string;
}

function parseFlags(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = { human: false, quiet: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-H" || a === "--human") flags.human = true;
    else if (a === "-q" || a === "--quiet") flags.quiet = true;
    else if ((a === "--track" || a === "--type") && i + 1 < args.length) { flags.track = args[++i]; }
    else positional.push(a);
  }
  return { positional, flags };
}

// --- Output ---

function out(data: unknown, flags: Flags): void {
  if (flags.quiet) return;
  process.stdout.write(JSON.stringify(data) + "\n");
}

function die(msg: string): never {
  process.stderr.write(JSON.stringify({ error: msg }) + "\n");
  process.exit(1);
  throw new Error("unreachable");
}

function requireArgs(args: string[], min: number, usage: string): void {
  if (args.length < min) die(`Missing arguments. Usage: ${usage}`);
}

// --- Commands ---

function cmdInfo(draft: Draft, flags: Flags): void {
  const totalSegments = draft.tracks.reduce((n, t) => n + t.segments.length, 0);
  const matTypes = getMaterialTypes(draft);
  const matWithItems = matTypes.filter(m => m.count > 0);
  const data = {
    id: draft.id,
    name: draft.name || draft.id,
    duration_us: draft.duration,
    fps: draft.fps,
    width: draft.canvas_config.width,
    height: draft.canvas_config.height,
    ratio: draft.canvas_config.ratio,
    tracks: draft.tracks.length,
    segments: totalSegments,
    platform: draft.platform ? `${draft.platform.app_source === "cc" ? "CapCut" : "JianYing"} ${draft.platform.app_version}` : null,
    material_types: matTypes.length,
    materials_with_items: matWithItems.length,
    material_summary: matWithItems.map(m => ({ type: m.type, count: m.count })),
  };
  if (flags.human) {
    const d = data;
    console.log(`Project:    ${d.name}`);
    console.log(`Duration:   ${formatDuration(d.duration_us)}`);
    console.log(`Resolution: ${d.width}x${d.height} (${d.ratio})`);
    console.log(`FPS:        ${d.fps}`);
    console.log(`Tracks:     ${d.tracks}`);
    console.log(`Segments:   ${d.segments}`);
    if (d.platform) console.log(`Platform:   ${d.platform}`);
    console.log(`Materials:  ${d.materials_with_items} types with data (${d.material_types} total)`);
    for (const m of d.material_summary) {
      console.log(`  ${m.type.padEnd(28)} ${m.count}`);
    }
  } else {
    out(data, flags);
  }
}

function cmdTracks(draft: Draft, flags: Flags): void {
  const data = draft.tracks.map((t, i) => {
    const end = t.segments.reduce((max, s) => {
      const e = s.target_timerange.start + s.target_timerange.duration;
      return e > max ? e : max;
    }, 0);
    return {
      index: i,
      id: t.id,
      type: t.type,
      name: t.name,
      segments: t.segments.length,
      duration_us: end,
      muted: !!(t.attribute & 1),
      hidden: !!(t.attribute & 2),
      locked: !!(t.attribute & 4),
    };
  });
  if (flags.human) {
    console.log(`#   Type     Name           Segs    Duration`);
    for (const t of data) {
      const fl: string[] = [];
      if (t.muted) fl.push("muted");
      if (t.hidden) fl.push("hidden");
      if (t.locked) fl.push("locked");
      console.log(`${String(t.index).padStart(2)}  ${t.type.padEnd(8)} ${t.name.padEnd(14)} ${String(t.segments).padStart(4)} segs  ${formatDuration(t.duration_us).padStart(10)}${fl.length ? "  [" + fl.join(",") + "]" : ""}`);
    }
  } else {
    out(data, flags);
  }
}

function segmentData(draft: Draft, track: Track, seg: Segment) {
  const t = seg.target_timerange;
  let label = "";
  if (track.type === "text") {
    const mat = findMaterial(draft.materials.texts, seg.material_id);
    if (mat) label = extractText(mat.content);
  } else if (track.type === "video") {
    const mat = findMaterial(draft.materials.videos, seg.material_id);
    if (mat) label = mat.material_name;
  } else if (track.type === "audio") {
    const mat = findMaterial(draft.materials.audios, seg.material_id);
    if (mat) label = mat.name || "";
  }
  return {
    id: seg.id,
    type: track.type,
    start_us: t.start,
    duration_us: t.duration,
    speed: seg.speed,
    volume: seg.volume,
    opacity: seg.clip?.alpha ?? 1,
    label,
  };
}

function cmdSegments(draft: Draft, flags: Flags): void {
  const tracks = flags.track ? getTracksByType(draft, flags.track) : draft.tracks;
  if (tracks.length === 0) die(`No tracks of type "${flags.track}"`);
  const data = tracks.flatMap(track => track.segments.map(seg => segmentData(draft, track, seg)));
  if (flags.human) {
    console.log(`ID        Type   Start   -End         Dur   Spd  Label`);
    for (const s of data) {
      const end = s.start_us + s.duration_us;
      console.log(`${s.id.slice(0, 8)}  ${s.type.padEnd(6)} ${formatTime(s.start_us).padStart(8)}-${formatTime(end).padStart(8)}  ${formatDuration(s.duration_us).padStart(8)}  ${s.speed !== 1 ? s.speed + "x" : "   "}  ${s.label.slice(0, 40)}`);
    }
  } else {
    out(data, flags);
  }
}

function cmdTexts(draft: Draft, flags: Flags): void {
  const textTracks = getTracksByType(draft, "text");
  const data = textTracks.flatMap(track =>
    track.segments.map(seg => {
      const mat = findMaterial(draft.materials.texts, seg.material_id);
      const t = seg.target_timerange;
      return {
        id: seg.id,
        start_us: t.start,
        duration_us: t.duration,
        text: mat ? extractText(mat.content) : "",
      };
    })
  );
  if (flags.human) {
    if (data.length === 0) { console.log("No text segments found."); return; }
    console.log(`ID        Start   -End       Text`);
    for (const s of data) {
      console.log(`${s.id.slice(0, 8)}  ${formatTime(s.start_us).padStart(8)}-${formatTime(s.start_us + s.duration_us).padStart(8)}  ${s.text}`);
    }
  } else {
    out(data, flags);
  }
}

function cmdSetText(draft: Draft, filePath: string, segId: string, newText: string, flags: Flags, save = true): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const mat = findMaterial(draft.materials.texts, result.segment.material_id);
  if (!mat) die(`Text material not found for segment ${segId}`);
  const oldText = extractText(mat.content);
  mat.content = updateTextContent(mat.content, newText);
  if (save) saveDraft(filePath, draft);
  out({ ok: true, id: result.segment.id, old: oldText, new: newText }, flags);
}

function cmdShift(draft: Draft, filePath: string, segId: string, offsetStr: string, flags: Flags, save = true): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const offset = parseTimeInput(offsetStr);
  const seg = result.segment;
  const oldStart = seg.target_timerange.start;
  seg.target_timerange.start = Math.max(0, oldStart + offset);
  if (save) saveDraft(filePath, draft);
  out({ ok: true, id: seg.id, old_start_us: oldStart, new_start_us: seg.target_timerange.start }, flags);
}

function cmdShiftAll(draft: Draft, filePath: string, offsetStr: string, flags: Flags, save = true): void {
  const offset = parseTimeInput(offsetStr);
  const tracks = flags.track ? getTracksByType(draft, flags.track) : draft.tracks;
  let count = 0;
  for (const track of tracks) {
    for (const seg of track.segments) {
      seg.target_timerange.start = Math.max(0, seg.target_timerange.start + offset);
      count++;
    }
  }
  if (save) saveDraft(filePath, draft);
  out({ ok: true, shifted: count, offset_us: offset }, flags);
}

function cmdSpeed(draft: Draft, filePath: string, segId: string, multiplier: string, flags: Flags, save = true): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const speed = parseFloat(multiplier);
  if (isNaN(speed) || speed <= 0) die("Speed must be a positive number");
  const seg = result.segment;
  const oldSpeed = seg.speed;
  seg.speed = speed;
  seg.source_timerange.duration = Math.round(seg.target_timerange.duration * speed);
  for (const refId of seg.extra_material_refs) {
    const speedMat = findMaterial(draft.materials.speeds, refId);
    if (speedMat) speedMat.speed = speed;
  }
  if (save) saveDraft(filePath, draft);
  out({ ok: true, id: seg.id, old_speed: oldSpeed, new_speed: speed }, flags);
}

function cmdVolume(draft: Draft, filePath: string, segId: string, levelStr: string, flags: Flags, save = true): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const level = parseFloat(levelStr);
  if (isNaN(level) || level < 0) die("Volume must be >= 0");
  const old = result.segment.volume;
  result.segment.volume = level;
  if (save) saveDraft(filePath, draft);
  out({ ok: true, id: result.segment.id, old_volume: old, new_volume: level }, flags);
}

function cmdTrim(draft: Draft, filePath: string, segId: string, startStr: string, durationStr: string, flags: Flags, save = true): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const start = parseTimeInput(startStr);
  const duration = parseTimeInput(durationStr);
  const seg = result.segment;
  seg.source_timerange.start = start;
  seg.source_timerange.duration = duration;
  seg.target_timerange.duration = Math.round(duration / seg.speed);
  if (save) saveDraft(filePath, draft);
  out({ ok: true, id: seg.id, source_start_us: start, source_duration_us: duration, target_duration_us: seg.target_timerange.duration }, flags);
}

function cmdOpacity(draft: Draft, filePath: string, segId: string, alphaStr: string, flags: Flags, save = true): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const alpha = parseFloat(alphaStr);
  if (isNaN(alpha) || alpha < 0 || alpha > 1) die("Opacity must be 0.0-1.0");
  if (!result.segment.clip) die(`Segment ${segId} has no clip (audio segment?)`);
  const old = result.segment.clip.alpha;
  result.segment.clip.alpha = alpha;
  if (save) saveDraft(filePath, draft);
  out({ ok: true, id: result.segment.id, old_opacity: old, new_opacity: alpha }, flags);
}

function cmdExportSrt(draft: Draft): void {
  const textTracks = getTracksByType(draft, "text");
  const entries: Array<{ start: number; end: number; text: string }> = [];
  for (const track of textTracks) {
    for (const seg of track.segments) {
      const mat = findMaterial(draft.materials.texts, seg.material_id);
      if (!mat) continue;
      const t = seg.target_timerange;
      entries.push({ start: t.start, end: t.start + t.duration, text: extractText(mat.content) });
    }
  }
  entries.sort((a, b) => a.start - b.start);
  const srt = entries.map((e, i) => `${i + 1}\n${srtTime(e.start)} --> ${srtTime(e.end)}\n${e.text}\n`).join("\n");
  process.stdout.write(srt);
}

// --- Discovery & drill-down ---

function cmdMaterials(draft: Draft, flags: Flags): void {
  const matTypes = getMaterialTypes(draft);
  if (flags.track) {
    // --type filter: list items of that material type
    const key = flags.track; // reuse --track flag as --type
    const arr = draft.materials[key];
    if (!arr || !Array.isArray(arr)) die(`Unknown material type: ${key}`);
    const items = arr.map((m: Record<string, unknown>) => {
      const summary: Record<string, unknown> = { id: m.id };
      if (m.name !== undefined) summary.name = m.name;
      if (m.material_name !== undefined) summary.name = m.material_name;
      if (m.path !== undefined) summary.path = m.path;
      if (m.duration !== undefined) summary.duration_us = m.duration;
      if (m.type !== undefined) summary.type = m.type;
      summary.fields = Object.keys(m).length;
      return summary;
    });
    if (flags.human) {
      if (items.length === 0) { console.log(`No ${key} materials.`); return; }
      console.log(`ID        Name/Path                                    Fields`);
      for (const item of items) {
        const label = (item.name || item.path || "") as string;
        console.log(`${(item.id as string).slice(0, 8)}  ${label.slice(0, 44).padEnd(44)} ${String(item.fields).padStart(3)}`);
      }
    } else {
      out(items, flags);
    }
    return;
  }
  if (flags.human) {
    console.log(`Type                          Count`);
    for (const m of matTypes) {
      console.log(`${m.type.padEnd(28)} ${String(m.count).padStart(5)}`);
    }
  } else {
    out(matTypes, flags);
  }
}

function cmdSegmentDetail(draft: Draft, segId: string, flags: Flags): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const seg = result.segment;
  // Resolve the primary material
  const mat = findMaterialGlobal(draft, seg.material_id);
  const detail = {
    ...seg,
    _track_type: result.track.type,
    _track_name: result.track.name,
    _track_id: result.track.id,
    _material: mat ? { _type: mat.type, ...mat.material } : null,
  };
  if (flags.human) {
    console.log(JSON.stringify(detail, null, 2));
  } else {
    out(detail, flags);
  }
}

function cmdMaterialDetail(draft: Draft, matId: string, flags: Flags): void {
  const result = findMaterialGlobal(draft, matId);
  if (!result) die(`Material not found: ${matId}`);
  const detail = { _type: result.type, ...result.material };
  if (flags.human) {
    console.log(JSON.stringify(detail, null, 2));
  } else {
    out(detail, flags);
  }
}

// --- Batch ---

interface BatchOp {
  cmd: string;
  id?: string;
  text?: string;
  offset?: string;
  speed?: number;
  volume?: number;
  opacity?: number;
  start?: string;
  duration?: string;
  track?: string;
}

function execBatchOp(draft: Draft, filePath: string, op: BatchOp, flags: Flags): void {
  const silent = { ...flags, quiet: true };
  switch (op.cmd) {
    case "set-text":
      if (!op.id || op.text === undefined) die(`batch set-text requires id and text`);
      cmdSetText(draft, filePath, op.id, op.text, silent, false);
      break;
    case "shift":
      if (!op.id || !op.offset) die(`batch shift requires id and offset`);
      cmdShift(draft, filePath, op.id, op.offset, silent, false);
      break;
    case "shift-all":
      if (!op.offset) die(`batch shift-all requires offset`);
      cmdShiftAll(draft, filePath, op.offset, { ...silent, track: op.track }, false);
      break;
    case "speed":
      if (!op.id || op.speed === undefined) die(`batch speed requires id and speed`);
      cmdSpeed(draft, filePath, op.id, String(op.speed), silent, false);
      break;
    case "volume":
      if (!op.id || op.volume === undefined) die(`batch volume requires id and volume`);
      cmdVolume(draft, filePath, op.id, String(op.volume), silent, false);
      break;
    case "opacity":
      if (!op.id || op.opacity === undefined) die(`batch opacity requires id and opacity`);
      cmdOpacity(draft, filePath, op.id, String(op.opacity), silent, false);
      break;
    case "trim":
      if (!op.id || !op.start || !op.duration) die(`batch trim requires id, start, duration`);
      cmdTrim(draft, filePath, op.id, op.start, op.duration, silent, false);
      break;
    default:
      die(`Unknown batch command: ${op.cmd}`);
  }
}

function cmdBatch(draft: Draft, filePath: string, flags: Flags): void {
  const input = readFileSync("/dev/stdin", "utf-8").trim();
  if (!input) die("No input on stdin");
  const lines = input.split("\n");
  let ok = 0;
  let fail = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const op = JSON.parse(trimmed) as BatchOp;
      execBatchOp(draft, filePath, op, flags);
      ok++;
    } catch (e) {
      fail++;
      process.stderr.write(JSON.stringify({ error: String(e), line: trimmed }) + "\n");
    }
  }
  saveDraft(filePath, draft);
  out({ ok: true, succeeded: ok, failed: fail }, flags);
}

// --- Main ---

function main(): void {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === "--help" || raw[0] === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const { positional, flags } = parseFlags(raw);
  const cmd = positional[0];
  const projectPath = positional[1];

  if (!projectPath) die("Missing project path. Run 'capcut --help' for usage.");

  const { draft, filePath } = loadDraft(projectPath);

  switch (cmd) {
    case "info":
      cmdInfo(draft, flags);
      break;
    case "tracks":
      cmdTracks(draft, flags);
      break;
    case "segments":
      cmdSegments(draft, flags);
      break;
    case "texts":
      cmdTexts(draft, flags);
      break;
    case "set-text":
      requireArgs(positional, 4, "capcut set-text <project> <id> <text>");
      cmdSetText(draft, filePath, positional[2], positional.slice(3).join(" "), flags);
      break;
    case "shift":
      requireArgs(positional, 4, "capcut shift <project> <id> <offset>");
      cmdShift(draft, filePath, positional[2], positional[3], flags);
      break;
    case "shift-all":
      requireArgs(positional, 3, "capcut shift-all <project> <offset> [--track <type>]");
      cmdShiftAll(draft, filePath, positional[2], flags);
      break;
    case "speed":
      requireArgs(positional, 4, "capcut speed <project> <id> <multiplier>");
      cmdSpeed(draft, filePath, positional[2], positional[3], flags);
      break;
    case "volume":
      requireArgs(positional, 4, "capcut volume <project> <id> <level>");
      cmdVolume(draft, filePath, positional[2], positional[3], flags);
      break;
    case "trim":
      requireArgs(positional, 5, "capcut trim <project> <id> <start> <duration>");
      cmdTrim(draft, filePath, positional[2], positional[3], positional[4], flags);
      break;
    case "opacity":
      requireArgs(positional, 4, "capcut opacity <project> <id> <alpha>");
      cmdOpacity(draft, filePath, positional[2], positional[3], flags);
      break;
    case "export-srt":
      cmdExportSrt(draft);
      break;
    case "materials":
      cmdMaterials(draft, flags);
      break;
    case "segment":
      requireArgs(positional, 3, "capcut segment <project> <id>");
      cmdSegmentDetail(draft, positional[2], flags);
      break;
    case "material":
      requireArgs(positional, 3, "capcut material <project> <id>");
      cmdMaterialDetail(draft, positional[2], flags);
      break;
    case "batch":
      cmdBatch(draft, filePath, flags);
      break;
    default:
      die(`Unknown command: ${cmd}. Run 'capcut --help' for usage.`);
  }
}

try {
  main();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(JSON.stringify({ error: msg }) + "\n");
  process.exit(1);
}
