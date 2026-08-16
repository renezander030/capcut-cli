import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { collapseKaraokeRuns, parseSrt, renderVtt } from "../dist/srt.js";
import { srtTime, vttTime } from "../dist/time.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDir } from "./helpers/tmp-draft.mjs";

function initDraft(dir, name) {
  const r = spawnCli(["init", name, "--drafts", dir]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return join(dir, name);
}

function addText(project, start, duration, text) {
  const r = spawnCli(["add-text", project, start, duration, text]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return r.json.segment_id;
}

describe("export-srt — line granularity (default)", () => {
  const t = tmpDir();
  after(() => t.cleanup());

  let project;
  before(() => {
    project = initDraft(t.dir, "phrases");
    const srt = "1\n00:00:01,000 --> 00:00:04,000\nhello brave world\n\n2\n00:00:05,000 --> 00:00:06,000\nbye\n";
    const r = spawnCli(["import-srt", project, "-"], { input: srt });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });

  it("emits phrase-level SRT and round-trips through parseSrt", () => {
    const r = spawnCli(["export-srt", project]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /00:00:01,000 --> 00:00:04,000/);
    const cues = parseSrt(r.stdout);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, "hello brave world");
    assert.equal(cues[0].startUs, 1_000_000);
    assert.equal(cues[0].endUs, 4_000_000);
  });

  it("--format vtt emits a WEBVTT header with dot milliseconds", () => {
    const r = spawnCli(["export-srt", project, "--format", "vtt"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^WEBVTT\n\n/);
    assert.match(r.stdout, /00:00:01\.000 --> 00:00:04\.000\nhello brave world/);
    assert.doesNotMatch(r.stdout, /,\d{3}/);
  });

  it("--granularity word interpolates cue timings by word length", () => {
    const r = spawnCli(["export-srt", project, "--granularity", "word"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // hello/brave/world are 5 chars each: the 3s cue splits into equal thirds.
    const cues = parseSrt(r.stdout);
    assert.equal(cues.length, 4);
    assert.deepEqual(
      cues.map((c) => c.text),
      ["hello", "brave", "world", "bye"],
    );
    assert.equal(cues[0].startUs, 1_000_000);
    assert.equal(cues[0].endUs, 2_000_000);
    assert.equal(cues[1].startUs, 2_000_000);
    assert.equal(cues[2].endUs, 4_000_000);
  });
});

describe("export-srt — karaoke word timings", () => {
  const t = tmpDir();
  after(() => t.cleanup());

  let project;
  before(() => {
    // Rebuild what `caption --karaoke` writes (src/caption.ts): one
    // full-phrase segment per word, word-timed, that word's range highlighted.
    project = initDraft(t.dir, "karaoke");
    const words = [
      ["1s", "0.4s", 0, 3],
      ["1.4s", "0.4s", 4, 7],
      ["1.8s", "0.7s", 8, 13],
    ];
    for (const [start, duration, from, to] of words) {
      const id = addText(project, start, duration, "one two three");
      const styles = JSON.stringify([{ start: from, end: to, font_color: "#FFD700", bold: true }]);
      const r = spawnCli(["text-ranges", project, id, "--styles", styles]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    }
  });

  it("exports the stored word timings as one SRT cue per word", () => {
    const r = spawnCli(["export-srt", project, "--granularity", "word"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const cues = parseSrt(r.stdout);
    assert.deepEqual(
      cues.map((c) => c.text),
      ["one", "two", "three"],
    );
    // Real stored timings, not length-weighted interpolation.
    assert.equal(cues[1].startUs, 1_400_000);
    assert.equal(cues[1].endUs, 1_800_000);
    assert.equal(cues[2].endUs, 2_500_000);
  });

  it("emits one VTT cue per phrase with inline word timestamps", () => {
    const r = spawnCli(["export-srt", project, "--granularity", "word", "--format", "vtt"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^WEBVTT\n\n/);
    assert.match(r.stdout, /00:00:01\.000 --> 00:00:02\.500\none <00:00:01\.400>two <00:00:01\.800>three/);
  });

  it("keeps line granularity as-is: one cue per stored segment", () => {
    const r = spawnCli(["export-srt", project]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const cues = parseSrt(r.stdout);
    assert.equal(cues.length, 3);
    for (const cue of cues) assert.equal(cue.text, "one two three");
  });
});

describe("export-srt — repeated karaoke phrase collapses per repetition", () => {
  const t = tmpDir();
  after(() => t.cleanup());

  let project;
  before(() => {
    // The SAME phrase spoken twice back-to-back: caption --karaoke writes
    // 2x2 adjacent same-text segments whose highlight ranges cycle. Each
    // cycle must collapse into its own cue with the real word timings.
    project = initDraft(t.dir, "chorus");
    const words = [
      ["0s", "0.5s", 0, 5], // hello (1st repetition)
      ["0.5s", "0.5s", 6, 11], // world
      ["1s", "0.5s", 0, 5], // hello (2nd repetition)
      ["1.5s", "0.5s", 6, 11], // world
    ];
    for (const [start, duration, from, to] of words) {
      const id = addText(project, start, duration, "hello world");
      const styles = JSON.stringify([{ start: from, end: to, font_color: "#FFD700", bold: true }]);
      const r = spawnCli(["text-ranges", project, id, "--styles", styles]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    }
  });

  it("word SRT emits 4 cues with the stored timings, not 8 interpolated ones", () => {
    const r = spawnCli(["export-srt", project, "--granularity", "word"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const cues = parseSrt(r.stdout);
    assert.deepEqual(
      cues.map((c) => c.text),
      ["hello", "world", "hello", "world"],
    );
    assert.deepEqual(
      cues.map((c) => [c.startUs, c.endUs]),
      [
        [0, 500_000],
        [500_000, 1_000_000],
        [1_000_000, 1_500_000],
        [1_500_000, 2_000_000],
      ],
    );
  });

  it("word VTT emits one karaoke cue per repetition", () => {
    const r = spawnCli(["export-srt", project, "--granularity", "word", "--format", "vtt"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /00:00:00\.000 --> 00:00:01\.000\nhello <00:00:00\.500>world/);
    assert.match(r.stdout, /00:00:01\.000 --> 00:00:02\.000\nhello <00:00:01\.500>world/);
  });

  it("keeps a rejected karaoke segment as its own highlighted word (no full-phrase explosion)", () => {
    // Segments stored out of start order fail run validation; each must
    // still export as ONE word at its own time, never the whole phrase
    // interpolated into a single word's timeslot.
    const entries = [
      { startUs: 1_000_000, endUs: 1_500_000, text: "hi yo", styleRanges: [[0, 2]] },
      { startUs: 0, endUs: 500_000, text: "hi yo", styleRanges: [[3, 5]] },
    ];
    const cues = collapseKaraokeRuns(entries);
    assert.equal(cues.length, 2);
    assert.deepEqual(cues[0].words, [{ word: "hi", startUs: 1_000_000, endUs: 1_500_000 }]);
    assert.deepEqual(cues[1].words, [{ word: "yo", startUs: 0, endUs: 500_000 }]);
  });

  it("still interpolates a lone caption that merely emphasizes one word", () => {
    const entries = [{ startUs: 0, endUs: 1_000_000, text: "hi yo", styleRanges: [[0, 2]] }];
    const cues = collapseKaraokeRuns(entries);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].words, undefined);
  });
});

describe("srtTime/vttTime — millisecond rollover carries into seconds", () => {
  it("carries a rounded-up millisecond field instead of emitting ,1000", () => {
    assert.equal(srtTime(1_999_999), "00:00:02,000");
    assert.equal(vttTime(1_999_999), "00:00:02.000");
  });

  it("carries across minute and hour boundaries", () => {
    assert.equal(vttTime(3_599_999_600), "01:00:00.000");
    assert.equal(srtTime(59_999_700), "00:01:00,000");
  });

  it("leaves non-rollover timestamps unchanged", () => {
    assert.equal(srtTime(1_234_567), "00:00:01,235");
    assert.equal(vttTime(1_400_000), "00:00:01.400");
  });

  it("export-srt --format vtt emits a spec-valid 3-digit fraction for rollover ends", () => {
    const t = tmpDir();
    try {
      const project = initDraft(t.dir, "rollover");
      addText(project, "0s", "1.999999s", "hello world");
      const r = spawnCli(["export-srt", project, "--format", "vtt"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /00:00:00\.000 --> 00:00:02\.000\nhello world/);
      assert.doesNotMatch(r.stdout, /\.\d{4}/);
    } finally {
      t.cleanup();
    }
  });
});

describe("renderVtt — inline timestamps and cue-text escaping", () => {
  it("skips inline timestamps equal to the cue start or a previous timestamp", () => {
    // Whisper can emit coincident word starts; a duplicate timestamp is
    // invalid per the WebVTT spec, so the word joins the previous group.
    const entries = [
      { startUs: 0, endUs: 400_000, text: "a b", styleRanges: [[0, 1]] },
      { startUs: 0, endUs: 800_000, text: "a b", styleRanges: [[2, 3]] },
    ];
    const vtt = renderVtt(collapseKaraokeRuns(entries), true);
    assert.match(vtt, /00:00:00\.000 --> 00:00:00\.800\na b\n/);
    assert.doesNotMatch(vtt, /<00:00:00\.000>/);
  });

  it("keeps strictly later timestamps after a skipped duplicate", () => {
    const entries = [
      { startUs: 0, endUs: 300_000, text: "a b c", styleRanges: [[0, 1]] },
      { startUs: 0, endUs: 600_000, text: "a b c", styleRanges: [[2, 3]] },
      { startUs: 600_000, endUs: 900_000, text: "a b c", styleRanges: [[4, 5]] },
    ];
    const vtt = renderVtt(collapseKaraokeRuns(entries), true);
    assert.match(vtt, /a b <00:00:00\.600>c/);
  });

  it("escapes & and < in VTT cue text so nothing is swallowed as a tag", () => {
    const t = tmpDir();
    try {
      const project = initDraft(t.dir, "escape");
      addText(project, "0s", "1s", "i <3 this & that");
      const vtt = spawnCli(["export-srt", project, "--format", "vtt"]);
      assert.equal(vtt.status, 0, `stderr: ${vtt.stderr}`);
      assert.match(vtt.stdout, /i &lt;3 this &amp; that/);
      const word = spawnCli(["export-srt", project, "--format", "vtt", "--granularity", "word"]);
      assert.equal(word.status, 0, `stderr: ${word.stderr}`);
      assert.match(word.stdout, /<00:00:0\d\.\d{3}>&lt;3/);
      // SRT has no markup semantics: text stays raw.
      const srt = spawnCli(["export-srt", project]);
      assert.equal(srt.status, 0, `stderr: ${srt.stderr}`);
      assert.match(srt.stdout, /i <3 this & that/);
    } finally {
      t.cleanup();
    }
  });
});

describe("export-srt — flag validation and empty drafts", () => {
  const t = tmpDir();
  after(() => t.cleanup());

  it("rejects unknown --granularity and --format values", () => {
    const badGranularity = spawnCli(["export-srt", "unused", "--granularity", "sentence"]);
    assert.notEqual(badGranularity.status, 0);
    assert.match(badGranularity.stderr, /--granularity must be line\|word/);
    const badFormat = spawnCli(["export-srt", "unused", "--format", "ass"]);
    assert.notEqual(badFormat.status, 0);
    assert.match(badFormat.stderr, /--format must be srt\|vtt/);
  });

  it("succeeds with empty output when the draft has no text track", () => {
    const project = initDraft(t.dir, "no-text");
    const srt = spawnCli(["export-srt", project, "--granularity", "word"]);
    assert.equal(srt.status, 0, `stderr: ${srt.stderr}`);
    assert.equal(srt.stdout, "");
    const vtt = spawnCli(["export-srt", project, "--format", "vtt"]);
    assert.equal(vtt.status, 0, `stderr: ${vtt.stderr}`);
    assert.equal(vtt.stdout, "WEBVTT\n\n");
  });
});
