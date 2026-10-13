import { spawnSync } from "node:child_process";

export interface FfmpegPassOptions {
  /** Command name every error starts with, e.g. "detect-scenes". */
  label: string;
  /** What the pass does, for the timeout message, e.g. "scene detection". */
  what: string;
  cmd: string;
  mediaPath: string;
  args: string[];
  timeoutMs: number;
  maxBuffer: number;
  /** What to try after a timeout. */
  timeoutHint: string;
  /** Which option emits less output after a buffer overflow. */
  bufferHint: string;
}

/**
 * Run one ffmpeg analysis pass (a filter that prints to stderr, output to the
 * null muxer) and return its stderr. Every failure throws an actionable error:
 * a missing binary says how to install or point at one, while a tripped
 * timeout or buffer — ffmpeg ran — says so instead of blaming the install.
 */
export function runFfmpegAnalysis(o: FfmpegPassOptions): string {
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(o.cmd, o.args, { encoding: "utf-8", timeout: o.timeoutMs, maxBuffer: o.maxBuffer });
  } catch (e) {
    throw new Error(
      `${o.label}: ffmpeg is unavailable at '${o.cmd}'. Install ffmpeg or pass --ffmpeg-cmd <path>. (${
        e instanceof Error ? e.message : String(e)
      })`,
    );
  }
  if (r.error) {
    // spawnSync reports its own limits via r.error, not by throwing — a tripped
    // timeout/buffer means ffmpeg RAN, so "install ffmpeg" would be a lie.
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new Error(
        `${o.label}: ${o.what} timed out after ${o.timeoutMs / 1000}s on ${o.mediaPath}. ${o.timeoutHint}`,
      );
    }
    if (code === "ENOBUFS") {
      const mib = o.maxBuffer / (1024 * 1024);
      const cap = mib >= 1 ? `${Math.round(mib)} MiB` : `${o.maxBuffer}-byte`;
      throw new Error(`${o.label}: ffmpeg output exceeded the ${cap} buffer on ${o.mediaPath}. ${o.bufferHint}`);
    }
    throw new Error(
      `${o.label}: ffmpeg is unavailable at '${o.cmd}'. Install ffmpeg or pass --ffmpeg-cmd <path>. (${
        code ?? r.error.message
      })`,
    );
  }
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  if (r.status !== 0) {
    throw new Error(`${o.label}: ffmpeg failed on ${o.mediaPath}.\n${stderr.slice(-600)}`);
  }
  return stderr;
}
