import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { judgeLoudness } from "../dist/loudness.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;

// lavfi's 1 kHz sine reads about -21.1 LUFS with a -18.1 dBTP true peak; at
// -10 dB that is about -31.1 LUFS and -28.1 dBTP. The levels below keep
// several LU of margin around those readings.
function toneDraft(t, db) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const tone = join(fix.dir, "tone.wav");
  const made = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:duration=5",
      "-af",
      `volume=${db}dB`,
      tone,
    ],
    { encoding: "utf-8" },
  );
  assert.equal(made.status, 0, made.stderr);
  const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
  draft.tracks = draft.tracks.filter((tr) => tr.type === "audio");
  const [segment] = draft.tracks[0].segments;
  segment.volume = 1;
  segment.target_timerange = { start: 0, duration: 5_000_000 };
  segment.source_timerange = { start: 0, duration: 5_000_000 };
  draft.materials.audios[0].path = tone;
  writeFileSync(fix.path, JSON.stringify(draft));
  return fix;
}

const volumeOf = (path) => JSON.parse(readFileSync(path, "utf-8")).tracks[0].segments[0].volume;

describe("loudness gate — --tolerance and --max-true-peak on the judged mix", () => {
  it("without a tolerance or a ceiling the result and exit code stay as they were", { skip: !hasFfmpeg }, (t) => {
    const f = toneDraft(t, -10);
    const r = spawnCli(["loudness", f.path, "--target", "-14"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.gate, undefined);
    assert.equal(r.stderr, "");
  });

  it("passes when the mix as it stands is within the tolerance", { skip: !hasFfmpeg }, (t) => {
    const f = toneDraft(t, -10);
    const r = spawnCli(["loudness", f.path, "--target", "-31", "--tolerance", "1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.gate.target, -31);
    assert.equal(r.json.gate.tolerance, 1);
    assert.equal(r.json.gate.within, true);
    assert.equal(r.json.gate.estimate_lufs, r.json.program_lufs, "without --apply the mix as it stands is judged");
    assert.equal(r.json.gate.true_peak_ok, undefined, "no ceiling, no peak verdict");
    assert.equal(r.stderr, "");
  });

  it("exits 1 with a one-line reason when the mix misses the tolerance", { skip: !hasFfmpeg }, (t) => {
    const f = toneDraft(t, -10);
    const r = spawnCli(["loudness", f.path, "--target", "-14", "--tolerance", "1"]);
    assert.equal(r.status, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.gate.within, false);
    assert.ok(r.json.gate.estimate_lufs < -25, `estimate ${r.json.gate.estimate_lufs}`);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.match(
      r.stderr,
      /^loudness gate failed: the mix as it stands is estimated at -3\d(\.\d+)? LUFS, .* below the -14 LUFS target \(tolerance 1 LU\)/,
    );
    assert.equal(volumeOf(f.path), 1, "no --apply, nothing written");
  });

  it("with --apply judges the mix after the gain, and the cap can make it miss", { skip: !hasFfmpeg }, (t) => {
    const f = toneDraft(t, -10);
    const reached = spawnCli(["loudness", f.path, "--target", "-20", "--tolerance", "0.5", "--apply"]);
    assert.equal(reached.status, 0, reached.stderr);
    assert.equal(reached.json.ok, true);
    assert.equal(reached.json.gate.within, true);
    assert.ok(Math.abs(reached.json.gate.estimate_lufs - -20) < 0.05, `estimate ${reached.json.gate.estimate_lufs}`);
    assert.ok(reached.json.program_lufs < -25, "program_lufs still reports the mix before the gain");
    assert.ok(volumeOf(f.path) > 3, "the gain is written");
    // Measured again, the written volume reads as the gate predicted.
    const again = spawnCli(["loudness", f.path]);
    assert.equal(again.json.program_lufs, reached.json.gate.estimate_lufs);

    const g = toneDraft(t, -10);
    const capped = spawnCli([
      "loudness",
      g.path,
      "--target",
      "-14",
      "--tolerance",
      "1",
      "--apply",
      "--max-gain-db",
      "5",
    ]);
    assert.equal(capped.status, 1);
    assert.equal(capped.json.ok, false);
    assert.equal(capped.json.gate.within, false);
    assert.ok(Math.abs(capped.json.gate.estimate_lufs - (capped.json.program_lufs + 5)) < 0.05);
    assert.match(capped.stderr, /the mix after this run's gain .* --max-gain-db 5 capped the boost/);
    assert.equal(capped.json.applied, true, "the capped gain is still written, as lint --fix writes its repairs");
    assert.equal(capped.json.changed, 1);
    assert.ok(Math.abs(volumeOf(g.path) - 10 ** (5 / 20)) < 0.001);
  });

  it("--max-true-peak judges the loudest clip at the volume judged", { skip: !hasFfmpeg }, (t) => {
    const f = toneDraft(t, -10);
    const over = spawnCli(["loudness", f.path, "--max-true-peak", "-35"]);
    assert.equal(over.status, 1);
    assert.equal(over.json.ok, false);
    assert.equal(over.json.gate.max_true_peak, -35);
    assert.equal(over.json.gate.true_peak_ok, false);
    assert.equal(over.json.gate.within, undefined, "no tolerance, no loudness verdict");
    assert.match(over.stderr, /peaks at -2\d(\.\d+)? dBTP, above the -35 dBTP ceiling/);

    const under = spawnCli(["loudness", f.path, "--max-true-peak", "-20"]);
    assert.equal(under.status, 0, under.stderr);
    assert.equal(under.json.gate.true_peak_ok, true);
    assert.ok(under.json.gate.estimate_true_peak < -25);

    // The same ceiling fails once this run's +11 dB gain is judged.
    const boosted = spawnCli([
      "loudness",
      f.path,
      "--target",
      "-20",
      "--tolerance",
      "1",
      "--max-true-peak",
      "-20",
      "--apply",
      "--dry-run",
    ]);
    assert.equal(boosted.status, 1);
    assert.equal(boosted.json.gate.within, true);
    assert.equal(boosted.json.gate.true_peak_ok, false);
    assert.ok(boosted.json.gate.estimate_true_peak > -20);
    assert.equal(volumeOf(f.path), 1, "--dry-run writes nothing");
  });

  it("refuses --tolerance without a target and values that are not numbers", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    assert.match(spawnCli(["loudness", fix.path, "--tolerance", "1"]).stderr, /--tolerance needs --target/);
    assert.match(
      spawnCli(["loudness", fix.path, "--target", "-14", "--tolerance", "-1"]).stderr,
      /--tolerance must be a number of LU >= 0/,
    );
    assert.match(
      spawnCli(["loudness", fix.path, "--max-true-peak", "loud"]).stderr,
      /--max-true-peak must be a true-peak level in dBTP/,
    );
  });
});

describe("judgeLoudness", () => {
  const report = () => ({
    mode: "uniform",
    program_lufs: -20,
    target: -14,
    max_gain_db: 3,
    clips: [
      {
        segment_id: "c1",
        track: "AAA",
        path: "a.wav",
        duration_us: 1_000_000,
        volume: 1,
        measured_lufs: -20,
        true_peak_dbfs: -6,
        effective_lufs: -20,
        gain_db: 3,
        new_volume: 1.4125,
        clamped: true,
      },
    ],
  });

  it("is null without a tolerance or a ceiling", () => {
    assert.equal(judgeLoudness(report(), {}), null);
  });

  it("judges the mix as it stands, or after the gain", () => {
    const standing = judgeLoudness(report(), { tolerance: 1 });
    assert.deepEqual(standing.gate, { target: -14, tolerance: 1, estimate_lufs: -20, within: false });
    assert.match(standing.failure, /as it stands is estimated at -20 LUFS, 6 LU below/);

    const after = judgeLoudness(report(), { tolerance: 2, afterGain: true });
    assert.equal(after.gate.estimate_lufs, -17);
    assert.equal(after.gate.within, false);
    assert.match(after.failure, /after this run's gain .* --max-gain-db 3 capped the boost/);
    assert.equal(judgeLoudness(report(), { tolerance: 3, afterGain: true }).failure, null, "the edge counts as within");
  });

  it("judges the true peak at the volume judged", () => {
    assert.equal(judgeLoudness(report(), { maxTruePeak: -4 }).gate.true_peak_ok, true);
    const after = judgeLoudness(report(), { maxTruePeak: -4, afterGain: true });
    assert.equal(after.gate.estimate_true_peak, -3);
    assert.equal(after.gate.true_peak_ok, false);
    assert.match(after.failure, /peaks at -3 dBTP, above the -4 dBTP ceiling/);
  });

  it("fails what it cannot measure and refuses a tolerance without a target", () => {
    const silent = report();
    silent.program_lufs = null;
    Object.assign(silent.clips[0], { measured_lufs: null, effective_lufs: null, true_peak_dbfs: null });
    const judged = judgeLoudness(silent, { tolerance: 1, maxTruePeak: -1 });
    assert.equal(judged.gate.within, false);
    assert.equal(judged.gate.true_peak_ok, false);
    assert.match(judged.failure, /loudness cannot be judged; .* true peak cannot be judged/);
    const untargeted = report();
    delete untargeted.target;
    assert.throws(() => judgeLoudness(untargeted, { tolerance: 1 }), /--tolerance needs --target/);
  });
});
