import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectShell } from "./helpers/project-shell.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const SERVE_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../dist/serve.js")).href;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-serve-boundaries-"));
  const child = join(dir, "child.mjs");
  const runner = join(dir, "runner.mjs");
  const log = join(dir, "events.jsonl");
  writeFileSync(
    runner,
    `import { serveQueue } from ${JSON.stringify(SERVE_URL)};
const options = JSON.parse(process.argv[4]);
let staleStatReads = 0;
if (options.delayPolling) {
  const interval = globalThis.setInterval;
  globalThis.setInterval = (callback) => interval(callback, 60000);
  delete options.delayPolling;
}
if (options.staleCaptureStats) {
  const { default: fs } = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const stat = fs.statSync;
  fs.statSync = (path, ...args) => {
    const result = stat(path, ...args);
    if (/[\\\\/]capcut-serve-[^\\\\/]+[\\\\/](stdout|stderr)$/.test(String(path))) {
      staleStatReads++;
      return { ...result, size: 0 };
    }
    return result;
  };
  syncBuiltinESMExports();
  delete options.staleCaptureStats;
}
try {
  const summary = await serveQueue({ cliPath: process.argv[2], queuePath: process.argv[3], ...options });
  process.stderr.write(JSON.stringify({ summary, staleStatReads }));
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
}
`,
  );
  return {
    dir,
    child,
    log,
    script(source) {
      writeFileSync(child, source);
    },
    run(jobs, options = {}) {
      const queue = join(dir, "queue.jsonl");
      writeFileSync(queue, jobs.map((job) => JSON.stringify(job)).join("\n"));
      const stdoutPath = join(dir, "runner.stdout");
      const stderrPath = join(dir, "runner.stderr");
      const stdout = openSync(stdoutPath, "w");
      const stderr = openSync(stderrPath, "w");
      let processResult;
      try {
        processResult = spawnSync(process.execPath, [runner, child, queue, JSON.stringify(options)], {
          stdio: ["ignore", stdout, stderr],
          timeout: 15_000,
        });
      } finally {
        closeSync(stdout);
        closeSync(stderr);
      }
      const out = readFileSync(stdoutPath, "utf-8");
      const err = readFileSync(stderrPath, "utf-8");
      return {
        status: processResult.status,
        stdout: out,
        stderr: err,
        results: out.trim() ? out.trim().split("\n").map(JSON.parse) : [],
      };
    },
    events() {
      return readFileSync(log, "utf-8").trim().split("\n").map(JSON.parse);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function eventScript(log) {
  return `import { appendFileSync } from "node:fs";
const id = process.argv.at(-1);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event: "begin", id }) + "\\n");
await new Promise(resolve => setTimeout(resolve, 90));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event: "end", id }) + "\\n");
process.stdout.write(JSON.stringify({ id }));
`;
}

describe("serve queue identity and capture boundaries", () => {
  it("deduplicates equal effective payloads despite omitted defaults and object key order", () => {
    const fixture = setup();
    after(fixture.cleanup);
    fixture.script(eventScript(fixture.log));
    const r = fixture.run(
      [
        { id: "same", cmd: "info", project: "/missing-project", args: ["job"] },
        { args: ["/missing-project", "job"], retries: 0, timeoutMs: 300_000, cmd: "info", id: "same" },
      ],
      { workers: 2 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.results.every((result) => result.ok));
    assert.equal(r.results.filter((result) => result.deduplicated).length, 1);
    assert.equal(fixture.events().filter((event) => event.event === "begin").length, 1);
  });

  it("rejects changed commands, arguments, projects, and execution limits for a used id", () => {
    const fixture = setup();
    after(fixture.cleanup);
    fixture.script(eventScript(fixture.log));
    const original = { id: "bound", cmd: "info", project: "/project-one", args: ["original"] };
    const r = fixture.run(
      [
        original,
        { ...original, cmd: "tracks" },
        { ...original, args: ["changed"] },
        { ...original, project: "/project-two" },
        { ...original, timeoutMs: 1000 },
        { ...original, retries: 1 },
      ],
      { workers: 6 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.results.filter((result) => result.ok).length, 1);
    const rejected = r.results.filter((result) => !result.ok);
    assert.equal(rejected.length, 5);
    assert.ok(rejected.every((result) => /different command payload/.test(result.stderr)));
    assert.ok(rejected.every((result) => !result.deduplicated && result.status === null));
    assert.equal(fixture.events().filter((event) => event.event === "begin").length, 1);
  });

  it("keeps changed credential values out of dedup conflict results", () => {
    const fixture = setup();
    after(fixture.cleanup);
    fixture.script('process.stdout.write("{}")');
    const r = fixture.run(
      [
        { id: "credential", cmd: "translate", args: ["--api-key", "secret-one"] },
        { id: "credential", cmd: "translate", args: ["--api-key", "secret-two"] },
      ],
      { workers: 2 },
    );
    assert.doesNotMatch(r.stdout, /secret-one|secret-two/);
    assert.equal(r.results.filter((result) => !result.ok).length, 1);
    assert.ok(r.results.every((result) => result.args.at(-1) === "***"));
  });

  it("serializes directory, timeline-file, relative, and symlink project aliases", () => {
    const fixture = setup();
    const draft = tmpDraft();
    after(fixture.cleanup);
    after(draft.cleanup);
    const alias = join(fixture.dir, "project-alias");
    symlinkSync(draft.dir, alias, process.platform === "win32" ? "junction" : "dir");
    fixture.script(eventScript(fixture.log));
    const jobs = [
      { cmd: "info", project: draft.dir, args: ["directory"] },
      { cmd: "info", project: draft.path, args: ["file"] },
      { cmd: "info", args: ["--human", relative(process.cwd(), draft.dir), "relative"] },
      { cmd: "info", args: [join(alias, "draft_content.json"), "symlink"] },
    ];
    if (process.platform === "win32") {
      jobs.push({ cmd: "info", project: draft.path.toUpperCase(), args: ["case-alias"] });
    } else {
      const fileAlias = join(fixture.dir, "file-alias.json");
      symlinkSync(draft.path, fileAlias, "file");
      jobs.push({ cmd: "info", project: fileAlias, args: ["file-symlink"] });
    }
    const r = fixture.run(jobs, { workers: jobs.length });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.results.every((result) => result.ok));
    const events = fixture.events();
    assert.deepEqual(
      events.map((event) => event.event),
      jobs.flatMap(() => ["begin", "end"]),
    );
  });

  it("serializes an active nested timeline with its root project and mirror", () => {
    const fixture = setup();
    after(fixture.cleanup);
    fixture.script(eventScript(fixture.log));
    const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "capcut-8.7-windows-active");
    const r = fixture.run(
      [
        { cmd: "info", project: root, args: ["root"] },
        { cmd: "info", project: join(root, "draft_content.json"), args: ["mirror"] },
        {
          cmd: "info",
          args: [join(root, "Timelines", "C1EFCDF2-B885-48ff-A2F8-C33A6C4F4A52", "draft_content.json"), "active"],
        },
      ],
      { workers: 3 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      fixture.events().map((event) => event.event),
      ["begin", "end", "begin", "end", "begin", "end"],
    );
  });

  it("serializes --into append targets with ordinary project mutations", () => {
    const fixture = setup();
    const draft = tmpDraft();
    after(fixture.cleanup);
    after(draft.cleanup);
    fixture.script(eventScript(fixture.log));
    const r = fixture.run(
      [
        { cmd: "import-timeline", args: ["cut.otio", "--into", draft.dir, "append"] },
        { cmd: "info", args: [draft.path, "inspect"] },
      ],
      { workers: 2 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      fixture.events().map((event) => event.event),
      ["begin", "end", "begin", "end"],
    );
  });

  it("locks the named creation destination, rather than the name in the working directory", () => {
    const fixture = setup();
    after(fixture.cleanup);
    fixture.script(eventScript(fixture.log));
    const target = join(fixture.dir, "Created");
    const r = fixture.run(
      [
        { cmd: "init", args: ["Created", "--drafts", fixture.dir, "init"] },
        { cmd: "quickstart", args: ["Created", "--drafts", fixture.dir, "quickstart"] },
        { cmd: "info", args: [target, "directory"] },
        { cmd: "info", args: [join(target, "draft_content.json"), "file"] },
      ],
      { workers: 4 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      fixture.events().map((event) => event.event),
      ["begin", "end", "begin", "end", "begin", "end", "begin", "end"],
    );
  });

  it("locks explicit new project destinations shared by compile, import, and translated drafts", () => {
    const fixture = setup();
    const draft = tmpDraft();
    after(fixture.cleanup);
    after(draft.cleanup);
    fixture.script(eventScript(fixture.log));
    const target = join(fixture.dir, "Built");
    const r = fixture.run(
      [
        { cmd: "compile", args: ["spec.json", "--out", target, "compile"] },
        { cmd: "import-timeline", args: ["cut.otio", "--out", target, "import"] },
        {
          cmd: "translate",
          project: draft.dir,
          args: ["--out", join(target, "draft_content.json"), "translate"],
        },
        { cmd: "info", args: [target, "inspect"] },
      ],
      { workers: 4 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      fixture.events().map((event) => event.event),
      ["begin", "end", "begin", "end", "begin", "end", "begin", "end"],
    );
  });

  it("locks both source projects and the sibling destination of a rename", () => {
    const fixture = setup();
    const first = tmpDraft();
    const second = tmpDraft();
    after(fixture.cleanup);
    after(first.cleanup);
    after(second.cleanup);
    fixture.script(eventScript(fixture.log));
    const newName = `renamed-${first.dir.split(/[/\\]/).at(-1)}`;
    const r = fixture.run(
      [
        { cmd: "concat", args: [first.dir, second.dir, "concat"] },
        { cmd: "rename", args: [first.path, newName, "rename"] },
        { cmd: "info", args: [join(dirname(first.dir), newName), "renamed-target"] },
        { cmd: "info", args: [second.path, "second-source"] },
      ],
      { workers: 4 },
    );
    assert.equal(r.status, 0, r.stderr);
    const events = fixture.events();
    const indexOf = (event, id) => events.findIndex((entry) => entry.event === event && entry.id === id);
    assert.ok(indexOf("end", "concat") < indexOf("begin", "rename"));
    assert.ok(indexOf("end", "concat") < indexOf("begin", "second-source"));
    assert.ok(indexOf("end", "rename") < indexOf("begin", "renamed-target"));
  });

  it("serializes shell compilation with edits through root and unverified nested file aliases", (t) => {
    const fixture = setup();
    t.after(fixture.cleanup);
    const shell = projectShell(t);
    fixture.script(eventScript(fixture.log));
    const result = fixture.run(
      [
        { cmd: "compile", args: ["spec.json", "--into", shell.dir, "--active-timeline", "compile"] },
        { cmd: "add-text", args: [shell.active, "0", "1s", "--active-timeline", "nested"] },
        { cmd: "add-text", args: [shell.root, "0", "1s", "--active-timeline", "root"] },
      ],
      { workers: 3 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fixture.events().map((event) => event.event),
      ["begin", "end", "begin", "end", "begin", "end"],
    );
  });

  it("allows separate projects to run concurrently and does not treat non-project arguments as projects", () => {
    const fixture = setup();
    const first = tmpDraft();
    const second = tmpDraft();
    after(fixture.cleanup);
    after(first.cleanup);
    after(second.cleanup);
    fixture.script(`import { appendFileSync, readFileSync } from "node:fs";
const log = ${JSON.stringify(fixture.log)};
const id = process.argv.at(-1);
appendFileSync(log, JSON.stringify({ event: "begin", id }) + "\\n");
const deadline = Date.now() + 4000;
while (readFileSync(log, "utf-8").trim().split("\\n").map(JSON.parse).filter(event => event.event === "begin").length < 3) {
  if (Date.now() > deadline) process.exit(2);
  await new Promise(resolve => setTimeout(resolve, 10));
}
appendFileSync(log, JSON.stringify({ event: "end", id }) + "\\n");
process.stdout.write(JSON.stringify({ id }));`);
    const r = fixture.run(
      [
        { cmd: "info", args: [first.dir, "first"] },
        { cmd: "info", args: [second.dir, "second"] },
        { cmd: "catalogue", args: [first.dir, "catalogue"] },
      ],
      { workers: 3 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.results.every((result) => result.ok));
    assert.deepEqual(
      fixture
        .events()
        .slice(0, 3)
        .map((event) => event.event),
      ["begin", "begin", "begin"],
    );
  });

  it("detects combined output at child exit before reading when it misses the polling ticks", () => {
    const fixture = setup();
    after(fixture.cleanup);
    fixture.script(
      'import { writeSync } from "node:fs"; writeSync(1, "o".repeat(600)); writeSync(2, "e".repeat(600));',
    );
    const r = fixture.run([{ cmd: "info" }], { maxBufferBytes: 1000, delayPolling: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.results[0].status, 0);
    assert.equal(r.results[0].ok, false);
    assert.equal(r.results[0].overflow, true);
    assert.equal(r.results[0].stdout, undefined);
    assert.match(r.results[0].stderr, /output exceeded 1000 bytes/);
    assert.doesNotMatch(r.stdout, /o{10}|e{10}/);
  });

  it("preserves output exactly at the combined capture threshold", () => {
    const fixture = setup();
    after(fixture.cleanup);
    fixture.script(
      'import { writeSync } from "node:fs"; writeSync(1, "o".repeat(500)); writeSync(2, "e".repeat(500));',
    );
    const r = fixture.run([{ cmd: "info" }], { maxBufferBytes: 1000 });
    assert.equal(r.results[0].ok, true);
    assert.equal(r.results[0].stdout, "o".repeat(500));
    assert.equal(r.results[0].stderr, "e".repeat(500));
  });

  it("bounds reads even when capture-size observations are stale", () => {
    const fixture = setup();
    after(fixture.cleanup);
    fixture.script('import { writeSync } from "node:fs"; writeSync(1, "x".repeat(3000));');
    const r = fixture.run([{ cmd: "info" }], { maxBufferBytes: 1000, staleCaptureStats: true });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stderr).staleStatReads >= 2, "the fixture must return stale capture sizes");
    assert.equal(r.results[0].overflow, true);
    assert.equal(r.results[0].stdout, undefined);
    assert.doesNotMatch(r.stdout, /x{10}/);
  });

  it("does not repeat an operation that exhausts its output capture threshold", () => {
    const fixture = setup();
    after(fixture.cleanup);
    fixture.script(`import { appendFileSync, writeSync } from "node:fs";
appendFileSync(${JSON.stringify(fixture.log)}, '{}\\n');
writeSync(1, 'x'.repeat(2000));`);
    const r = fixture.run([{ cmd: "info" }], { maxBufferBytes: 1000, retries: 2, backoffMs: 0 });
    assert.equal(r.results[0].overflow, true);
    assert.equal(r.results[0].attempts, 1);
    assert.equal(fixture.events().length, 1);
  });

  it("rejects malformed jobs without coercing arguments or spawning and continues to valid jobs", () => {
    const fixture = setup();
    after(fixture.cleanup);
    fixture.script(eventScript(fixture.log));
    const invalid = [
      null,
      [],
      { cmd: "" },
      { cmd: "info", id: 7 },
      { cmd: "info", id: "" },
      { cmd: "info", project: [] },
      { cmd: "info", args: "not-an-array" },
      { cmd: "info", args: [42] },
      { cmd: "info", args: ["nul\0argument"] },
      { cmd: "info", timeoutMs: 0 },
      { cmd: "info", timeoutMs: 2_147_483_648 },
      { cmd: "info", timeoutMs: 1.5 },
      { cmd: "info", retries: -1 },
      { cmd: "info", retries: 1.5 },
      { cmd: "info", retries: "1" },
      { cmd: "info", retries: null },
    ];
    const r = fixture.run([...invalid, { cmd: "info", args: ["valid"] }]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.results.filter((result) => !result.ok).length, invalid.length);
    assert.equal(r.results.filter((result) => result.ok).length, 1);
    assert.equal(fixture.events().filter((event) => event.event === "begin").length, 1);
  });

  it("rejects invalid queue limits before starting any jobs", () => {
    const fixture = setup();
    after(fixture.cleanup);
    fixture.script('process.stdout.write("{}")');
    for (const options of [
      { workers: 0 },
      { workers: 1.5 },
      { workers: 33 },
      { retries: -1 },
      { retries: 0.5 },
      { timeoutMs: 0 },
      { timeoutMs: 2_147_483_648 },
      { timeoutMs: "10" },
      { backoffMs: -1 },
      { backoffMs: 1.5 },
      { maxBufferBytes: 0 },
      { maxBufferBytes: 1.5 },
      { maxBufferBytes: null },
    ]) {
      const r = fixture.run([{ cmd: "info" }], options);
      assert.equal(r.status, 1, JSON.stringify(options));
      assert.match(r.stderr, /must be an integer/);
      assert.equal(r.results.length, 0);
    }
  });

  it("rejects non-finite numeric limits before reading a queue", async () => {
    const { serveQueue } = await import(SERVE_URL);
    for (const [field, value] of [
      ["workers", Number.NaN],
      ["workers", Number.POSITIVE_INFINITY],
      ["retries", Number.NEGATIVE_INFINITY],
      ["timeoutMs", Number.POSITIVE_INFINITY],
      ["backoffMs", Number.NaN],
      ["maxBufferBytes", Number.POSITIVE_INFINITY],
    ]) {
      await assert.rejects(serveQueue({ cliPath: "unused.mjs", [field]: value }), /must be an integer/);
    }
  });
});
