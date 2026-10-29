import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readSubtitleText } from "../dist/bom.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const cue = "1\n00:00:00,000 --> 00:00:01,000\nCaf\u00e9 \u4f60\u597d \uFFFD\n";
const invalidSrt = Buffer.concat([
  Buffer.from("1\n00:00:00,000 --> 00:00:01,000\n"),
  Buffer.from([0xff]),
  Buffer.from("\n"),
]);
const invalidAss = Buffer.concat([
  Buffer.from(
    "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,",
  ),
  Buffer.from([0xff]),
  Buffer.from("\n"),
]);

function setup(t) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  return fix;
}

describe("subtitle decoding integrity", () => {
  it("accepts UTF-8 with or without BOM, including an intentional replacement character", (t) => {
    const fix = setup(t),
      path = join(fix.dir, "captions.srt");
    for (const prefix of ["", "\uFEFF"]) {
      writeFileSync(path, prefix + cue);
      assert.equal(readSubtitleText(path), cue);
    }
    const result = spawnCli(["import-srt", fix.path, path]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(fix.path, "utf-8"), /Caf/);
  });

  for (const [command, bytes] of [
    ["import-srt", invalidSrt],
    ["import-ass", invalidAss],
  ]) {
    it(`${command} rejects malformed file bytes without changing the draft`, (t) => {
      const fix = setup(t),
        input = join(fix.dir, "captions.txt");
      writeFileSync(input, bytes);
      const before = readFileSync(fix.path);
      const result = spawnCli([command, fix.path, input]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not valid UTF-8.*Convert the file to UTF-8/);
      assert.deepEqual(readFileSync(fix.path), before);
    });
  }

  it("rejects malformed stdin bytes before writing", (t) => {
    const fix = setup(t),
      before = readFileSync(fix.path);
    const result = spawnCli(["import-srt", fix.path, "-"], { input: invalidSrt });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not valid UTF-8: stdin/);
    assert.deepEqual(readFileSync(fix.path), before);
  });

  it("compile captions rejects corrupt bytes and removes its uncommitted output", (t) => {
    const fix = setup(t),
      input = join(fix.dir, "captions.srt"),
      spec = join(fix.dir, "spec.json"),
      out = join(fix.dir, "compiled");
    writeFileSync(input, invalidSrt);
    writeFileSync(
      spec,
      JSON.stringify({
        name: "Example",
        width: 720,
        height: 1280,
        fps: 30,
        tracks: [{ type: "text", items: [{ text: "Example", start: 0, duration: 1 }] }],
        operations: [{ op: "captions", path: input }],
      }),
    );
    const result = spawnCli(["compile", spec, "--out", out]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not valid UTF-8/);
    assert.equal(existsSync(out), false);
  });
});
