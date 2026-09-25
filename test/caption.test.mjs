import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { buildWhisperInvocation, groupWords, parseWhisperJson } from "../dist/caption.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut caption — input validation", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  // The full pipeline needs whisper installed and a real audio file; not
  // something we can mock in CI without a binary. We cover the validation
  // surface that runs before whisper is invoked.

  it("errors when neither --audio nor --from-segment is provided", () => {
    const r = spawnCli(["caption", fix.path]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Missing --audio/);
  });

  it("errors when --audio path doesn't exist", () => {
    const r = spawnCli(["caption", fix.path, "--audio", "/nonexistent/audio.wav"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Audio file not found/);
  });

  it("errors when --from-segment points to a non-audio track", () => {
    const r = spawnCli(["caption", fix.path, "--from-segment", "nonexistent-id"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Segment not found/);
  });

  it("rejects a non-integer --audio-stream without touching ffmpeg", () => {
    const r = spawnCli(["caption", fix.path, "--audio", "/nonexistent/audio.mov", "--audio-stream", "1x"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /zero-based non-negative integer/);
    assert.doesNotMatch(r.stderr, /Audio file not found/);
  });
});

describe("caption engine adapters and karaoke grouping", () => {
  it("builds engine-specific OpenAI and whisper.cpp invocations", () => {
    const openai = buildWhisperInvocation("openai", "audio.wav", "base", "en", "/tmp/out", true);
    assert.deepEqual(openai.args.slice(0, 3), ["audio.wav", "--model", "base"]);
    assert.ok(openai.args.includes("--word_timestamps"));
    const cpp = buildWhisperInvocation("whisper-cpp", "audio.wav", "ggml.bin", "en", "/tmp/out", true);
    assert.deepEqual(cpp.args.slice(0, 4), ["-m", "ggml.bin", "-f", "audio.wav"]);
    assert.ok(cpp.args.includes("-oj"));
  });

  it("parses word timestamps and groups readable karaoke cues", () => {
    const parsed = parseWhisperJson(
      JSON.stringify({
        segments: [
          {
            start: 0,
            end: 2,
            text: "one two three four five",
            words: [
              { word: "one", start: 0, end: 0.3 },
              { word: "two", start: 0.3, end: 0.6 },
              { word: "three", start: 0.6, end: 1 },
              { word: "four", start: 1, end: 1.4 },
              { word: "five", start: 1.4, end: 2 },
            ],
          },
        ],
      }),
    );
    assert.equal(parsed.words.length, 5);
    const grouped = groupWords(parsed.words, 3, 20, 500_000);
    assert.equal(grouped.length, 2);
    assert.equal(grouped[0].text, "one two three");
    assert.equal(grouped[1].words[0].startUs, 1_000_000);
  });
});
