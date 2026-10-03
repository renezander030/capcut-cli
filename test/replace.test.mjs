import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function videoSegmentId(path) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  return draft.tracks.find((t) => t.type === "video").segments[0].id;
}

function materialPath(path, materialId) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  for (const arr of Object.values(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    const m = arr.find((x) => x && x.id === materialId);
    if (m) return m.path;
  }
  return null;
}

describe("capcut replace-media", () => {
  it("swaps a segment's source into the draft's assets, preserving its material id", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const segId = videoSegmentId(fix.path);
    const newFile = join(fix.dir, "final.mp4");
    writeFileSync(newFile, "final-render-bytes");

    const r = spawnCli(["replace-media", fix.path, segId, newFile]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.segment_id, segId);
    assert.match(r.json.new_path, /assets[/\\]video[/\\]final\.mp4$/);

    // The material the segment points at now references the copied file.
    assert.equal(materialPath(fix.path, r.json.material_id), r.json.new_path);
    assert.ok(existsSync(join(fix.dir, "assets", "video", "final.mp4")), "new file copied into assets");
  });

  it("honors --dry-run: no write, no asset copy, dryRun marker", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const segId = videoSegmentId(fix.path);
    const before = readFileSync(fix.path, "utf-8");
    const newFile = join(fix.dir, "final.mp4");
    writeFileSync(newFile, "x");

    const r = spawnCli(["replace-media", fix.path, segId, newFile, "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dryRun, true);
    assert.equal(readFileSync(fix.path, "utf-8"), before, "draft must be byte-identical under --dry-run");
    assert.equal(existsSync(join(fix.dir, "assets", "video", "final.mp4")), false, "must not copy media in dry-run");
    assert.equal(existsSync(join(fix.dir, "assets")), false, "must not create directories in dry-run");
    assert.equal(existsSync(`${fix.path}.bak`), false, "must not create a draft backup in dry-run");
    assert.equal(existsSync(join(fix.dir, "draft_meta_info.json.bak")), false, "must not back up the sidecar");
  });

  it("copies different bytes sharing a basename without changing segment identity or timing", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const before = JSON.parse(readFileSync(fix.path, "utf-8"));
    const segment = before.tracks.find((t) => t.type === "video").segments[0];
    const sharedSegment = {
      ...structuredClone(segment),
      id: "shared-replacement-segment",
      target_timerange: {
        ...segment.target_timerange,
        start: segment.target_timerange.start + segment.target_timerange.duration,
      },
    };
    before.tracks.find((t) => t.type === "video").segments.push(sharedSegment);
    writeFileSync(fix.path, JSON.stringify(before));
    const assets = join(fix.dir, "assets", "video");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "clip.mp4"), "OLD-BYTES");
    const replacement = join(fix.dir, "clip.mp4");
    writeFileSync(replacement, "NEW-BYTES");

    const preview = spawnCli(["replace-media", fix.path, segment.id, replacement, "--dry-run"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(existsSync(preview.json.new_path), false, "preview must not copy its chosen destination");
    const result = spawnCli(["replace-media", fix.path, segment.id, replacement]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.new_path, preview.json.new_path, "preview and commit choose the same destination");
    assert.equal(result.json.shared_with_segments, 1, "replacement reports other uses of the shared material");
    assert.notEqual(result.json.new_path, join(assets, "clip.mp4"));
    assert.equal(readFileSync(result.json.new_path, "utf-8"), "NEW-BYTES");
    assert.equal(readFileSync(join(assets, "clip.mp4"), "utf-8"), "OLD-BYTES");
    const afterDraft = JSON.parse(readFileSync(fix.path, "utf-8"));
    const afterSegment = afterDraft.tracks.flatMap((t) => t.segments).find((s) => s.id === segment.id);
    assert.deepEqual(afterSegment, segment, "replacement preserves timing, effects and IDs");
    assert.deepEqual(
      afterDraft.tracks.flatMap((t) => t.segments).find((s) => s.id === sharedSegment.id),
      sharedSegment,
      "other segments keep their timing and continue sharing the same material",
    );
    assert.equal(materialPath(fix.path, segment.material_id), result.json.new_path);
  });

  it("checks occupied hash filenames instead of trusting their suffix", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const assets = join(fix.dir, "assets", "video");
    mkdirSync(assets, { recursive: true });
    const replacement = join(fix.dir, "clip.mp4");
    writeFileSync(replacement, "ACTUAL-REPLACEMENT");
    const hash = createHash("sha1").update("ACTUAL-REPLACEMENT").digest("hex");
    writeFileSync(join(assets, "clip.mp4"), "ORIGINAL");
    const occupied = join(assets, `clip.${hash.slice(0, 8)}.mp4`);
    writeFileSync(occupied, "UNRELATED-FILE");
    const result = spawnCli(["replace-media", fix.path, videoSegmentId(fix.path), replacement]);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.json.new_path, occupied);
    assert.equal(readFileSync(result.json.new_path, "utf-8"), "ACTUAL-REPLACEMENT");
    assert.equal(readFileSync(occupied, "utf-8"), "UNRELATED-FILE");
  });

  it("rejects directories and non-media segments before creating assets", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const before = readFileSync(fix.path, "utf-8");
    const directoryResult = spawnCli(["replace-media", fix.path, videoSegmentId(fix.path), fix.dir]);
    assert.notEqual(directoryResult.status, 0);
    assert.match(directoryResult.stderr, /regular file/);
    assert.equal(readFileSync(fix.path, "utf-8"), before);
    assert.equal(existsSync(join(fix.dir, "assets")), false);

    const replacement = join(fix.dir, "clip.mp4");
    writeFileSync(replacement, "BYTES");
    const textSegment = JSON.parse(before).tracks.find((t) => t.type === "text").segments[0];
    const textResult = spawnCli(["replace-media", fix.path, textSegment.id, replacement]);
    assert.notEqual(textResult.status, 0);
    assert.match(textResult.stderr, /requires a video or audio material/);
    assert.equal(readFileSync(fix.path, "utf-8"), before);
    assert.equal(existsSync(join(fix.dir, "assets")), false);
  });

  it("fails clearly on an unknown segment id", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const newFile = join(fix.dir, "final.mp4");
    writeFileSync(newFile, "x");

    const r = spawnCli(["replace-media", fix.path, "does-not-exist", newFile]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Segment not found/);
  });

  it("requires the new-file argument", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const segId = videoSegmentId(fix.path);
    const r = spawnCli(["replace-media", fix.path, segId]);
    assert.notEqual(r.status, 0);
  });
});
