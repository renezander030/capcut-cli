import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { planChangedMediaRegistration } from "../dist/materials-register.js";

function fixture(meta) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-changed-registration-"));
  const path = join(dir, "draft_meta_info.json");
  if (meta !== undefined) writeFileSync(path, typeof meta === "string" ? meta : JSON.stringify(meta, null, 2));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path };
}

function draft(materials) {
  return { materials: { videos: [], audios: [], ...materials } };
}

describe("changed-media registration planning", () => {
  it("links only changed media to new entries and preserves every existing entry without writes", () => {
    const oldEntry = { id: "old-entry", file_Path: "old.mp4", app_field: "keep old source" };
    const unrelated = { id: "other-entry", file_Path: "other.wav", app_field: { preserve: true } };
    const meta = {
      app_metadata: "unchanged",
      draft_materials: [{ type: 0, value: [oldEntry] }, { type: 2, value: [unrelated] }, null],
    };
    const f = fixture(meta);
    const before = readFileSync(f.path, "utf-8");
    const changed = {
      id: "video",
      path: "final.mp4",
      local_material_id: "old-entry",
      duration: 3_500_000,
      width: 640,
      height: 360,
    };
    const untouched = { id: "untouched", path: "missing.mp4", local_material_id: "old-link" };
    const content = draft({ videos: [changed, untouched] });

    const plan = planChangedMediaRegistration(content, f.dir, ["video"]);
    assert.equal(plan.path, f.path);
    assert.equal(plan.raw, before);
    const proposed = JSON.parse(plan.content);
    assert.equal(proposed.app_metadata, "unchanged");
    assert.deepEqual(proposed.draft_materials[0].value[0], oldEntry);
    assert.deepEqual(proposed.draft_materials[1], meta.draft_materials[1]);
    assert.equal(proposed.draft_materials[2], null, "opaque group entries are preserved");
    const entry = proposed.draft_materials[0].value[1];
    assert.equal(entry.file_Path, "final.mp4");
    assert.equal(entry.duration, 3_500_000);
    assert.equal(entry.width, 640);
    assert.equal(entry.height, 360);
    assert.equal(changed.local_material_id, entry.id);
    assert.equal(untouched.local_material_id, "old-link", "unselected media is never registered or relinked");
    assert.equal(readFileSync(f.path, "utf-8"), before, "planning leaves sidecar bytes unchanged");
    assert.equal(existsSync(`${f.path}.bak`), false);
    assert.equal(existsSync(join(f.dir, "assets")), false);
  });

  it("reuses a path registered in any group and changes its link without rewriting the sidecar", () => {
    const f = fixture({ draft_materials: [{ type: 2, value: [{ id: "known-entry", file_Path: "final.mp4" }] }] });
    const before = readFileSync(f.path, "utf-8");
    const material = { id: "video", path: join(f.dir, "final.mp4"), local_material_id: "stale-id" };
    const plan = planChangedMediaRegistration(draft({ videos: [material] }), f.dir, ["video"]);
    assert.deepEqual(
      plan,
      { path: f.path, raw: before, content: before },
      "reused entries retain a conflict-check snapshot",
    );
    assert.equal(material.local_material_id, "known-entry");
    assert.equal(readFileSync(f.path, "utf-8"), before);
  });

  it("returns no sidecar plan when no selected material has a local media path", () => {
    const f = fixture({ draft_materials: [{ type: 0, value: [] }] });
    const material = { id: "video", path: "local.mp4", local_material_id: "unchanged" };
    const remote = { id: "remote", path: "https://example.com/remote.mp4", local_material_id: "remote-link" };
    const content = draft({ videos: [material, remote] });
    assert.equal(planChangedMediaRegistration(content, f.dir, ["unknown", "remote"]), null);
    assert.equal(material.local_material_id, "unchanged");
    assert.equal(remote.local_material_id, "remote-link");
  });

  it("registers a shared file once and links each changed material to the same entry", () => {
    const f = fixture({ draft_materials: [{ type: 0, value: [] }] });
    const first = { id: "first", path: "shared.mp4" };
    const second = { id: "second", path: "./shared.mp4" };
    const plan = planChangedMediaRegistration(draft({ videos: [first, second] }), f.dir, ["first", "second"]);
    const entries = JSON.parse(plan.content).draft_materials[0].value;
    assert.equal(entries.length, 1);
    assert.equal(first.local_material_id, entries[0].id);
    assert.equal(second.local_material_id, entries[0].id);
  });

  it("retains legacy dictionary groups and registers audio without video dimensions", () => {
    const preserved = [{ id: "existing", file_Path: "old.wav", app_field: "keep" }];
    const f = fixture({ draft_materials: { imported: preserved, custom: "opaque" } });
    const material = { id: "audio", path: "new.wav", name: "Narration", duration: 9_000_000, width: 99, height: 99 };
    const plan = planChangedMediaRegistration(draft({ audios: [material] }), f.dir, ["audio"]);
    const groups = JSON.parse(plan.content).draft_materials;
    assert.deepEqual(groups.imported, preserved);
    assert.equal(groups.custom, "opaque");
    assert.equal(groups["0"][0].metetype, "music");
    assert.equal(groups["0"][0].extra_info, "Narration");
    assert.equal(groups["0"][0].duration, 9_000_000);
    assert.equal(groups["0"][0].width, 0);
    assert.equal(groups["0"][0].height, 0);
    assert.equal(material.local_material_id, groups["0"][0].id);
  });

  it("leaves missing or unreadable sidecars and existing links untouched", () => {
    for (const meta of [undefined, "invalid json", "[]"]) {
      const f = fixture(meta);
      const material = { id: "video", path: "new.mp4", local_material_id: "app-link" };
      const before = JSON.stringify(material);
      assert.equal(planChangedMediaRegistration(draft({ videos: [material] }), f.dir, ["video"]), null);
      assert.equal(JSON.stringify(material), before);
      assert.equal(existsSync(`${f.path}.bak`), false);
      assert.equal(existsSync(f.path), meta !== undefined, "planner never fabricates a sidecar");
      if (meta !== undefined) assert.equal(readFileSync(f.path, "utf-8"), meta);
    }
  });
});
