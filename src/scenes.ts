import { existsSync } from "node:fs";
import { runFfmpegAnalysis } from "./ffmpeg-pass.js";
import { probeMedia } from "./probe.js";

/**
 * Deterministic scene-cut detection (ffmpeg scene filter, no AI).
 *
 * Seeds the cut-long-form-to-shorts workflow: a raw recording is opaque until
 * you know where the content-aware cut points are (pyJianYingDraft#191 asks
 * for exactly this). `detect-scenes` runs ffmpeg's scene-change score over a
 * video — select='gt(scene,T)' + metadata=print writes each selected frame's
 * pts_time and lavfi.scene_score to stderr — and turns that into cut points
 * plus a ready-to-use segment list (seconds + draft-native microseconds).
 *
 * Architecture mirrors `probe`/`render`: parsing and cut/segment math are
 * pure, deterministic functions (`parseSceneCuts`, `parseFfmpegDuration`,
 * `mergeCloseCuts`, `limitCuts`, `buildSceneSegments`) tests assert without
 * invoking ffmpeg; the live shell-out (`detectScenes`) throws an actionable
 * error when ffmpeg is missing, matching render's behavior.
 */

const US = 1_000_000; // microseconds per second — CapCut's timing unit

export interface SceneCut {
  time: number; // seconds
  score: number; // ffmpeg scene score, 0..1
}

export interface SceneSegment {
  start: number;
  end: number | null; // null when the source duration is unknown
  duration: number | null;
  start_us: number;
  end_us: number | null;
  duration_us: number | null;
}

export interface SceneDetectOptions {
  threshold?: number; // scene score a frame must exceed (default 0.4)
  minGap?: number; // merge cuts closer than this many seconds (default 2)
  limit?: number; // keep only the N strongest cuts
  ffmpegCmd?: string; // ffmpeg binary (default "ffmpeg")
  ffprobeCmd?: string; // ffprobe binary for video-stream duration (default "ffprobe")
  timeoutMs?: number; // kill ffmpeg after this long (default 600s)
  maxBufferBytes?: number; // ffmpeg stdout/stderr cap (default 64 MiB)
}

export interface SceneReport {
  video: string;
  threshold: number;
  min_gap: number;
  limit: number | null;
  duration: number | null;
  duration_us: number | null;
  // Where `duration` came from: the video stream itself (ffprobe — the value
  // segments must end at), or the container header (the LONGEST stream; only
  // used when ffprobe is unavailable, may overrun the video track).
  duration_source: "video-stream" | "container" | null;
  cuts: Array<{ time: number; time_us: number; timecode: string; score: number }>;
  segments: SceneSegment[];
}

/**
 * Parse the stderr of `-vf select='gt(scene,T)',metadata=print -f null -`.
 * Each selected frame emits two lines:
 *   [Parsed_metadata_1 @ 0x...] frame:0  pts:15360  pts_time:1.024
 *   [Parsed_metadata_1 @ 0x...] lavfi.scene_score=0.400000
 */
export function parseSceneCuts(stderr: string): SceneCut[] {
  const cuts: SceneCut[] = [];
  let pending: number | null = null;
  for (const line of stderr.split("\n")) {
    const time = line.match(/\bpts_time:(-?\d+(?:\.\d+)?)/);
    if (time) {
      pending = Number(time[1]);
      continue;
    }
    const score = line.match(/lavfi\.scene_score=(\d+(?:\.\d+)?)/);
    if (score && pending !== null) {
      // A cut at t<=0 has no preceding frame to cut away from.
      if (pending > 0) cuts.push({ time: pending, score: Number(score[1]) });
      pending = null;
    }
  }
  return cuts.sort((a, b) => a.time - b.time);
}

