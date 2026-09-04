import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { alignScript, normalizeToken, tokenizeScript } from "../dist/align.js";
import { extractText } from "../dist/draft.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// `caption --script`: whisper's timing, the script's words. The alignment is
// pure (asserted directly); the CLI path runs through a fake whisper binary.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_WHISPER = join(__dirname, "helpers", "fake-whisper.mjs");
// spawnSync cannot execute a shebang script on Windows (same reason the other
// fake-binary suites skip there); the alignment itself is asserted directly above.
const isWindows = process.platform === "win32";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-caption-script-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Whisper "heard" this: chanel/ramarys are the classic mis-hearings.
const HEARD_WORDS = [
  { word: "welcome", start: 0.0, end: 0.4 },
  { word: "to", start: 0.4, end: 0.5 },
  { word: "the", start: 0.5, end: 0.6 },
  { word: "chanel", start: 0.6, end: 1.0 },
  { word: "today", start: 1.2, end: 1.5 },
  { word: "we", start: 1.5, end: 1.6 },
  { word: "talk", start: 1.6, end: 1.9 },
  { word: "about", start: 1.9, end: 2.1 },
  { word: "ramarys", start: 2.1, end: 2.7 },
];
const SCRIPT = "Welcome to the channel, today we talk about Ramaris.\nAnd the sidecar it writes.\n";

function whisperJson() {
  return JSON.stringify({
    segments: [
      {
        start: 0,
        end: 2.7,
        text: HEARD_WORDS.map((w) => w.word).join(" "),
        words: HEARD_WORDS.map((w) => ({ word: w.word, start: w.start, end: w.end })),
      },
    ],
  });
}

function textCues(path) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  const cues = [];
  for (const track of draft.tracks) {
    if (track.type !== "text") continue;
    for (const seg of track.segments) {
      const mat = draft.materials.texts.find((m) => m.id === seg.material_id);
      cues.push({
        track: track.name,
        text: extractText(mat.content),
        start: seg.target_timerange.start,
        end: seg.target_timerange.start + seg.target_timerange.duration,
      });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

describe("align.ts — transcript alignment", () => {
  it("normalises case, punctuation and compatibility forms", () => {
    assert.equal(normalizeToken("Ramaris,"), "ramaris");
    assert.equal(normalizeToken("“Hello”"), "hello");
    assert.equal(normalizeToken("ＣapCut"), "capcut");
    assert.equal(normalizeToken("—"), "");
    assert.deepEqual(tokenizeScript("one two\n\n—\nthree"), [["one", "two"], ["three"]]);
  });

  it("keeps whisper timing, takes the script wording, and interpolates unheard words", () => {
    const recognized = HEARD_WORDS.map((w) => ({
      word: w.word,
      startUs: Math.round(w.start * 1e6),
      endUs: Math.round(w.end * 1e6),
    }));
    const { words, lines, report } = alignScript(tokenizeScript(SCRIPT), recognized);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].map((w) => w.word).join(" "), "Welcome to the channel, today we talk about Ramaris.");
    // Substitutions inherit the mis-heard word's timing.
    const channel = words.find((w) => w.word === "channel,");
    assert.equal(channel.matched, false);
    assert.equal(channel.startUs, 600_000);
    assert.equal(channel.endUs, 1_000_000);
    const ramaris = words.find((w) => w.word === "Ramaris.");
    assert.equal(ramaris.startUs, 2_100_000);
    // The second line was never spoken in the recognised words: extrapolated
    // after the last timed word at the median recognised word length (300 ms).
    const second = lines[1];
    assert.equal(second[0].startUs, 2_700_000);
    assert.equal(second[second.length - 1].endUs, 2_700_000 + second.length * 300_000);
    assert.ok(second.every((w) => w.matched === false));
    for (let k = 1; k < words.length; k++) assert.ok(words[k].startUs >= words[k - 1].endUs, "monotonic timing");

    assert.equal(report.script_words, 14);
    assert.equal(report.recognized_words, 9);
    assert.equal(report.matched, 7);
    assert.equal(report.substituted, 2);
    assert.equal(report.inserted, 5);
    assert.equal(report.dropped, 0);
    assert.equal(report.match_ratio, 0.5);
  });

  it("drops recognised words the script does not contain", () => {
    const recognized = [
      { word: "um", startUs: 0, endUs: 200_000 },
      { word: "hello", startUs: 200_000, endUs: 600_000 },
      { word: "uh", startUs: 600_000, endUs: 700_000 },
      { word: "world", startUs: 700_000, endUs: 1_100_000 },
    ];
    const { words, report } = alignScript([["Hello", "world!"]], recognized);
    assert.deepEqual(
      words.map((w) => [w.word, w.startUs, w.endUs, w.matched]),
      [
        ["Hello", 200_000, 600_000, true],
        ["world!", 700_000, 1_100_000, true],
      ],
    );
    assert.equal(report.dropped, 2);
    assert.equal(report.match_ratio, 1);
  });
});

