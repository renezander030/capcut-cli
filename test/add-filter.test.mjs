import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut add-filter", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("creates a filter track + video_effects material with type=filter", () => {
    const r = spawnCli(["add-filter", fix.path, "vintage", "0s", "5s"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.name, "Vintage");

    const draft = loadDraft(fix.path);
    const track = draft.tracks.find((t) => t.id === r.json.trackId);
    assert.ok(track, "filter track exists");
    assert.equal(track.type, "filter");
    const mat = draft.materials.video_effects.find((m) => m.id === r.json.materialId);
    assert.ok(mat, "filter material exists");
    assert.equal(mat.type, "filter");
    assert.equal(mat.effect_id, "7028463716732079117");
  });

  it("rejects unknown slugs with a helpful hint", () => {
    const r = spawnCli(["add-filter", fix.path, "definitely-not-a-filter", "0s", "5s"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Unknown filter slug|enums --filters/i);
  });

  it("slug path stays byte-compatible: value 1, source_platform 0", () => {
    const r = spawnCli(["add-filter", fix.path, "warm", "0s", "2s"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const mat = loadDraft(fix.path).materials.video_effects.find((m) => m.id === r.json.materialId);
    assert.equal(mat.value, 1);
    assert.equal(mat.source_platform, 0);
    assert.equal(mat.apply_target_type, 2);
  });
});

describe("capcut add-filter --resource-id (raw store escape hatch)", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("applies a raw catalogue id, positional becomes the display name", () => {
    const r = spawnCli(["add-filter", fix.path, "My Store Look", "0s", "3s", "--resource-id", "7529669127365202194"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.name, "My Store Look");
    const mat = loadDraft(fix.path).materials.video_effects.find((m) => m.id === r.json.materialId);
    assert.ok(mat, "raw-id filter material exists");
    assert.equal(mat.resource_id, "7529669127365202194");
    assert.equal(mat.effect_id, "7529669127365202194", "effect_id defaults to --resource-id");
    assert.equal(mat.name, "My Store Look");
    assert.equal(mat.source_platform, 1, "store-downloaded marker");
    assert.equal(mat.type, "filter");
  });

  it("honours a distinct --effect-id alongside --resource-id", () => {
    const r = spawnCli([
      "add-filter",
      fix.path,
      "Split Ids",
      "0s",
      "3s",
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
    const r = spawnCli(["add-filter", fix.path, "vintage", "0s", "3s", "--effect-id", "2222222222"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--effect-id requires --resource-id/);
  });
});

describe("capcut add-filter --intensity", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("writes the intensity as the material value on the slug path", () => {
    const r = spawnCli(["add-filter", fix.path, "vintage", "0s", "3s", "--intensity", "0.4"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const mat = loadDraft(fix.path).materials.video_effects.find((m) => m.id === r.json.materialId);
    assert.equal(mat.value, 0.4);
  });

  it("rejects out-of-range intensity", () => {
    const r = spawnCli(["add-filter", fix.path, "vintage", "0s", "3s", "--intensity", "1.5"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--intensity must be a number in range/);
  });

  it("rejects non-numeric intensity", () => {
    const r = spawnCli(["add-filter", fix.path, "vintage", "0s", "3s", "--intensity", "abc"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--intensity must be a number in range/);
  });
});

describe("capcut add-filter --full", () => {
  const fix = tmpDraft();
  const fixExplicit = tmpDraft();
  const fixZero = tmpDraft();
  after(() => {
    fix.cleanup();
    fixExplicit.cleanup();
    fixZero.cleanup();
  });

  it("spans the whole timeline without start/duration positionals", () => {
    const r = spawnCli(["add-filter", fix.path, "vintage", "--full"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.start_us, 0);
    assert.equal(r.json.duration_us, 10000000);
    const draft = loadDraft(fix.path);
    const track = draft.tracks.find((t) => t.id === r.json.trackId);
    const seg = track.segments.find((s) => s.id === r.json.segmentId);
    assert.deepEqual(seg.target_timerange, { start: 0, duration: 10000000 });
  });

  it("wins over explicit start/duration when both are given", () => {
    const r = spawnCli(["add-filter", fixExplicit.path, "vintage", "1s", "2s", "--full"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const draft = loadDraft(fixExplicit.path);
    const track = draft.tracks.find((t) => t.id === r.json.trackId);
    const seg = track.segments.find((s) => s.id === r.json.segmentId);
    assert.deepEqual(seg.target_timerange, { start: 0, duration: 10000000 });
  });

  it("dies on a draft without a usable duration", () => {
    const draft = JSON.parse(readFileSync(fixZero.path, "utf-8"));
    draft.duration = 0;
    writeFileSync(fixZero.path, JSON.stringify(draft));
    const r = spawnCli(["add-filter", fixZero.path, "vintage", "--full"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--full: draft has no duration/);
  });
});

describe("capcut enums --filters", () => {
  it("returns the capcut starter catalogue", () => {
    const r = spawnCli(["enums", "--filters"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(Array.isArray(r.json));
    const slugs = r.json.map((e) => e.slug);
    for (const expected of [
      "vintage",
      "warm",
      "cool",
      "bw",
      "sepia",
      "vivid",
      "contrast",
      "faded",
      "dramatic",
      "soft",
    ]) {
      assert.ok(slugs.includes(expected), `missing ${expected}`);
    }
  });

  it("returns the JianYing catalogue with --jianying", () => {
    const r = spawnCli(["enums", "--filters", "--jianying"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(Array.isArray(r.json));
    assert.ok(r.json.length > 100, "JY filters > 100 entries");
  });
});
