import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// `--easing hold`: CapCut always interpolates, so a step is emulated with a
// helper keyframe one frame before the NEXT keyframe on the same property.

const SEG = "aaaaaa01-0000-0000-0000-000000000001";

function list(path, propertyType, segId = SEG) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  for (const track of draft.tracks) {
    const seg = track.segments.find((s) => s.id === segId);
    if (seg) return (seg.common_keyframes ?? []).find((l) => l.property_type === propertyType)?.keyframe_list ?? [];
  }
  return [];
}

function frameUs(path) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  return Math.round(1_000_000 / (draft.fps || 30));
}

describe("keyframe --easing hold", () => {
  it("holds the value with a helper keyframe one frame before the next keyframe", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const first = spawnCli(["keyframe", fix.path, SEG, "alpha", "0s", "1", "--easing", "hold"]);
    assert.equal(first.status, 0, `stderr: ${first.stderr}`);
    assert.equal(first.json.hold_keyframes, undefined, "nothing to hold until yet");
    assert.match(first.stderr, /no later keyframe to hold until/);

    const second = spawnCli(["keyframe", fix.path, SEG, "alpha", "2s", "0"]);
    assert.equal(second.status, 0, `stderr: ${second.stderr}`);
    // The hold was requested on the FIRST keyframe; adding the second one
    // linearly does not retroactively step it — re-issue the hold now.
    const held = spawnCli(["keyframe", fix.path, SEG, "alpha", "0s", "1", "--easing", "hold"]);
    assert.equal(held.status, 0, `stderr: ${held.stderr}`);
    assert.equal(held.json.hold_keyframes, 1);

    const entries = list(fix.path, "KFTypeAlpha");
    assert.deepEqual(
      entries.map((k) => k.time_offset),
      [0, 0, 2_000_000 - frameUs(fix.path), 2_000_000],
    );
    const helper = entries[2];
    assert.deepEqual(helper.values, [1], "the helper carries the held value");
    assert.equal(helper.curveType, "Line");
    assert.deepEqual(helper.left_control, { x: 0, y: 0 });
  });

  it("--batch: a hold named before its pair keyframe in the same call still steps", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const input = [
      '{"property":"scale","time":"0s","value":"1","easing":"hold"}',
      '{"property":"scale","time":"1s","value":"2"}',
      '{"property":"scale","time":"3s","value":"1","easing":"hold"}',
      '{"property":"scale","time":"4s","value":"3"}',
    ].join("\n");
    const r = spawnCli(["keyframe", fix.path, SEG, "--batch"], { input });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.added, 4);
    assert.equal(r.json.hold_keyframes, 2);
    const f = frameUs(fix.path);
    const times = list(fix.path, "UNIFORM_SCALE").map((k) => k.time_offset);
    assert.deepEqual(times, [0, 1_000_000 - f, 1_000_000, 3_000_000, 4_000_000 - f, 4_000_000]);
    const values = list(fix.path, "UNIFORM_SCALE").map((k) => k.values[0]);
    assert.deepEqual(values, [1, 1, 2, 1, 1, 3]);
    assert.ok(r.json.lists.some((l) => l.property === "uniform_scale" && l.count === 6));
  });

  it("does not invent a keyframe when the next one is within a frame, and never duplicates a helper", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const f = frameUs(fix.path);
    const input = [
      '{"property":"alpha","time":"0s","value":"1","easing":"hold"}',
      `{"property":"alpha","time":${f},"value":"0"}`,
    ].join("\n");
    const tight = spawnCli(["keyframe", fix.path, SEG, "--batch"], { input });
    assert.equal(tight.status, 0, `stderr: ${tight.stderr}`);
    assert.equal(tight.json.hold_keyframes, undefined);
    assert.match(tight.stderr, /within one frame, nothing to hold/);

    const again = spawnCli(["keyframe", fix.path, SEG, "alpha", "5s", "0.5", "--easing", "hold"]);
    assert.equal(again.status, 0);
    const more = spawnCli(["keyframe", fix.path, SEG, "alpha", "8s", "0", "--easing", "linear"]);
    assert.equal(more.status, 0);
    const first = spawnCli(["keyframe", fix.path, SEG, "alpha", "5s", "0.5", "--easing", "hold"]);
    assert.equal(first.json.hold_keyframes, 1);
    const second = spawnCli(["keyframe", fix.path, SEG, "alpha", "5s", "0.5", "--easing", "hold"]);
    assert.equal(second.json.hold_keyframes, undefined, "the helper already exists — not written twice");
    assert.equal(list(fix.path, "KFTypeAlpha").filter((k) => k.time_offset === 8_000_000 - f).length, 1);
  });

  it("describe lists hold among the easings", () => {
    const r = spawnCli(["describe"]);
    const spec = r.json.commands.find((c) => c.name === "keyframe");
    const easing = spec.options.find((o) => o.flags.includes("--easing"));
    assert.ok(easing.values.includes("hold"));
  });
});
