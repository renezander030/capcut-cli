import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseWordTimings } from "../dist/caption.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// caption --words: word timings from an external aligner (Whisper JSON,
// WhisperX, Qwen3-ForcedAligner, any {word,start,end} list) go through the
// same grouping / karaoke / reveal / --script path as Whisper's own words,
// without Whisper being installed.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "words");
const CLI = join(__dirname, "..", "dist", "index.js");
const fixture = (name) => join(FIXTURES, name);
// Only node's own directory on PATH: no whisper binary can be found.
const NO_WHISPER_ENV = { PATH: dirname(process.execPath) };

function trackTexts(draftPath, trackName = "captions") {
  const draft = JSON.parse(readFileSync(draftPath, "utf-8"));
  const track = draft.tracks.find((t) => t.type === "text" && t.name === trackName);
  assert.ok(track, `track ${trackName} present`);
  return track.segments.map((s) => {
    const mat = draft.materials.texts.find((m) => m.id === s.material_id);
    return { start: s.target_timerange.start, text: JSON.parse(mat.content).text };
  });
}

function tmpWords(t, content) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-caption-words-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "words.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("parseWordTimings format detection", () => {
  it("reads openai-whisper segments[].words[] as whisper", () => {
    const parsed = parseWordTimings(readFileSync(fixture("whisper.json"), "utf-8"));
    assert.equal(parsed.format, "whisper");
    assert.equal(parsed.skipped, 0);
    assert.deepEqual(parsed.words[0], { word: "Hello", startUs: 0, endUs: 400_000 });
    assert.equal(parsed.words.length, 5);
  });

  it("reads WhisperX word_segments and counts unaligned words as skipped", () => {
    const parsed = parseWordTimings(readFileSync(fixture("whisperx.json"), "utf-8"));
    assert.equal(parsed.format, "whisperx");
    assert.equal(parsed.skipped, 1);
    assert.deepEqual(
      parsed.words.map((w) => w.word),
      ["We", "shipped", "drafts", "today."],
    );
  });

  it("recognises WhisperX segments[].words[] by the per-word score", () => {
    const raw = JSON.parse(readFileSync(fixture("whisperx.json"), "utf-8"));
    delete raw.word_segments;
    const parsed = parseWordTimings(JSON.stringify(raw));
    assert.equal(parsed.format, "whisperx");
    assert.equal(parsed.skipped, 1);
  });

  it("reads plain lists with start_time/end_time (Qwen3) and start_ms/end_ms", () => {
    const zh = parseWordTimings(readFileSync(fixture("qwen3-zh.json"), "utf-8"));
    assert.equal(zh.format, "word-list");
    assert.equal(zh.words.length, 18);
    assert.deepEqual(zh.words[1], { word: "天", startUs: 200_000, endUs: 400_000 });
    const ms = parseWordTimings(readFileSync(fixture("word-list-ms.json"), "utf-8"));
    assert.deepEqual(ms.words[0], { word: "Cut", startUs: 1_000_000, endUs: 1_300_000 });
  });

  it("accepts a char key and seconds start/end", () => {
    const parsed = parseWordTimings(JSON.stringify([{ char: "好", start: 0.5, end: 0.7 }]));
    assert.deepEqual(parsed.words, [{ word: "好", startUs: 500_000, endUs: 700_000 }]);
  });

  it("refuses end before start, naming the entry", () => {
    assert.throws(
      () =>
        parseWordTimings(
          JSON.stringify([
            { word: "a", start: 0, end: 0.2 },
            { word: "b", start: 0.5, end: 0.3 },
          ]),
        ),
      /refused \[words-invalid\]: entry \[1\] \("b"\) ends before it starts/,
    );
  });

  it("refuses out-of-order entries, naming both", () => {
    assert.throws(
      () =>
        parseWordTimings(
          JSON.stringify({
            segments: [
              {
                words: [
                  { word: "a", start: 1, end: 1.2 },
                  { word: "b", start: 0.5, end: 0.7 },
                ],
              },
            ],
          }),
        ),
      /refused \[words-invalid\]: entry segments\[0\]\.words\[1\] \("b"\) starts before entry segments\[0\]\.words\[0\]/,
    );
  });

  it("refuses JSON that carries no word timings", () => {
    assert.throws(() => parseWordTimings('{"text":"hi"}'), /refused \[words-format\]/);
    assert.throws(() => parseWordTimings("not json"), /refused \[words-format\]: --words is not valid JSON/);
  });
});

