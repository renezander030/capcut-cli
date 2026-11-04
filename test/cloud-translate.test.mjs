import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  normalizeLanguageCode,
  translateCuesCapcutCloud,
  translateTextsCapcutCloud,
  translateUtterancesCapcutCloud,
} from "../dist/capcut-cloud-translate.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut-cloud-translate — language normalization", () => {
  it("normalizes common language names and variants to canonical CapCut codes", () => {
    assert.equal(normalizeLanguageCode("English"), "en");
    assert.equal(normalizeLanguageCode("english"), "en");
    assert.equal(normalizeLanguageCode("en"), "en");

    assert.equal(normalizeLanguageCode("Vietnamese"), "vi");
    assert.equal(normalizeLanguageCode("tieng_viet"), "vi");
    assert.equal(normalizeLanguageCode("vi"), "vi");

    assert.equal(normalizeLanguageCode("Spanish"), "es");
    assert.equal(normalizeLanguageCode("espanol"), "es");
    assert.equal(normalizeLanguageCode("es"), "es");

    assert.equal(normalizeLanguageCode("French"), "fr");
    assert.equal(normalizeLanguageCode("francais"), "fr");

    assert.equal(normalizeLanguageCode("German"), "de");
    assert.equal(normalizeLanguageCode("deutsch"), "de");

    assert.equal(normalizeLanguageCode("Chinese"), "zh-CN");
    assert.equal(normalizeLanguageCode("simplified chinese"), "zh-CN");
    assert.equal(normalizeLanguageCode("traditional chinese"), "zh-TW");
    assert.equal(normalizeLanguageCode("zh-tw"), "zh-TW");

    assert.equal(normalizeLanguageCode("Japanese"), "ja");
    assert.equal(normalizeLanguageCode("nihongo"), "ja");

    assert.equal(normalizeLanguageCode("Korean"), "ko");
    assert.equal(normalizeLanguageCode("hangul"), "ko");

    assert.equal(normalizeLanguageCode("Portuguese"), "pt");
    assert.equal(normalizeLanguageCode("Russian"), "ru");
    assert.equal(normalizeLanguageCode("Arabic"), "ar-SA");
    assert.equal(normalizeLanguageCode("Turkish"), "tr");
    assert.equal(normalizeLanguageCode("Dutch"), "nl");
    assert.equal(normalizeLanguageCode("Italian"), "it");
    assert.equal(normalizeLanguageCode("Indonesian"), "id");

    assert.equal(normalizeLanguageCode("unknown-lang"), "unknown-lang");
  });
});

describe("capcut-cloud-translate — empty inputs", () => {
  it("handles empty arrays immediately without network calls", async () => {
    assert.deepEqual(await translateUtterancesCapcutCloud([], "vi"), []);
    assert.deepEqual(await translateTextsCapcutCloud([], "vi"), []);
    assert.deepEqual(await translateCuesCapcutCloud([], "vi"), []);
  });
});

describe("capcut translate --cloud — CLI execution", () => {
  const fix = tmpDraft();
  const outDir = mkdtempSync(join(tmpdir(), "capcut-cloud-translate-"));
  const outPath = join(outDir, "translated-cloud.json");
  after(() => {
    fix.cleanup();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("supports --cloud with --dry-run without API keys", () => {
    const r = spawnCli(["translate", fix.path, "--to", "vi", "--out", outPath, "--cloud", "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json.ok);
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.engine, "capcut-cloud");
    assert.equal(r.json.to, "vi");
    assert.ok(r.json.count >= 1);
    assert.ok(existsSync(outPath));
  });

  it("performs live translation via CapCut Cloud when --cloud is used", async () => {
    const r = spawnCli(["translate", fix.path, "--to", "vi", "--out", outPath, "--cloud"]);
    if (r.status !== 0 && (r.stderr.includes("1014") || r.stderr.includes("fetch failed"))) {
      // ByteDance server throttling / offline sandbox guard
      return;
    }
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json.ok);
    assert.equal(r.json.engine, "capcut-cloud");
    assert.equal(r.json.to, "vi");
    assert.equal(r.json.dry_run, false);
    assert.ok(r.json.pairs.length >= 1);
    assert.ok(existsSync(outPath));

    const translatedDraft = JSON.parse(readFileSync(outPath, "utf-8"));
    assert.ok(translatedDraft.materials?.texts?.length > 0);
  });
});

describe("capcut caption --translate — CLI execution", () => {
  function tmpWords(t, content) {
    const dir = mkdtempSync(join(tmpdir(), "capcut-caption-translate-words-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "words.json");
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  }

  it("translates captions when caption --translate is passed", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const wordsFile = tmpWords(t, [
      { word: "Hello", start: 0.1, end: 0.5 },
      { word: "world", start: 0.5, end: 1.0 },
    ]);
    const r = spawnCli(["caption", fix.path, "--words", wordsFile, "--translate", "vi"]);
    if (r.status !== 0 && (r.stderr.includes("1014") || r.stderr.includes("fetch failed"))) {
      return;
    }
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json.ok);
    assert.equal(r.json.translated_to, "vi");
    assert.ok(r.json.cues >= 1);

    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    const track = draft.tracks.find((tr) => tr.type === "text" && tr.name === "captions");
    assert.ok(track);
    assert.ok(track.segments.length >= 1);
  });
});

describe("capcut-cloud-translate — live translation functions", () => {
  it("translates plain texts via CapCut Cloud", async () => {
    try {
      const res = await translateTextsCapcutCloud(["Hello world", "Good morning"], "vi");
      assert.equal(res.length, 2);
      assert.ok(typeof res[0] === "string" && res[0].length > 0);
      assert.ok(typeof res[1] === "string" && res[1].length > 0);
    } catch (e) {
      if (e.message.includes("1014") || e.message.includes("fetch failed")) {
        return; // network throttling / offline guard
      }
      throw e;
    }
  });

  it("translates caption cues and preserves word timings", async () => {
    try {
      const inputCues = [
        {
          startUs: 1_000_000,
          endUs: 3_000_000,
          text: "The quick brown fox jumps over the lazy dog",
        },
      ];
      const translated = await translateCuesCapcutCloud(inputCues, "vi");
      assert.equal(translated.length, 1);
      assert.equal(translated[0].startUs, 1_000_000);
      assert.equal(translated[0].endUs, 3_000_000);
      assert.ok(translated[0].text.length > 0);
      assert.ok(Array.isArray(translated[0].words));
      assert.ok(translated[0].words.length > 0);
      assert.ok(translated[0].words[0].startUs >= 1_000_000);
      assert.ok(translated[0].words[translated[0].words.length - 1].endUs <= 3_000_000);
    } catch (e) {
      if (e.message.includes("1014") || e.message.includes("fetch failed")) {
        return;
      }
      throw e;
    }
  });
});
