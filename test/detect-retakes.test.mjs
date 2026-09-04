import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// detect-retakes: repeated takes in caption cues → cut the earlier one, keep
// the later. Three guards (window, min words, similarity) are what separate it
// from the "collapsed 29 minutes into 1:47" failure it was designed against.

function srt(cues) {
  const stamp = (s) => {
    const ms = Math.round(s * 1000);
    const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
    const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
    const sec = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
    const milli = String(ms % 1000).padStart(3, "0");
    return `${h}:${m}:${sec},${milli}`;
  };
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join("\n");
}

const TAKES = [
  { start: 0, end: 3, text: "Welcome back to the channel, today we look at CapCut drafts" },
  { start: 3.5, end: 6.5, text: "welcome back to the channel today we look at capcut drafts." },
  { start: 7, end: 9, text: "First, the timeline file." },
  { start: 9.5, end: 12, text: "Okay so" },
  { start: 12.5, end: 14, text: "Okay so" },
  { start: 15, end: 18, text: "The sidecar registers every media file you import." },
];

function scratchSrt(cues) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-retakes-"));
  const path = join(dir, "cues.srt");
  writeFileSync(path, srt(cues));
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("detect-retakes", () => {
  it("--srt: finds the repeated sentence, cuts the earlier take, keeps the later; short cues never count", (t) => {
    const s = scratchSrt(TAKES);
    t.after(s.cleanup);
    const r = spawnCli(["detect-retakes", "--srt", s.path]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.cues, 6);
    assert.equal(r.json.retakes.length, 1, JSON.stringify(r.json.retakes));
    const [pair] = r.json.retakes;
    assert.equal(pair.earlier.start, 0);
    assert.equal(pair.earlier.end, 3);
    assert.equal(pair.later.start, 3.5);
    assert.equal(pair.similarity, 1, "punctuation and case never count against a repeat");
    assert.equal(pair.words, 11);
    // "Okay so" repeats but is below --min-words.
    assert.ok(!r.json.retakes.some((p) => /okay so/i.test(p.earlier.text)));
    assert.deepEqual(
      r.json.cuts.map((c) => [c.start, c.end, c.start_us, c.end_us]),
      [[0, 3, 0, 3_000_000]],
    );
    // Keeps are the complement over the last cue's end (18 s).
    assert.deepEqual(
      r.json.keeps.map((k) => [k.start, k.end]),
      [[3, 18]],
    );
    assert.equal(r.json.duration_us, 18_000_000);
    assert.equal(r.json.window, 60);
    assert.equal(r.json.similarity, 0.8);
    assert.equal(r.json.min_words, 4);
  });

  it("the window guard: a repeat too far away is not a retake", (t) => {
    const far = [TAKES[0], { start: 200, end: 203, text: TAKES[1].text }];
    const s = scratchSrt(far);
    t.after(s.cleanup);
    const r = spawnCli(["detect-retakes", "--srt", s.path]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.retakes.length, 0);
    const wide = spawnCli(["detect-retakes", "--srt", s.path, "--window", "300"]);
    assert.equal(wide.json.retakes.length, 1);
  });

  it("the similarity guard: a rephrased sentence is not a repeat unless the floor is lowered", (t) => {
    const cues = [
      { start: 0, end: 3, text: "the sidecar registers every media file you import" },
      { start: 4, end: 7, text: "the sidecar lists every media file that you import into the draft" },
    ];
    const s = scratchSrt(cues);
    t.after(s.cleanup);
    const strict = spawnCli(["detect-retakes", "--srt", s.path]);
    assert.equal(strict.json.retakes.length, 0);
    const loose = spawnCli(["detect-retakes", "--srt", s.path, "--similarity", "0.6"]);
    assert.equal(loose.json.retakes.length, 1);
    assert.ok(loose.json.retakes[0].similarity >= 0.6 && loose.json.retakes[0].similarity < 0.8);
  });

  it("three attempts keep the last one: two pairs, two adjacent cuts merged when they touch", (t) => {
    const cues = [
      { start: 0, end: 2, text: "we ship nine items in every release" },
      { start: 2, end: 4, text: "we ship nine items in every release" },
      { start: 4.5, end: 6.5, text: "we ship nine items in every release" },
    ];
    const s = scratchSrt(cues);
    t.after(s.cleanup);
    const r = spawnCli(["detect-retakes", "--srt", s.path]);
    assert.equal(r.json.retakes.length, 2);
    assert.deepEqual(
      r.json.cuts.map((c) => [c.start, c.end]),
      [[0, 4]],
      "touching earlier takes merge into one cut",
    );
    assert.deepEqual(
      r.json.keeps.map((k) => [k.start, k.end]),
      [[4, 6.5]],
    );
  });

  it("project form: reads the draft's text tracks, bounds keeps by the draft duration, honours --track-name", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const s = scratchSrt(TAKES);
    t.after(s.cleanup);
    const imported = spawnCli(["import-srt", fix.path, s.path, "--track-name", "takes"]);
    assert.equal(imported.status, 0, `stderr: ${imported.stderr}`);

    const r = spawnCli(["detect-retakes", fix.path, "--track-name", "takes"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.source, "takes");
    assert.equal(r.json.retakes.length, 1);
    assert.equal(r.json.retakes[0].earlier.start_us, 0);
    assert.equal(r.json.retakes[0].later.start_us, 3_500_000);

    const wrong = spawnCli(["detect-retakes", fix.path, "--track-name", "nope"]);
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /No text track named/);

    // The fixture's own caption text is never mistaken for a retake of the imported cues.
    const all = spawnCli(["detect-retakes", fix.path]);
    assert.equal(all.status, 0, `stderr: ${all.stderr}`);
    assert.equal(all.json.retakes.length, 1);
  });

  it("-H prints the pairs with cut/keep text; --json wins over -H", (t) => {
    const s = scratchSrt(TAKES);
    t.after(s.cleanup);
    const human = spawnCli(["detect-retakes", "--srt", s.path, "-H"]);
    assert.equal(human.status, 0, `stderr: ${human.stderr}`);
    assert.match(human.stdout, /Retakes:\s+1/);
    assert.match(human.stdout, /cut:\s+Welcome back to the channel/);
    assert.match(human.stdout, /keep:\s+welcome back to the channel/);
    assert.match(human.stdout, /Next: pipe the keep segments/);
    const forced = spawnCli(["detect-retakes", "--srt", s.path, "-H", "--json"]);
    assert.ok(forced.json && Array.isArray(forced.json.retakes));
  });

  it("validates its guards and refuses a project together with --srt", (t) => {
    const s = scratchSrt(TAKES);
    t.after(s.cleanup);
    for (const [flag, value, message] of [
      ["--window", "0", /--window must be > 0/],
      ["--similarity", "1.5", /--similarity must be in \(0, 1\]/],
      ["--min-words", "0", /--min-words must be a positive integer/],
    ]) {
      const r = spawnCli(["detect-retakes", "--srt", s.path, flag, value]);
      assert.notEqual(r.status, 0, `${flag} ${value} should fail`);
      assert.match(r.stderr, message);
    }
    const both = spawnCli(["detect-retakes", s.path, "--srt", s.path]);
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /drop the <project> argument/);
    const missing = spawnCli(["detect-retakes", "--srt", join(s.dir, "nope.srt")]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--srt file not found/);
  });

  it("describe lists detect-retakes as a non-mutating command with its guards", () => {
    const r = spawnCli(["describe"]);
    const spec = r.json.commands.find((c) => c.name === "detect-retakes");
    assert.ok(spec, "describe must list detect-retakes");
    assert.equal(spec.mutates, false);
    for (const flag of ["--window", "--similarity", "--min-words", "--srt", "--track-name"]) {
      assert.ok(
        spec.options.some((o) => o.flags.includes(flag)),
        `${flag} declared`,
      );
    }
  });
});
