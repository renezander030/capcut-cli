import { existsSync } from "node:fs";
import { platform, release } from "node:os";
import { delimiter, join } from "node:path";
import { probeFfmpegCapabilities } from "./render.js";
import { draftDirCandidates } from "./store.js";

export type CheckStatus = "ok" | "warn" | "missing";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Commands degraded or unavailable when this check is not "ok". */
  affects?: string[];
  /** How to fix, when not "ok". */
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  platform: string;
  node: string;
  checks: DoctorCheck[];
}

/** Minimal cross-platform PATH lookup — no `which`/`where` shell-out. */
function onPath(cmd: string): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = platform() === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, cmd + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function nodeMajor(): number {
  return Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
}

/** Default per-OS CapCut/JianYing project directories. */
export function draftDirs(): { label: string; path: string }[] {
  return draftDirCandidates();
}

export function runDoctor(): DoctorReport {
  const checks: DoctorCheck[] = [];

  // Node runtime — hard requirement.
  const major = nodeMajor();
  checks.push({
    name: "node",
    status: major >= 18 ? "ok" : "missing",
    detail: `Node ${process.versions.node}${major >= 18 ? "" : " (capcut-cli needs >= 18)"}`,
    affects: major >= 18 ? undefined : ["*"],
    fix: major >= 18 ? undefined : "Upgrade to Node 18 or newer.",
  });

  const ffprobe = onPath("ffprobe");
  checks.push({
    name: "ffprobe",
    status: ffprobe ? "ok" : "warn",
    detail: ffprobe ? `found: ${ffprobe}` : "ffprobe not found; media duration/dimensions cannot be auto-detected",
    affects: ["add-video", "add-audio", "compile"],
    fix: ffprobe
      ? undefined
      : "Install ffmpeg (which includes ffprobe), or pass media durations and dimensions explicitly.",
  });

  const ffmpeg = onPath("ffmpeg");
  const capabilities = ffmpeg ? probeFfmpegCapabilities(ffmpeg) : null;
  checks.push({
    name: "ffmpeg",
    status: capabilities?.available ? "ok" : "warn",
    detail: capabilities?.available
      ? `found: ${ffmpeg}; drawtext=${capabilities.drawtext}; overlay=${capabilities.overlay}; libx264=${capabilities.x264}`
      : "ffmpeg not found; proxy rendering unavailable",
    affects: ["render"],
    fix: capabilities?.available ? undefined : "Install ffmpeg or pass --ffmpeg-cmd <path> to render.",
  });

  // whisper — needed by `caption`.
  const whisper = onPath("whisper") ?? onPath("whisper-cli") ?? onPath("faster-whisper");
  checks.push({
    name: "whisper",
    status: whisper ? "ok" : "warn",
    detail: whisper ? `found: ${whisper}` : "no whisper binary on PATH",
    affects: ["caption"],
    fix: whisper ? undefined : "pip install openai-whisper · brew install whisper-cpp · or pass --whisper-cmd <path>",
  });

  // ANTHROPIC_API_KEY — needed by `translate`.
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  checks.push({
    name: "anthropic-api-key",
    status: hasKey ? "ok" : "warn",
    detail: hasKey ? "ANTHROPIC_API_KEY is set" : "ANTHROPIC_API_KEY not set",
    affects: ["translate"],
    fix: hasKey ? undefined : "export ANTHROPIC_API_KEY=… (or pass --api-key) to use `translate`.",
  });

  // CapCut / JianYing project directories — informational.
  const dirs = draftDirs();
  if (dirs.length === 0) {
    checks.push({
      name: "draft-dir",
      status: "warn",
      detail: `no default project directory for ${platform()} — pass the draft path explicitly`,
    });
  } else {
    for (const d of dirs) {
      const found = existsSync(d.path);
      checks.push({
        name: "draft-dir",
        status: found ? "ok" : "warn",
        detail: `${d.label}: ${found ? "found" : "not found"} (${d.path})`,
        fix: found ? undefined : "Open a project in CapCut/JianYing once, or pass the draft path directly.",
      });
    }
  }

  // `ok` reflects only hard failures (missing), not optional-tool warnings.
  const ok = !checks.some((c) => c.status === "missing");
  return { ok, platform: `${platform()} ${release()}`, node: process.versions.node, checks };
}
