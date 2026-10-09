import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { applyLexicon, LexiconError, parseLexicon } from "../dist/lexicon.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const isWindows = process.platform === "win32"; // fake-TTS tests use /bin/sh scripts

const rules = (...list) => parseLexicon(list);
const spoken = (text, ...list) => applyLexicon(text, rules(...list)).spoken_text;

describe("lexicon — parsing", () => {
  it("accepts { rules: [...] } and a bare array, defaulting case_sensitive to true", () => {
    const wrapped = parseLexicon({ rules: [{ text: "Nguyen", say: "Win" }] });
    const bare = parseLexicon([{ text: "Nguyen", say: "Win" }]);
    assert.deepEqual(wrapped, [{ text: "Nguyen", say: "Win", case_sensitive: true }]);
    assert.deepEqual(bare, wrapped);
    assert.equal(parseLexicon([{ text: "a", say: "b", case_sensitive: false }])[0].case_sensitive, false);
  });

  for (const [label, doc] of [
    ["a non-array document", { rule: [] }],
    ["a missing say", [{ text: "x" }]],
    ["a missing text", [{ say: "x" }]],
    ["an empty text", [{ text: "", say: "x" }]],
    ["a non-string say", [{ text: "x", say: 3 }]],
    ["a non-object rule", ["x"]],
    ["a non-boolean case_sensitive", [{ text: "x", say: "y", case_sensitive: "no" }]],
  ]) {
    it(`refuses ${label} as lexicon-invalid`, () => {
      assert.throws(
        () => parseLexicon(doc),
        (e) => e instanceof LexiconError && e.gate === "lexicon-invalid",
      );
    });
  }
});

describe("lexicon — matcher", () => {
  it("replaces at word boundaries only", () => {
    assert.equal(
      spoken("SQL and MySQLite and SQL_x, (SQL).", { text: "SQL", say: "sequel" }),
      "sequel and MySQLite and SQL_x, (sequel).",
    );
  });

  it("does not require a boundary at a non-word rule edge", () => {
    assert.equal(spoken("C++is fun", { text: "C++", say: "C plus plus" }), "C plus plusis fun");
  });

  it("prefers the longest match at a position", () => {
    const r = applyLexicon(
      "New York City and New York",
      rules({ text: "New York", say: "NY" }, { text: "New York City", say: "NYC" }),
    );
    assert.equal(r.spoken_text, "NYC and NY");
    assert.deepEqual(
      r.applied.map((a) => [a.rule_text, a.source_start, a.source_end]),
      [
        ["New York City", 0, 13],
        ["New York", 18, 26],
      ],
    );
  });

  it("matches CJK rules anywhere and lets Latin rules sit next to CJK text", () => {
    assert.equal(spoken("我喜欢重庆火锅", { text: "重庆", say: "Chongqing" }), "我喜欢Chongqing火锅");
    assert.equal(spoken("我用SQL查询", { text: "SQL", say: "sequel" }), "我用sequel查询");
  });

  it("refuses equal-length matches that say different things, but allows identical duplicates", () => {
    assert.throws(
      () =>
        applyLexicon(
          "use SQL",
          rules({ text: "SQL", say: "sequel" }, { text: "sql", say: "S Q L", case_sensitive: false }),
        ),
      (e) => e instanceof LexiconError && e.gate === "lexicon-ambiguous",
    );
    assert.equal(spoken("use SQL", { text: "SQL", say: "sequel" }, { text: "SQL", say: "sequel" }), "use sequel");
    // A conflicting pair that never matches the text is not ambiguous.
    assert.equal(spoken("hello", { text: "SQL", say: "a" }, { text: "SQL", say: "b" }), "hello");
  });

  it("is case-sensitive by default and case-insensitive on request", () => {
    assert.equal(spoken("nguyen Nguyen", { text: "Nguyen", say: "Win" }), "nguyen Win");
    assert.equal(spoken("nguyen NGUYEN", { text: "Nguyen", say: "Win", case_sensitive: false }), "Win Win");
  });

  it("reports offsets in UTF-16 code units past astral characters", () => {
    const r = applyLexicon("😀 Nguyen", rules({ text: "Nguyen", say: "Win" }));
    assert.deepEqual(r.applied, [{ rule_text: "Nguyen", say: "Win", source_start: 3, source_end: 9 }]);
  });
});

