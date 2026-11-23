import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cueSpeechText, planDubClips } from "../dist/dub.js";
import { parseSubtitles } from "../dist/srt.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const isWindows = process.platform === "win32"; // the fake TTS and ffprobe are #! scripts

/**
 * A stand-in TTS tool and ffprobe, so no speech engine runs: the TTS writes a real PCM WAV whose length is 0.4 s per
 * word of the text it gets on stdin (and logs that text); the ffprobe reads the length back from the WAV header.
 */
function tools(dir) {
  const log = join(dir, "spoken.log");
  const tts = join(dir, "fake-tts");
  writeFileSync(
    tts,
    `#!/usr/bin/env node
const fs = require("node:fs");
const text = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(log)}, text + "\\n");
const rate = 8000, samples = Math.round(rate * 0.4 * text.trim().split(/\\s+/).length), size = samples * 2;
const b = Buffer.alloc(44 + size);
b.write("RIFF", 0); b.writeUInt32LE(36 + size, 4); b.write("WAVE", 8); b.write("fmt ", 12);
b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(size, 40);
fs.writeFileSync(process.argv[2], b);
`,
  );
  const ffprobe = join(dir, "fake-ffprobe");
  writeFileSync(
    ffprobe,
    `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.argv[process.argv.length - 1];
const b = fs.readFileSync(file);
const seconds = b.readUInt32LE(40) / b.readUInt32LE(28);
console.log(JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 1 }], format: { duration: String(seconds) } }));
`,
  );
  chmodSync(tts, 0o755);
  chmodSync(ffprobe, 0o755);
  return { tts, ffprobe, spoken: () => readFileSync(log, "utf8").trim().split("\n") };
}

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello there

2
00:00:04,000 --> 00:00:06,500
<i>This is</i> the second line
{\\an8}split over two

