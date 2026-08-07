import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEN_BURNS = join(__dirname, "..", "skills", "capcut-edit", "scripts", "ken-burns.sh");

// First video segment of the canonical fixture (see test/draft_content.json).
const SEG = "aaaaaa01";
const SEG_FULL = "aaaaaa01-0000-0000-0000-000000000001";

function keyframeList(path, propertyType, segId = SEG_FULL) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  for (const track of draft.tracks) {
    const seg = track.segments.find((s) => s.id === segId);
    if (!seg) continue;
    return (seg.common_keyframes ?? []).find((l) => l.property_type === propertyType)?.keyframe_list ?? [];
  }
  return [];
}

const HEX32 = /^[0-9a-f]{32}$/;

describe("keyframe --easing: snapshot encodings", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("back-compat: no easing still writes the Line encoding", () => {
    const r = spawnCli(["keyframe", fix.path, SEG, "alpha", "0s", "0.5"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const list = keyframeList(fix.path, "KFTypeAlpha");
    assert.equal(list.length, 1);
    assert.match(list[0].id, HEX32);
    assert.deepEqual(list[0], {
      curveType: "Line",
      graphID: "",
      left_control: { x: 0, y: 0 },
      right_control: { x: 0, y: 0 },
      id: list[0].id,
      time_offset: 0,
      values: [0.5],
    });
  });

  it("--easing linear writes the same Line encoding as no easing", () => {
    const r = spawnCli(["keyframe", fix.path, SEG, "rotation", "1s", "45deg", "--easing", "linear"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const list = keyframeList(fix.path, "KFTypeRotation");
    assert.deepEqual(list[0], {
      curveType: "Line",
      graphID: "",
      left_control: { x: 0, y: 0 },
      right_control: { x: 0, y: 0 },
      id: list[0].id,
      time_offset: 1000000,
      values: [45],
    });
  });

  // Bezier handle profiles per easing for a 1.0 -> 1.3 pair over 5s:
  //   handle x = ratio × interval; ease-out's outgoing y = round(0.94 × Δ, 6).
  // Ratios from the CapCut UI oracle in Davidb-2107/capcut-cli-david.
  const PAIR_SNAPSHOTS = [
    ["ease-in", "scale_x", "KFTypeScaleX", { x: 2100000, y: 0 }, { x: 0, y: 0 }],
    ["ease-out", "scale_y", "KFTypeScaleY", { x: 1600000, y: 0.282 }, { x: -2000000, y: 0 }],
    ["ease-in-out", "position_x", "KFTypePositionX", { x: 2100000, y: 0 }, { x: -2100000, y: 0 }],
  ];

  for (const [easing, property, propertyType, startRight, endLeft] of PAIR_SNAPSHOTS) {
    it(`--easing ${easing} writes the FreeCurveInOut handle pair`, () => {
      const lines = [
        JSON.stringify({ property, time: 0, value: "1.0" }),
        JSON.stringify({ property, time: 5000000, value: "1.3" }),
      ].join("\n");
      const r = spawnCli(["keyframe", fix.path, SEG, "--batch", "--easing", easing], { input: lines });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const list = keyframeList(fix.path, propertyType);
      assert.equal(list.length, 2);
      assert.deepEqual(list[0], {
        curveType: "FreeCurveInOut",
        graphID: "",
        left_control: { x: 0, y: 0 },
        right_control: startRight,
        id: list[0].id,
        time_offset: 0,
        values: [1],
      });
      assert.deepEqual(list[1], {
        curveType: "FreeCurveInOut",
        graphID: "",
        left_control: endLeft,
        right_control: { x: 0, y: 0 },
        id: list[1].id,
        time_offset: 5000000,
        values: [1.3],
      });
    });
  }

  it("per-line easing in --batch overrides the --easing flag", () => {
    const lines = [
      JSON.stringify({ property: "contrast", time: 0, value: "0", easing: "ease-out" }),
      JSON.stringify({ property: "contrast", time: 2000000, value: "+0.5", easing: "ease-out" }),
    ].join("\n");
    const r = spawnCli(["keyframe", fix.path, SEG, "--batch", "--easing", "linear"], { input: lines });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const list = keyframeList(fix.path, "KFTypeContrast");
    assert.equal(list[0].curveType, "FreeCurveInOut");
    assert.deepEqual(list[0].right_control, { x: 640000, y: 0.47 });
    assert.deepEqual(list[1].left_control, { x: -800000, y: 0 });
  });
});

describe("keyframe --easing: ease-out oracle replay", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  // Replays the CapCut UI oracle capture from Davidb-2107/capcut-cli-david
  // (test-fixtures/oracles/cubic-out-triplet-frame-aligned.json): 3 scale_x
  // keyframes at 0 / 5s / 8.133333s with values 1.0 / 1.3 / 1.0, ease-out
  // applied per keyframe. Inserting the third keyframe must retro-update the
  // second one's outgoing handle for the new 3_133_333μs interval.
  // CapCut's own bytes are x=1002666 / x=-1253334 on the non-frame-aligned
  // interval; Math.round lands within the oracle's documented ±1μs tolerance.
  it("incremental inserts retro-update neighbour handles like the UI", () => {
    const inputs = [
      { time: 0, value: "1.0" },
      { time: 5000000, value: "1.3" },
      { time: 8133333, value: "1.0" },
    ];
    for (const { time, value } of inputs) {
      const line = JSON.stringify({ property: "scale_x", time, value, easing: "ease-out" });
      const r = spawnCli(["keyframe", fix.path, SEG, "--batch"], { input: line });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    }
    const list = keyframeList(fix.path, "KFTypeScaleX");
    assert.equal(list.length, 3);
    const controls = list.map((k) => ({ left: k.left_control, right: k.right_control }));
    assert.deepEqual(controls, [
      { left: { x: 0, y: 0 }, right: { x: 1600000, y: 0.282 } },
      { left: { x: -2000000, y: 0 }, right: { x: 1002667, y: -0.282 } },
      { left: { x: -1253333, y: 0 }, right: { x: 0, y: 0 } },
    ]);
    assert.ok(list.every((k) => k.curveType === "FreeCurveInOut"));
  });
});

describe("keyframe --easing: rejection", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("rejects an unknown easing on the flag", () => {
    const r = spawnCli(["keyframe", fix.path, SEG, "alpha", "0s", "0.5", "--easing", "bounce"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unsupported keyframe easing: bounce/);
    assert.match(r.stderr, /linear, ease-in, ease-out, ease-in-out/);
  });

  it("rejects an unknown easing on a batch line", () => {
    const line = JSON.stringify({ property: "alpha", time: 0, value: "0.5", easing: "elastic" });
    const r = spawnCli(["keyframe", fix.path, SEG, "--batch"], { input: line });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unsupported keyframe easing: elastic/);
  });
});

// v0.13.0 review: `easing in EASING_PROFILES` matched inherited
// Object.prototype members, so EASING_PROFILES[easing] resolved to an
// inherited function whose ratios are undefined — Math.round(undefined ×
// interval) = NaN, serialized by JSON.stringify as `"x": null` control
// points, with exit 0. Every prototype name must be rejected up front.
describe("keyframe --easing: inherited prototype names are rejected", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  for (const name of ["hasOwnProperty", "toString", "constructor", "valueOf", "__proto__", "isPrototypeOf"]) {
    it(`rejects '${name}' on the flag`, () => {
      const r = spawnCli(["keyframe", fix.path, SEG, "uniform_scale", "3s", "1.3", "--easing", name]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`Unsupported keyframe easing: ${name}`));
    });
  }

  it("rejects a prototype name on a batch line and leaves the draft uncorrupted", () => {
    // Mirrors the reviewer's reproduction: two keyframes with easing
    // "toString" used to exit 0 and write "x": null into draft_content.json.
    const lines = [
      JSON.stringify({ property: "uniform_scale", time: 0, value: "1.0", easing: "toString" }),
      JSON.stringify({ property: "uniform_scale", time: 3000000, value: "1.3", easing: "toString" }),
    ].join("\n");
    const r = spawnCli(["keyframe", fix.path, SEG, "--batch"], { input: lines });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unsupported keyframe easing: toString/);
    const raw = readFileSync(fix.path, "utf-8");
    assert.ok(!/"x":\s*null/.test(raw), "draft contains null control points");
    assert.equal(keyframeList(fix.path, "UNIFORM_SCALE").length, 0);
  });

  it("rejects inherited prototype names as keyframe properties too", () => {
    const r = spawnCli(["keyframe", fix.path, SEG, "toString", "0s", "1.0"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unsupported keyframe property: toString/);
  });
});

