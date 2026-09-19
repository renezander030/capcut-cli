import { existsSync } from "node:fs";
import { platform, release } from "node:os";
import { delimiter, join } from "node:path";
import { appVersionsPath, scanTrackedStores } from "./app-versions.js";
import { scanStore } from "./factory.js";
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

export interface DoctorOptions {
  /** Draft library root to inspect instead of the per-OS default directories. */
  drafts?: string;
}

// Structural, not factory's StoreScanSummary: `lib.d.ts` exposes this module,
// and a type import would pull factory (and its enums/wikimedia graph) into the
// packaged declarations for no consumer benefit.
type StoreCounts = { projects: number; readable: number; markerless: number; encrypted: number; unreadable: number };

/**
 * What a drafts folder holds, project by project, as one doctor check. A
 * JianYing 6.0+ store is the ecosystem's most repeated pain (pyJianYingDraft
 * #92/#115/#174): every project the app wrote is an encrypted payload, and
 * users learn it one failed command at a time. Say it once, up front, with
 * what still works: new drafts from the bundled template are plaintext until
 * the app opens them.
 */
function storeCheck(label: string, path: string, store: StoreCounts): DoctorCheck {
  const { projects, readable, markerless, encrypted, unreadable } = store;
  const counts = `${readable} readable, ${markerless} markerless, ${encrypted} encrypted, ${unreadable} unreadable`;
  if (projects === 0) {
    return { name: "draft-store", status: "ok", detail: `${label}: no projects yet (${path})` };
  }
  if (encrypted === 0) {
    return { name: "draft-store", status: "ok", detail: `${label}: ${projects} project(s) — ${counts} (${path})` };
  }
  const which = encrypted === projects ? `all ${projects}` : `${encrypted} of ${projects}`;
  return {
    name: "draft-store",
    status: "warn",
    detail:
      `${label}: ${which} project(s) are encrypted (JianYing 6.0+ writes draft_content.json as an encrypted payload this CLI does not read) — ` +
      `${counts} (${path})`,
    affects: ["every command that reads an existing encrypted project"],
    fix:
      "Existing encrypted projects cannot be edited here. New drafts still work: `init`, `quickstart` and `compile` build " +
      "plaintext drafts from the bundled template, which JianYing is reported to open and upgrade in place (11.4 on macOS; " +
      "other builds unverified). To keep editing app-made projects, pin JianYing to 5.9.x (docs/version-support.md). " +
      "Details: docs/jianying-encryption.md; one project: `capcut decrypt <project>`.",
  };
}

export function runDoctor(options: DoctorOptions = {}): DoctorReport {
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

  // TTS — needed by `tts`. --tts-cmd takes any local tool, so this only
  // reports whether one of the common engines is on PATH.
  const tts = onPath("piper") ?? onPath("say") ?? onPath("espeak-ng") ?? onPath("flite");
  checks.push({
    name: "tts",
    status: tts ? "ok" : "warn",
    detail: tts ? `found: ${tts}` : "no TTS binary on PATH (looked for piper, say, espeak-ng, flite)",
    affects: ["tts"],
    fix: tts ? undefined : "Install piper or espeak-ng, or pass --tts-cmd <template> pointing at your TTS tool.",
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

  // CapCut / JianYing project directories — informational. `--drafts` names
  // one folder to inspect instead (custom stores, CI, and a machine where the
  // app is not installed).
  const dirs = options.drafts ? [{ label: "drafts", path: options.drafts }] : draftDirs();
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
        fix: found
          ? undefined
          : options.drafts
            ? "Pass a folder that contains the project directories (the one holding root_meta_info.json)."
            : "Open a project in CapCut/JianYing once, or pass the draft path directly.",
      });
      // What the folder holds — readable, markerless, encrypted, unreadable —
      // so a JianYing 6.0+ store is named before the first command fails on it.
      if (found) checks.push(storeCheck(d.label, d.path, scanStore(d.path).store));
    }
  }

  // App auto-upgrade tripwire (pyJianYingDraft#115): re-inspect every draft
  // store the CLI has written to and flag the ones whose app/version evidence
  // moved since. Warn only — the write-time version guard decides refusals.
  const scan = scanTrackedStores();
  if (scan.error) {
    checks.push({
      name: "app-upgrade",
      status: "warn",
      detail: `${scan.error} — treated as empty; the next mutating write rebuilds it`,
      fix: `Delete or repair ${appVersionsPath()}.`,
    });
  } else if (scan.drifts.length > 0) {
    for (const drift of scan.drifts) {
      checks.push({
        name: "app-upgrade",
        status: "warn",
        detail: `${drift.store_dir}: ${drift.changes.join(", ")} (recorded ${drift.from.seen_at})`,
        fix: 'The app may have auto-updated. See "Pinning app updates" in docs/version-support.md.',
      });
    }
  } else {
    checks.push({
      name: "app-upgrade",
      status: "ok",
      detail:
        scan.tracked === 0
          ? "no tracked draft stores yet (the tripwire records on the first mutating write)"
          : `no app-version drift across ${scan.tracked} tracked draft store(s)`,
    });
  }

  // `ok` reflects only hard failures (missing), not optional-tool warnings.
  const ok = !checks.some((c) => c.status === "missing");
  return { ok, platform: `${platform()} ${release()}`, node: process.versions.node, checks };
}