/** Pull the input duration off ffmpeg's stderr header ("Duration: 00:00:03.00, ..."). */
export function parseFfmpegDuration(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * Merge cuts closer than `minGap` seconds. Chains of close cuts collapse into
 * one cluster; the strongest cut (earliest on ties) represents each cluster.
 */
export function mergeCloseCuts(cuts: SceneCut[], minGap: number): SceneCut[] {
  if (minGap <= 0 || cuts.length < 2) return [...cuts].sort((a, b) => a.time - b.time);
  const sorted = [...cuts].sort((a, b) => a.time - b.time);
  const merged: SceneCut[] = [];
  let best = sorted[0];
  let prevTime = sorted[0].time;
  for (const cut of sorted.slice(1)) {
    if (cut.time - prevTime < minGap) {
      if (cut.score > best.score) best = cut;
    } else {
      merged.push(best);
      best = cut;
    }
    prevTime = cut.time;
  }
  merged.push(best);
  return merged;
}

/** Keep the N strongest cuts (earliest wins ties), returned back in time order. */
export function limitCuts(cuts: SceneCut[], limit: number | undefined): SceneCut[] {
  if (limit === undefined || cuts.length <= limit) return cuts;
  return [...cuts]
    .sort((a, b) => b.score - a.score || a.time - b.time)
    .slice(0, limit)
    .sort((a, b) => a.time - b.time);
}

/**
 * Turn cut points into contiguous segments [0..cut1][cut1..cut2][..duration].
 * With an unknown duration the trailing segment is open-ended (end null).
 */
export function buildSceneSegments(cuts: SceneCut[], duration: number | null): SceneSegment[] {
  const bounded = duration === null ? cuts : cuts.filter((c) => c.time < duration);
  const starts = [0, ...bounded.map((c) => c.time)];
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : duration;
    return {
      start,
      end,
      duration: end === null ? null : round6(end - start),
      start_us: Math.round(start * US),
      end_us: end === null ? null : Math.round(end * US),
      duration_us: end === null ? null : Math.round(end * US) - Math.round(start * US),
    };
  });
}

/**
 * Format seconds as hh:mm:ss.mmm. Rounds to milliseconds FIRST so the carry
 * propagates through seconds/minutes/hours — 59.9996 must become
 * "00:01:00.000", never the out-of-range "00:00:60.000".
 */
export function timecode(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = (totalMs % 60_000) / 1000;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${s.toFixed(3).padStart(6, "0")}`;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Live detection. Runs ffmpeg's scene filter over `videoPath` and assembles
 * the report. Throws with an actionable message when the file or ffmpeg is
 * missing, or when ffmpeg fails (mirrors render's error style).
 */
export function detectScenes(videoPath: string, opts: SceneDetectOptions = {}): SceneReport {
  const threshold = opts.threshold ?? 0.4;
  const minGap = opts.minGap ?? 2;
  const cmd = opts.ffmpegCmd ?? "ffmpeg";
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const maxBuffer = opts.maxBufferBytes ?? 64 * 1024 * 1024;
  if (!existsSync(videoPath)) {
    throw new Error(`detect-scenes: video not found: ${videoPath}`);
  }
  const args = [
    "-hide_banner",
    "-i",
    videoPath,
    "-vf",
    `select='gt(scene,${threshold})',metadata=print`,
    "-an",
    "-f",
    "null",
    "-",
  ];
  const stderr = runFfmpegAnalysis({
    label: "detect-scenes",
    what: "scene detection",
    cmd,
    mediaPath: videoPath,
    args,
    timeoutMs,
    maxBuffer,
    timeoutHint: "Try a shorter or lower-resolution input.",
    bufferHint: "Raise --threshold to emit fewer cut candidates.",
  });
  // Segment ends must come from the VIDEO stream's duration. The container
  // header ("Duration:") is the LONGEST stream — when the audio track outlasts
  // the video (common in screen recordings), it would point the final segment
  // past the last video frame. ffprobe reads the real stream metadata; the
  // centisecond-rounded header is only a fallback when ffprobe is unavailable,
  // and duration_source says which one the report used.
  const probe = probeMedia(videoPath, opts.ffprobeCmd ?? "ffprobe");
  let duration: number | null;
  let durationSource: SceneReport["duration_source"];
  if (probe?.videoDurationUs != null) {
    duration = probe.videoDurationUs / US;
    durationSource = "video-stream";
  } else {
    duration = probe?.durationUs != null ? probe.durationUs / US : parseFfmpegDuration(stderr);
    durationSource = duration === null ? null : "container";
  }
  // Drop cuts at/after the known end ONCE, so cuts[] and segments[] agree
  // (buildSceneSegments applies the same bound internally).
  const detected = parseSceneCuts(stderr).filter((c) => duration === null || c.time < duration);
  const cuts = limitCuts(mergeCloseCuts(detected, minGap), opts.limit);
  return {
    video: videoPath,
    threshold,
    min_gap: minGap,
    limit: opts.limit ?? null,
    duration,
    duration_us: duration === null ? null : Math.round(duration * US),
    duration_source: durationSource,
    cuts: cuts.map((c) => ({
      time: c.time,
      time_us: Math.round(c.time * US),
      timecode: timecode(c.time),
      score: c.score,
    })),
    segments: buildSceneSegments(cuts, duration),
  };
}
