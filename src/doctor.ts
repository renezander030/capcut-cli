import { existsSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { delimiter, join } from "node:path";

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
function draftDirs(): { label: string; path: string }[] {
  const home = homedir();
  if (platform() === "darwin") {
    return [
      { label: "CapCut (macOS)", path: join(home, "Movies/CapCut/User Data/Projects/com.lveditor.draft") },
      { label: "JianYing (macOS)", path: join(home, "Movies/JianyingPro/User Data/Projects/com.lveditor.draft") },
    ];
  }
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData/Local");
    return [
      { label: "CapCut (Windows)", path: join(local, "CapCut/User Data/Projects/com.lveditor.draft") },
      { label: "JianYing (Windows)", path: join(local, "JianyingPro/User Data/Projects/com.lveditor.draft") },
    ];
  }
  return [];
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
