import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// IR-style keyframe property names (the translation table every downstream
// integrator re-implements: vertir's PROP_MAP, qcut's spec.py) are accepted
// and stored under the canonical on-disk property_type.

const SEG = "aaaaaa01-0000-0000-0000-000000000001";

function keyframeLists(path, segId = SEG) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  for (const track of draft.tracks) {
    const seg = track.segments.find((s) => s.id === segId);
    if (seg) return seg.common_keyframes ?? [];
  }
  return [];
}

describe("keyframe property aliases", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("scale → UNIFORM_SCALE, reported under the canonical name", () => {
    const r = spawnCli(["keyframe", fix.path, SEG, "scale", "0s", "1.5"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const list = keyframeLists(fix.path).find((l) => l.property_type === "UNIFORM_SCALE");
    assert.ok(list, "alias must land on the uniform_scale list");
    assert.deepEqual(list.keyframe_list[0].values, [1.5]);
    assert.ok(r.json.lists.some((l) => l.property === "uniform_scale"));
    assert.ok(!r.json.lists.some((l) => l.property === "scale"), "output uses canonical names only");
  });

  it("x / y → KFTypePositionX / KFTypePositionY with the position range check", () => {
    const x = spawnCli(["keyframe", fix.path, SEG, "x", "0s", "0.25"]);
    assert.equal(x.status, 0, `stderr: ${x.stderr}`);
    const y = spawnCli(["keyframe", fix.path, SEG, "y", "0s", "-0.5"]);
    assert.equal(y.status, 0, `stderr: ${y.stderr}`);
    const lists = keyframeLists(fix.path);
    assert.deepEqual(lists.find((l) => l.property_type === "KFTypePositionX").keyframe_list[0].values, [0.25]);
    assert.deepEqual(lists.find((l) => l.property_type === "KFTypePositionY").keyframe_list[0].values, [-0.5]);

    const outOfRange = spawnCli(["keyframe", fix.path, SEG, "x", "1s", "42"]);
    assert.notEqual(outOfRange.status, 0);
    assert.match(outOfRange.stderr, /position_x must be a finite number in \[-10, 10\]/);
  });

  it("opacity → KFTypeAlpha, percentages included", () => {
    const r = spawnCli(["keyframe", fix.path, SEG, "opacity", "0s", "50%"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const list = keyframeLists(fix.path).find((l) => l.property_type === "KFTypeAlpha");
    assert.deepEqual(list.keyframe_list[0].values, [0.5]);
  });

  it("aliases work per line in --batch and merge into the canonical list", () => {
    const input = [
      '{"property":"scale","time":"1s","value":"2"}',
      '{"property":"uniform_scale","time":"2s","value":"1"}',
    ].join("\n");
    const r = spawnCli(["keyframe", fix.path, SEG, "--batch"], { input });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const list = keyframeLists(fix.path).find((l) => l.property_type === "UNIFORM_SCALE");
    assert.equal(list.keyframe_list.length, 3, "alias and canonical name share one list");
    assert.equal(keyframeLists(fix.path).filter((l) => l.property_type === "UNIFORM_SCALE").length, 1);
  });

  it("an unknown name still fails, and the error lists the aliases", () => {
    const r = spawnCli(["keyframe", fix.path, SEG, "zoom", "0s", "1"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Unsupported keyframe property: zoom/);
    assert.match(r.stderr, /aliases: scale=uniform_scale, x=position_x, y=position_y, opacity=alpha/);
  });
});