3
00:00:08,000 --> 00:00:09,000
Last
`;

describe("dub — cue reading and placement", () => {
  it("reads WebVTT: header, NOTE and STYLE blocks, cue ids, settings and short timestamps", () => {
    const vtt =
      "WEBVTT - a title\n\nNOTE written by hand\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:03.000 align:start position:10%\nHello there\n\n00:00:04.000 --> 00:00:06.500\nSecond\n";
    assert.deepEqual(
      parseSubtitles(vtt).map((c) => [c.startUs, c.endUs, c.text]),
      [
        [1_000_000, 3_000_000, "Hello there"],
        [4_000_000, 6_500_000, "Second"],
      ],
    );
  });
  it("speaks the cue's words, not its markup", () => {
    assert.equal(
      cueSpeechText("<i>This is</i> the second line\n{\\an8}split over two"),
      "This is the second line split over two",
    );
    assert.equal(cueSpeechText("<c.yellow>Tom & Jerry</c>"), "Tom & Jerry");
  });
  it("keeps words around a bare < or > and removes only known subtitle tags", () => {
    assert.equal(cueSpeechText("2 < 3 and 5 > 4"), "2 < 3 and 5 > 4");
    assert.equal(cueSpeechText("a < b, so say yes -> go"), "a < b, so say yes -> go");
    assert.equal(
      cueSpeechText('<i>Hi</i> <b>there</b> <font color="red">red</font> <v Bob>Bob</v> <c.loud>x</c> {\\an8}y'),
      "Hi there red Bob x y",
    );
  });

  it("decodes character references once: WebVTT's in the reader, SRT text as written", () => {
    const [vtt] = parseSubtitles("WEBVTT\n\n00:01.000 --> 00:02.000\nTom &amp;lt; Jerry\n");
    assert.equal(cueSpeechText(vtt.text), "Tom &lt; Jerry");
    assert.equal(cueSpeechText("Fish &amp; chips"), "Fish &amp; chips");
  });

  it("refuses a clip that runs into the next cue, or cuts it there with trimOverlap", () => {
    const clips = [
      { cue: 1, startUs: 0, speechUs: 3_000_000 },
      { cue: 2, startUs: 2_000_000, speechUs: 1_000_000 },
    ];
    assert.deepEqual(planDubClips(clips, [], false).refusals, ["cue 1: its speech runs 1.000 s into cue 2"]);
    const trimmed = planDubClips(clips, [], true);
    assert.deepEqual(
      trimmed.clips.map((c) => [c.cue, c.durationUs, c.trimmed]),
      [
        [1, 2_000_000, true],
        [2, 1_000_000, false],
      ],
    );
  });
  it("refuses a clip that runs into a segment already on the track", () => {
    const r = planDubClips(
      [{ cue: 4, startUs: 0, speechUs: 2_000_000 }],
      [{ startUs: 1_500_000, endUs: 5_000_000 }],
      false,
    );
    assert.deepEqual(r.refusals, ["cue 4: its speech runs 0.500 s into a segment already on the track"]);
  });
  it("returns each placed clip in start order with the fields the caller gave it", () => {
    const r = planDubClips(
      [
        { cue: 2, startUs: 5_000_000, speechUs: 1_000_000, path: "b.wav" },
        { cue: 1, startUs: 0, speechUs: 1_000_000, path: "a.wav" },
      ],
      [],
      false,
    );
    assert.deepEqual(
      r.clips.map((c) => [c.cue, c.path, c.durationUs]),
      [
        [1, "a.wav", 1_000_000],
        [2, "b.wav", 1_000_000],
      ],
    );
  });
});

describe("dub — the command", { skip: isWindows && "fake TTS and ffprobe are #! scripts" }, () => {
  let dir;
  let t;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "capcut-dub-test-"));
    t = tools(dir);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function dub(draft, file, ...extra) {
    return spawnCli(["dub", draft.path, file, "--tts-cmd", `${t.tts} {out}`, "--ffprobe-cmd", t.ffprobe, ...extra]);
  }

  it("places one clip per cue at the cue's start, each as long as its speech, on one audio track", () => {
    const draft = tmpDraft();
    try {
      const srt = join(dir, "track.srt");
      writeFileSync(srt, SRT);
      const r = dub(draft, srt);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(
        r.json.clips.map((c) => [c.cue, c.start_us, c.duration_us, c.trimmed]),
        [
          [1, 1_000_000, 800_000, false],
          [2, 4_000_000, 3_200_000, false],
          [3, 8_000_000, 400_000, false],
        ],
      );
      assert.equal(r.json.track_name, "dub");
      const content = JSON.parse(readFileSync(draft.path, "utf8"));
      const track = content.tracks.find((x) => x.type === "audio" && x.name === "dub");
      assert.deepEqual(
        track.segments.map((s) => [s.target_timerange.start, s.target_timerange.duration]),
        [
          [1_000_000, 800_000],
          [4_000_000, 3_200_000],
          [8_000_000, 400_000],
        ],
      );
      assert.deepEqual(t.spoken().slice(-3), ["Hello there", "This is the second line split over two", "Last"]);
      for (const c of r.json.clips) assert.ok(existsSync(c.path), c.path);
    } finally {
      draft.cleanup();
    }
  });

  it("refuses speech that runs into the next cue and writes nothing; --trim-overlap cuts it there", () => {
    const draft = tmpDraft();
    try {
      const srt = join(dir, "tight.srt");
      writeFileSync(
        srt,
        "1\n00:00:00,000 --> 00:00:01,000\none two three four five six\n\n2\n00:00:01,000 --> 00:00:02,000\nnext\n",
      );
      const before = readFileSync(draft.path, "utf8");
      const refused = dub(draft, srt);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /refused \[dub-overlap\]: cue 1: its speech runs 1\.400 s into cue 2/);
      assert.equal(readFileSync(draft.path, "utf8"), before);
      const audio = join(draft.dir, "assets", "audio");
      assert.deepEqual(existsSync(audio) ? readdirSync(audio) : [], []);
      const trimmed = dub(draft, srt, "--trim-overlap");
      assert.equal(trimmed.status, 0, trimmed.stderr);
      assert.deepEqual(
        trimmed.json.clips.map((c) => [c.cue, c.duration_us, c.speech_us, c.trimmed]),
        [
          [1, 1_000_000, 2_400_000, true],
          [2, 400_000, 400_000, false],
        ],
      );
    } finally {
      draft.cleanup();
    }
  });

  it("reads a WebVTT file", () => {
    const draft = tmpDraft();
    try {
      const vtt = join(dir, "track.vtt");
      writeFileSync(vtt, "WEBVTT\n\n00:02.000 --> 00:04.000\nFrom a VTT file\n");
      const r = dub(draft, vtt);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(
        r.json.clips.map((c) => [c.start_us, c.duration_us]),
        [[2_000_000, 1_600_000]],
      );
    } finally {
      draft.cleanup();
    }
  });

  it("refuses a cue that would reach the TTS tool as an option, before any clip is made", () => {
    const draft = tmpDraft();
    try {
      const srt = join(dir, "dash.srt");
      writeFileSync(
        srt,
        "1\n00:00:01,000 --> 00:00:02,000\nfine\n\n2\n00:00:03,000 --> 00:00:04,000\n--output /etc/x\n",
      );
      const before = readFileSync(draft.path, "utf8");
      const argv = spawnCli(["dub", draft.path, srt, "--tts-cmd", `${t.tts} {out} {text}`, "--ffprobe-cmd", t.ffprobe]);
      assert.equal(argv.status, 1);
      assert.match(argv.stderr, /cue 2's text starts with \\?"-\\?"/);
      assert.equal(readFileSync(draft.path, "utf8"), before);
      const audio = join(draft.dir, "assets", "audio");
      assert.deepEqual(existsSync(audio) ? readdirSync(audio) : [], []);
      const stdin = dub(draft, srt); // no {text}: the text goes to stdin, where a leading dash is just text
      assert.equal(stdin.status, 0, stdin.stderr);
      assert.equal(t.spoken().at(-1), "--output /etc/x");
    } finally {
      draft.cleanup();
    }
  });

  it("removes the clips it wrote when writing them into the draft fails", () => {
    const draft = tmpDraft();
    try {
      // CapCut 10.x is write-guarded: the save refuses without --force-write, after every clip was synthesized.
      const content = JSON.parse(readFileSync(draft.path, "utf8"));
      content.platform = { ...(content.platform ?? {}), app_source: "cc", app_version: "10.2.0" };
      writeFileSync(draft.path, JSON.stringify(content));
      const srt = join(dir, "place.srt");
      writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,000\nhello\n\n2\n00:00:03,000 --> 00:00:04,000\nagain\n");
      const before = readFileSync(draft.path, "utf8");
      const r = dub(draft, srt);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /force-write/);
      assert.equal(readFileSync(draft.path, "utf8"), before);
      const audio = join(draft.dir, "assets", "audio");
      assert.deepEqual(existsSync(audio) ? readdirSync(audio) : [], []);
    } finally {
      draft.cleanup();
    }
  });

  it("refuses subtitles that are not UTF-8, and a missing --tts-cmd", () => {
    const draft = tmpDraft();
    try {
      const bad = join(dir, "latin1.srt");
      writeFileSync(bad, Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nCaf\xe9\n", "latin1"));
      const r = dub(draft, bad);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not valid UTF-8/);
      const none = spawnCli(["dub", draft.path, bad]);
      assert.equal(none.status, 1);
      assert.match(none.stderr, /Missing --tts-cmd/);
    } finally {
      draft.cleanup();
    }
  });
});
