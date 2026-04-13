#!/usr/bin/env node

import { loadDraft, saveDraft, extractText, updateTextContent, findSegment, findMaterial, getTracksByType } from "./draft.js";
import { formatTime, formatDuration, parseTimeInput, srtTime, usToSeconds, secondsToUs } from "./time.js";
import type { Draft, Track, Segment, MaterialText } from "./draft.js";

const HELP = `capcut-cli -- fast edits to CapCut projects

Usage: capcut <command> <project> [options]

  <project> = path to draft_content.json, draft_info.json, or their parent directory

Commands:
  info       <project>                          Project overview
  tracks     <project>                          List all tracks
  segments   <project> [--track <type>]         List segments with timing
  texts      <project>                          List all text/subtitle content
  set-text   <project> <id> <text>              Change text content
  shift      <project> <id> <offset>            Shift segment timing (e.g. +0.5s, -1s)
  shift-all  <project> <offset> [--track <type>] Shift all segments on a track
  speed      <project> <id> <multiplier>        Set playback speed
  volume     <project> <id> <level>             Set volume (0.0-1.0)
  trim       <project> <id> <start> <duration>  Trim segment (times in seconds)
  opacity    <project> <id> <alpha>             Set opacity (0.0-1.0)
  export-srt <project>                          Export subtitles to SRT

Time formats: 1.5s, 500ms, 1:30, +0.5s, -200ms
IDs: first 6+ chars of segment ID (prefix match)

Examples:
  capcut info ./my-project/
  capcut texts ./draft_content.json
  capcut set-text ./project a1b2c3 "New subtitle"
  capcut shift ./project a1b2c3 +0.5s
  capcut speed ./project a1b2c3 1.5
  capcut export-srt ./project > subs.srt`;

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
  throw new Error("unreachable");
}

function requireArgs(args: string[], min: number, usage: string): void {
  if (args.length < min) die(`Missing arguments.\nUsage: ${usage}`);
}

// --- Commands ---

function cmdInfo(draft: Draft): void {
  const { canvas_config: c } = draft;
  const textTracks = getTracksByType(draft, "text");
  const videoTracks = getTracksByType(draft, "video");
  const audioTracks = getTracksByType(draft, "audio");
  const totalSegments = draft.tracks.reduce((n, t) => n + t.segments.length, 0);

  console.log(`Project:    ${draft.name || draft.id}`);
  console.log(`Duration:   ${formatDuration(draft.duration)}`);
  console.log(`Resolution: ${c.width}x${c.height} (${c.ratio})`);
  console.log(`FPS:        ${draft.fps}`);
  console.log(`Tracks:     ${draft.tracks.length} (${videoTracks.length} video, ${audioTracks.length} audio, ${textTracks.length} text)`);
  console.log(`Segments:   ${totalSegments}`);
  console.log(`Materials:  ${draft.materials.videos.length} video, ${draft.materials.audios.length} audio, ${draft.materials.texts.length} text`);
  if (draft.platform) {
    console.log(`Platform:   ${draft.platform.app_source === "cc" ? "CapCut" : "JianYing"} ${draft.platform.app_version} (${draft.platform.os})`);
  }
}

function cmdTracks(draft: Draft): void {
  const rows = draft.tracks.map((t, i) => {
    const segCount = t.segments.length;
    const dur = t.segments.reduce((max, s) => {
      const end = s.target_timerange.start + s.target_timerange.duration;
      return end > max ? end : max;
    }, 0);
    const flags: string[] = [];
    if (t.attribute & 1) flags.push("muted");
    if (t.attribute & 2) flags.push("hidden");
    if (t.attribute & 4) flags.push("locked");
    return `${String(i).padStart(2)}  ${t.type.padEnd(8)} ${t.name.padEnd(14)} ${String(segCount).padStart(4)} segs  ${formatDuration(dur).padStart(10)}${flags.length ? "  [" + flags.join(",") + "]" : ""}`;
  });
  console.log(`#   Type     Name           Segs    Duration`);
  console.log(rows.join("\n"));
}

