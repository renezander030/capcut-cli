import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildKeepSpans,
  closeSilenceSpans,
  detectSilence,
  limitSilences,
  padSilenceSpans,
  parseSilenceSpans,
  spansToSegments,
} from "../dist/silence.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const US = 1_000_000;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;
const isWindows = process.platform === "win32"; // fake-ffmpeg tests use /bin/sh scripts

// 1s tone + 1s silence + 1s tone -> one silence span at ~[1, 2].
function makeSilenceClip(dir) {
  const clip = join(dir, "speech.wav");
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=1",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=mono:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=1",
      "-filter_complex",
      "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]",
      "-map",
      "[a]",
      clip,
    ],
    { encoding: "utf-8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return clip;
}

const SILENCE_STDERR = [
  "Input #0, wav, from 'speech.wav':",
  "  Duration: 00:00:10.00, start: 0.000000, bitrate: 768 kb/s",
  "[silencedetect @ 0x1] silence_start: 1",
  "[silencedetect @ 0x1] silence_end: 3.5 | silence_duration: 2.5",
  "[silencedetect @ 0x1] silence_start: 6",
  "[silencedetect @ 0x1] silence_end: 7 | silence_duration: 1",
].join("\n");

describe("detect-silence — parsing + span math (pure)", () => {
  it("pairs silence_start with the following silence_end", () => {
    assert.deepEqual(parseSilenceSpans(SILENCE_STDERR), [
      { start: 1, end: 3.5 },
      { start: 6, end: 7 },
    ]);
  });

  it("parses CRLF stderr identically", () => {
    assert.deepEqual(parseSilenceSpans(SILENCE_STDERR.replaceAll("\n", "\r\n")), [
      { start: 1, end: 3.5 },
      { start: 6, end: 7 },
    ]);
  });

  it("keeps an unmatched silence_start open-ended (silence to EOF)", () => {
    const stderr = `${SILENCE_STDERR}\n[silencedetect @ 0x1] silence_start: 8.25`;
    assert.deepEqual(parseSilenceSpans(stderr).at(-1), { start: 8.25, end: null });
  });

  it("clamps ffmpeg's slightly-negative leading silence_start to 0", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: -0.00119",
      "[silencedetect @ 0x1] silence_end: 2 | silence_duration: 2.00119",
    ].join("\n");
    assert.deepEqual(parseSilenceSpans(stderr), [{ start: 0, end: 2 }]);
  });

  it("returns [] on unrelated or empty stderr", () => {
    assert.deepEqual(parseSilenceSpans("Duration: 00:00:03.00\nnothing else"), []);
    assert.deepEqual(parseSilenceSpans(""), []);
    // an end with no start is noise, not a span
    assert.deepEqual(parseSilenceSpans("[silencedetect @ 0x1] silence_end: 3 | silence_duration: 3"), []);
  });

  it("closeSilenceSpans closes an open span at the duration and clamps overruns", () => {
    assert.deepEqual(closeSilenceSpans([{ start: 8, end: null }], 10), [{ start: 8, end: 10 }]);
    assert.deepEqual(
      closeSilenceSpans(
        [
          { start: 1, end: 12 },
          { start: 11, end: null },
        ],
        10,
      ),
      [{ start: 1, end: 10 }],
    );
    // unknown duration passes spans through untouched
    assert.deepEqual(closeSilenceSpans([{ start: 8, end: null }], null), [{ start: 8, end: null }]);
  });

  it("padSilenceSpans shrinks both ends and never goes negative", () => {
    assert.deepEqual(padSilenceSpans([{ start: 1, end: 3 }], 0.25), [{ start: 1.25, end: 2.75 }]);
    // a span not longer than 2*pad disappears
    assert.deepEqual(padSilenceSpans([{ start: 1, end: 1.5 }], 0.25), []);
    assert.deepEqual(padSilenceSpans([{ start: 1, end: 1.4 }], 0.25), []);
    // pad 0 is a no-op
    assert.deepEqual(padSilenceSpans([{ start: 1, end: 3 }], 0), [{ start: 1, end: 3 }]);
    // an open-ended span pads only its start — no speech follows it
    assert.deepEqual(padSilenceSpans([{ start: 8, end: null }], 0.25), [{ start: 8.25, end: null }]);
  });

  it("limitSilences keeps the N longest, back in time order", () => {
    const spans = [
      { start: 1, end: 2 }, // 1s
      { start: 4, end: 7 }, // 3s
      { start: 9, end: 11 }, // 2s
    ];
    assert.deepEqual(limitSilences(spans, 2), [
      { start: 4, end: 7 },
      { start: 9, end: 11 },
    ]);
    assert.deepEqual(limitSilences(spans, undefined), spans);
    // a silence to EOF always counts as longest
    assert.deepEqual(limitSilences([...spans, { start: 20, end: null }], 1), [{ start: 20, end: null }]);
  });

  it("buildKeepSpans complements the silences over 0..duration", () => {
    assert.deepEqual(
      buildKeepSpans(
        [
          { start: 1, end: 3.5 },
          { start: 6, end: 7 },
        ],
        10,
      ),
      [
        { start: 0, end: 1 },
        { start: 3.5, end: 6 },
        { start: 7, end: 10 },
      ],
    );
    // no silence at all -> keep the whole file
    assert.deepEqual(buildKeepSpans([], 10), [{ start: 0, end: 10 }]);
    // all silence -> nothing to keep
    assert.deepEqual(buildKeepSpans([{ start: 0, end: 10 }], 10), []);
    // silence at t=0 -> no head keep segment
    assert.deepEqual(buildKeepSpans([{ start: 0, end: 2 }], 10), [{ start: 2, end: 10 }]);
  });

  it("buildKeepSpans handles open ends: EOF silence keeps nothing after it", () => {
    assert.deepEqual(buildKeepSpans([{ start: 8, end: null }], null), [{ start: 0, end: 8 }]);
    // unknown duration with closed silences leaves the tail open
    assert.deepEqual(buildKeepSpans([{ start: 1, end: 2 }], null), [
      { start: 0, end: 1 },
      { start: 2, end: null },
    ]);
  });

  it("spansToSegments carries seconds and draft-native microseconds", () => {
    assert.deepEqual(spansToSegments([{ start: 1, end: 2.5 }]), [
      { start: 1, end: 2.5, duration: 1.5, start_us: US, end_us: 2.5 * US, duration_us: 1.5 * US },
    ]);
    assert.deepEqual(spansToSegments([{ start: 2, end: null }]), [
      { start: 2, end: null, duration: null, start_us: 2 * US, end_us: null, duration_us: null },
    ]);
  });
});

