import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseTimeInput } from "../dist/time.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("time input validation", () => {
  it("preserves signed decimal seconds, milliseconds and clock forms", () => {
    const samples = [
      ["0", 0],
      ["12", 12_000_000],
      ["+0.5s", 500_000],
      ["-1s", -1_000_000],
      ["1.25", 1_250_000],
      [".5s", 500_000],
      ["1.s", 1_000_000],
      ["+500ms", 500_000],
      ["-0.25ms", -250],
      ["1:30", 90_000_000],
      ["0:05.5", 5_500_000],
      ["-1:02:03.25", -3_723_250_000],
      ["+0:.5", 500_000],
      ["90:90", 5_490_000_000],
      ["1:90:90", 9_090_000_000],
      ["0.0000006s", 1],
      ["9007199254s", 9_007_199_254_000_000],
    ];
    for (const [text, expected] of samples) assert.equal(parseTimeInput(text), expected, text);
  });

  it("rejects incomplete numbers, trailing text, malformed clocks and unsafe microseconds", () => {
    const invalid = [
      "",
      " ",
      "+",
      "-",
      ".",
      "s",
      "ms",
      "1junk",
      "1s\n",
      "1:30\r\n",
      " 1s",
      "1junkms",
      "1msms",
      "1ss",
      "1:2junk",
      ":30",
      "1:",
      "1::2",
      "1:2:3:4",
      "1.5:30",
      "1:-2",
      "1:2:+3",
      "NaN",
      "Infinity",
      "-Infinitys",
      "Infinityms",
      "1:Infinity",
      "0x10",
      "1_000",
      "9007199255s",
      "9007199254741ms",
      "999999999999:00:00",
    ];
    for (const text of invalid) assert.throws(() => parseTimeInput(text), /Invalid time:/, JSON.stringify(text));
  });

  for (const [name, args] of [
    ["shift trailing text", ["shift", "aaaaaa01", "1junk"]],
    ["shift malformed clock", ["shift", "aaaaaa01", "1::2"]],
    ["shift unsafe time", ["shift", "aaaaaa01", "9007199255s"]],
    ["trim malformed start", ["trim", "aaaaaa01", "1:2junk", "1s"]],
    ["trim non-finite duration", ["trim", "aaaaaa01", "0s", "Infinitys"]],
    ["trim unsafe duration", ["trim", "aaaaaa01", "0s", "9007199254741ms"]],
  ]) {
    it(`${name} fails before changing the draft or creating recovery files`, (t) => {
      const fixture = tmpDraft();
      t.after(() => fixture.cleanup());
      const before = readFileSync(fixture.path);
      const files = readdirSync(fixture.dir).sort();
      const [command, ...rest] = args;
      const result = spawnCli([command, fixture.path, ...rest]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Invalid time:/);
      assert.deepEqual(readFileSync(fixture.path), before);
      assert.deepEqual(readdirSync(fixture.dir).sort(), files);
    });
  }
});