// v0.13.0 review: a plain (linear) insert skipped the neighbour handle
// updates entirely, so an eased pair kept facing handles computed against the
// OLD prev→next interval — t=0's right handle reached 1.6s into a segment now
// only 1s long (overshoot toward ~1.47 + snap-back in CapCut).
describe("keyframe: linear insert between an eased pair clears stale handles", () => {
  it("resets both neighbours' facing handles (and curveType when bare)", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    assert.equal(spawnCli(["keyframe", fix.path, SEG, "uniform_scale", "0s", "1.0"]).status, 0);
    assert.equal(spawnCli(["keyframe", fix.path, SEG, "uniform_scale", "5s", "1.5", "--easing", "ease-out"]).status, 0);
    // Sanity: the eased pair carries the reviewer-observed handle first.
    let list = keyframeList(fix.path, "UNIFORM_SCALE");
    assert.deepEqual(list[0].right_control, { x: 1600000, y: 0.47 });

    // v0.12-style plain insert between the pair.
    assert.equal(spawnCli(["keyframe", fix.path, SEG, "uniform_scale", "1s", "1.1"]).status, 0);
    list = keyframeList(fix.path, "UNIFORM_SCALE");
    assert.equal(list.length, 3);
    // No handle may point at a keyframe that is no longer the segment
    // neighbour: both split sub-segments render linear.
    assert.deepEqual(
      list.map((k) => ({ t: k.time_offset, curve: k.curveType, left: k.left_control, right: k.right_control })),
      [
        { t: 0, curve: "Line", left: { x: 0, y: 0 }, right: { x: 0, y: 0 } },
        { t: 1000000, curve: "Line", left: { x: 0, y: 0 }, right: { x: 0, y: 0 } },
        { t: 5000000, curve: "Line", left: { x: 0, y: 0 }, right: { x: 0, y: 0 } },
      ],
    );
  });

  it("keeps easing on segments the insert does not split", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    // Oracle triplet at 0 / 5s / 8.133333s ease-out, then a linear insert at
    // 6s: only the 5s→8.13s segment is split; the 0→5s easing must survive.
    for (const { time, value } of [
      { time: 0, value: "1.0" },
      { time: 5000000, value: "1.3" },
      { time: 8133333, value: "1.0" },
    ]) {
      const line = JSON.stringify({ property: "scale_x", time, value, easing: "ease-out" });
      assert.equal(spawnCli(["keyframe", fix.path, SEG, "--batch"], { input: line }).status, 0);
    }
    assert.equal(spawnCli(["keyframe", fix.path, SEG, "scale_x", "6s", "1.1"]).status, 0);
    const list = keyframeList(fix.path, "KFTypeScaleX");
    assert.equal(list.length, 4);
    // 0→5s eased segment untouched.
    assert.equal(list[0].curveType, "FreeCurveInOut");
    assert.deepEqual(list[0].right_control, { x: 1600000, y: 0.282 });
    assert.deepEqual(list[1].left_control, { x: -2000000, y: 0 });
    // 5s keyframe keeps its incoming handle but loses the stale outgoing one.
    assert.equal(list[1].curveType, "FreeCurveInOut");
    assert.deepEqual(list[1].right_control, { x: 0, y: 0 });
    // Inserted keyframe and the old segment end are fully linear now.
    assert.equal(list[2].curveType, "Line");
    assert.equal(list[3].curveType, "Line");
    assert.deepEqual(list[3].left_control, { x: 0, y: 0 });
  });
});