/** Minimal valid PCM WAV the fake TTS copies to {out}. */
function writeTinyWav(path) {
  const dataSize = 8000 * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataSize, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataSize, 40);
  writeFileSync(path, b);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-tts-lexicon-"));
  const srcWav = join(dir, "src.wav");
  writeTinyWav(srcWav);
  const fakeFfprobe = join(dir, "fake-ffprobe");
  const probeJson = JSON.stringify({
    streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 1 }],
    format: { duration: "1.5" },
  });
  writeFileSync(fakeFfprobe, `#!/bin/sh\necho '${probeJson}'\n`);
  chmodSync(fakeFfprobe, 0o755);
  const capture = join(dir, "capture");
  const ran = join(dir, "ran");
  // Records the stdin text it was handed, then writes the wav.
  const fakeTts = join(dir, "fake-tts");
  writeFileSync(fakeTts, `#!/bin/sh\ntouch "${ran}"\ncat > "${capture}"\ncp "${srcWav}" "$1"\n`);
  chmodSync(fakeTts, 0o755);
  const lexicon = (doc) => {
    const p = join(dir, `lexicon-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc));
    return p;
  };
  return {
    dir,
    fakeFfprobe,
    fakeTts,
    capture,
    ran,
    lexicon,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("capcut tts --lexicon — end to end with a fake TTS", () => {
  const s = setup();
  const fix = tmpDraft();
  after(() => {
    s.cleanup();
    fix.cleanup();
  });
  const run = (extra) =>
    spawnCli(["tts", fix.path, ...extra, "--tts-cmd", `${s.fakeTts} {out}`, "--ffprobe-cmd", s.fakeFfprobe]);

  it("speaks the rewritten text and reports the applied rules", { skip: isWindows }, () => {
    const text = "Dr. Nguyen explains SQL, not MySQLite.";
    const lex = s.lexicon({
      rules: [
        { text: "Nguyen", say: "Win" },
        { text: "sql", say: "sequel", case_sensitive: false },
      ],
    });
    const r = run(["--text", text, "--lexicon", lex]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(readFileSync(s.capture, "utf-8"), "Dr. Win explains sequel, not MySQLite.");
    assert.equal(r.json.text_chars, text.length, "text_chars keeps describing the original text");
    assert.equal(r.json.lexicon.rules, 2);
    assert.equal(r.json.lexicon.spoken_text, "Dr. Win explains sequel, not MySQLite.");
    assert.deepEqual(
      r.json.lexicon.applied.map((a) => [a.rule_text, a.source_start, a.source_end]),
      [
        ["Nguyen", 4, 10],
        ["sql", 20, 23],
      ],
    );
    assert.equal(text.slice(4, 10), "Nguyen");
    // tts writes no visible text: nothing in the draft carries the spoken spelling.
    const draftText = readFileSync(fix.path, "utf-8");
    assert.ok(!draftText.includes("sequel"), "the draft must not contain the spoken rewrite");
  });

  it("applies to --text-file content and accepts a top-level array", { skip: isWindows }, () => {
    const textFile = join(s.dir, "script.txt");
    writeFileSync(textFile, "我在重庆\n");
    const r = run(["--text-file", textFile, "--lexicon", s.lexicon([{ text: "重庆", say: "Chongqing" }])]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(readFileSync(s.capture, "utf-8"), "我在Chongqing");
    assert.equal(r.json.lexicon.applied[0].source_start, 2);
  });

  for (const [label, doc, gate] of [
    ["a rule without say", { rules: [{ text: "x" }] }, "lexicon-invalid"],
    ["an empty text rule", [{ text: "", say: "y" }], "lexicon-invalid"],
    ["unparseable JSON", "{ rules: ", "lexicon-invalid"],
    [
      "equal-length rules with different say values",
      [
        { text: "Nguyen", say: "Win" },
        { text: "nguyen", say: "New-yen", case_sensitive: false },
      ],
      "lexicon-ambiguous",
    ],
  ]) {
    it(`refuses ${label} before the engine runs`, { skip: isWindows }, () => {
      rmSync(s.ran, { force: true });
      const audioDir = join(fix.dir, "assets", "audio");
      const count = () => (existsSync(audioDir) ? readdirSync(audioDir).length : 0);
      const before = count();
      const r = run(["--text", "Dr. Nguyen", "--lexicon", s.lexicon(doc)]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, new RegExp(`refused \\[${gate}\\]`));
      assert.equal(existsSync(s.ran), false, "the TTS engine must not run");
      assert.equal(count(), before);
    });
  }

  it("refuses a missing lexicon file", () => {
    const r = run(["--text", "hello", "--lexicon", join(s.dir, "nope.json")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refused \[lexicon-invalid\]/);
  });
});
