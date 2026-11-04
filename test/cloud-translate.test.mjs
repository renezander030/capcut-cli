import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_CAPCUT_HEADERS } from "../dist/capcut-cloud-asr.js";
import {
  DEFAULT_CAPCUT_TRANSLATE_HEADERS,
  normalizeLanguageCode,
  translateCuesCapcutCloud,
  translateUtterancesCapcutCloud,
} from "../dist/capcut-cloud-translate.js";
import { captionDraft } from "../dist/caption.js";
import { extractText, loadDraft } from "../dist/draft.js";
import { translateDraft } from "../dist/translate.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// The translation exchange runs offline: a stand-in fetch answers the way
// CapCut's common_task/sync does. The calls to ByteDance itself run only with
// CAPCUT_LIVE=1, so `npm test` and CI never send text anywhere.
const LIVE = process.env.CAPCUT_LIVE === "1";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

/** A reply carrying one translated line per line sent, the payload as a JSON string as the service sends it. */
function reply(lang, lines) {
  return json({
    ret: "0",
    errmsg: "success",
    data: { tasks: [{ payload: JSON.stringify({ translation: { [lang]: lines } }) }] },
  });
}

/** Stand-in service: `answer(sentUtterances, request)` returns the Response; every request is recorded. */
function service(answer) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), method: init.method, headers: init.headers, body });
    return answer(body.tasks[0].payload.utterances, body);
  };
  return calls;
}

/** Translates each line by prefixing the language, with one timed word per source word. */
const echo = (lang) => (sent) =>
  reply(
    lang,
    sent.map((u) => ({
      text: u.text,
      start_time: u.start_time,
      end_time: u.end_time,
      translation_text: `${lang}:${u.text}`,
      translation_words: u.text.split(" ").map((w, i) => ({
        text: `${lang}:${w}`,
        start_time: u.start_time + i * 100,
        end_time: u.start_time + (i + 1) * 100,
      })),
    })),
  );

const FAST = { retryDelayMs: 0 };

describe("capcut-cloud-translate — language normalization", () => {
  it("normalizes common language names and variants to canonical CapCut codes", () => {
    assert.equal(normalizeLanguageCode("English"), "en");
    assert.equal(normalizeLanguageCode("tieng_viet"), "vi");
    assert.equal(normalizeLanguageCode("espanol"), "es");
    assert.equal(normalizeLanguageCode("deutsch"), "de");
    assert.equal(normalizeLanguageCode("Chinese"), "zh-CN");
    assert.equal(normalizeLanguageCode("traditional chinese"), "zh-TW");
    assert.equal(normalizeLanguageCode("zh-tw"), "zh-TW");
    assert.equal(normalizeLanguageCode("nihongo"), "ja");
    assert.equal(normalizeLanguageCode("Arabic"), "ar-SA");
    assert.equal(normalizeLanguageCode("unknown-lang"), "unknown-lang");
  });
});

describe("capcut-cloud-translate — captured headers", () => {
  it("both cloud clients send the same install identity and differ only in their captured signature", () => {
    const signatureKeys = [
      "App-Sdk-Version",
      "appvr",
      "device-time",
      "sign",
      "x-ss-stub",
      "x-tt-trace-id",
      "x-khronos",
    ];
    assert.deepEqual(Object.keys(DEFAULT_CAPCUT_TRANSLATE_HEADERS), Object.keys(DEFAULT_CAPCUT_HEADERS));
    for (const key of Object.keys(DEFAULT_CAPCUT_HEADERS)) {
      if (signatureKeys.includes(key)) continue;
      assert.equal(DEFAULT_CAPCUT_TRANSLATE_HEADERS[key], DEFAULT_CAPCUT_HEADERS[key], key);
    }
    assert.equal(DEFAULT_CAPCUT_HEADERS.sign, "4a60da398f60fefd56083e55ac9eda17");
    assert.equal(DEFAULT_CAPCUT_HEADERS["x-khronos"], DEFAULT_CAPCUT_HEADERS["device-time"]);
    assert.equal(DEFAULT_CAPCUT_TRANSLATE_HEADERS.sign, "279639a654a9a0928d629f54e79fd626");
    assert.equal(DEFAULT_CAPCUT_TRANSLATE_HEADERS.appvr, "8.5.0");
  });
});

