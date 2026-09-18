import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { groupWords } from "../dist/caption.js";
import { captionScript, groupingDefaults, wordSeparator } from "../dist/script.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// Whisper's "words" for Chinese or Japanese are characters or short tokens.
// Joined with spaces and cut four to a cue, a Chinese sentence came out as
// "今 天 我 们" fragments; now the script chooses the separator (none for zh /
// ja) and the grouping defaults (the character cap alone, at the line width
// lint holds captions to).

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_WHISPER = join(__dirname, "helpers", "fake-whisper.mjs");
const isWindows = process.platform === "win32";

const ZH = "今天我们来聊一聊剪映草稿的自动化处理"; // 18 characters
const timed = (text, stepS = 0.2) =>
  [...text].map((word, i) => ({
    word,
    startUs: Math.round(i * stepS * 1e6),
    endUs: Math.round((i + 1) * stepS * 1e6),
  }));

describe("script detection and defaults (script.ts)", () => {
  it("names the script from the visible characters", () => {
    assert.equal(captionScript(ZH), "zh");
    assert.equal(captionScript("きょうはじまる物語"), "ja", "kana decides even beside kanji");
    assert.equal(captionScript("오늘은 새로운 이야기"), "ko");
    assert.equal(captionScript("This is a Latin line"), "latin");
    assert.equal(captionScript("Rene 说 hello world today again"), "latin", "one CJK word in a Latin line");
    assert.equal(captionScript(""), "latin");
  });

  it("joins without a space in Chinese and Japanese, with one elsewhere", () => {
    assert.equal(wordSeparator("zh"), "");
    assert.equal(wordSeparator("ja"), "");
    assert.equal(wordSeparator("ko"), " ");
    assert.equal(wordSeparator("latin"), " ");
  });

  it("bounds Chinese and Japanese cues by characters only, at the lint line width", () => {
    assert.deepEqual(groupingDefaults("latin"), { karaokeMaxWords: 4, karaokeMaxChars: 28, lineMaxChars: 42 });
    assert.deepEqual(groupingDefaults("zh"), {
      karaokeMaxWords: Number.POSITIVE_INFINITY,
      karaokeMaxChars: 16,
      lineMaxChars: 16,
    });
    assert.deepEqual(groupingDefaults("ja"), {
      karaokeMaxWords: Number.POSITIVE_INFINITY,
      karaokeMaxChars: 13,
      lineMaxChars: 13,
    });
    assert.deepEqual(groupingDefaults("ko"), { karaokeMaxWords: 4, karaokeMaxChars: 16, lineMaxChars: 16 });
  });
});

describe("groupWords with a separator", () => {
  it("joins Chinese characters without spaces and splits at the character cap", () => {
    const cues = groupWords(timed(ZH), Number.POSITIVE_INFINITY, 16, Number.POSITIVE_INFINITY, "");
    assert.deepEqual(
      cues.map((c) => c.text),
      ["今天我们来聊一聊剪映草稿的自动化", "处理"],
    );
    assert.equal(cues[0].words.length, 16);
  });

  it("keeps the Latin behaviour when no separator is given", () => {
    const words = ["one", "two", "three", "four", "five"].map((word, i) => ({
      word,
      startUs: i * 200_000,
      endUs: (i + 1) * 200_000,
    }));
    const cues = groupWords(words, 3, 20);
    assert.deepEqual(
      cues.map((c) => c.text),
      ["one two three", "four five"],
    );
  });
});

function trackTexts(draftPath, trackName) {
  const draft = JSON.parse(readFileSync(draftPath, "utf-8"));
  const track = draft.tracks.find((t) => t.type === "text" && t.name === trackName);
  assert.ok(track, `track ${trackName} present`);
  return track.segments.map((s) => {
    const mat = draft.materials.texts.find((m) => m.id === s.material_id);
    return JSON.parse(mat.content);
  });
}

describe("capcut caption --karaoke on a Chinese transcript (fake whisper)", { skip: isWindows }, () => {
  it("writes space-free cues of at most 16 characters and reports caption_script", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const dir = mkdtempSync(join(tmpdir(), "capcut-caption-cjk-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const audio = join(dir, "voice.wav");
    writeFileSync(audio, "stub");
    const heard = join(dir, "heard.json");
    writeFileSync(
      heard,
      JSON.stringify({
        segments: [{ words: [...ZH].map((word, i) => ({ word, start: i * 0.2, end: (i + 1) * 0.2 })) }],
      }),
    );

    const r = spawnCli(
      ["caption", fix.path, "--audio", audio, "--whisper-cmd", FAKE_WHISPER, "--karaoke", "--track-name", "zh"],
      { env: { FAKE_WHISPER_SOURCE: heard } },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.caption_script, "zh");
    assert.equal(r.json.words, 18);
    assert.equal(r.json.first_cue.text, "今天我们来聊一聊剪映草稿的自动化");
    assert.equal(r.json.last_cue.text, "处理");

    // Karaoke writes one segment per word carrying the whole cue's text.
    const texts = trackTexts(fix.path, "zh");
    assert.equal(texts.length, 18);
    for (const content of texts) {
      assert.doesNotMatch(content.text, / /, "no space between Chinese characters");
      assert.ok(content.text.length <= 16, `cue within 16 characters: ${content.text}`);
    }
    // The third word's highlight covers exactly its own character.
    const third = texts[2].styles.find((s) => s.range && s.range[0] === 2);
    assert.ok(third, `third word range present: ${JSON.stringify(texts[2].styles)}`);
    assert.deepEqual(third.range, [2, 3]);
  });

  it("still honours an explicit --max-words / --max-chars", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const dir = mkdtempSync(join(tmpdir(), "capcut-caption-cjk-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const audio = join(dir, "voice.wav");
    writeFileSync(audio, "stub");
    const heard = join(dir, "heard.json");
    writeFileSync(
      heard,
      JSON.stringify({
        segments: [{ words: [...ZH].map((word, i) => ({ word, start: i * 0.2, end: (i + 1) * 0.2 })) }],
      }),
    );
    const r = spawnCli(
      ["caption", fix.path, "--audio", audio, "--whisper-cmd", FAKE_WHISPER, "--karaoke", "--max-words", "6"],
      { env: { FAKE_WHISPER_SOURCE: heard } },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.first_cue.text, "今天我们来聊");
  });
});