describe("detect-silence — CLI", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "capcut-detect-silence-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("detects the silence span and returns draft-ready keep segments", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    const clip = makeSilenceClip(s.dir);
    const r = spawnCli(["detect-silence", clip, "--min-silence", "0.3", "--pad", "0"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.silences.length, 1, JSON.stringify(r.json.silences));
    assert.ok(Math.abs(r.json.silences[0].start - 1) < 0.2, `silence starts at ${r.json.silences[0].start}`);
    assert.ok(Math.abs(r.json.silences[0].end - 2) < 0.2, `silence ends at ${r.json.silences[0].end}`);
    assert.ok(Math.abs(r.json.duration - 3) < 0.2);
    assert.equal(r.json.keeps.length, 2);
    assert.equal(r.json.keeps[0].start, 0);
    for (const seg of [...r.json.silences, ...r.json.keeps]) {
      assert.equal(seg.start_us, Math.round(seg.start * US));
      assert.equal(seg.end_us, Math.round(seg.end * US));
      assert.equal(seg.duration_us, seg.end_us - seg.start_us);
    }
    // silences and keeps tile the clip: keep, silence, keep
    assert.equal(r.json.keeps[0].end, r.json.silences[0].start);
    assert.equal(r.json.keeps[1].start, r.json.silences[0].end);
  });

  it("--pad shrinks the silence span on both ends (default 0.1)", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    const clip = makeSilenceClip(s.dir);
    const padded = spawnCli(["detect-silence", clip, "--min-silence", "0.3", "--pad", "0.2"]);
    assert.equal(padded.status, 0, padded.stderr);
    const bare = spawnCli(["detect-silence", clip, "--min-silence", "0.3", "--pad", "0"]);
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(padded.json.silences.length, 1);
    const span = padded.json.silences[0];
    const raw = bare.json.silences[0];
    assert.ok(Math.abs(span.start - (raw.start + 0.2)) < 0.01, `padded start ${span.start} vs raw ${raw.start}`);
    assert.ok(Math.abs(span.end - (raw.end - 0.2)) < 0.01, `padded end ${span.end} vs raw ${raw.end}`);
  });

  it("a pad wider than the span makes it disappear, keeping the whole file", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    const clip = makeSilenceClip(s.dir);
    const r = spawnCli(["detect-silence", clip, "--min-silence", "0.3", "--pad", "0.6"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.silences.length, 0);
    assert.equal(r.json.keeps.length, 1);
    assert.equal(r.json.keeps[0].start, 0);
  });

  it("an all-silence file keeps nothing (EOF silence closed at the duration)", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    const clip = join(s.dir, "silence.wav");
    const r = spawnSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2", clip],
      { encoding: "utf-8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const cli = spawnCli(["detect-silence", clip, "--min-silence", "0.3", "--pad", "0"]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.json.silences.length, 1);
    assert.equal(cli.json.silences[0].start, 0);
    assert.ok(Math.abs(cli.json.silences[0].end - 2) < 0.2, `EOF silence ends at ${cli.json.silences[0].end}`);
    assert.deepEqual(cli.json.keeps, []);
  });

  it("a file with no silence keeps the whole file", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    const clip = join(s.dir, "tone.wav");
    const r = spawnSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2", clip],
      { encoding: "utf-8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const cli = spawnCli(["detect-silence", clip, "--min-silence", "0.3"]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(cli.json.silences, []);
    assert.equal(cli.json.keeps.length, 1);
    assert.equal(cli.json.keeps[0].start, 0);
    assert.ok(Math.abs(cli.json.keeps[0].end - 2) < 0.2);
  });

  it("--limit keeps only the N longest silences; keeps complement the survivors", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    // tone 1s | silence 1s | tone 1s | silence 0.5s | tone 1s -> the 1s silence wins
    const clip = join(s.dir, "two-silences.wav");
    const src = (spec) => ["-f", "lavfi", "-i", spec];
    const r = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        ...src("sine=frequency=440:sample_rate=44100:duration=1"),
        ...src("anullsrc=r=44100:cl=mono:d=1"),
        ...src("sine=frequency=440:sample_rate=44100:duration=1"),
        ...src("anullsrc=r=44100:cl=mono:d=0.5"),
        ...src("sine=frequency=440:sample_rate=44100:duration=1"),
        "-filter_complex",
        "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1[a]",
        "-map",
        "[a]",
        clip,
      ],
      { encoding: "utf-8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const cli = spawnCli(["detect-silence", clip, "--min-silence", "0.3", "--pad", "0", "--limit", "1"]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.json.silences.length, 1);
    assert.ok(
      Math.abs(cli.json.silences[0].start - 1) < 0.2,
      `longest silence starts at ${cli.json.silences[0].start}`,
    );
    assert.equal(cli.json.keeps.length, 2, "the un-cut short silence stays inside a keep segment");
  });

  it("-H prints a human summary; --json overrides it", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    const clip = makeSilenceClip(s.dir);
    const human = spawnCli(["detect-silence", clip, "--min-silence", "0.3", "-H"]);
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.json, null, "human output must not be JSON");
    assert.match(human.stdout, /Silences:\s+1/);
    assert.match(human.stdout, /Keeps:\s+2/);
    assert.match(human.stdout, /00:00:0\d\.\d{3}/);
    const json = spawnCli(["detect-silence", clip, "--min-silence", "0.3", "-H", "--json"]);
    assert.equal(json.status, 0, json.stderr);
    assert.ok(json.json && Array.isArray(json.json.silences), "--json must force JSON output");
  });

  it("falls back to the ffmpeg header when ffprobe is unavailable, and says so", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const placeholder = join(s.dir, "speech.wav");
    writeFileSync(placeholder, "");
    // Fake ffmpeg emits a real-looking header + silencedetect lines; ffprobe is
    // pointed at a nonexistent path to force the header fallback.
    const fakeFfmpeg = join(s.dir, "fake-ffmpeg");
    writeFileSync(fakeFfmpeg, `#!/bin/sh\ncat >&2 <<'EOF'\n${SILENCE_STDERR}\nEOF\nexit 0\n`);
    chmodSync(fakeFfmpeg, 0o755);
    const r = spawnCli([
      "detect-silence",
      placeholder,
      "--pad",
      "0",
      "--ffmpeg-cmd",
      fakeFfmpeg,
      "--ffprobe-cmd",
      "/nonexistent/ffprobe",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.duration, 10);
    assert.equal(r.json.duration_source, "ffmpeg-header");
    assert.equal(r.json.keeps[r.json.keeps.length - 1].end, 10);
  });

  it("a silence to EOF with unknown duration stays open-ended and keeps no tail", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const placeholder = join(s.dir, "speech.wav");
    writeFileSync(placeholder, "");
    // No Duration header and no ffprobe -> duration unknown; the unmatched
    // silence_start runs to EOF.
    const fakeFfmpeg = join(s.dir, "fake-ffmpeg");
    writeFileSync(fakeFfmpeg, "#!/bin/sh\necho '[silencedetect @ 0x1] silence_start: 4' >&2\nexit 0\n");
    chmodSync(fakeFfmpeg, 0o755);
    const r = spawnCli([
      "detect-silence",
      placeholder,
      "--pad",
      "0",
      "--ffmpeg-cmd",
      fakeFfmpeg,
      "--ffprobe-cmd",
      "/nonexistent/ffprobe",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.duration, null);
    assert.equal(r.json.duration_source, null);
    assert.deepEqual(r.json.silences, [
      { start: 4, end: null, duration: null, start_us: 4 * US, end_us: null, duration_us: null },
    ]);
    assert.deepEqual(r.json.keeps, [
      { start: 0, end: 4, duration: 4, start_us: 0, end_us: 4 * US, duration_us: 4 * US },
    ]);
  });

  it("fails with a clear error when the media is missing", () => {
    const r = spawnCli(["detect-silence", "/nonexistent/speech.wav"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /media not found/);
  });

  it("fails actionably when ffmpeg is unavailable", () => {
    const s = setup();
    after(s.cleanup);
    const placeholder = join(s.dir, "speech.wav");
    writeFileSync(placeholder, "");
    const r = spawnCli(["detect-silence", placeholder, "--ffmpeg-cmd", "/nonexistent/ffmpeg"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ffmpeg is unavailable/);
    assert.match(r.stderr, /--ffmpeg-cmd/);
  });

  it("rejects out-of-range flag values", () => {
    const s = setup();
    after(s.cleanup);
    const placeholder = join(s.dir, "speech.wav");
    writeFileSync(placeholder, "");
    const positive = spawnCli(["detect-silence", placeholder, "--threshold-db", "5"]);
    assert.equal(positive.status, 1);
    assert.match(positive.stderr, /--threshold-db must be/);
    const zero = spawnCli(["detect-silence", placeholder, "--min-silence", "0"]);
    assert.equal(zero.status, 1);
    assert.match(zero.stderr, /--min-silence must be/);
    const negative = spawnCli(["detect-silence", placeholder, "--pad", "-0.5"]);
    assert.equal(negative.status, 1);
    assert.match(negative.stderr, /--pad must be/);
  });

  it("reports a timeout as a timeout, not as ffmpeg being unavailable", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const placeholder = join(s.dir, "speech.wav");
    writeFileSync(placeholder, "");
    const slowFfmpeg = join(s.dir, "slow-ffmpeg");
    writeFileSync(slowFfmpeg, "#!/bin/sh\nsleep 3\n");
    chmodSync(slowFfmpeg, 0o755);
    let err = null;
    try {
      detectSilence(placeholder, { ffmpegCmd: slowFfmpeg, timeoutMs: 250 });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected detectSilence to throw on timeout");
    assert.match(err.message, /timed out after 0\.25s/);
    assert.doesNotMatch(err.message, /install ffmpeg|unavailable/i);
  });

  it("reports a maxBuffer overflow as such, not as ffmpeg being unavailable", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const placeholder = join(s.dir, "speech.wav");
    writeFileSync(placeholder, "");
    const noisyFfmpeg = join(s.dir, "noisy-ffmpeg");
    writeFileSync(noisyFfmpeg, "#!/bin/sh\nhead -c 200000 /dev/zero\n");
    chmodSync(noisyFfmpeg, 0o755);
    let err = null;
    try {
      detectSilence(placeholder, { ffmpegCmd: noisyFfmpeg, maxBufferBytes: 1024 });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected detectSilence to throw on buffer overflow");
    assert.match(err.message, /output exceeded/);
    assert.match(err.message, /--min-silence/);
    assert.doesNotMatch(err.message, /install ffmpeg|unavailable/i);
  });
});
