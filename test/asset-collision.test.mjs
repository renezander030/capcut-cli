import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// Collect the `path` of every material referenced in the draft (any track type).
function materialPaths(draftPath) {
  const draft = JSON.parse(readFileSync(draftPath, "utf-8"));
  const paths = [];
  for (const arr of Object.values(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    for (const m of arr) if (m && typeof m.path === "string") paths.push(m.path);
  }
  return paths;
}

describe("asset copy: basename collision (issue #37)", () => {
  it("de-collides two different sources sharing a basename, and warns", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    // Two DIFFERENT files that resolve to the same basename `0_00.png`.
    mkdirSync(join(fix.dir, "jp"), { recursive: true });
    mkdirSync(join(fix.dir, "en"), { recursive: true });
    const jp = join(fix.dir, "jp", "0_00.png");
    const en = join(fix.dir, "en", "0_00.png");
    writeFileSync(jp, "JAPANESE-IMAGE-BYTES");
    writeFileSync(en, "ENGLISH-IMAGE-BYTES-different-length");

    const r1 = spawnCli(["add-video", fix.path, jp, "0", "7s", "--no-probe"]);
    assert.equal(r1.status, 0, `add jp failed: ${r1.stderr}`);
    const r2 = spawnCli(["add-video", fix.path, en, "0", "7s", "--no-probe"]);
    assert.equal(r2.status, 0, `add en failed: ${r2.stderr}`);

    // The collision is surfaced, not silent.
    assert.match(r2.stderr, /already exists from a different source/i);

    // Both sources landed as distinct files in assets/video.
    const videoDir = join(fix.dir, "assets", "video");
    const files = readdirSync(videoDir).filter((f) => f.endsWith(".png"));
    assert.equal(files.length, 2, `expected 2 distinct assets, got: ${files.join(", ")}`);

    // The two newest video materials point at different, existing files whose
    // content matches their original source (no stale reference).
    const paths = [...new Set(materialPaths(fix.path))].filter((p) => p.includes("0_00"));
    assert.equal(paths.length, 2, `expected 2 distinct material paths, got: ${paths.join(", ")}`);
    const contents = paths.map((p) => readFileSync(p, "utf-8")).sort();
    assert.deepEqual(contents, ["ENGLISH-IMAGE-BYTES-different-length", "JAPANESE-IMAGE-BYTES"].sort());
  });

  it("re-adding the SAME file is an idempotent no-op (no dup, no warning)", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const src = join(fix.dir, "clip.png");
    writeFileSync(src, "SAME-BYTES");

    const r1 = spawnCli(["add-video", fix.path, src, "0", "5s", "--no-probe"]);
    assert.equal(r1.status, 0, `first add failed: ${r1.stderr}`);
    const r2 = spawnCli(["add-video", fix.path, src, "0", "5s", "--no-probe"]);
    assert.equal(r2.status, 0, `second add failed: ${r2.stderr}`);

    assert.doesNotMatch(r2.stderr, /already exists from a different source/i);
    const videoDir = join(fix.dir, "assets", "video");
    const clips = readdirSync(videoDir).filter((f) => f.startsWith("clip"));
    assert.equal(clips.length, 1, `expected a single copy, got: ${clips.join(", ")}`);
    assert.ok(existsSync(join(videoDir, "clip.png")));
  });
});
