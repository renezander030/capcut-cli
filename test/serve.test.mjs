import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut serve", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("dispatches a single JSONL job via stdin and emits one result", () => {
    const job = `${JSON.stringify({ cmd: "info", project: fix.path })}\n`;
    const r = spawnCli(["serve"], { input: job });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // First stdout line is the per-job result, summary is on stderr
    const firstLine = r.stdout.split("\n").find((l) => l.trim().length > 0);
    const parsed = JSON.parse(firstLine);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.cmd, "info");
    assert.ok(parsed.stdout);
    assert.equal(typeof parsed.stdout.duration_us, "number");
  });

  it("emits a summary line on stderr after the queue drains", () => {
    const job = `${JSON.stringify({ cmd: "info", project: fix.path })}\n`;
    const r = spawnCli(["serve"], { input: job });
    const summaryLine = r.stderr.split("\n").find((l) => /"summary"/.test(l));
    const parsed = JSON.parse(summaryLine);
    assert.equal(parsed.summary.succeeded, 1);
    assert.equal(parsed.summary.failed, 0);
  });

  it("flags invalid JSON lines as failures and continues", () => {
    const input = `this is not json\n${JSON.stringify({ cmd: "info", project: fix.path })}\n`;
    const r = spawnCli(["serve"], { input });
    const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.ok, false);
    assert.match(first.stderr, /JSON parse error/);
    assert.equal(second.ok, true);
  });

  it("captures JSON output larger than the platform pipe buffer", () => {
    const job = `${JSON.stringify({ cmd: "enums", args: ["--filters", "--jianying"] })}\n`;
    const r = spawnCli(["serve", "--max-buffer-mb", "2"], { input: job });
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout.trim());
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.stdout));
    assert.ok(result.stdout.length > 100);
  });

  it("deduplicates stable job ids across concurrent workers", () => {
    const job = JSON.stringify({ id: "same-job", cmd: "info", project: fix.path });
    const r = spawnCli(["serve", "--workers", "2"], { input: `${job}\n${job}\n` });
    assert.equal(r.status, 0, r.stderr);
    const results = r.stdout.trim().split("\n").map(JSON.parse);
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.ok));
    assert.equal(results.filter((result) => result.deduplicated).length, 1);
    const summary = JSON.parse(r.stderr.trim()).summary;
    assert.equal(summary.deduplicated, 1);
  });

  it("retries failed jobs with exponential backoff", () => {
    const job = `${JSON.stringify({ cmd: "definitely-not-a-command" })}\n`;
    const r = spawnCli(["serve", "--retries", "1", "--backoff-ms", "1"], { input: job });
    const result = JSON.parse(r.stdout.trim());
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
  });

  // Every result line goes to stdout, which for serve's callers is an
  // automation log. The echoed args used to carry a job's --api-key verbatim.
  it("redacts credential values from the echoed args, keeping the rest verbatim", () => {
    const secret = "sk-ant-do-not-log-this";
    const job = `${JSON.stringify({
      cmd: "translate",
      project: "/nonexistent/draft",
      args: ["--to", "es", "--api-key", secret],
    })}\n`;
    const r = spawnCli(["serve"], { input: job });
    const line = r.stdout.split("\n").find((l) => l.trim().length > 0);
    assert.doesNotMatch(line, new RegExp(secret), "the API key was written to the result line");
    const result = JSON.parse(line);
    assert.deepEqual(result.args, ["translate", "/nonexistent/draft", "--to", "es", "--api-key", "***"]);
  });

  // The CLI parses `--api-key VALUE`, not `--api-key=VALUE`, but a caller who
  // typed the `=` form still put a key on the wire — so the echo masks it too.
  // (The child's own stderr may still quote the unparsed token; only the args
  // echo is this function's to redact.)
  it("redacts the --api-key=VALUE form too", () => {
    const job = `${JSON.stringify({ cmd: "translate", args: ["--api-key=sk-ant-inline-form"] })}\n`;
    const r = spawnCli(["serve"], { input: job });
    const line = r.stdout.split("\n").find((l) => l.trim().length > 0);
    assert.deepEqual(JSON.parse(line).args, ["translate", "--api-key=***"]);
  });
});
