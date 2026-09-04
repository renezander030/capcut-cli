import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// Smart matting lives on the VIDEO MATERIAL (materials.videos[].matting), not
// the segment. Shape: docs/draft-schema/02-materials.md (flag 0, the app's off
// state) + pyJianYingDraft PRs #183/#184 (flag 3 = smart portrait matting).

function firstSegment(path, trackType) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  const track = draft.tracks.find((t) => t.type === trackType);
  assert.ok(track, `fixture must contain a ${trackType} track`);
  return { draft, seg: track.segments[0] };
}

function materialOf(path, segId) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  const seg = draft.tracks.flatMap((t) => t.segments).find((s) => s.id === segId);
  return draft.materials.videos.find((m) => m.id === seg.material_id);
}

describe("capcut matting", () => {
  describe("on a video segment", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("writes flag 3 with the documented off-shape fields on the segment's material", () => {
      const { seg } = firstSegment(fix.path, "video");
      const r = spawnCli(["matting", fix.path, seg.id]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.enabled, true);
      assert.equal(r.json.flag, 3);
      assert.equal(r.json.segmentId, seg.id);
      assert.equal(r.json.materialId, seg.material_id);
      assert.deepEqual(r.json.shared_segments, []);

      const mat = materialOf(fix.path, seg.id);
      assert.deepEqual(mat.matting, {
        flag: 3,
        has_use_quick_brush: false,
        has_use_quick_eraser: false,
        interactiveTime: [],
        path: "",
        strokes: [],
      });
    });

    it("is idempotent: a second run leaves the same object", () => {
      const { seg } = firstSegment(fix.path, "video");
      const before = JSON.stringify(materialOf(fix.path, seg.id).matting);
      const r = spawnCli(["matting", fix.path, seg.id]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(JSON.stringify(materialOf(fix.path, seg.id).matting), before);
    });

    it("--off writes flag 0 and keeps the other fields (never deletes the key)", () => {
      const { seg } = firstSegment(fix.path, "video");
      const r = spawnCli(["matting", fix.path, seg.id, "--off"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.enabled, false);
      assert.equal(r.json.flag, 0);
      const mat = materialOf(fix.path, seg.id);
      assert.equal(mat.matting.flag, 0);
      assert.deepEqual(mat.matting.strokes, []);
      assert.equal(mat.matting.path, "");
    });
  });

  it("preserves app-authored cache fields when toggling on", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const { draft, seg } = firstSegment(fix.path, "video");
    const mat = draft.materials.videos.find((m) => m.id === seg.material_id);
    mat.matting = {
      flag: 0,
      has_use_quick_brush: true,
      interactiveTime: [1],
      path: "matting/cache.bin",
      strokes: [{ x: 1 }],
    };
    writeFileSync(fix.path, JSON.stringify(draft));

    const r = spawnCli(["matting", fix.path, seg.id]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const after_ = materialOf(fix.path, seg.id).matting;
    assert.equal(after_.flag, 3);
    assert.equal(after_.has_use_quick_brush, true, "app-authored brush flag must survive");
    assert.equal(after_.path, "matting/cache.bin", "the app's cache path must survive");
    assert.deepEqual(after_.strokes, [{ x: 1 }]);
    assert.deepEqual(after_.interactiveTime, [1]);
    assert.equal(after_.has_use_quick_eraser, false, "missing fields are filled from the documented defaults");
  });

  it("reports the other segments sharing the material (matting is per material)", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const { draft, seg } = firstSegment(fix.path, "video");
    const track = draft.tracks.find((t) => t.type === "video");
    track.segments.push({
      ...structuredClone(seg),
      id: "shared-copy-0000-0000-0000-000000000001",
      target_timerange: { start: seg.target_timerange.start + seg.target_timerange.duration, duration: 1000 },
    });
    writeFileSync(fix.path, JSON.stringify(draft));

    const r = spawnCli(["matting", fix.path, seg.id]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.shared_segments, ["shared-copy-0000-0000-0000-000000000001"]);
    assert.match(r.stderr, /shared by 1 other segment/);
  });

  it("refuses a non-video segment", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const { seg } = firstSegment(fix.path, "text");
    const r = spawnCli(["matting", fix.path, seg.id]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /only applies to video\/photo segments/);
  });

  it("fails clearly on an unknown segment id and without an id", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const unknown = spawnCli(["matting", fix.path, "no-such-segment"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Segment not found/);
    const missing = spawnCli(["matting", fix.path]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Usage: capcut matting/);
  });

  it("is listed by describe as a mutating command with --off", () => {
    const r = spawnCli(["describe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const spec = r.json.commands.find((c) => c.name === "matting");
    assert.ok(spec, "describe must list matting");
    assert.equal(spec.mutates, true);
    assert.ok(spec.options.some((o) => o.flags.includes("--off")));
  });
});