function cmdSegments(draft: Draft, trackType?: string): void {
  const tracks = trackType ? getTracksByType(draft, trackType) : draft.tracks;
  if (tracks.length === 0) die(`No tracks of type "${trackType}"`);

  const rows: string[] = [];
  for (const track of tracks) {
    for (const seg of track.segments) {
      const t = seg.target_timerange;
      const shortId = seg.id.slice(0, 8);
      let label = "";
      if (track.type === "text") {
        const mat = findMaterial(draft.materials.texts, seg.material_id);
        if (mat) label = extractText(mat.content).slice(0, 40);
      } else if (track.type === "video") {
        const mat = findMaterial(draft.materials.videos, seg.material_id);
        if (mat) label = mat.material_name.slice(0, 40);
      } else if (track.type === "audio") {
        const mat = findMaterial(draft.materials.audios, seg.material_id);
        if (mat) label = (mat.name || "").slice(0, 40);
      }
      rows.push(
        `${shortId}  ${track.type.padEnd(6)} ${formatTime(t.start).padStart(8)}-${formatTime(t.start + t.duration).padStart(8)}  ${formatDuration(t.duration).padStart(8)}  ${seg.speed !== 1 ? seg.speed + "x" : "   "}  ${label}`
      );
    }
  }
  console.log(`ID        Type   Start   -End         Dur   Spd  Label`);
  console.log(rows.join("\n"));
}

function cmdTexts(draft: Draft): void {
  const textTracks = getTracksByType(draft, "text");
  const rows: string[] = [];
  for (const track of textTracks) {
    for (const seg of track.segments) {
      const mat = findMaterial(draft.materials.texts, seg.material_id);
      if (!mat) continue;
      const text = extractText(mat.content);
      const t = seg.target_timerange;
      const shortId = seg.id.slice(0, 8);
      rows.push(`${shortId}  ${formatTime(t.start).padStart(8)}-${formatTime(t.start + t.duration).padStart(8)}  ${text}`);
    }
  }
  if (rows.length === 0) {
    console.log("No text segments found.");
    return;
  }
  console.log(`ID        Start   -End       Text`);
  console.log(rows.join("\n"));
}

function cmdSetText(draft: Draft, filePath: string, segId: string, newText: string): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const mat = findMaterial(draft.materials.texts, result.segment.material_id);
  if (!mat) die(`Text material not found for segment ${segId}`);
  const oldText = extractText(mat.content);
  mat.content = updateTextContent(mat.content, newText);
  saveDraft(filePath, draft);
  console.log(`"${oldText}" -> "${newText}"`);
}

function cmdShift(draft: Draft, filePath: string, segId: string, offsetStr: string): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const offset = parseTimeInput(offsetStr);
  const seg = result.segment;
  const oldStart = seg.target_timerange.start;
  seg.target_timerange.start = Math.max(0, oldStart + offset);
  saveDraft(filePath, draft);
  console.log(`${formatTime(oldStart)} -> ${formatTime(seg.target_timerange.start)}`);
}

function cmdShiftAll(draft: Draft, filePath: string, offsetStr: string, trackType?: string): void {
  const offset = parseTimeInput(offsetStr);
  const tracks = trackType ? getTracksByType(draft, trackType) : draft.tracks;
  let count = 0;
  for (const track of tracks) {
    for (const seg of track.segments) {
      seg.target_timerange.start = Math.max(0, seg.target_timerange.start + offset);
      count++;
    }
  }
  saveDraft(filePath, draft);
  console.log(`Shifted ${count} segments by ${offsetStr}`);
}

function cmdSpeed(draft: Draft, filePath: string, segId: string, multiplier: string): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const speed = parseFloat(multiplier);
  if (isNaN(speed) || speed <= 0) die("Speed must be a positive number");
  const seg = result.segment;
  const oldSpeed = seg.speed;
  seg.speed = speed;
  // Adjust source timerange proportionally
  seg.source_timerange.duration = Math.round(seg.target_timerange.duration * speed);
  // Update speed material if exists
  for (const refId of seg.extra_material_refs) {
    const speedMat = findMaterial(draft.materials.speeds, refId);
    if (speedMat) speedMat.speed = speed;
  }
  saveDraft(filePath, draft);
  console.log(`Speed: ${oldSpeed}x -> ${speed}x`);
}

