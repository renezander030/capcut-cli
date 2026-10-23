/**
 * `loudness`: how loud each audible clip is, and the gain that brings the
 * draft to a delivery target. A draft carries no master gain, so a CapCut
 * export of a quiet recording uploads as quiet as it was recorded; platforms
 * expect around -14 LUFS (long-form) and louder for shorts. Each clip is
 * measured with ffmpeg's EBU R128 meter over the part of its media the
 * timeline plays; the gain is written as segment volume, which the app applies
 * on export (its master bus is limited, so a boost cannot hard-clip it).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Draft, Segment } from "./draft.js";

export interface LoudnessOptions {
  ffmpegCmd?: string;
  /** Delivery target in LUFS; without it the report only measures. */
  target?: number;
  /** Normalize every clip to the target instead of one gain for the whole mix. */
  perClip?: boolean;
  /** Largest boost a clip may get, in dB (default 20). */
  maxGainDb?: number;
  /** Folder relative media paths resolve against. */
  draftDir?: string;
}

export interface ClipLoudness {
  segment_id: string;
  track: string;
  path: string;
  duration_us: number;
  volume: number;
  /** Integrated loudness of the clip's media at volume 1, LUFS. */
  measured_lufs: number | null;
  true_peak_dbfs: number | null;
  /** measured_lufs with the segment's volume applied. */
  effective_lufs: number | null;
  gain_db?: number;
  new_volume?: number;
  /** The gain wanted more than maxGainDb and was capped. */
  clamped?: boolean;
  skipped?: string;
}

export interface LoudnessReport {
  mode: "uniform" | "per-clip";
  /** Duration-weighted energy mean of the measured clips: an estimate of the
   * export's integrated loudness when clips do not overlap. */
  program_lufs: number | null;
  target?: number;
  max_gain_db: number;
  clips: ClipLoudness[];
}

/** Below this the meter reads silence (ffmpeg reports -70 LUFS). */
const SILENCE_LUFS = -69.9;
export const DEFAULT_MAX_GAIN_DB = 20;

/** Integrated loudness and true peak from ebur128's summary (the last ones printed). */
export function parseEbur128(text: string): { lufs: number | null; peak: number | null } {
  const last = (re: RegExp): number | null => {
    const all = [...text.matchAll(re)];
    if (all.length === 0) return null;
    const value = Number.parseFloat(all[all.length - 1][1]);
    return Number.isFinite(value) ? value : null;
  };
  return { lufs: last(/\bI:\s+(-?[\d.]+|-inf)\s+LUFS/g), peak: last(/\bPeak:\s+(-?[\d.]+|-inf)\s+dBFS/g) };
}