describe("capcut caption --words", () => {
  it("captions a whisper JSON without whisper installed", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const r = spawnCli(["caption", fix.path, "--words", fixture("whisper.json")], { env: NO_WHISPER_ENV });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.engine, "words");
    assert.equal(r.json.words_format, "whisper");
    assert.equal(r.json.words_skipped, 0);
    assert.equal(r.json.words, 5);
    assert.equal(r.json.source_words, fixture("whisper.json"));
    assert.equal(r.json.source_audio, undefined);
    assert.deepEqual(trackTexts(fix.path), [{ start: 0, text: "Hello world from the timeline." }]);
  });

  it("splits WhisperX words at a pause and reports the skipped entry", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const r = spawnCli(["caption", fix.path, "--words", fixture("whisperx.json")]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.words_format, "whisperx");
    assert.equal(r.json.words_skipped, 1);
    assert.deepEqual(
      trackTexts(fix.path).map((c) => c.text),
      ["We shipped", "drafts today."],
    );
  });

  it("joins Chinese per-character Qwen3 output into space-free cues", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const r = spawnCli(["caption", fix.path, "--words", fixture("qwen3-zh.json")], { env: NO_WHISPER_ENV });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.words_format, "word-list");
    assert.equal(r.json.caption_script, "zh");
    assert.deepEqual(
      trackTexts(fix.path).map((c) => c.text),
      ["今天我们来聊一聊剪映草稿的自动化", "处理"],
    );
  });

  it("places cues at the timings' own positions (start_ms list)", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const r = spawnCli(["caption", fix.path, "--words", fixture("word-list-ms.json")]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(trackTexts(fix.path), [
      { start: 1_000_000, text: "Cut the silence" },
      { start: 3_000_000, text: "first" },
    ]);
  });

  it("drives --karaoke and --word-reveal like whisper words", (t) => {
    const karaoke = tmpDraft();
    t.after(() => karaoke.cleanup());
    const k = spawnCli(["caption", karaoke.path, "--words", fixture("whisper.json"), "--karaoke"]);
    assert.equal(k.status, 0, `stderr: ${k.stderr}`);
    assert.equal(k.json.cues, 5, "one karaoke segment per word");
    assert.equal(k.json.first_cue.text, "Hello world from the");

    const reveal = tmpDraft();
    t.after(() => reveal.cleanup());
    const w = spawnCli(["caption", reveal.path, "--words", fixture("word-list-ms.json"), "--word-reveal"]);
    assert.equal(w.status, 0, `stderr: ${w.stderr}`);
    assert.deepEqual(
      trackTexts(reveal.path).map((c) => c.text),
      ["Cut", "Cut the", "Cut the silence", "first"],
    );
  });

  it("keeps the --script wording on the aligner's timing", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const script = tmpWords(t, "今天我们来聊一聊\n剪映草稿的自动化处理\n");
    const r = spawnCli(["caption", fix.path, "--words", fixture("qwen3-zh.json"), "--script", script]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.script.matched, 18);
    assert.deepEqual(trackTexts(fix.path), [
      { start: 0, text: "今天我们来聊一聊" },
      { start: 1_600_000, text: "剪映草稿的自动化处理" },
    ]);
  });

  it("reads the timings from stdin with --words -", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const r = spawnCli(["caption", fix.path, "--words", "-"], {
      input: readFileSync(fixture("word-list-ms.json"), "utf-8"),
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.source_words, "stdin");
    assert.equal(r.json.words, 4);
  });

  it("refuses invalid timings without touching the draft", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const before = readFileSync(fix.path, "utf-8");
    const bad = tmpWords(t, [
      { word: "a", start: 0, end: 0.2 },
      { word: "b", start: 0.6, end: 0.4 },
    ]);
    const r = spawnCli(["caption", fix.path, "--words", bad]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refused \[words-invalid\]: entry \[1\]/);
    assert.equal(readFileSync(fix.path, "utf-8"), before);
  });

  it("refuses a file where no entry has timing", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const empty = tmpWords(t, [{ word: "a" }, { word: "b" }]);
    const r = spawnCli(["caption", fix.path, "--words", empty]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no timed words \(2 entries without timing skipped\)/);
  });

  for (const extra of [
    ["--audio", "voice.wav"],
    ["--from-segment", "abc"],
    ["--whisper-model", "small"],
    ["--audio-stream", "1"],
  ]) {
    it(`is mutually exclusive with ${extra[0]}`, (t) => {
      const fix = tmpDraft();
      t.after(() => fix.cleanup());
      const r = spawnCli(["caption", fix.path, "--words", fixture("whisper.json"), ...extra]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, new RegExp(`--words is mutually exclusive with ${extra[0]}`));
    });
  }

  it("is declared in describe", () => {
    const r = spawnCli(["describe", "--command", "caption"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /--words/);
  });
});

describe("doctor whisper hint", () => {
  it("names the Whisper-free routes when no whisper is on PATH, still as a warning", () => {
    const r = spawnSync(process.execPath, [CLI, "doctor"], {
      encoding: "utf-8",
      env: { ...process.env, ...NO_WHISPER_ENV },
    });
    const report = JSON.parse(r.stdout);
    const whisper = report.checks.find((c) => c.name === "whisper");
    if (whisper.status === "ok") return; // a whisper beside node: nothing to hint
    assert.equal(whisper.status, "warn");
    assert.match(whisper.fix, /caption --words/);
    assert.match(whisper.fix, /import-srt/);
  });
});