describe("capcut-cloud-translate — exchange (offline)", () => {
  it("returns nothing and sends nothing for no lines", async () => {
    const calls = service(echo("vi"));
    assert.deepEqual(await translateUtterancesCapcutCloud([], "vi"), []);
    assert.deepEqual(await translateCuesCapcutCloud([], "vi"), { cues: [], kept_original: 0 });
    assert.equal(calls.length, 0);
  });

  it("sends the subtitle task and pairs each translation with its line", async () => {
    const calls = service(echo("vi"));
    const res = await translateUtterancesCapcutCloud(
      [
        { start_time: 0, end_time: 900.4, text: "hello world" },
        { start_time: 1000, end_time: 1500, text: "bye" },
      ],
      "Vietnamese",
      { from: "english", ...FAST },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://editor-api-sg.capcutapi.com/lv/v1/common_task/sync");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers, DEFAULT_CAPCUT_TRANSLATE_HEADERS);
    const task = calls[0].body.tasks[0];
    assert.equal(task.req_key, "cc_audio_subtitle_translate");
    assert.equal(task.payload.source_language, "en");
    assert.deepEqual(task.payload.target_languages, ["vi"]);
    assert.equal(task.payload.utterances[0].end_time, 900, "times go out as whole milliseconds");
    assert.deepEqual(
      res.map((r) => r.translation_text),
      ["vi:hello world", "vi:bye"],
    );
    assert.equal(res[0].kept_original, undefined);
    assert.equal(res[0].translation_words.length, 2);
  });

  it("detects the source language unless one is given", async () => {
    const calls = service(echo("de"));
    await translateUtterancesCapcutCloud([{ start_time: 0, end_time: 0, text: "x" }], "de", FAST);
    assert.equal(calls[0].body.tasks[0].payload.source_language, "UNSPECIFIED");
  });

  it("sends 50 lines per request and keeps their order", async () => {
    const calls = service(echo("es"));
    const lines = Array.from({ length: 51 }, (_, i) => ({ start_time: i, end_time: i + 1, text: `line ${i}` }));
    const res = await translateUtterancesCapcutCloud(lines, "es", FAST);
    assert.deepEqual(
      calls.map((c) => c.body.tasks[0].payload.utterances.length),
      [50, 1],
    );
    assert.equal(res.length, 51);
    assert.equal(res[50].translation_text, "es:line 50");
  });

  it("refuses a reply with fewer lines than were sent instead of shifting translations onto other lines", async () => {
    service((sent) => echo("vi")(sent.slice(1)));
    await assert.rejects(
      translateUtterancesCapcutCloud(
        [
          { start_time: 0, end_time: 1, text: "a" },
          { start_time: 1, end_time: 2, text: "b" },
        ],
        "vi",
        FAST,
      ),
      /returned 1 line\(s\) for the 2 sent; nothing was translated/,
    );
  });

  it("keeps the original text, marked, for a line the reply left untranslated", async () => {
    service((sent) =>
      reply("vi", [
        { text: sent[0].text, translation_text: "" },
        { text: sent[1].text, translation_text: "vi:b" },
      ]),
    );
    const res = await translateUtterancesCapcutCloud(
      [
        { start_time: 0, end_time: 1, text: "a" },
        { start_time: 1, end_time: 2, text: "b" },
      ],
      "vi",
      FAST,
    );
    assert.deepEqual(
      res.map((r) => [r.translation_text, r.kept_original]),
      [
        ["a", true],
        ["vi:b", undefined],
      ],
    );
  });

  it("names the service's refusals", async () => {
    service(() => json({ ret: "1014", errmsg: "system busy" }));
    await assert.rejects(
      translateUtterancesCapcutCloud([{ start_time: 0, end_time: 1, text: "a" }], "vi", FAST),
      /1014/,
    );
    service(() => json({ ret: "2", errmsg: "bad lang" }));
    await assert.rejects(
      translateUtterancesCapcutCloud([{ start_time: 0, end_time: 1, text: "a" }], "vi", FAST),
      /\[ret=2\]: bad lang/,
    );
    service(() => reply("en", []));
    await assert.rejects(
      translateUtterancesCapcutCloud([{ start_time: 0, end_time: 1, text: "a" }], "vi", FAST),
      /"vi" \(vi\) was not recognized/,
    );
  });

  it("retries a 5xx answer and then succeeds", async () => {
    let n = 0;
    service((sent) => (++n === 1 ? new Response("down", { status: 503 }) : echo("vi")(sent)));
    const res = await translateUtterancesCapcutCloud([{ start_time: 0, end_time: 1, text: "a" }], "vi", FAST);
    assert.equal(n, 2);
    assert.equal(res[0].translation_text, "vi:a");
  });

  it("turns translated words into µs cue words and leaves an untranslated cue exactly as it was", async () => {
    service((sent) =>
      reply("vi", [
        {
          text: sent[0].text,
          translation_text: "xin chào",
          translation_words: [
            { text: "xin", start_time: 1000, end_time: 1500 },
            { text: " ", start_time: 1500, end_time: 1500 },
            { text: "chào", start_time: 1500, end_time: 2900 },
          ],
        },
        { text: sent[1].text, translation_text: "  " },
      ]),
    );
    const untouched = {
      startUs: 3_000_000,
      endUs: 4_000_000,
      text: "CapCut",
      words: [{ word: "CapCut", startUs: 3_000_000, endUs: 4_000_000 }],
    };
    const { cues, kept_original } = await translateCuesCapcutCloud(
      [{ startUs: 1_000_000, endUs: 3_000_000, text: "hello there" }, untouched],
      "vi",
      FAST,
    );
    assert.equal(kept_original, 1);
    assert.deepEqual(cues[0], {
      startUs: 1_000_000,
      endUs: 3_000_000,
      text: "xin chào",
      words: [
        { word: "xin", startUs: 1_000_000, endUs: 1_500_000 },
        { word: "chào", startUs: 1_500_000, endUs: 2_900_000 },
      ],
    });
    assert.equal(cues[1], untouched);
  });
});

describe("translate --cloud (offline)", () => {
  it("writes the translations into the new draft and counts the segments kept in their language", async (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const outDir = mkdtempSync(join(tmpdir(), "capcut-cloud-translate-"));
    t.after(() => rmSync(outDir, { recursive: true, force: true }));
    const outPath = join(outDir, "translated.json");
    const calls = service(echo("vi"));
    const res = await translateDraft(loadDraft(fix.path).draft, { to: "vi", outPath, cloud: true });
    assert.equal(calls.length, 1);
    assert.equal(res.engine, "capcut-cloud");
    assert.equal(res.kept_original, undefined);
    assert.ok(res.pairs.length >= 1);
    for (const pair of res.pairs) assert.equal(pair.translated, `vi:${pair.original}`);
    const written = loadDraft(outPath).draft;
    const texts = written.materials.texts.map((m) => extractText(m.content)).filter((x) => x.trim());
    assert.deepEqual(
      texts,
      res.pairs.map((p) => p.translated),
    );

    service((sent) =>
      reply(
        "vi",
        sent.map((u) => ({ text: u.text, translation_text: "" })),
      ),
    );
    const kept = await translateDraft(loadDraft(fix.path).draft, { to: "vi", outPath, cloud: true });
    assert.equal(kept.kept_original, kept.pairs.length);
    for (const pair of kept.pairs) assert.equal(pair.translated, pair.original);
  });
});

describe("caption --translate (offline)", () => {
  it("translates the cues before they are written and reports what was sent", async (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const { draft } = loadDraft(fix.path);
    service(echo("vi"));
    const res = await captionDraft(draft, {
      wordsJson: JSON.stringify([
        { word: "Hello", start: 0.1, end: 0.5 },
        { word: "world", start: 0.5, end: 1.0 },
      ]),
      translate: "Vietnamese",
    });
    assert.equal(res.translated_to, "vi");
    assert.deepEqual(res.translation, {
      language: "vi",
      lines: res.cues,
      to: "CapCut Cloud translation (ByteDance servers)",
      sent: true,
      kept_original: 0,
    });
    const track = draft.tracks.find((tr) => tr.type === "text" && tr.name === "captions");
    const ids = new Set(track.segments.map((s) => s.material_id));
    const written = draft.materials.texts.filter((m) => ids.has(m.id)).map((m) => extractText(m.content));
    assert.ok(written.length >= 1);
    for (const text of written) assert.match(text, /^vi:/);
  });
});

describe("--dry-run sends nothing to CapCut's translation", () => {
  function wordsFile(t) {
    const dir = mkdtempSync(join(tmpdir(), "capcut-caption-translate-words-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "words.json");
    writeFileSync(
      path,
      JSON.stringify([
        { word: "Hello", start: 0.1, end: 0.5 },
        { word: "world", start: 0.5, end: 1.0 },
      ]),
    );
    return path;
  }

  it("caption --translate --dry-run reports the lines it would send and leaves the draft as it was", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const before = readFileSync(fix.path, "utf-8");
    const r = spawnCli(["caption", fix.path, "--words", wordsFile(t), "--translate", "vi", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.translated_to, undefined);
    assert.deepEqual(r.json.translation, {
      language: "vi",
      lines: r.json.cues,
      to: "CapCut Cloud translation (ByteDance servers)",
      sent: false,
    });
    assert.doesNotMatch(r.stderr, /sending/);
    assert.equal(readFileSync(fix.path, "utf-8"), before);
  });

  it("translate --cloud --dry-run needs no API key and sends nothing", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const outDir = mkdtempSync(join(tmpdir(), "capcut-cloud-translate-"));
    t.after(() => rmSync(outDir, { recursive: true, force: true }));
    const outPath = join(outDir, "translated-cloud.json");
    const r = spawnCli(["translate", fix.path, "--to", "vi", "--out", outPath, "--cloud", "--dry-run"], {
      env: { ANTHROPIC_API_KEY: "" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.engine, "capcut-cloud");
    assert.ok(r.json.count >= 1);
    assert.ok(existsSync(outPath));
    assert.doesNotMatch(r.stderr, /sending/);
  });
});

describe("CapCut's translation service (live, CAPCUT_LIVE=1)", {
  skip: !LIVE && "set CAPCUT_LIVE=1 to call ByteDance",
}, () => {
  it("translates plain lines", async () => {
    const res = await translateUtterancesCapcutCloud(
      [
        { start_time: 0, end_time: 0, text: "Hello world" },
        { start_time: 0, end_time: 0, text: "Good morning" },
      ],
      "vi",
    );
    assert.equal(res.length, 2);
    for (const item of res) assert.equal(item.kept_original, undefined, JSON.stringify(item));
  });

  it("translates a cue with word timings inside it", async () => {
    const { cues } = await translateCuesCapcutCloud(
      [{ startUs: 1_000_000, endUs: 3_000_000, text: "The quick brown fox jumps over the lazy dog" }],
      "vi",
    );
    assert.ok(cues[0].words?.length > 0);
    assert.ok(cues[0].words[0].startUs >= 1_000_000);
    assert.ok(cues[0].words.at(-1).endUs <= 3_000_000);
  });
});
