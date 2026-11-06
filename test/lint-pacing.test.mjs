import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_LINT_OPTIONS, fixDraft, lintDraft } from "../dist/lint.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const opts = { ...DEFAULT_LINT_OPTIONS, checkLocalPaths: false, probeMedia: false };

function seg(id, materialId, start, duration) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start, duration },
    source_timerange: { start: 0, duration },
    speed: 1,
    volume: 1,
    visible: true,
    clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
    extra_material_refs: [],
    render_index: 0,
  };
}

const track = (type, name, segments) => ({ id: name, type, name, attribute: 0, segments });

// A still held 10 s, a 15 s shot, a 2 s still and an 8 s still on the main
// track; a 20 s picture-in-picture shot on an overlay track.
function pacedDraft() {
  return {
    fps: 30,
    duration: 35_000_000,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    materials: {
      videos: [
        { id: "p", type: "photo", path: "", duration: 10_800_000_000 },
        { id: "v", type: "video", path: "", duration: 60_000_000 },
      ],
      audios: [],
      texts: [],
      speeds: [],
    },
    tracks: [
      track("video", "main", [
        seg("still-long", "p", 0, 10_000_000),
        seg("shot-long", "v", 10_000_000, 15_000_000),
        seg("still-short", "p", 25_000_000, 2_000_000),
        seg("still-edge", "p", 27_000_000, 8_000_000),
      ]),
      track("video", "overlay", [seg("pip-long", "v", 0, 20_000_000)]),
    ],
  };
}

const codes = (issues, code) => issues.filter((issue) => issue.code === code);

describe("lint pacing — still-too-long and shot-too-long", () => {
  it("runs neither check unless its threshold is given", () => {
    const issues = lintDraft(pacedDraft(), opts);
    assert.deepEqual(codes(issues, "still-too-long"), []);
    assert.deepEqual(codes(issues, "shot-too-long"), []);
  });

  it("reports a still image that plays longer than --max-still-secs", () => {
    const issues = codes(lintDraft(pacedDraft(), { ...opts, maxStillUs: 8_000_000 }), "still-too-long");
    assert.deepEqual(
      issues.map((issue) => [issue.location.segment_id, issue.location.track, issue.severity, issue.fixable]),
      [["still-long", "main", "warning", false]],
      "the 2 s still and the still of exactly 8 s are not longer than the limit",
    );
    assert.equal(
      issues[0].message,
      'Still image still-lo on video track "main" starts at 0s and plays 10s, longer than the 8s --max-still-secs limit',
    );
    assert.deepEqual(codes(lintDraft(pacedDraft(), { ...opts, maxStillUs: 8_000_000 }), "shot-too-long"), []);
  });

  it("reports every video clip, overlays included, longer than --max-shot-secs and never a still", () => {
    const issues = codes(lintDraft(pacedDraft(), { ...opts, maxShotUs: 12_000_000 }), "shot-too-long");
    assert.deepEqual(
      issues.map((issue) => [issue.location.segment_id, issue.location.track]),
      [
        ["shot-long", "main"],
        ["pip-long", "overlay"],
      ],
    );
    assert.match(
      issues[0].message,
      /^Video clip shot-lon on video track "main" starts at 10s and plays 15s, longer than the 12s --max-shot-secs limit$/,
    );
    assert.deepEqual(codes(lintDraft(pacedDraft(), { ...opts, maxShotUs: 12_000_000 }), "still-too-long"), []);
  });

  it("skips a segment whose material is missing and stays report-only under --fix", () => {
    const draft = pacedDraft();
    draft.tracks[0].segments[0].material_id = "gone";
    const strict = { ...opts, maxStillUs: 1_000_000, maxShotUs: 1_000_000 };
    const issues = lintDraft(draft, strict);
    assert.ok(!issues.some((issue) => issue.location?.segment_id === "still-long" && issue.code.endsWith("-too-long")));
    const { fixed, remaining } = fixDraft(draft, strict);
    assert.ok(!fixed.some((issue) => issue.code === "still-too-long" || issue.code === "shot-too-long"));
    assert.equal(codes(remaining, "still-too-long").length, 2);
    assert.equal(codes(remaining, "shot-too-long").length, 2);
  });
});

describe("lint pacing — on the command line", () => {
  it("--max-still-secs and --max-shot-secs warn with exit 1; without them the result is unchanged", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    draft.materials.videos[0].type = "photo"; // the first 5 s clip becomes a still
    writeFileSync(fix.path, JSON.stringify(draft));

    const plain = spawnCli(["lint", fix.path, "--no-check-paths", "--no-probe"]);
    assert.equal(plain.status, 0, plain.stdout);
    assert.equal(plain.json.summary.total, 0);

    const still = spawnCli(["lint", fix.path, "--no-check-paths", "--no-probe", "--max-still-secs", "4"]);
    assert.equal(still.status, 1, still.stdout);
    assert.deepEqual(
      still.json.issues.map((issue) => [issue.code, issue.location.segment_id]),
      [["still-too-long", draft.tracks[0].segments[0].id]],
    );

    const shot = spawnCli(["lint", fix.path, "--no-check-paths", "--no-probe", "--max-shot-secs", "4.5", "-H"]);
    assert.equal(shot.status, 1, shot.stdout);
    assert.match(
      shot.stdout,
      /WARNING shot-too-long +\[aaaaaa02\] +Video clip aaaaaa02 on video track "Track 1" starts at 5s and plays 5s, longer than the 4\.5s --max-shot-secs limit/,
    );
  });

  it("refuses a threshold that is not a positive number of seconds", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    for (const [flag, value] of [
      ["--max-still-secs", "0"],
      ["--max-shot-secs", "-2"],
      ["--max-shot-secs", "long"],
    ]) {
      const r = spawnCli(["lint", fix.path, flag, value]);
      assert.equal(r.status, 1, `${flag} ${value}`);
      assert.match(r.stderr, new RegExp(`${flag} must be a number of seconds > 0`));
    }
  });
});
