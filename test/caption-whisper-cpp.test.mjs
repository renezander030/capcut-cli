import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseWhisperJson, parseWordTimings } from "../dist/caption.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JFK = readFileSync(join(__dirname, "fixtures", "whisper-cpp", "jfk-ojf.json"), "utf-8");

const token = (text, from, to) => ({ text, offsets: { from, to } });
const segment = (text, tokens, from = 0, to = 5000) => ({ text, offsets: { from, to }, tokens });
const wordsOf = (seg) => parseWhisperJson(JSON.stringify({ transcription: [seg] })).words;

describe("whisper.cpp full JSON (-ojf) words", () => {
  it("times every word of a real whisper-cli run from its tokens", () => {
    const { cues, words } = parseWhisperJson(JFK);
    assert.equal(cues.length, 1);
    assert.equal(words.map((w) => w.word).join(" "), cues[0].text);
    assert.deepEqual(words.slice(0, 4), [
      { word: "And", startUs: 320_000, endUs: 330_000 },
      { word: "so,", startUs: 330_000, endUs: 740_000 },
      { word: "my", startUs: 740_000, endUs: 950_000 },
      { word: "fellow", startUs: 950_000, endUs: 1_590_000 },
    ]);
    assert.deepEqual(cues[0].words, words);
    for (const w of words) assert.ok(w.endUs > w.startUs, `${w.word} has a duration`);
  });

  it("joins sub-word pieces and punctuation, and skips special tokens", () => {
    const words = wordsOf(
      segment(" Privet, mir", [
        token("[_BEG_]", 0, 0),
        token(" Pri", 100, 200),
        token("vet", 200, 400),
        token(",", 400, 450),
        token(" mir", 500, 900),
        token("[_TT_45]", 900, 900),
      ]),
    );
    assert.deepEqual(words, [
      { word: "Privet,", startUs: 100_000, endUs: 450_000 },
      { word: "mir", startUs: 500_000, endUs: 900_000 },
    ]);
  });

  it("makes every token its own word in Chinese", () => {
    const words = wordsOf(segment("你好世界", [token("你好", 0, 300), token("世界", 300, 700)]));
    assert.deepEqual(
      words.map((w) => w.word),
      ["你好", "世界"],
    );
  });

  it("leaves a segment whose tokens do not spell its text to the even split", () => {
    const broken = segment("你好", [token("�", 0, 100), token("�好", 100, 300)], 0, 300);
    assert.deepEqual(wordsOf(broken), [{ word: "你好", startUs: 0, endUs: 300_000 }], "the even split of the segment");
  });

  it("parses plain -oj output (no tokens) exactly as before", () => {
    const plain = JSON.stringify({ transcription: [{ text: " one two", offsets: { from: 0, to: 2000 } }] });
    const { cues, words } = parseWhisperJson(plain);
    assert.equal(cues[0].words, undefined);
    assert.deepEqual(words, [
      { word: "one", startUs: 0, endUs: 1_000_000 },
      { word: "two", startUs: 1_000_000, endUs: 2_000_000 },
    ]);
  });

  it("reads whisper.cpp full JSON through --words", () => {
    const parsed = parseWordTimings(JFK);
    assert.equal(parsed.format, "whisper-cpp");
    assert.equal(parsed.skipped, 0);
    assert.deepEqual(parsed.words, parseWhisperJson(JFK).words);
  });
});
