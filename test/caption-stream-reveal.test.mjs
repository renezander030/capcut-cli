import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAudioStreamInvocation } from "../dist/caption.js";
import { extractText } from "../dist/draft.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_WHISPER = join(__dirname, "helpers", "fake-whisper.mjs");
const isWindows = process.platform === "win32";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-caption-stream-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function trackTexts(path, name) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  const track = draft.tracks.find((candidate) => candidate.type === "text" && candidate.name === name);
  return track.segments
    .map((segment) => {
      const material = draft.materials.texts.find((candidate) => candidate.id === segment.material_id);
      return { text: extractText(material.content), start: segment.target_timerange.start };
    })
    .sort((a, b) => a.start - b.start);
}

describe("caption audio stream selection", () => {
  it("builds an explicit zero-based ffmpeg stream map", () => {
    assert.deepEqual(buildAudioStreamInvocation("talk.mov", 2, "selected.wav"), [
      "-y",
      "-i",
      "talk.mov",
      "-map",
      "0:a:2",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "selected.wav",
    ]);
  });

  it("extracts the selected stream before whisper and reports the original source", { skip: isWindows }, (t) => {
    const fix = tmpDraft();
    const s = scratch();
    t.after(() => fix.cleanup());
    t.after(s.cleanup);
    const media = join(s.dir, "multi-audio.mov");
    const transcript = join(s.dir, "heard.srt");
    const ffmpeg = join(s.dir, "fake-ffmpeg");
    writeFileSync(media, "container");
    writeFileSync(transcript, "1\n00:00:00,000 --> 00:00:01,000\nselected voice\n");
    writeFileSync(ffmpeg, '#!/bin/sh\nfor last do :; done\nprintf selected > "$last"\n');
    chmodSync(ffmpeg, 0o755);

    const r = spawnCli(
      [
        "caption",
        fix.path,
        "--audio",
        media,
        "--audio-stream",
        "1",
        "--ffmpeg-cmd",
        ffmpeg,
        "--whisper-cmd",
        FAKE_WHISPER,
        "--track-name",
        "selected",
      ],
      { env: { FAKE_WHISPER_SOURCE: transcript } },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.audio_stream, 1);
    assert.equal(r.json.source_audio, media);
    assert.deepEqual(
      trackTexts(fix.path, "selected").map((cue) => cue.text),
      ["selected voice"],
    );
  });
});

describe("caption --word-reveal", { skip: isWindows }, () => {
  it("creates progressive prefix captions on word timestamps", (t) => {
    const fix = tmpDraft();
    const s = scratch();
    t.after(() => fix.cleanup());
    t.after(s.cleanup);
    const audio = join(s.dir, "voice.wav");
    const transcript = join(s.dir, "heard.json");
    writeFileSync(audio, "stub");
    writeFileSync(
      transcript,
      JSON.stringify({
        segments: [
          {
            start: 0,
            end: 1,
            text: "one two three",
            words: [
              { word: "one", start: 0, end: 0.25 },
              { word: "two", start: 0.3, end: 0.55 },
              { word: "three", start: 0.6, end: 1 },
            ],
          },
        ],
      }),
    );
    const r = spawnCli(
      ["caption", fix.path, "--audio", audio, "--whisper-cmd", FAKE_WHISPER, "--word-reveal", "--track-name", "reveal"],
      { env: { FAKE_WHISPER_SOURCE: transcript } },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.word_reveal, true);
    assert.equal(r.json.cues, 3);
    assert.deepEqual(trackTexts(fix.path, "reveal"), [
      { text: "one", start: 0 },
      { text: "one two", start: 300_000 },
      { text: "one two three", start: 600_000 },
    ]);
  });
});
