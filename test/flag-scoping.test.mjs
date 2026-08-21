import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDir, tmpDraft } from "./helpers/tmp-draft.mjs";

// Regression: flags added in this release (--threshold, --min-gap, --limit,
// --json, --granularity, --format, --easing, --preset, --apply) are parsed by
// the single global parseFlags pass. They must be scoped to the commands that
// declare them, so a free-text positional that happens to contain a flag-like
// substring is preserved verbatim instead of being silently stripped.

describe("flag scoping — free-text positionals survive release flags (regression)", () => {
  const src = tmpDraft();
  after(() => src.cleanup());

  it("add-text keeps a '--limit 5' substring inside the text verbatim", () => {
    const r = spawnCli(["add-text", src.path, "0s", "2s", "New", "Year", "--limit", "5", "drinks"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // On the regression the value token "5" was consumed too, yielding
    // "New Year drinks". The whole run of tokens must be preserved.
    assert.equal(r.json.text, "New Year --limit 5 drinks");
  });

  it("add-text preserves every new-in-release flag token that it does not declare", () => {
    const words = [
      "keep",
      "--json",
      "--apply",
      "--easing",
      "linear",
      "--format",
      "vtt",
      "--threshold",
      "0.4",
      "--min-gap",
      "2",
      "--granularity",
      "word",
      "--keep-track",
      "--keep-materials",
      "--full",
      "--bind",
      "--encoder",
      "h264_nvenc",
      "--data",
      "rows.jsonl",
      "zzz",
      "end",
    ];
    const r = spawnCli(["add-text", src.path, "0s", "2s", ...words]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.text, words.join(" "));
  });

  it("a '--format json'-looking substring no longer hard-errors on an unrelated command", () => {
    // --format is only declared by export-srt; add-text must treat it as text
    // rather than validating it against srt|vtt (which used to throw).
    const r = spawnCli(["add-text", src.path, "0s", "2s", "render", "--format", "json"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.text, "render --format json");
  });
});

describe("flag scoping — scoped flags still work on the command that declares them", () => {
  const t = tmpDir();
  after(() => t.cleanup());

  let project;
  before(() => {
    const init = spawnCli(["init", "scoped", "--drafts", t.dir]);
    assert.equal(init.status, 0, `stderr: ${init.stderr}`);
    project = join(t.dir, "scoped");
    const srt = "1\n00:00:01,000 --> 00:00:04,000\nhello brave world\n\n2\n00:00:05,000 --> 00:00:06,000\nbye\n";
    const imported = spawnCli(["import-srt", project, "-"], { input: srt });
    assert.equal(imported.status, 0, `stderr: ${imported.stderr}`);
  });

  it("export-srt --format vtt is consumed and applied (value flag on its own command)", () => {
    const r = spawnCli(["export-srt", project, "--format", "vtt"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^WEBVTT\n\n/);
  });

  it("export-srt --granularity rejects an invalid value (validation still runs on its own command)", () => {
    const r = spawnCli(["export-srt", project, "--granularity", "sentence"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--granularity must be line\|word/);
  });
});

describe("flag scoping — pre-release global flags keep swallowing their value token", () => {
  const src = tmpDraft();
  after(() => src.cleanup());

  // --font predates RELEASE_SCOPED_FLAGS, so it is parsed globally on every
  // command and its value token is consumed. Nothing reads the value, but the
  // token-swallowing is observable in the positional stream, so it is pinned
  // here: dropping the parse branch would change add-text's output text.
  it("add-text drops a '--font <name>' pair from the text rather than keeping it verbatim", () => {
    const r = spawnCli(["add-text", src.path, "0s", "2s", "hello", "--font", "Arial", "world"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.text, "hello world");
  });
});
