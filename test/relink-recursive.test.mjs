import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractText } from "../dist/draft.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function setMedia(fix, paths) {
  const draft = JSON.parse(readFileSync(fix.path, "utf8"));
  draft.materials.videos = paths.map((path, index) => ({ id: `video-${index}`, path }));
  draft.materials.audios = [];
  writeFileSync(fix.path, JSON.stringify(draft));
}

describe("recursive relink", () => {
  it("preserves --recursive as free text on unrelated commands", () => {
    const fix = tmpDraft();
    try {
      const result = spawnCli(["add-text", fix.path, "0s", "1s", "--recursive"]);
      assert.equal(result.status, 0, result.stderr);
      const draft = JSON.parse(readFileSync(fix.path, "utf8"));
      assert.ok(draft.materials.texts.some((material) => extractText(material.content) === "--recursive"));
    } finally {
      fix.cleanup();
    }
  });

  it("recovers nested media only when requested and handles Windows basenames", () => {
    const fix = tmpDraft();
    try {
      const media = join(fix.dir, "media");
      mkdirSync(join(media, "nested"), { recursive: true });
      const file = join(media, "nested", "clip.mp4");
      writeFileSync(file, "media bytes");
      setMedia(fix, ["C:\\old\\clip.mp4"]);
      const flat = spawnCli(["relink", fix.path, "--dir", media]);
      assert.equal(flat.json.relinked, 0);
      const recursive = spawnCli(["relink", fix.path, "--dir", media, "--recursive"]);
      assert.equal(recursive.status, 0, recursive.stderr);
      assert.equal(recursive.json.relinked, 1);
      assert.equal(recursive.json.changes[0].to, file);
    } finally {
      fix.cleanup();
    }
  });

  it("leaves ambiguous basenames unchanged and reports all candidate files", () => {
    const fix = tmpDraft();
    try {
      const media = join(fix.dir, "media");
      for (const name of ["one", "two"]) {
        mkdirSync(join(media, name), { recursive: true });
        writeFileSync(join(media, name, "clip.mp4"), name);
      }
      setMedia(fix, ["/missing/clip.mp4"]);
      const before = readFileSync(fix.path, "utf8");
      const result = spawnCli(["relink", fix.path, "--dir", media, "--recursive", "--stage"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.json.relinked, 0);
      assert.equal(result.json.still_missing, 1);
      assert.equal(result.json.ambiguous[0].candidates.length, 2);
      assert.equal(readFileSync(fix.path, "utf8"), before);
      assert.equal(existsSync(join(fix.dir, "assets")), false);
    } finally {
      fix.cleanup();
    }
  });

  it("matches prefixes at a path boundary, including a trailing separator", () => {
    const fix = tmpDraft();
    try {
      setMedia(fix, ["/old/root/a.mp4", "/old/root-extra/b.mp4"]);
      const result = spawnCli(["relink", fix.path, "--from", "/old/root/", "--to", "/new/root"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.json.relinked, 1);
      const materials = JSON.parse(readFileSync(fix.path, "utf8")).materials.videos;
      assert.equal(materials[0].path, "/new/root/a.mp4");
      assert.equal(materials[1].path, "/old/root-extra/b.mp4");
    } finally {
      fix.cleanup();
    }
  });

  it("does not change timeline bytes or stage assets in recursive dry-run", () => {
    const fix = tmpDraft();
    try {
      const media = join(fix.dir, "media", "nested");
      mkdirSync(media, { recursive: true });
      writeFileSync(join(media, "clip.mp4"), "media bytes");
      setMedia(fix, ["/missing/clip.mp4"]);
      const before = readFileSync(fix.path, "utf8");
      const result = spawnCli([
        "relink",
        fix.path,
        "--dir",
        join(fix.dir, "media"),
        "--recursive",
        "--stage",
        "--dry-run",
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.json.relinked, 1);
      assert.equal(readFileSync(fix.path, "utf8"), before);
      assert.equal(existsSync(join(fix.dir, "assets")), false);
    } finally {
      fix.cleanup();
    }
  });
});