function measure(
  command: string,
  path: string,
  startUs: number,
  durationUs: number,
): { lufs: number | null; peak: number | null } {
  const args = ["-hide_banner", "-nostats", "-ss", (startUs / 1e6).toFixed(6)];
  if (durationUs > 0) args.push("-t", (durationUs / 1e6).toFixed(6));
  args.push("-i", path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-");
  const r = spawnSync(command, args, { encoding: "utf-8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(
      `loudness needs ffmpeg (its ebur128 meter) and '${command}' was not found. Install FFmpeg, or point --ffmpeg-cmd at it.`,
    );
  }
  return parseEbur128(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

/** The clips that make sound in the export: audio tracks, and video clips that carry their own sound. */
function audibleSegments(draft: Draft): Array<{ segment: Segment; track: string; path: string | null; why?: string }> {
  const videos = new Map((draft.materials.videos ?? []).map((m) => [m.id, m]));
  const audios = new Map((draft.materials.audios ?? []).map((m) => [m.id, m]));
  const out: Array<{ segment: Segment; track: string; path: string | null; why?: string }> = [];
  for (const track of draft.tracks) {
    if (track.type !== "audio" && track.type !== "video") continue;
    for (const segment of track.segments) {
      const name = track.name || track.type;
      if (track.type === "audio") {
        const material = audios.get(segment.material_id);
        out.push({
          segment,
          track: name,
          path: material?.path || null,
          why: material ? undefined : "no audio material",
        });
        continue;
      }
      const material = videos.get(segment.material_id);
      if (!material) continue;
      if (material.type === "photo") continue;
      if (material.has_sound_separated === true) {
        out.push({ segment, track: name, path: null, why: "sound separated to an audio track" });
        continue;
      }
      out.push({ segment, track: name, path: material.path || null });
    }
  }
  return out;
}

/** Measure every audible clip; with a target, compute the gain each one gets. */
export function measureLoudness(draft: Draft, opts: LoudnessOptions = {}): LoudnessReport {
  const command = opts.ffmpegCmd ?? "ffmpeg";
  const maxGainDb = opts.maxGainDb ?? DEFAULT_MAX_GAIN_DB;
  if (!Number.isFinite(maxGainDb) || maxGainDb < 0) throw new Error("--max-gain-db must be a number >= 0.");
  if (opts.target !== undefined && (!Number.isFinite(opts.target) || opts.target > 0 || opts.target < -70)) {
    throw new Error("--target must be a loudness in LUFS between -70 and 0 (for example -14).");
  }
  const clips: ClipLoudness[] = [];
  for (const { segment, track, path, why } of audibleSegments(draft)) {
    const volume = typeof segment.volume === "number" ? segment.volume : 1;
    const durationUs = segment.target_timerange.duration;
    const clip: ClipLoudness = {
      segment_id: segment.id,
      track,
      path: path ?? "",
      duration_us: durationUs,
      volume,
      measured_lufs: null,
      true_peak_dbfs: null,
      effective_lufs: null,
    };
    clips.push(clip);
    if (why) {
      clip.skipped = why;
      continue;
    }
    if (volume <= 0) {
      clip.skipped = "muted";
      continue;
    }
    const file = path && !isAbsolute(path) && opts.draftDir ? resolve(opts.draftDir, path) : (path ?? "");
    if (!file || /^https?:\/\//i.test(file) || !existsSync(file)) {
      clip.skipped = "media not found";
      continue;
    }
    const source = segment.source_timerange;
    const { lufs, peak } = measure(command, file, source?.start ?? 0, source?.duration ?? durationUs);
    clip.true_peak_dbfs = peak;
    if (lufs === null) {
      clip.skipped = "no audio stream";
      continue;
    }
    clip.measured_lufs = lufs;
    if (lufs <= SILENCE_LUFS) {
      clip.skipped = "silent";
      continue;
    }
    clip.effective_lufs = round(lufs + 20 * Math.log10(volume), 2);
  }

  const measured = clips.filter((clip) => clip.effective_lufs !== null && clip.duration_us > 0);
  const totalUs = measured.reduce((sum, clip) => sum + clip.duration_us, 0);
  const program =
    totalUs > 0
      ? round(
          10 *
            Math.log10(
              measured.reduce((sum, clip) => sum + clip.duration_us * 10 ** ((clip.effective_lufs as number) / 10), 0) /
                totalUs,
            ),
          2,
        )
      : null;

  const report: LoudnessReport = {
    mode: opts.perClip ? "per-clip" : "uniform",
    program_lufs: program,
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    max_gain_db: maxGainDb,
    clips,
  };
  if (opts.target === undefined || program === null) return report;
  const target = opts.target;
  for (const clip of measured) {
    const wanted = target - (opts.perClip ? (clip.effective_lufs as number) : program);
    const gain = Math.min(wanted, maxGainDb);
    clip.gain_db = round(gain, 2);
    clip.new_volume = round(clip.volume * 10 ** (gain / 20), 4);
    if (wanted > maxGainDb) clip.clamped = true;
  }
  return report;
}

/** Write each measured clip's new volume into the draft; returns how many changed. */
export function applyLoudness(draft: Draft, report: LoudnessReport): number {
  const byId = new Map(report.clips.filter((c) => c.new_volume !== undefined).map((c) => [c.segment_id, c]));
  let changed = 0;
  for (const track of draft.tracks) {
    for (const segment of track.segments) {
      const clip = byId.get(segment.id);
      if (!clip || clip.new_volume === undefined || segment.volume === clip.new_volume) continue;
      segment.volume = clip.new_volume;
      changed++;
    }
  }
  return changed;
}