// v0.13.0 review: a lone --easing keyframe used to stamp curveType
// FreeCurveInOut with zero-length handles — a curve marker its handles
// contradict, and no signal that the requested easing encoded nothing.
describe("keyframe --easing: lone keyframe has no neighbour to ease against", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("stays Line, exits 0, and warns on stderr", () => {
    const r = spawnCli(["keyframe", fix.path, SEG, "alpha", "2s", "0.5", "--easing", "ease-out"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /no adjacent keyframe to ease against/);
    assert.equal(r.json.warnings.length, 1);
    const list = keyframeList(fix.path, "KFTypeAlpha");
    assert.equal(list.length, 1);
    assert.equal(list[0].curveType, "Line");
    assert.deepEqual(list[0].left_control, { x: 0, y: 0 });
    assert.deepEqual(list[0].right_control, { x: 0, y: 0 });
  });

  it("picks up the curve when the pair keyframe arrives with an easing", () => {
    const r = spawnCli(["keyframe", fix.path, SEG, "alpha", "5s", "1.0", "--easing", "ease-out"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.warnings, undefined);
    const list = keyframeList(fix.path, "KFTypeAlpha");
    assert.equal(list.length, 2);
    // 0.32 × 3s interval; y = round(0.94 × (1.0 − 0.5), 6).
    assert.equal(list[0].curveType, "FreeCurveInOut");
    assert.deepEqual(list[0].right_control, { x: 960000, y: 0.47 });
    assert.equal(list[1].curveType, "FreeCurveInOut");
    assert.deepEqual(list[1].left_control, { x: -1200000, y: 0 });
  });
});

describe("ken-burns.sh easing default", () => {
  function runKenBurns(fix, extra = []) {
    return spawnSync("bash", [KEN_BURNS, fix.path, SEG, "1.0", "1.2", "0", "-0.1", "0", "-0.05", "3s", ...extra], {
      encoding: "utf-8",
      // The recipe invokes the CLI itself, bypassing spawn-cli: isolate the
      // app-version tripwire state the same way so the fixture's version
      // marker never lands in the developer's real config.
      env: { ...process.env, CAPCUT_CLI_APP_VERSIONS: join(fix.dir, "app-versions.json") },
    });
  }

  it("defaults to ease-out — the easing CapCut's UI applies to a ken-burns zoom", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const r = runKenBurns(fix);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const list = keyframeList(fix.path, "UNIFORM_SCALE");
    assert.equal(list.length, 2);
    assert.equal(list[0].curveType, "FreeCurveInOut");
    // 0.32 × 3s and round(0.94 × (1.2 − 1.0), 6)
    assert.deepEqual(list[0].right_control, { x: 960000, y: 0.188 });
    assert.deepEqual(list[1].left_control, { x: -1200000, y: 0 });
    // position keyframes get the same treatment, Δ-scaled per property
    const px = keyframeList(fix.path, "KFTypePositionX");
    assert.deepEqual(px[0].right_control, { x: 960000, y: -0.094 });
  });

  it("explicit linear argument keeps the legacy Line encoding", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const r = runKenBurns(fix, ["linear"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const list = keyframeList(fix.path, "UNIFORM_SCALE");
    assert.equal(list.length, 2);
    assert.equal(list[0].curveType, "Line");
    assert.deepEqual(list[0].right_control, { x: 0, y: 0 });
    assert.deepEqual(list[1].left_control, { x: 0, y: 0 });
  });
});
