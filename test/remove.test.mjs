import assert from "node:assert/strict";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// Fixture layout (test/draft_content.json), by unambiguous id prefix:
//   video "Track 1":  aaaaaa01 (mat-video-01 + extra ref mat-speed-01, 0-5s)
//                     aaaaaa02 (mat-video-02, 5-10s)
//   audio "Audio 1":  bbbbbb01 (mat-audio-01, 0-10s; only segment on its track)
//   text "Subtitles": cccccc01 (ends 3.2s), cccccc02 (ends 7.7s), cccccc03 (ends 9.7s)
// duration: 10000000us
const VID1 = "aaaaaa01";
const VID2 = "aaaaaa02";
const AUD1 = "bbbbbb01";
const TXT1 = "cccccc01";
const TXT2 = "cccccc02";
const TXT3 = "cccccc03";

describe("remove — clean segment removal", () => {
  it("removes a segment in place, keeps its non-empty track, sweeps its materials", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const r = spawnCli(["remove", fix.path, VID1]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.ok(r.json.removed_segment_id.startsWith(VID1));
    assert.equal(r.json.track_removed, false);
    assert.equal(r.json.track_name, "Track 1");
    assert.equal(r.json.track_type, "video");

    const d = loadDraft(fix.path);
    const video = d.tracks.find((t) => t.type === "video");
    assert.equal(video.segments.length, 1, "the sibling segment must survive");
    assert.ok(video.segments[0].id.startsWith(VID2));
    assert.ok(!d.materials.videos.some((m) => m.id === "mat-video-01"), "removed segment's material must be swept");
    assert.ok(
      d.materials.videos.some((m) => m.id === "mat-video-02"),
      "sibling's material must be kept",
    );
  });

  it("drops a track the removal empties and reports track_removed:true", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const r = spawnCli(["remove", fix.path, AUD1]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.track_removed, true);
    assert.equal(r.json.materials_by_type.audios.removed, 1);

    const d = loadDraft(fix.path);
    assert.ok(!d.tracks.some((t) => t.id === "track-audio-01"), "emptied track must be gone");
    assert.equal(d.materials.audios.length, 0, "audio material must be swept");
  });

  it("--keep-track keeps the emptied track with segments: []", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const r = spawnCli(["remove", fix.path, AUD1, "--keep-track"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.track_removed, false);

    const d = loadDraft(fix.path);
    const audio = d.tracks.find((t) => t.id === "track-audio-01");
    assert.ok(audio, "track must survive with --keep-track");
    assert.deepEqual(audio.segments, []);
  });

  it("recomputes duration as the max segment end across ALL tracks", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    // Remove the last-ending video: audio still spans 10s, so duration holds.
    let r = spawnCli(["remove", fix.path, VID2]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.duration_before_us, 10000000);
    assert.equal(r.json.duration_after_us, 10000000);
    assert.equal(loadDraft(fix.path).duration, 10000000);

    // Drop the audio: the text track's cccccc03 (ends 9.7s) now rules.
    r = spawnCli(["remove", fix.path, AUD1]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.duration_after_us, 9700000);

    // Drop cccccc03: cccccc02 (ends 7.7s) is the new max.
    r = spawnCli(["remove", fix.path, TXT3]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.duration_after_us, 7700000);
    assert.equal(loadDraft(fix.path).duration, 7700000);
  });

  it("sweeps extra_material_refs companions of the removed segment", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const r = spawnCli(["remove", fix.path, VID1]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.materials_by_type.speeds.removed, 1);
    assert.equal(loadDraft(fix.path).materials.speeds.length, 0, "speed companion must be swept");
  });

  it("SAFETY: a material another segment still references is never deleted", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    // Make both video segments share one material entry.
    const d = loadDraft(fix.path);
    const video = d.tracks.find((t) => t.type === "video");
    video.segments[1].material_id = "mat-video-01";
    writeFileSync(fix.path, JSON.stringify(d, null, 2));

    const r = spawnCli(["remove", fix.path, VID1]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.materials_by_type.videos.kept, 1);

    const after_ = loadDraft(fix.path);
    assert.ok(
      after_.materials.videos.some((m) => m.id === "mat-video-01"),
      "shared material must survive the removal of one of its segments",
    );
  });

  it("--keep-materials skips the sweep; a follow-up prune removes the same orphans", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const r = spawnCli(["remove", fix.path, VID1, "--keep-materials"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.materials_removed, 0);
    assert.deepEqual(r.json.materials_by_type, {});

    const mid = loadDraft(fix.path);
    assert.ok(
      mid.materials.videos.some((m) => m.id === "mat-video-01"),
      "material must survive --keep-materials",
    );
    assert.equal(mid.materials.speeds.length, 1, "companion must survive --keep-materials");

    const p = spawnCli(["prune", fix.path]);
    assert.equal(p.status, 0, `stderr: ${p.stderr}`);
    assert.equal(p.json.removed, 2, "prune must sweep exactly the material + its speed companion");
    const after_ = loadDraft(fix.path);
    assert.ok(!after_.materials.videos.some((m) => m.id === "mat-video-01"));
    assert.equal(after_.materials.speeds.length, 0);
  });

  it("sweeps pre-existing orphans in the same pass (same sweep as prune)", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const d = loadDraft(fix.path);
    d.materials.texts.push({ id: "ORPHAN_PRE" });
    writeFileSync(fix.path, JSON.stringify(d, null, 2));

    // Removing aaaaaa02 orphans only mat-video-02; ORPHAN_PRE rides along.
    const r = spawnCli(["remove", fix.path, VID2]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.materials_removed, 2);

    const after_ = loadDraft(fix.path);
    assert.ok(!after_.materials.texts.some((m) => m.id === "ORPHAN_PRE"), "pre-existing orphan must be swept too");
    assert.ok(!after_.materials.videos.some((m) => m.id === "mat-video-02"));
  });

  it("unknown segment id: exit 1, no write, no .bak", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const before = readFileSync(fix.path, "utf-8");

    const r = spawnCli(["remove", fix.path, "zzz"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Segment not found: zzz/);
    assert.equal(readFileSync(fix.path, "utf-8"), before, "file must be untouched");
    assert.equal(existsSync(`${fix.path}.bak`), false, "no .bak on a failed remove");
  });

  it("missing <segment-id>: exit 1 with usage", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const r = spawnCli(["remove", fix.path]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /capcut remove <project> <segment-id> \[--keep-track\] \[--keep-materials\]/);
  });

  it("--dry-run previews the full result without writing", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const before = readFileSync(fix.path, "utf-8");

    const r = spawnCli(["remove", fix.path, VID1, "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.dryRun, true);
    assert.ok(r.json.removed_segment_id.startsWith(VID1));
    assert.equal(r.json.duration_after_us, 10000000);

    assert.equal(readFileSync(fix.path, "utf-8"), before, "draft must be byte-identical after --dry-run");
    assert.equal(existsSync(`${fix.path}.bak`), false, "no .bak in --dry-run");
    assert.equal(existsSync(join(fix.dir, ".capcut-cli-history")), false, "no history snapshot in --dry-run");
  });

  it("restore undoes a remove byte-for-byte", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const before = readFileSync(fix.path, "utf-8");

    const r = spawnCli(["remove", fix.path, VID1]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.notEqual(readFileSync(fix.path, "utf-8"), before, "remove must have written");

    const u = spawnCli(["restore", fix.path]);
    assert.equal(u.status, 0, `stderr: ${u.stderr}`);
    assert.equal(readFileSync(fix.path, "utf-8"), before, "restore must return the pre-remove bytes");
  });

  it("removing every segment leaves tracks: [], duration 0, empty material arrays", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    for (const id of [VID1, VID2, AUD1, TXT1, TXT2, TXT3]) {
      const r = spawnCli(["remove", fix.path, id]);
      assert.equal(r.status, 0, `removing ${id}: ${r.stderr}`);
    }
    const d = loadDraft(fix.path);
    assert.deepEqual(d.tracks, []);
    assert.equal(d.duration, 0);
    for (const [type, arr] of Object.entries(d.materials)) {
      if (Array.isArray(arr)) assert.equal(arr.length, 0, `materials.${type} should be empty`);
    }
  });

  it("mirrors the removal into readable sibling timeline files (draft_info.json)", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const mirror = join(fix.dir, "draft_info.json");
    copyFileSync(fix.path, mirror);

    const r = spawnCli(["remove", fix.path, VID1]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    for (const [label, path] of [
      ["draft_content.json", fix.path],
      ["draft_info.json", mirror],
    ]) {
      const d = loadDraft(path);
      assert.ok(
        !d.tracks.some((t) => t.segments.some((s) => s.id.startsWith(VID1))),
        `${label} must not contain the removed segment`,
      );
      assert.equal(d.duration, 10000000, `${label} duration must be in sync`);
    }
  });

  it("flag scoping: --keep-track/--keep-materials stay verbatim text on other commands", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const r = spawnCli(["add-text", fix.path, "0s", "2s", "keep", "--keep-track", "--keep-materials", "out"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.text, "keep --keep-track --keep-materials out");
  });
});
