import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Minimal cross-platform PATH lookup — no `which`/`where` shell-out. */
export function onPath(cmd: string): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, cmd + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** A PATH lookup, injectable so the resolution below is testable without a
 * real whisper install on the test host. */
export type PathProbe = (cmd: string) => string | null;

/**
 * Whisper CLI dialects this project knows how to drive, in preference order:
 * openai-whisper's `whisper`, then the name whisper.cpp has shipped since
 * v1.7.4 (`whisper-cli`), then `faster-whisper`.
 *
 * `doctor` has always probed all three, but `caption` only ever spawned
 * `whisper` and defaulted its dialect to openai — so on a host that installs
 * whisper.cpp (a `whisper-cli` binary and no `whisper`), doctor reported the
 * check as ok and the first `caption` run died with ENOENT, hinting at the
 * wrong dialect. One resolver, used by both.
 */
export const WHISPER_COMMANDS = ["whisper", "whisper-cli", "faster-whisper"] as const;

/** First installed Whisper dialect, as an absolute path, or null. */
export function resolveWhisperCommand(probe: PathProbe = onPath): string | null {
  for (const cmd of WHISPER_COMMANDS) {
    const found = probe(cmd);
    if (found) return found;
  }
  return null;
}
