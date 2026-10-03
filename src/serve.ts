import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  buildCommandSpecs,
  commandDeclaresFlag,
  commandNames,
  GLOBAL_OPTION_SPECS,
  RELEASE_SCOPED_FLAGS,
} from "./command-specs.js";
import { defaultDraftsDir, discoverDraftStore } from "./store.js";

export interface ServeOptions {
  queuePath?: string;
  cliPath: string;
  failFast?: boolean;
  workers?: number;
  retries?: number;
  timeoutMs?: number;
  backoffMs?: number;
  maxBufferBytes?: number;
}

export interface JobInput {
  id?: string;
  cmd: string;
  args?: string[];
  project?: string;
  timeoutMs?: number;
  retries?: number;
}

export interface JobResult {
  id?: string;
  ok: boolean;
  cmd: string;
  args: string[];
  status: number | null;
  stdout?: unknown;
  stderr?: string;
  attempts?: number;
  duration_ms?: number;
  deduplicated?: boolean;
  timed_out?: boolean;
  overflow?: boolean;
}

export interface ServeSummary {
  succeeded: number;
  failed: number;
  deduplicated: number;
}

/**
 * Bounded JSONL job runner for n8n/Make/Coze/cron.
 *
 * Jobs for different projects may run in parallel; jobs targeting the same
 * project are serialized so two writers never race. An optional stable `id`
 * deduplicates retries from external orchestrators. Each job has bounded
 * output capture, configurable timeout, retry/backoff, and one JSON result
 * line. Capture thresholds are checked every 25ms and when the child exits;
 * they are not hard disk quotas. Locks and IDs last for this queue invocation.
 */
