import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

function draft(mediaPath, kind = "videos") {
  const materials = { videos: [], audios: [], texts: [], speeds: [] };
  materials[kind] = [{ id: "M1", type: kind === "audios" ? "audio" : "video", path: mediaPath, duration: 1_000_000 }];
  return {
    id: "guid-relink",
    name: "relink-draft",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "8.7.0", os: "windows" },
    tracks: [
      {
        id: "T1",
        type: kind === "audios" ? "audio" : "video",
        name: kind === "audios" ? "audio" : "video",
        attribute: 0,
        segments: [
          {
            id: "S1",
            material_id: "M1",
            target_timerange: { start: 0, duration: 1_000_000 },
            source_timerange: { start: 0, duration: 1_000_000 },
          },
        ],
      },
    ],
    materials,
  };
}

// A draft pointing at a media path that no longer exists, plus a replacement
// directory holding the real file — the classic moved-machines relink case.
function fixture({ kind = "videos" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-relink-stage-"));
  const mediaDir = mkdtempSync(join(tmpdir(), "capcut-relink-media-"));
  const filename = kind === "audios" ? "sound.mp3" : "clip.mp4";
  writeFileSync(join(mediaDir, filename), "media-bytes");
  const gonePath = join(mediaDir, "gone-subdir", filename); // never exists
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(draft(gonePath, kind), null, 2));
  return {
    dir,
    mediaDir,
    filename,
    path: join(dir, "draft_content.json"),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(mediaDir, { recursive: true, force: true });
    },
  };
}

describe("relink --stage (portable repair)", () => {
  it("copies the relinked file into assets/video/ and points the material at the copy", () => {
    const f = fixture();
    after(f.cleanup);

    const r = spawnCli(["relink", f.path, "--dir", f.mediaDir, "--stage"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.relinked, 1);
    assert.equal(r.json.staged, 1);
    assert.equal(r.json.changes[0].staged, true);

    const saved = JSON.parse(readFileSync(f.path, "utf-8"));
    const staged = saved.materials.videos[0].path;
    assert.ok(staged.startsWith(join(f.dir, "assets", "video")), `expected staged path, got ${staged}`);
    assert.ok(existsSync(staged), "the staged copy must exist");
    assert.equal(readFileSync(staged, "utf-8"), "media-bytes");
  });

  it("stages audio into assets/audio/", () => {
    const f = fixture({ kind: "audios" });
    after(f.cleanup);

    const r = spawnCli(["relink", f.path, "--dir", f.mediaDir, "--stage"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.staged, 1);
    const saved = JSON.parse(readFileSync(f.path, "utf-8"));
    assert.ok(saved.materials.audios[0].path.startsWith(join(f.dir, "assets", "audio")));
  });

  it("without --stage, relink only rewrites the path (previous behaviour intact)", () => {
    const f = fixture();
    after(f.cleanup);

    const r = spawnCli(["relink", f.path, "--dir", f.mediaDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.relinked, 1);
    assert.equal(r.json.staged, 0);
    const saved = JSON.parse(readFileSync(f.path, "utf-8"));
    assert.equal(saved.materials.videos[0].path, join(f.mediaDir, f.filename));
    assert.ok(!existsSync(join(f.dir, "assets")), "nothing may be copied without --stage");
  });

  it("--dry-run --stage neither copies nor writes", () => {
    const f = fixture();
    after(f.cleanup);
    const before = readFileSync(f.path, "utf-8");

    const r = spawnCli(["relink", f.path, "--dir", f.mediaDir, "--stage", "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!existsSync(join(f.dir, "assets")), "dry-run must not copy");
    assert.equal(readFileSync(f.path, "utf-8"), before, "dry-run must not write the draft");
  });
});
