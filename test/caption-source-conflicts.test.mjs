import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transcriptionSourceConflict } from "../dist/caption.js";

describe("caption transcription-source rules", () => {
  it("lets each source stand alone", () => {
    assert.equal(transcriptionSourceConflict({ words: true }), undefined);
    assert.equal(transcriptionSourceConflict({ words: false, audio: "a.wav", cloud: true }), undefined);
    assert.equal(
      transcriptionSourceConflict({ words: false, audio: "a.wav", whisperCmd: "whisper", whisperModel: "small" }),
      undefined,
    );
  });

  it("names every option --words makes pointless, in one sentence", () => {
    assert.equal(
      transcriptionSourceConflict({ words: true, audio: "a.wav", cloud: true, ffmpegCmd: "ff", whisperModel: "m" }),
      "--words is mutually exclusive with --audio, --cloud, --ffmpeg-cmd, --whisper-model: the word timings come from the file, Whisper does not run.",
    );
  });

  it("names the --whisper-* options --cloud replaces", () => {
    assert.equal(
      transcriptionSourceConflict({ words: false, cloud: true, whisperEngine: "openai", whisperModel: "m" }),
      "--cloud uses CapCut Cloud ASR and is mutually exclusive with --whisper-engine, --whisper-model.",
    );
  });

  it("reports --words first when both sources are contradicted", () => {
    assert.match(
      transcriptionSourceConflict({ words: true, cloud: true, whisperCmd: "w" }) ?? "",
      /^--words is mutually exclusive with --cloud, --whisper-cmd:/,
    );
  });
});