describe("capcut caption --script (fake whisper)", { skip: isWindows }, () => {
  it("one cue per script line with the script's wording and whisper's timing; reports the alignment", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const s = scratch();
    t.after(s.cleanup);
    const audio = join(s.dir, "voice.wav");
    writeFileSync(audio, "stub");
    const script = join(s.dir, "script.txt");
    writeFileSync(script, SCRIPT);
    // Non-karaoke captions request SRT from whisper: cue-level timing only.
    const heardSrt = join(s.dir, "heard.srt");
    writeFileSync(
      heardSrt,
      "1\n00:00:00,000 --> 00:00:01,000\nwelcome to the chanel\n\n2\n00:00:01,200 --> 00:00:02,700\ntoday we talk about ramarys\n",
    );

    const r = spawnCli(
      [
        "caption",
        fix.path,
        "--audio",
        audio,
        "--whisper-cmd",
        FAKE_WHISPER,
        "--script",
        script,
        "--track-name",
        "scripted",
        // The first script line is 52 characters; the default --max-chars (42)
        // would split it — lines are the cue boundary only up to that width.
        "--max-chars",
        "80",
      ],
      { env: { FAKE_WHISPER_SOURCE: heardSrt } },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.cues, 2);
    assert.equal(r.json.track_name, "scripted");
    assert.ok(r.json.script, "the alignment report rides along");
    assert.equal(r.json.script.script_words, 14);
    assert.equal(r.json.script.matched, 7);
    assert.equal(r.json.script.inserted, 5);

    const cues = textCues(fix.path).filter((c) => c.track === "scripted");
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, "Welcome to the channel, today we talk about Ramaris.");
    assert.equal(cues[0].start, 0, "the cue starts where whisper heard the first word");
    assert.equal(cues[0].end, 2_700_000, "and ends where it heard the last one");
    assert.equal(cues[1].text, "And the sidecar it writes.");
    assert.equal(cues[1].start, 2_700_000, "unheard words follow the last timed word");
    assert.ok(!/Check that --script belongs/.test(r.stderr), "50% matched is not below the warning threshold");
  });

  it("--karaoke keeps per-word timing from the JSON transcript with the script's words", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const s = scratch();
    t.after(s.cleanup);
    const audio = join(s.dir, "voice.wav");
    writeFileSync(audio, "stub");
    const script = join(s.dir, "script.txt");
    writeFileSync(script, "Welcome to the channel, today we talk about Ramaris.\n");
    const heardJson = join(s.dir, "heard.json");
    writeFileSync(heardJson, whisperJson());

    const r = spawnCli(
      [
        "caption",
        fix.path,
        "--audio",
        audio,
        "--whisper-cmd",
        FAKE_WHISPER,
        "--script",
        script,
        "--karaoke",
        "--track-name",
        "kara",
      ],
      { env: { FAKE_WHISPER_SOURCE: heardJson } },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.karaoke, true);
    assert.equal(r.json.script.script_words, 9);
    assert.equal(r.json.script.matched, 7);
    assert.equal(r.json.script.substituted, 2);
    const cues = textCues(fix.path).filter((c) => c.track === "kara");
    // Karaoke writes one segment per word, each carrying the whole cue text.
    const channelSeg = cues.find((c) => c.start === 600_000);
    assert.ok(channelSeg, "the corrected word keeps the mis-heard word's start");
    assert.equal(channelSeg.end, 1_000_000);
    assert.match(channelSeg.text, /channel,/);
    assert.ok(!/chanel/.test(channelSeg.text), "whisper's spelling is gone");
  });

  it("warns when the script does not match the audio, and fails on a missing script file", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const s = scratch();
    t.after(s.cleanup);
    const audio = join(s.dir, "voice.wav");
    writeFileSync(audio, "stub");
    const heardSrt = join(s.dir, "heard.srt");
    writeFileSync(heardSrt, "1\n00:00:00,000 --> 00:00:02,000\nwelcome to the chanel today we talk\n");
    const wrongScript = join(s.dir, "wrong.txt");
    writeFileSync(wrongScript, "Quarterly revenue grew twelve percent on strong demand.\n");

    const r = spawnCli(
      ["caption", fix.path, "--audio", audio, "--whisper-cmd", FAKE_WHISPER, "--script", wrongScript],
      {
        env: { FAKE_WHISPER_SOURCE: heardSrt },
      },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /Check that --script belongs to this audio/);
    assert.ok(r.json.script.match_ratio < 0.5);

    const missing = spawnCli(
      ["caption", fix.path, "--audio", audio, "--whisper-cmd", FAKE_WHISPER, "--script", join(s.dir, "nope.txt")],
      {
        env: { FAKE_WHISPER_SOURCE: heardSrt },
      },
    );
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--script file not found/);
  });

  it("without --script the result has no script block (byte-identical JSON shape)", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const s = scratch();
    t.after(s.cleanup);
    const audio = join(s.dir, "voice.wav");
    writeFileSync(audio, "stub");
    const heardSrt = join(s.dir, "heard.srt");
    writeFileSync(heardSrt, "1\n00:00:00,000 --> 00:00:02,000\nwelcome to the chanel\n");
    const r = spawnCli(["caption", fix.path, "--audio", audio, "--whisper-cmd", FAKE_WHISPER], {
      env: { FAKE_WHISPER_SOURCE: heardSrt },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.script, undefined);
    assert.equal(r.json.cues, 1);
  });
});

describe("caption --script surface", () => {
  it("describe lists --script on caption", () => {
    const r = spawnCli(["describe"]);
    const spec = r.json.commands.find((c) => c.name === "caption");
    assert.ok(spec.options.some((o) => o.flags.includes("--script")));
  });
});
