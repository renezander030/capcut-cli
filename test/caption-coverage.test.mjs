import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { captionCoverage, mergeSpans, subtractSpans, uncaptionedWarning } from "../dist/caption-coverage.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// After `caption` transcribes, the speech in the audio (ffmpeg silencedetect)
// is compared with the cues: speech no cue covers is reported. The span math
// is asserted directly; the CLI path runs a fake whisper over a generated
// tone/silence clip.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_WHISPER = join(__dirname, "helpers", "fake-whisper.mjs");
const isWindows = process.platform === "win32"; // fake whisper is a shebang script
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;

// Speech at 0-2, 3-5 and 6-9 seconds of a 10 s clip.
const SPEECH = [
  { start: 0, end: 2 },
  { start: 3, end: 5 },
  { start: 6, end: 9 },
];

describe("caption coverage span math", () => {
  it("merges overlapping and touching spans and drops empty ones", () => {
    assert.deepEqual(
      mergeSpans([
        { start: 3, end: 4 },
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 3.5, end: 5 },
        { start: 7, end: 7 },
      ]),
      [
        { start: 0, end: 2 },
        { start: 3, end: 5 },
      ],
    );
  });

  it("subtracts the covered parts, keeping what is left over", () => {
    assert.deepEqual(
      subtractSpans(
        [
          { start: 0, end: 10 },
          { start: 12, end: 14 },
        ],
        [
          { start: 1, end: 2 },
          { start: 1.5, end: 3 },
          { start: 9, end: 13 },
        ],
      ),
      [
        { start: 0, end: 1 },
        { start: 3, end: 9 },
        { start: 13, end: 14 },
      ],
    );
    assert.deepEqual(subtractSpans([{ start: 0, end: 5 }], []), [{ start: 0, end: 5 }]);
    assert.deepEqual(subtractSpans([{ start: 0, end: 5 }], [{ start: -1, end: 6 }]), []);
  });

  it("a transcription that stops early leaves the tail uncaptioned", () => {
    const coverage = captionCoverage(SPEECH, [
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
    assert.deepEqual(coverage, {
      speech_s: 7,
      captioned_s: 4,
      ratio: 0.5714,
      uncaptioned: [{ start_s: 6, end_s: 9 }],
      tail_uncaptioned_s: 3,
    });
  });

  it("an internal gap is listed but is not tail", () => {
    const coverage = captionCoverage(SPEECH, [
      { start: 0, end: 2 },
      { start: 6, end: 9 },
    ]);
    assert.deepEqual(coverage.uncaptioned, [{ start_s: 3, end_s: 5 }]);
    assert.equal(coverage.tail_uncaptioned_s, 0);
    assert.equal(coverage.captioned_s, 5);
  });

  it("full coverage lists nothing; slivers below the minimum still count in the ratio", () => {
    const full = captionCoverage(SPEECH, [
      { start: 0, end: 2.5 },
      { start: 2.9, end: 9 },
    ]);
    assert.deepEqual(full, { speech_s: 7, captioned_s: 7, ratio: 1, uncaptioned: [], tail_uncaptioned_s: 0 });
    const early = captionCoverage(SPEECH, [
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 8 },
    ]);
    assert.deepEqual(early.uncaptioned, [], "a 1 s miss is below the 1.5 s default");
    assert.equal(early.captioned_s, 6);
    assert.equal(captionCoverage(SPEECH, [{ start: 0, end: 8 }], 1).uncaptioned.length, 1);
  });

  it("audio without speech counts as covered", () => {
    assert.deepEqual(captionCoverage([], [{ start: 0, end: 1 }]), {
      speech_s: 0,
      captioned_s: 0,
      ratio: 1,
      uncaptioned: [],
      tail_uncaptioned_s: 0,
    });
  });

  it("the warning names every span and the tail", () => {
    const warning = uncaptionedWarning(
      captionCoverage(SPEECH, [
        { start: 0, end: 2 },
        { start: 6, end: 7 },
      ]),
    );
    assert.match(warning, /^\[uncaptioned-speech\] 4\.00s of speech in 2 spans has no caption \(43%/);
    assert.match(warning, /3\.00-5\.00s, 7\.00-9\.00s/);
    assert.match(warning, /2\.00s of it comes after the last cue/);
    assert.ok(warning.endsWith("\n"));
  });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-caption-coverage-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 2 s tone, 1 s silence, 2 s tone, 1 s silence, 3 s tone, 1 s silence. */
function makeSpeechClip(dir) {
  const clip = join(dir, "speech.wav");
  const parts = [
    ["sine", 2],
    ["silence", 1],
    ["sine", 2],
    ["silence", 1],
    ["sine", 3],
    ["silence", 1],
  ];
  const inputs = parts.flatMap(([kind, d]) => [
    "-f",
    "lavfi",
    "-i",
    kind === "sine" ? `sine=frequency=440:sample_rate=16000:duration=${d}` : `anullsrc=r=16000:cl=mono:d=${d}`,
  ]);
  const labels = parts.map((_, i) => `[${i}:a]`).join("");
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      ...inputs,
      "-filter_complex",
      `${labels}concat=n=${parts.length}:v=0:a=1[a]`,
      "-map",
      "[a]",
      "-ac",
      "1",
      clip,
    ],
    { encoding: "utf-8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return clip;
}

function srt(cues) {
  const stamp = (s) => {
    const ms = Math.round(s * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `00:00:${pad(Math.floor(ms / 1000))},${pad(ms % 1000, 3)}`;
  };
  return cues.map(([start, end, text], i) => `${i + 1}\n${stamp(start)} --> ${stamp(end)}\n${text}\n`).join("\n");
}

function caption(t, cues, extra = [], audio) {
  const fix = tmpDraft();
  const s = scratch();
  t.after(fix.cleanup);
  t.after(s.cleanup);
  const clip = audio ?? makeSpeechClip(s.dir);
  const heard = join(s.dir, "heard.srt");
  writeFileSync(heard, srt(cues));
  return spawnCli(["caption", fix.path, "--audio", clip, "--whisper-cmd", FAKE_WHISPER, ...extra], {
    env: { FAKE_WHISPER_SOURCE: heard },
  });
}

const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 0.1, `${label}: ${actual} is not ~${expected}`);

describe("caption coverage check (CLI)", { skip: isWindows }, () => {
  it("reports a truncated tail and warns once on stderr", { skip: !hasFfmpeg }, (t) => {
    const r = caption(t, [
      [0, 2, "first words"],
      [3, 5, "then more"],
    ]);
    assert.equal(r.status, 0, r.stderr);
    const c = r.json.coverage;
    near(c.speech_s, 7, "speech_s");
    near(c.captioned_s, 4, "captioned_s");
    assert.equal(c.uncaptioned.length, 1, JSON.stringify(c));
    near(c.uncaptioned[0].start_s, 6, "uncaptioned start");
    near(c.uncaptioned[0].end_s, 9, "uncaptioned end");
    near(c.tail_uncaptioned_s, 3, "tail");
    assert.ok(c.ratio > 0.5 && c.ratio < 0.65, `ratio ${c.ratio}`);
    const warnings = r.stderr.split("\n").filter((line) => line.startsWith("[uncaptioned-speech]"));
    assert.equal(warnings.length, 1, r.stderr);
    assert.match(warnings[0], /after the last cue/);
  });

  it("reports an internal gap without a tail", { skip: !hasFfmpeg }, (t) => {
    const r = caption(t, [
      [0, 2, "first words"],
      [6, 9, "the ending"],
    ]);
    assert.equal(r.status, 0, r.stderr);
    const c = r.json.coverage;
    assert.equal(c.uncaptioned.length, 1, JSON.stringify(c));
    near(c.uncaptioned[0].start_s, 3, "uncaptioned start");
    near(c.uncaptioned[0].end_s, 5, "uncaptioned end");
    assert.equal(c.tail_uncaptioned_s, 0);
    assert.match(r.stderr, /^\[uncaptioned-speech\]/m);
    assert.doesNotMatch(r.stderr, /after the last cue/);
  });

  it("full coverage lists nothing and stays quiet", { skip: !hasFfmpeg }, (t) => {
    const r = caption(t, [
      [0, 2, "first words"],
      [3, 5, "then more"],
      [6, 9, "the ending"],
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.coverage.uncaptioned, []);
    assert.equal(r.json.coverage.tail_uncaptioned_s, 0);
    assert.ok(r.json.coverage.ratio > 0.97, `ratio ${r.json.coverage.ratio}`);
    assert.doesNotMatch(r.stderr, /uncaptioned-speech/);
  });

  it("--min-uncaptioned raises the bar for what is listed", { skip: !hasFfmpeg }, (t) => {
    const r = caption(
      t,
      [
        [0, 2, "first words"],
        [3, 5, "then more"],
      ],
      ["--min-uncaptioned", "5"],
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.coverage.uncaptioned, []);
    assert.ok(r.json.coverage.ratio < 0.65, "the missing tail still lowers the ratio");
    assert.doesNotMatch(r.stderr, /uncaptioned-speech/);
  });

  it("is skipped, not fatal, when ffmpeg is missing", (t) => {
    const s = scratch();
    t.after(s.cleanup);
    const audio = join(s.dir, "voice.wav");
    writeFileSync(audio, "stub");
    const r = caption(t, [[0, 1, "hello"]], ["--ffmpeg-cmd", join(s.dir, "no-such-ffmpeg")], audio);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.coverage, { skipped: "ffmpeg not found" });
    assert.equal(r.json.cues, 1);
    assert.doesNotMatch(r.stderr, /uncaptioned-speech/);
  });

  it("--no-coverage leaves the check out", (t) => {
    const s = scratch();
    t.after(s.cleanup);
    const audio = join(s.dir, "voice.wav");
    writeFileSync(audio, "stub");
    const r = caption(t, [[0, 1, "hello"]], ["--no-coverage"], audio);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.coverage, undefined);
  });

  it("--words reads no audio, so there is nothing to measure", (t) => {
    const fix = tmpDraft();
    const s = scratch();
    t.after(fix.cleanup);
    t.after(s.cleanup);
    const words = join(s.dir, "words.json");
    writeFileSync(words, JSON.stringify([{ word: "hello", start: 0, end: 0.5 }]));
    const r = spawnCli(["caption", fix.path, "--words", words]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.coverage, undefined);
  });

  it("refuses a negative --min-uncaptioned", (t) => {
    const r = caption(t, [[0, 1, "hello"]], ["--min-uncaptioned", "-1"], "/dev/null");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--min-uncaptioned/);
  });
});