export async function serveQueue(opts: ServeOptions): Promise<ServeSummary> {
  validateOptions(opts);
  if (opts.queuePath && !existsSync(opts.queuePath)) throw new Error(`Queue file not found: ${opts.queuePath}`);
  const input = opts.queuePath ? createReadStream(opts.queuePath, "utf-8") : process.stdin;
  const reader = createInterface({ input, crlfDelay: Infinity });
  const jobs: JobInput[] = [];
  const immediate: JobResult[] = [];

  for await (const rawLine of reader) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Parser diagnostics can include part of a malformed credential value.
        throw new Error("invalid JSON");
      }
      jobs.push(validateJob(parsed));
    } catch (error) {
      const result: JobResult = {
        ok: false,
        cmd: "",
        args: [],
        status: null,
        stderr: `JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
      };
      immediate.push(result);
      writeResult(result);
      if (opts.failFast) break;
    }
  }

  let succeeded = 0;
  let failed = immediate.length;
  let deduplicated = 0;
  const projectLocks = new Map<string, Promise<unknown>>();
  const idResults = new Map<string, { fingerprint: string; result: Promise<JobResult> }>();
  // Resolve all identities before executing jobs, while paths still represent
  // the same project layout. Normal writes may change the selected timeline.
  const lockKeys = new Map(jobs.map((job) => [job, projectLockKeys(job)]));

  const execute = async (job: JobInput): Promise<JobResult> => {
    const fingerprint = jobFingerprint(opts, job);
    if (job.id) {
      const previous = idResults.get(job.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          return {
            id: job.id,
            ok: false,
            cmd: job.cmd,
            args: redactArgs(jobArgs(job)),
            status: null,
            stderr: "job id already used with a different command payload or execution limits",
          };
        }
        const result = await previous.result;
        return { ...result, deduplicated: true };
      }
    }
    const operation = withProjectLocks(projectLocks, lockKeys.get(job) ?? [], () => runWithRetries(opts, job));
    if (job.id) idResults.set(job.id, { fingerprint, result: operation });
    return operation;
  };

  const record = async (job: JobInput): Promise<boolean> => {
    const result = await execute(job);
    writeResult(result);
    if (result.deduplicated) deduplicated++;
    if (result.ok) succeeded++;
    else failed++;
    return result.ok;
  };

  if (opts.failFast) {
    for (const job of jobs) {
      if (!(await record(job))) break;
    }
  } else {
    const workerCount = opts.workers ?? 1;
    let cursor = 0;
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < jobs.length) {
        const index = cursor++;
        await record(jobs[index]);
      }
    });
    await Promise.all(workers);
  }

  return { succeeded, failed, deduplicated };
}

const MAX_TIMER_MS = 2_147_483_647;

function validateInteger(value: unknown, field: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function validateOptions(opts: ServeOptions): void {
  if (!validString(opts.cliPath)) throw new Error("cliPath must be a non-empty string without NUL bytes");
  if (opts.queuePath !== undefined && !validString(opts.queuePath))
    throw new Error("queuePath must be a non-empty string");
  if (opts.failFast !== undefined && typeof opts.failFast !== "boolean") throw new Error("failFast must be a boolean");
  if (opts.workers !== undefined) validateInteger(opts.workers, "workers", 1, 32);
  if (opts.retries !== undefined) validateInteger(opts.retries, "retries", 0);
  if (opts.timeoutMs !== undefined) validateInteger(opts.timeoutMs, "timeoutMs", 1, MAX_TIMER_MS);
  if (opts.backoffMs !== undefined) validateInteger(opts.backoffMs, "backoffMs", 0, MAX_TIMER_MS);
  if (opts.maxBufferBytes !== undefined) validateInteger(opts.maxBufferBytes, "maxBufferBytes", 1);
}

function validateJob(value: unknown): JobInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("job must be an object");
  const job = value as Record<string, unknown>;
  if (!validString(job.cmd)) throw new Error("missing or invalid 'cmd' field");
  if (job.id !== undefined && !validString(job.id)) throw new Error("id must be a non-empty string without NUL bytes");
  if (job.project !== undefined && !validString(job.project)) throw new Error("project must be a non-empty string");
  if (
    job.args !== undefined &&
    (!Array.isArray(job.args) || job.args.some((arg) => typeof arg !== "string" || arg.includes("\0")))
  ) {
    throw new Error("args must be an array of strings without NUL bytes");
  }
  if (job.timeoutMs !== undefined) validateInteger(job.timeoutMs, "timeoutMs", 1, MAX_TIMER_MS);
  if (job.retries !== undefined) validateInteger(job.retries, "retries", 0);
  return job as unknown as JobInput;
}

function jobArgs(job: JobInput): string[] {
  return [job.cmd, ...(job.project === undefined ? [] : [job.project]), ...(job.args ?? [])];
}

function jobFingerprint(opts: ServeOptions, job: JobInput): string {
  // Fixed field order, normalized defaults, and the exact spawned argv bind an
  // ID to its effective operation. Credentials are hashed and never reported.
  return createHash("sha256")
    .update(
      JSON.stringify({
        cliPath: resolve(opts.cliPath),
        cwd: process.cwd(),
        args: jobArgs(job),
        timeoutMs: job.timeoutMs ?? opts.timeoutMs ?? 300_000,
        retries: job.retries ?? opts.retries ?? 0,
        backoffMs: opts.backoffMs ?? 250,
        maxBufferBytes: opts.maxBufferBytes ?? 16 * 1024 * 1024,
      }),
    )
    .digest("hex");
}

const COMMAND_SPECS = buildCommandSpecs(commandNames(), {});
const OPTION_TYPES = new Map(
  [...GLOBAL_OPTION_SPECS, ...COMMAND_SPECS.flatMap((spec) => spec.options)].flatMap((option) =>
    option.flags.map((flag) => [flag, option.type] as const),
  ),
);
const TIMELINE_FILES = new Set(["draft_content.json", "draft_info.json", "draft_meta_info.json", "template-2.tmp"]);

function canonicalPath(input: string): string {
  let current = resolve(input);
  const suffix: string[] = [];
  while (true) {
    try {
      current = join(realpathSync.native(current), ...suffix);
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        current = join(current, ...suffix);
        break;
      }
      suffix.unshift(basename(current));
      current = parent;
    }
  }
  return current;
}

function projectKey(input: string): string {
  const canonical = canonicalPath(input);
  let root = canonical;
  try {
    root = discoverDraftStore(canonical).projectDir;
  } catch {
    // New draft destinations and unreadable stores still need a stable lock.
    if ((existsSync(canonical) && statSync(canonical).isFile()) || TIMELINE_FILES.has(basename(canonical))) {
      root = dirname(canonical);
      if (basename(dirname(root)) === "Timelines" && TIMELINE_FILES.has(basename(canonical))) {
        root = dirname(dirname(root));
      }
    }
  }
  const key = canonicalPath(root);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function projectLockKeys(job: JobInput): string[] {
  const spec = COMMAND_SPECS.find((candidate) => candidate.name === job.cmd);
  if (!spec) return [];
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const args = jobArgs(job).slice(1);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const type = OPTION_TYPES.get(arg);
    if (type && (!RELEASE_SCOPED_FLAGS.has(arg) || commandDeclaresFlag(job.cmd, arg))) {
      if (type !== "boolean" && index + 1 < args.length) options.set(arg, args[++index]);
    } else {
      positionals.push(arg);
    }
  }
  const paths = spec.positionals.flatMap((argument, index) =>
    /^project(?:$|-)/.test(argument.name) && positionals[index] && !positionals[index].startsWith("-")
      ? [positionals[index]]
      : [],
  );
  if (job.cmd === "import-timeline" && options.has("--into")) paths.push(options.get("--into") as string);
  if (["compile", "import-timeline", "cut", "concat", "translate"].includes(job.cmd) && options.has("--out")) {
    paths.push(options.get("--out") as string);
  }
  if (["init", "quickstart"].includes(job.cmd) && positionals[0]) {
    const drafts = options.get("--drafts") ?? defaultDraftsDir();
    if (drafts) paths.push(resolve(drafts, positionals[0]));
  }
  if (job.cmd === "rename" && positionals[0] && positionals[1] && !/[/\\]/.test(positionals[1])) {
    paths.push(join(dirname(projectKey(positionals[0])), positionals[1]));
  }
  return [...new Set(paths.map(projectKey))].sort();
}

function withProjectLocks(
  locks: Map<string, Promise<unknown>>,
  projects: string[],
  operation: () => Promise<JobResult>,
): Promise<JobResult> {
  const previous = projects.map((project) => locks.get(project) ?? Promise.resolve());
  const current = Promise.all(previous.map((pending) => pending.catch(() => undefined))).then(operation);
  const released = current.then(
    () => undefined,
    () => undefined,
  );
  for (const project of projects) locks.set(project, released);
  return current;
}

async function runWithRetries(opts: ServeOptions, job: JobInput): Promise<JobResult> {
  const started = Date.now();
  const retries = job.retries ?? opts.retries ?? 0;
  let result: JobResult = { ok: false, cmd: job.cmd, args: [], status: null };
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    result = await runJob(opts.cliPath, job, {
      timeoutMs: job.timeoutMs ?? opts.timeoutMs ?? 300_000,
      maxBufferBytes: opts.maxBufferBytes ?? 16 * 1024 * 1024,
    });
    result.attempts = attempt;
    if (result.ok || result.overflow) break;
    if (attempt <= retries)
      await delay(Math.min((opts.backoffMs ?? 250) * 2 ** Math.min(attempt - 1, 31), MAX_TIMER_MS));
  }
  result.duration_ms = Date.now() - started;
  return result;
}

// Flags whose VALUE is a credential. Every result line is written to stdout,
// which for serve's callers (n8n/Make/Coze/cron) is an automation log, so the
// echoed args must not carry the secret the job passed. `--api-key`
// (translate's Anthropic key) is the CLI's only credential flag today.
const SECRET_FLAGS = new Set(["--api-key"]);
const REDACTED = "***";

/**
 * The result line's `args` echo with credential VALUES masked. The spawned
 * child still receives the real argv — only what is reported is redacted.
 * Covers `--api-key VALUE` (the form the CLI parses) and `--api-key=VALUE`
 * (which the CLI ignores, but a caller who typed it still leaked a key).
 */
function redactArgs(args: string[]): string[] {
  const echoed = [...args];
  for (let i = 0; i < echoed.length; i++) {
    const eq = echoed[i].indexOf("=");
    const flag = eq === -1 ? echoed[i] : echoed[i].slice(0, eq);
    if (!SECRET_FLAGS.has(flag)) continue;
    if (eq !== -1) echoed[i] = `${flag}=${REDACTED}`;
    else if (i + 1 < echoed.length) echoed[++i] = REDACTED;
  }
  return echoed;
}

function readCapture(path: string, remainingBytes: number): { text: string; bytes: number; overflow: boolean } {
  const fd = openSync(path, "r");
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    // Descendants can inherit the capture descriptors. Read at most the
    // remaining budget plus one byte even if a file grows after its stat.
    while (bytes <= remainingBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, remainingBytes - bytes + 1));
      const read = readSync(fd, buffer);
      if (read === 0) return { text: Buffer.concat(chunks).toString("utf-8"), bytes, overflow: false };
      bytes += read;
      if (bytes > remainingBytes) return { text: "", bytes, overflow: true };
      chunks.push(buffer.subarray(0, read));
    }
    return { text: "", bytes, overflow: true };
  } finally {
    closeSync(fd);
  }
}

function runJob(
  cliPath: string,
  job: JobInput,
  limits: { timeoutMs: number; maxBufferBytes: number },
): Promise<JobResult> {
  const args = jobArgs(job);
  const echoedArgs = redactArgs(args);
  return new Promise((resolve) => {
    const captureDir = mkdtempSync(join(tmpdir(), "capcut-serve-"));
    const stdoutPath = join(captureDir, "stdout");
    const stderrPath = join(captureDir, "stderr");
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", stdoutFd, stderrFd] });
    closeSync(stdoutFd);
    closeSync(stderrFd);
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let captureError: string | undefined;
    const capturedBytes = () => statSync(stdoutPath).size + statSync(stderrPath).size;

    const finish = (result: JobResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(bufferWatch);
      rmSync(captureDir, { recursive: true, force: true });
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limits.timeoutMs);
    const bufferWatch = setInterval(() => {
      try {
        if (capturedBytes() > limits.maxBufferBytes) {
          overflow = true;
          child.kill("SIGKILL");
        }
      } catch {
        captureError = "unable to inspect captured output";
        child.kill("SIGKILL");
      }
    }, 25);
    child.on("error", (error) =>
      finish({ id: job.id, ok: false, cmd: job.cmd, args: echoedArgs, status: null, stderr: error.message }),
    );
    child.on("close", (status) => {
      if (settled) return;
      let out = "";
      let err = "";
      try {
        // A child can write and exit between two polling ticks. Stat first so
        // oversized output is never loaded into memory, including this race.
        overflow ||= capturedBytes() > limits.maxBufferBytes;
        if (!overflow && !captureError) {
          const stdout = readCapture(stdoutPath, limits.maxBufferBytes);
          overflow = stdout.overflow;
          if (!overflow) {
            const stderr = readCapture(stderrPath, limits.maxBufferBytes - stdout.bytes);
            overflow = stderr.overflow;
            if (!overflow) {
              out = stdout.text;
              err = stderr.text.trim();
            }
          }
        }
      } catch {
        captureError = "unable to read captured output";
      }
      let parsed: unknown = out;
      try {
        if (out.trim()) parsed = JSON.parse(out);
      } catch {
        // Keep text output unchanged.
      }
      finish({
        id: job.id,
        ok: status === 0 && !timedOut && !overflow && !captureError,
        cmd: job.cmd,
        args: echoedArgs,
        status,
        stdout: overflow || captureError ? undefined : parsed,
        stderr: overflow
          ? `output exceeded ${limits.maxBufferBytes} bytes`
          : timedOut
            ? `timed out after ${limits.timeoutMs}ms`
            : captureError || err || undefined,
        timed_out: timedOut || undefined,
        overflow: overflow || undefined,
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeResult(result: JobResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
