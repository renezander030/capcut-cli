import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDir, tmpDraft } from "./helpers/tmp-draft.mjs";

const cue = (text) => `1\n00:00:01,000 --> 00:00:02,000\n${text}\n`;
const imported = (path) =>
  JSON.parse(readFileSync(path, "utf8")).materials.texts.map((m) => {
    try {
      return JSON.parse(m.content).text;
    } catch {
      return m.content;
    }
  });

describe("subtitle input encodings", () => {
  for (const [name, bom, bytes] of [
    ["UTF-16LE", [0xff, 0xfe], Buffer.from(cue("Café 日本語"), "utf16le")],
    ["UTF-16BE", [0xfe, 0xff], Buffer.from(cue("Café 日本語"), "utf16le").swap16()],
  ]) {
    it(`imports a BOM-marked ${name} file without corrupting caption text`, (t) => {
      const fix = tmpDraft();
      t.after(fix.cleanup);
      const source = join(fix.dir, "captions.srt");
      writeFileSync(source, Buffer.concat([Buffer.from(bom), bytes]));
      const result = spawnCli(["import-srt", fix.path, source]);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(imported(fix.path).includes("Café 日本語"));
    });
  }

  it("imports a user-selected Windows code page, retaining strict UTF-8 by default", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const source = join(fix.dir, "captions.srt");
    writeFileSync(source, Buffer.from(cue("Café"), "latin1"));
    const before = readFileSync(fix.path);
    const strict = spawnCli(["import-srt", fix.path, source]);
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /not valid UTF-8/);
    assert.deepEqual(readFileSync(fix.path), before);
    const result = spawnCli(["import-srt", fix.path, source, "--encoding", "windows-1252"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(imported(fix.path).includes("Café"));
  });

  it("passes explicit subtitle encoding through quickstart before creating a project", (t) => {
    const fix = tmpDir();
    t.after(fix.cleanup);
    const source = join(fix.dir, "captions.srt");
    writeFileSync(source, Buffer.from(cue("Café"), "latin1"));
    const result = spawnCli([
      "quickstart",
      "encoded",
      "--srt",
      source,
      "--drafts",
      fix.dir,
      "--encoding",
      "windows-1252",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.added.captions, 1);
    assert.ok(imported(result.json.file_path).includes("Café"));
  });

  it("refuses NUL-bearing text and an unsupported explicit encoding without touching the draft", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const source = join(fix.dir, "captions.srt");
    const before = readFileSync(fix.path);
    writeFileSync(source, cue("a\u0000b"));
    const nul = spawnCli(["import-srt", fix.path, source]);
    assert.notEqual(nul.status, 0);
    assert.match(nul.stderr, /NUL/);
    writeFileSync(source, cue("hello"));
    const unsupported = spawnCli(["import-srt", fix.path, source, "--encoding", "not-an-encoding"]);
    assert.notEqual(unsupported.status, 0);
    assert.match(unsupported.stderr, /encoding/i);
    assert.deepEqual(readFileSync(fix.path), before);
  });
});
