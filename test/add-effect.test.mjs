import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// Video segment present in the canonical fixture (test/draft_content.json).
const FIXTURE_VIDEO_SEGMENT = "aaaaaa01-0000-0000-0000-000000000001";

describe("capcut add-effect", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("creates an effect track + video_effects material on the slug path", () => {
    const r = spawnCli(["add-effect", fix.path, "shake", "0s", "2s"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.name, "Shake");

    const draft = loadDraft(fix.path);
    const track = draft.tracks.find((t) => t.id === r.json.trackId);
    assert.ok(track, "effect track exists");
    assert.equal(track.type, "effect");
    const mat = draft.materials.video_effects.find((m) => m.id === r.json.materialId);
    assert.ok(mat, "effect material exists");
    assert.equal(mat.type, "video_effect");
    assert.equal(mat.apply_target_type, 2, "track/global scope by default");
    assert.equal(mat.value, 1);
    assert.equal(mat.source_platform, 0);
    assert.equal(mat.bind_segment_id, undefined, "no bind field when unbound");
  });

  it("rejects unknown slugs without --resource-id", () => {
    const r = spawnCli(["add-effect", fix.path, "definitely-not-an-effect", "0s", "2s"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Unknown effect slug/);
  });
});

describe("capcut add-effect --resource-id (raw store escape hatch)", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("applies a raw catalogue id, positional becomes the display name", () => {
    const r = spawnCli(["add-effect", fix.path, "VHS Deluxe", "0s", "2s", "--resource-id", "7529669127365202194"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.name, "VHS Deluxe");
    const mat = loadDraft(fix.path).materials.video_effects.find((m) => m.id === r.json.materialId);
    assert.ok(mat, "raw-id effect material exists");
    assert.equal(mat.resource_id, "7529669127365202194");
    assert.equal(mat.effect_id, "7529669127365202194", "effect_id defaults to --resource-id");
    assert.equal(mat.name, "VHS Deluxe");
    assert.equal(mat.source_platform, 1, "store-downloaded marker");
    assert.equal(mat.type, "video_effect", "raw ids are scene effects");
  });

  it("honours a distinct --effect-id alongside --resource-id", () => {
    const r = spawnCli([
      "add-effect",
      fix.path,
      "Split Ids",
      "0s",
      "2s",
      "--resource-id",
      "1111111111",
      "--effect-id",
      "2222222222",
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const mat = loadDraft(fix.path).materials.video_effects.find((m) => m.id === r.json.materialId);
    assert.equal(mat.resource_id, "1111111111");
    assert.equal(mat.effect_id, "2222222222");
  });

  it("rejects --effect-id without --resource-id", () => {
    const r = spawnCli(["add-effect", fix.path, "shake", "0s", "2s", "--effect-id", "2222222222"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--effect-id requires --resource-id/);
  });
});

describe("capcut add-effect --intensity", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("writes the intensity as the material value", () => {
    const r = spawnCli(["add-effect", fix.path, "shake", "0s", "2s", "--intensity", "0.7"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const mat = loadDraft(fix.path).materials.video_effects.find((m) => m.id === r.json.materialId);
    assert.equal(mat.value, 0.7);
  });

  it("rejects out-of-range intensity", () => {
    const r = spawnCli(["add-effect", fix.path, "shake", "0s", "2s", "--intensity", "-0.1"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--intensity must be a number in range/);
  });
});

describe("capcut add-effect --bind (experimental per-segment attachment)", () => {
  const fixBind = tmpDraft();
  const fixShort = tmpDraft();
  const fixMissing = tmpDraft();
  after(() => {
    fixBind.cleanup();
    fixShort.cleanup();
    fixMissing.cleanup();
  });

  it("binds the effect to a segment: apply_target_type 0 + bind_segment_id", () => {
    const r = spawnCli(["add-effect", fixBind.path, "shake", "0s", "2s", "--bind", FIXTURE_VIDEO_SEGMENT]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const mat = loadDraft(fixBind.path).materials.video_effects.find((m) => m.id === r.json.materialId);
    assert.equal(mat.apply_target_type, 0, "segment-scoped");
    assert.equal(mat.bind_segment_id, FIXTURE_VIDEO_SEGMENT);
  });

  it("resolves a short segment-id prefix to the full id", () => {
    const r = spawnCli(["add-effect", fixShort.path, "shake", "0s", "2s", "--bind", "aaaaaa01"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const mat = loadDraft(fixShort.path).materials.video_effects.find((m) => m.id === r.json.materialId);
    assert.equal(mat.bind_segment_id, FIXTURE_VIDEO_SEGMENT);
  });

  it("dies on an unknown segment id and leaves the draft untouched", () => {
    const before = readFileSync(fixMissing.path, "utf-8");
    const r = spawnCli(["add-effect", fixMissing.path, "shake", "0s", "2s", "--bind", "nonexistent-id"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Segment not found/);
    assert.equal(readFileSync(fixMissing.path, "utf-8"), before, "draft file unchanged");
  });
});

describe("capcut add-effect --full", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("spans the whole timeline without start/duration positionals", () => {
    const r = spawnCli(["add-effect", fix.path, "vhs", "--full"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.start_us, 0);
    assert.equal(r.json.duration_us, 10000000);
    const draft = loadDraft(fix.path);
    const track = draft.tracks.find((t) => t.id === r.json.trackId);
    const seg = track.segments.find((s) => s.id === r.json.segmentId);
    assert.deepEqual(seg.target_timerange, { start: 0, duration: 10000000 });
  });
});