function cmdVolume(draft: Draft, filePath: string, segId: string, levelStr: string): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const level = parseFloat(levelStr);
  if (isNaN(level) || level < 0) die("Volume must be >= 0");
  const old = result.segment.volume;
  result.segment.volume = level;
  saveDraft(filePath, draft);
  console.log(`Volume: ${old} -> ${level}`);
}

function cmdTrim(draft: Draft, filePath: string, segId: string, startStr: string, durationStr: string): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const start = parseTimeInput(startStr);
  const duration = parseTimeInput(durationStr);
  const seg = result.segment;
  seg.source_timerange.start = start;
  seg.source_timerange.duration = duration;
  seg.target_timerange.duration = Math.round(duration / seg.speed);
  saveDraft(filePath, draft);
  console.log(`Trimmed to ${formatTime(start)} + ${formatDuration(duration)}`);
}

function cmdOpacity(draft: Draft, filePath: string, segId: string, alphaStr: string): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const alpha = parseFloat(alphaStr);
  if (isNaN(alpha) || alpha < 0 || alpha > 1) die("Opacity must be 0.0-1.0");
  const old = result.segment.clip.alpha;
  result.segment.clip.alpha = alpha;
  saveDraft(filePath, draft);
  console.log(`Opacity: ${old} -> ${alpha}`);
}

function cmdExportSrt(draft: Draft): void {
  const textTracks = getTracksByType(draft, "text");
  const entries: Array<{ start: number; end: number; text: string }> = [];
  for (const track of textTracks) {
    for (const seg of track.segments) {
      const mat = findMaterial(draft.materials.texts, seg.material_id);
      if (!mat) continue;
      const t = seg.target_timerange;
      entries.push({
        start: t.start,
        end: t.start + t.duration,
        text: extractText(mat.content),
      });
    }
  }
  entries.sort((a, b) => a.start - b.start);
  const srt = entries
    .map((e, i) => `${i + 1}\n${srtTime(e.start)} --> ${srtTime(e.end)}\n${e.text}\n`)
    .join("\n");
  process.stdout.write(srt);
}

// --- Main ---

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const cmd = args[0];
  const projectPath = args[1];

  if (!projectPath) die("Missing project path. Run 'capcut --help' for usage.");

  const { draft, filePath } = loadDraft(projectPath);

  switch (cmd) {
    case "info":
      cmdInfo(draft);
      break;

    case "tracks":
      cmdTracks(draft);
      break;

    case "segments": {
      const trackType = args.indexOf("--track") !== -1 ? args[args.indexOf("--track") + 1] : undefined;
      cmdSegments(draft, trackType);
      break;
    }

    case "texts":
      cmdTexts(draft);
      break;

    case "set-text":
      requireArgs(args, 4, "capcut set-text <project> <id> <text>");
      cmdSetText(draft, filePath, args[2], args.slice(3).join(" "));
      break;

    case "shift":
      requireArgs(args, 4, "capcut shift <project> <id> <offset>");
      cmdShift(draft, filePath, args[2], args[3]);
      break;

    case "shift-all": {
      requireArgs(args, 3, "capcut shift-all <project> <offset> [--track <type>]");
      const trackType = args.indexOf("--track") !== -1 ? args[args.indexOf("--track") + 1] : undefined;
      cmdShiftAll(draft, filePath, args[2], trackType);
      break;
    }

    case "speed":
      requireArgs(args, 4, "capcut speed <project> <id> <multiplier>");
      cmdSpeed(draft, filePath, args[2], args[3]);
      break;

    case "volume":
      requireArgs(args, 4, "capcut volume <project> <id> <level>");
      cmdVolume(draft, filePath, args[2], args[3]);
      break;

    case "trim":
      requireArgs(args, 5, "capcut trim <project> <id> <start> <duration>");
      cmdTrim(draft, filePath, args[2], args[3], args[4]);
      break;

    case "opacity":
      requireArgs(args, 4, "capcut opacity <project> <id> <alpha>");
      cmdOpacity(draft, filePath, args[2], args[3]);
      break;

    case "export-srt":
      cmdExportSrt(draft);
      break;

    default:
      die(`Unknown command: ${cmd}\nRun 'capcut --help' for usage.`);
  }
}

main();
