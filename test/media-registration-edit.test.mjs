import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadDraft, saveDraft } from "../dist/draft.js";
import { planChangedMediaRegistration } from "../dist/materials-register.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function fixture() {
  const fix = tmpDraft();
  const draft = JSON.parse(readFileSync(fix.path, "utf8"));
  const segment = draft.tracks.find((track) => track.type === "video").segments[0];
  const material = draft.materials.videos.find((material) => material.id === segment.material_id);
  material.path = join(fix.dir, "missing", "clip.mp4");
  material.local_material_id = "old-import";
  writeFileSync(fix.path, JSON.stringify(draft));
  const metaPath = join(fix.dir, "draft_meta_info.json");
  const old = { id: "old-import", file_Path: material.path, custom: "preserve old import" };
  const unrelated = { id: "other-import", file_Path: "/unrelated/file.mp4", custom: "preserve other import" };
  writeFileSync(metaPath, JSON.stringify({ draft_materials: [{ type: 0, value: [old, unrelated] }], custom: "keep" }));
  const folder = join(fix.dir, "incoming");
  mkdirSync(folder);
  const media = join(folder, "clip.mp4");
  writeFileSync(media, "new media bytes");
  return { ...fix, metaPath, old, unrelated, media, folder, segment, material };
}

describe("media edit registration transactions", () => {
  it("rejects duplicate targets reached through a directory alias", () => {
    const fix = fixture();
    try {
      const alias = join(fix.dir, "alias");
      symlinkSync(fix.dir, alias, process.platform === "win32" ? "junction" : "dir");
      const { draft, filePath } = loadDraft(fix.path);
      const before = readFileSync(fix.path, "utf8");
      assert.throws(
        () =>
          saveDraft(filePath, draft, {
            additionalFiles: [{ path: join(alias, "draft_content.json"), raw: before, content: "wrong document" }],
          }),
        /Duplicate draft transaction target/,
      );
      assert.equal(readFileSync(fix.path, "utf8"), before);
      assert.equal(existsSync(`${fix.path}.bak`), false);
    } finally {
      fix.cleanup();
    }
  });

  it("rejects Windows target aliases with different casing", { skip: process.platform !== "win32" }, () => {
    const fix = fixture();
    try {
      const { draft, filePath } = loadDraft(fix.path);
      const before = readFileSync(fix.path, "utf8");
      assert.throws(
        () =>
          saveDraft(filePath, draft, {
            additionalFiles: [{ path: fix.path.toUpperCase(), raw: before, content: "wrong document" }],
          }),
        /Duplicate draft transaction target/,
      );
      assert.equal(readFileSync(fix.path, "utf8"), before);
    } finally {
      fix.cleanup();
    }
  });

  it("checks a reused registration snapshot without rewriting or backing up an unchanged sidecar", () => {
    const fix = fixture();
    try {
      const sidecar = JSON.parse(readFileSync(fix.metaPath, "utf8"));
      sidecar.draft_materials[0].value.push({ id: "reused-import", file_Path: fix.media });
      writeFileSync(fix.metaPath, JSON.stringify(sidecar));
      const { draft, filePath } = loadDraft(fix.path);
      const material = draft.materials.videos.find((material) => material.id === fix.material.id);
      material.path = fix.media;
      const planned = planChangedMediaRegistration(draft, fix.dir, [material.id]);
      const before = readFileSync(fix.metaPath, "utf8");
      assert.equal(planned.content, before);
      saveDraft(filePath, draft, { additionalFiles: [planned] });
      assert.equal(readFileSync(fix.metaPath, "utf8"), before);
      assert.equal(existsSync(`${fix.metaPath}.bak`), false);
      assert.equal(
        JSON.parse(readFileSync(fix.path, "utf8")).materials.videos.find((value) => value.id === material.id)
          .local_material_id,
        "reused-import",
      );
      const freshPlan = planChangedMediaRegistration(draft, fix.dir, [material.id]);
      writeFileSync(fix.metaPath, JSON.stringify({ draft_materials: [] }));
      const timeline = readFileSync(fix.path, "utf8");
      assert.throws(() => saveDraft(filePath, draft, { additionalFiles: [freshPlan] }), /sidecar changed/);
      assert.equal(readFileSync(fix.path, "utf8"), timeline);
    } finally {
      fix.cleanup();
    }
  });

  for (const command of ["replace-media", "relink"]) {
    it(`${command} updates the local ID and preserves previous and unrelated imports`, () => {
      const fix = fixture();
      try {
        const beforeMeta = readFileSync(fix.metaPath, "utf8");
        const args =
          command === "replace-media"
            ? [command, fix.path, fix.segment.id, fix.media]
            : [command, fix.path, "--dir", fix.folder, "--stage"];
        const result = spawnCli(args);
        assert.equal(result.status, 0, result.stderr);
        const draft = JSON.parse(readFileSync(fix.path, "utf8"));
        const material = draft.materials.videos.find((material) => material.id === fix.material.id);
        const meta = JSON.parse(readFileSync(fix.metaPath, "utf8"));
        const entries = meta.draft_materials[0].value;
        assert.deepEqual(entries[0], fix.old);
        assert.deepEqual(entries[1], fix.unrelated);
        const imported = entries.find((entry) => entry.file_Path === material.path);
        assert.ok(imported);
        assert.equal(material.local_material_id, imported.id);
        assert.notEqual(material.local_material_id, "old-import");
        assert.equal(meta.custom, "keep");
        assert.equal(readFileSync(`${fix.metaPath}.bak`, "utf8"), beforeMeta);
      } finally {
        fix.cleanup();
      }
    });

    it(`${command} leaves timeline, sidecar and backups unchanged under --dry-run`, () => {
      const fix = fixture();
      try {
        const timeline = readFileSync(fix.path, "utf8");
        const sidecar = readFileSync(fix.metaPath, "utf8");
        const args =
          command === "replace-media"
            ? [command, fix.path, fix.segment.id, fix.media]
            : [command, fix.path, "--dir", fix.folder, "--stage"];
        const result = spawnCli([...args, "--dry-run"]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(fix.path, "utf8"), timeline);
        assert.equal(readFileSync(fix.metaPath, "utf8"), sidecar);
        assert.equal(existsSync(`${fix.metaPath}.bak`), false);
        assert.equal(existsSync(join(fix.dir, "assets")), false);
      } finally {
        fix.cleanup();
      }
    });

    it(`${command} does not change registration when the write guard refuses the draft`, () => {
      const fix = fixture();
      try {
        const draft = JSON.parse(readFileSync(fix.path, "utf8"));
        draft.platform.app_version = "99.0.0";
        writeFileSync(fix.path, JSON.stringify(draft));
        const timeline = readFileSync(fix.path, "utf8");
        const sidecar = readFileSync(fix.metaPath, "utf8");
        const args =
          command === "replace-media"
            ? [command, fix.path, fix.segment.id, fix.media]
            : [command, fix.path, "--dir", fix.folder];
        const result = spawnCli(args);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /version-boundary/);
        assert.equal(readFileSync(fix.path, "utf8"), timeline);
        assert.equal(readFileSync(fix.metaPath, "utf8"), sidecar);
        assert.equal(existsSync(`${fix.metaPath}.bak`), false);
      } finally {
        fix.cleanup();
      }
    });
  }

  it("refuses a changed sidecar before writing any timeline or backup", () => {
    const fix = fixture();
    try {
      const { draft, filePath } = loadDraft(fix.path);
      const material = draft.materials.videos.find((material) => material.id === fix.material.id);
      material.path = fix.media;
      const planned = planChangedMediaRegistration(draft, fix.dir, [material.id]);
      writeFileSync(fix.metaPath, '{"updated_by_app":true}');
      const before = readFileSync(fix.path, "utf8");
      assert.throws(() => saveDraft(filePath, draft, { additionalFiles: [planned] }), /sidecar changed/);
      assert.equal(readFileSync(fix.path, "utf8"), before);
      assert.equal(readFileSync(fix.metaPath, "utf8"), '{"updated_by_app":true}');
      assert.equal(existsSync(`${fix.path}.bak`), false);
    } finally {
      fix.cleanup();
    }
  });

  it("rolls back committed timeline bytes if sidecar publication fails", () => {
    const fix = fixture();
    const rename = fs.renameSync;
    try {
      const { draft, filePath } = loadDraft(fix.path);
      const material = draft.materials.videos.find((material) => material.id === fix.material.id);
      material.path = fix.media;
      const planned = planChangedMediaRegistration(draft, fix.dir, [material.id]);
      const before = readFileSync(fix.path, "utf8");
      const beforeMeta = readFileSync(fix.metaPath, "utf8");
      fs.renameSync = (from, to) => {
        if (to === fix.metaPath) throw new Error("injected sidecar commit failure");
        return rename(from, to);
      };
      syncBuiltinESMExports();
      assert.throws(() => saveDraft(filePath, draft, { additionalFiles: [planned] }), /injected sidecar/);
      assert.equal(readFileSync(fix.path, "utf8"), before);
      assert.equal(readFileSync(fix.metaPath, "utf8"), beforeMeta);
    } finally {
      fs.renameSync = rename;
      syncBuiltinESMExports();
      fix.cleanup();
    }
  });
});
