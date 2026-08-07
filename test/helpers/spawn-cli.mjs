import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "..", "dist", "index.js");

/**
 * Invoke the built CLI with args. Returns { status, stdout, stderr, json }.
 * `json` is the parsed stdout (or null if not parseable).
 */
export function spawnCli(args, opts = {}) {
  // On macOS, spawnSync pipe capture can stop at the kernel's 64 KiB pipe
  // buffer without returning an error. Capture to files so large JSON outputs
  // (notably JianYing enums) are complete and parseable on every platform.
  const captureDir = mkdtempSync(join(tmpdir(), "capcut-test-capture-"));
  const stdoutPath = join(captureDir, "stdout");
  const stderrPath = join(captureDir, "stderr");
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let r;
  try {
    r = spawnSync("node", [CLI, ...args], {
      cwd: opts.cwd,
      input: opts.input,
      // Isolate the app-version tripwire state per spawn (removed with
      // captureDir) so mutating-command tests never touch the developer's
      // real ~/.config/capcut-cli/app-versions.json. Tests that exercise the
      // tripwire across invocations pass their own path via opts.env.
      env: {
        ...process.env,
        CAPCUT_CLI_APP_VERSIONS: join(captureDir, "app-versions.json"),
        ...(opts.env ?? {}),
      },
      timeout: opts.timeout ?? 30_000,
      stdio: ["pipe", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const stdout = readFileSync(stdoutPath, "utf-8");
  const stderr = readFileSync(stderrPath, "utf-8");
  rmSync(captureDir, { recursive: true, force: true });
  let json = null;
  try {
    json = stdout ? JSON.parse(stdout) : null;
  } catch {
    /* not JSON; leave null */
  }
  return { status: r.status, stdout, stderr, json };
}
