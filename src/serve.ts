import { spawn } from "node:child_process";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

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
 * output, configurable timeout, retry/backoff, and one JSON result line.
 */
export async function serveQueue(opts: ServeOptions): Promise<ServeSummary> {
  if (opts.queuePath && !existsSync(opts.queuePath)) throw new Error(`Queue file not found: ${opts.queuePath}`);
  const input = opts.queuePath ? createReadStream(opts.queuePath, "utf-8") : process.stdin;
  const reader = createInterface({ input, crlfDelay: Infinity });
  const jobs: JobInput[] = [];
  const immediate: JobResult[] = [];

  for await (const rawLine of reader) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const job = JSON.parse(line) as JobInput;
      if (!job || typeof job.cmd !== "string" || job.cmd.length === 0) {
        throw new Error("missing or invalid 'cmd' field");
      }
      jobs.push(job);
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
  const idResults = new Map<string, Promise<JobResult>>();

  const execute = async (job: JobInput): Promise<JobResult> => {
    if (job.id) {
      const previous = idResults.get(job.id);
      if (previous) {
        const result = await previous;
        return { ...result, deduplicated: true };
      }
    }
    const operation = withProjectLock(projectLocks, job.project, () => runWithRetries(opts, job));
    if (job.id) idResults.set(job.id, operation);
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
    const workerCount = Math.max(1, Math.min(Math.floor(opts.workers ?? 1), 32));
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

function withProjectLock(
  locks: Map<string, Promise<unknown>>,
  project: string | undefined,
  operation: () => Promise<JobResult>,
): Promise<JobResult> {
  if (!project) return operation();
  const previous = locks.get(project) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  locks.set(
    project,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

async function runWithRetries(opts: ServeOptions, job: JobInput): Promise<JobResult> {
  const started = Date.now();
  const retries = Math.max(0, Math.floor(job.retries ?? opts.retries ?? 0));
  let result: JobResult = { ok: false, cmd: job.cmd, args: [], status: null };
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    result = await runJob(opts.cliPath, job, {
      timeoutMs: job.timeoutMs ?? opts.timeoutMs ?? 300_000,
      maxBufferBytes: opts.maxBufferBytes ?? 16 * 1024 * 1024,
    });
    result.attempts = attempt;
    if (result.ok) break;
    if (attempt <= retries) await delay((opts.backoffMs ?? 250) * 2 ** (attempt - 1));
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

function runJob(
  cliPath: string,
  job: JobInput,
  limits: { timeoutMs: number; maxBufferBytes: number },
): Promise<JobResult> {
  const args: string[] = [job.cmd];
  if (job.project) args.push(job.project);
  if (Array.isArray(job.args)) args.push(...job.args.map(String));
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
      const bytes = [stdoutPath, stderrPath].reduce((sum, path) => {
        try {
          return sum + statSync(path).size;
        } catch {
          return sum;
        }
      }, 0);
      if (bytes > limits.maxBufferBytes) {
        overflow = true;
        child.kill("SIGKILL");
      }
    }, 25);
    child.on("error", (error) =>
      finish({ id: job.id, ok: false, cmd: job.cmd, args: echoedArgs, status: null, stderr: error.message }),
    );
    child.on("close", (status) => {
      if (settled) return;
      const out = readFileSync(stdoutPath, "utf-8");
      const err = readFileSync(stderrPath, "utf-8").trim();
      let parsed: unknown = out;
      try {
        if (out.trim()) parsed = JSON.parse(out);
      } catch {
        // Keep text output unchanged.
      }
      finish({
        id: job.id,
        ok: status === 0 && !timedOut && !overflow,
        cmd: job.cmd,
        args: echoedArgs,
        status,
        stdout: parsed,
        stderr: overflow
          ? `output exceeded ${limits.maxBufferBytes} bytes`
          : timedOut
            ? `timed out after ${limits.timeoutMs}ms`
            : err || undefined,
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
