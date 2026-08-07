import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// The timeline files are read-only for rename: byte-identical after every run,
// even when they reference assets under the folder being renamed.
function contentDraft(dir) {
  return {
    id: "guid-rename-draft",
    name: "My Draft",
    duration: 2_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "8.7.0", os: "windows" },
    tracks: [{ id: "T1", type: "video", name: "video", attribute: 0, segments: [] }],
    materials: {
      videos: dir ? [{ id: "M1", path: join(dir, "assets", "video", "clip.mp4") }] : [],
      audios: [],
      texts: [],
    },
  };
}

// An unrelated draft's entry already in the store index. Carries a
// version-specific field (draft_enterprise_info) that must survive a sibling's
// rename byte-for-byte.
function otherEntry(root) {
  return {
    draft_cover: "draft_cover.jpg",
    draft_enterprise_info: { draft_enterprise_extra: "" },
    draft_fold_path: join(root, "Other Draft"),
    draft_id: "guid-other-draft",
    draft_json_file: join(root, "Other Draft", "draft_content.json"),
    draft_name: "Other Draft",
    draft_root_path: root,
    tm_draft_create: 1_700_000_000_000_000,
    tm_draft_modified: 1_700_000_000_000_000,
    tm_draft_removed: 0,
    tm_duration: 5_000_000,
  };
}

function myEntry(root, dir) {
  return {
    draft_cover: join(dir, "draft_cover.jpg"), // absolute, under the folder: must be prefix-rewritten
    draft_enterprise_info: { draft_enterprise_extra: "" },
    draft_fold_path: dir,
    draft_id: "guid-rename-draft",
    draft_json_file: join(dir, "draft_content.json"),
    draft_name: "My Draft",
    draft_root_path: root,
    tm_draft_create: 1_700_000_000_000_000,
    tm_draft_modified: 1_700_000_000_000_000,
    tm_draft_removed: 0,
    tm_duration: 2_000_000,
  };
}

// A draft store: root dir holding root_meta_info.json plus one draft folder
// ("My Draft"). Options control whether the sidecar and the index entry exist,
// and whether the timeline references assets under the draft folder.
function storeFixture({ withMeta = true, withEntry = true, withMediaRefs = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "capcut-rename-store-"));
  const dir = join(root, "My Draft");
  mkdirSync(dir);
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(contentDraft(withMediaRefs ? dir : null), null, 2));
  if (withMeta) writeFileSync(join(dir, "draft_meta_info.json"), JSON.stringify(myEntry(root, dir)));
  const entries = [otherEntry(root)];
  if (withEntry) entries.push(myEntry(root, dir));
  writeFileSync(join(root, "root_meta_info.json"), JSON.stringify({ all_draft_store: entries }));
  return {
    root,
    dir,
    newDir: join(root, "Better Name"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("rename", () => {
  it("renames the folder and rewrites draft_name + every self-referential path in both metadata files", () => {
    const f = storeFixture();
    after(f.cleanup);
    const metaBefore = readFileSync(join(f.dir, "draft_meta_info.json"), "utf-8");
    const indexBefore = readFileSync(join(f.root, "root_meta_info.json"), "utf-8");

    const r = spawnCli(["rename", f.dir, "Better Name"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.renamed, true);
    assert.equal(r.json.old_name, "My Draft");
    assert.equal(r.json.new_name, "Better Name");
    assert.equal(r.json.old_path, f.dir);
    assert.equal(r.json.new_path, f.newDir);
    assert.deepEqual(
      r.json.updated.sort(),
      [join(f.newDir, "draft_meta_info.json"), join(f.root, "root_meta_info.json")].sort(),
      "the result must name every path rewritten",
    );
    assert.ok(!existsSync(f.dir), "the old folder must be gone");
    assert.ok(existsSync(f.newDir), "the new folder must exist");

    // Sidecar: name + every field pointing at/under the old folder rewritten,
    // identity and unknown fields preserved, tm_draft_modified bumped.
    const meta = JSON.parse(readFileSync(join(f.newDir, "draft_meta_info.json"), "utf-8"));
    assert.equal(meta.draft_name, "Better Name");
    assert.equal(meta.draft_fold_path, f.newDir);
    assert.equal(meta.draft_json_file, join(f.newDir, "draft_content.json"));
    assert.equal(
      meta.draft_cover,
      join(f.newDir, "draft_cover.jpg"),
      "any absolute path under the folder is rewritten",
    );
    assert.equal(meta.draft_root_path, f.root, "the store root does not change");
    assert.equal(meta.draft_id, "guid-rename-draft", "the id never changes");
    assert.equal(meta.tm_draft_create, 1_700_000_000_000_000);
    assert.ok(meta.tm_draft_modified > 1_700_000_000_000_000, "tm_draft_modified must be bumped");
    assert.ok("draft_enterprise_info" in meta, "unknown sidecar fields must be preserved");
    const metaTarget = r.json.targets.find((t) => t.file === "draft_meta_info.json");
    assert.deepEqual(
      metaTarget.updated_fields.sort(),
      ["draft_cover", "draft_fold_path", "draft_json_file", "draft_name"],
      "the report must name exactly the fields the rename rewrote",
    );

    // Index: my entry updated in place, the unrelated entry byte-preserved.
    const index = JSON.parse(readFileSync(join(f.root, "root_meta_info.json"), "utf-8"));
    assert.equal(index.all_draft_store.length, 2, "the entry is updated in place, not duplicated");
    assert.deepEqual(
      index.all_draft_store.find((e) => e.draft_id === "guid-other-draft"),
      otherEntry(f.root),
      "other drafts' entries must survive untouched",
    );
    const mine = index.all_draft_store.find((e) => e.draft_id === "guid-rename-draft");
    assert.equal(mine.draft_name, "Better Name");
    assert.equal(mine.draft_fold_path, f.newDir);
    assert.equal(mine.draft_json_file, join(f.newDir, "draft_content.json"));

    // Backups: pre-rename bytes, one per rewritten file (the sidecar's .bak
    // travels with the renamed folder).
    assert.deepEqual(r.json.backups.sort(), ["draft_meta_info.json.bak", "root_meta_info.json.bak"]);
    assert.equal(readFileSync(join(f.newDir, "draft_meta_info.json.bak"), "utf-8"), metaBefore);
    assert.equal(readFileSync(join(f.root, "root_meta_info.json.bak"), "utf-8"), indexBefore);
  });

  it("never touches timeline files: draft_content.json + draft_info.json stay byte-identical, no .bak", () => {
    const f = storeFixture({ withMediaRefs: true });
    after(f.cleanup);
    // A draft_info.json mirror rides along to prove the whole timeline set is untouched.
    writeFileSync(join(f.dir, "draft_info.json"), JSON.stringify(contentDraft(f.dir)));
    const contentBefore = readFileSync(join(f.dir, "draft_content.json"), "utf-8");
    const infoBefore = readFileSync(join(f.dir, "draft_info.json"), "utf-8");

    const r = spawnCli(["rename", f.dir, "Better Name"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(readFileSync(join(f.newDir, "draft_content.json"), "utf-8"), contentBefore);
    assert.equal(readFileSync(join(f.newDir, "draft_info.json"), "utf-8"), infoBefore);
    assert.ok(!existsSync(join(f.newDir, "draft_content.json.bak")), "rename must never back up timeline files");
    assert.ok(!existsSync(join(f.newDir, "draft_info.json.bak")), "rename must never back up timeline files");

    // The stale absolute media references are counted and routed to relink,
    // never rewritten silently.
    assert.ok(r.json.stale_media_refs >= 2, `expected refs in both timeline files, got ${r.json.stale_media_refs}`);
    assert.match(r.stderr, /relink/, "stderr must hand the user the relink repair");
    assert.match(r.stderr, /WARNING/);
  });

  it("refuses when the target folder already exists, leaving everything untouched", () => {
    const f = storeFixture();
    after(f.cleanup);
    mkdirSync(f.newDir);
    const indexBefore = readFileSync(join(f.root, "root_meta_info.json"), "utf-8");

    const r = spawnCli(["rename", f.dir, "Better Name"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already exists/);
    assert.ok(existsSync(f.dir), "the draft folder must not move");
    assert.equal(readFileSync(join(f.root, "root_meta_info.json"), "utf-8"), indexBefore, "no write on refusal");
    assert.ok(!existsSync(join(f.root, "root_meta_info.json.bak")), "no backup on refusal");
  });

  it("rejects invalid names symmetrically: empty, dot-dirs, and paths", () => {
    const f = storeFixture();
    after(f.cleanup);
    for (const bad of ["", " ", ".", "..", "a/b", "a\\b"]) {
      const r = spawnCli(["rename", f.dir, bad]);
      assert.equal(r.status, 1, `name ${JSON.stringify(bad)} must be rejected`);
      assert.ok(existsSync(f.dir), `name ${JSON.stringify(bad)} must not move the folder`);
    }
    const same = spawnCli(["rename", f.dir, "My Draft"]);
    assert.equal(same.status, 1);
    assert.match(same.stderr, /already named/);
  });

  it("renames an unregistered draft with no sidecar, reporting what register would recreate", () => {
    const f = storeFixture({ withMeta: false, withEntry: false });
    after(f.cleanup);
    const indexBefore = readFileSync(join(f.root, "root_meta_info.json"), "utf-8");

    const r = spawnCli(["rename", f.dir, "Better Name"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.renamed, true);
    assert.equal(r.json.old_name, "My Draft", "with no sidecar the folder name is the old name");
    assert.deepEqual(r.json.updated, [], "nothing to rewrite when neither metadata surface has this draft");
    assert.ok(existsSync(f.newDir));
    assert.equal(r.json.targets.find((t) => t.file === "draft_meta_info.json").state, "missing");
    assert.equal(r.json.targets.find((t) => t.file === "root_meta_info.json").state, "unregistered");
    assert.match(r.stderr, /register/, "the report must route the user to register for the missing metadata");
    assert.equal(
      readFileSync(join(f.root, "root_meta_info.json"), "utf-8"),
      indexBefore,
      "an index without this draft's entry is not rename's to write",
    );
  });

  it("refuses to rename around an unreadable root_meta_info.json or sidecar", () => {
    const f = storeFixture();
    after(f.cleanup);
    const indexPath = join(f.root, "root_meta_info.json");
    writeFileSync(indexPath, "\x00\x01not-json\x02");

    const r = spawnCli(["rename", f.dir, "Better Name"]);
    assert.equal(r.status, 1, "an unreadable index must refuse the rename, not desync the store");
    assert.ok(existsSync(f.dir), "the folder must not move when the index cannot be updated");
    assert.equal(readFileSync(indexPath, "utf-8"), "\x00\x01not-json\x02", "the index must never be clobbered");

    const g = storeFixture();
    after(g.cleanup);
    writeFileSync(join(g.dir, "draft_meta_info.json"), "\x00\x01not-json\x02");
    const s = spawnCli(["rename", g.dir, "Better Name"]);
    assert.equal(s.status, 1, "an unreadable sidecar must refuse the rename");
    assert.match(s.stderr, /register/, "the refusal must name the repair path");
    assert.ok(existsSync(g.dir));
  });

  it("--dry-run previews the full plan without renaming or writing", () => {
    const f = storeFixture();
    after(f.cleanup);
    const metaBefore = readFileSync(join(f.dir, "draft_meta_info.json"), "utf-8");
    const indexBefore = readFileSync(join(f.root, "root_meta_info.json"), "utf-8");

    const r = spawnCli(["rename", f.dir, "Better Name", "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dryRun, true);
    assert.equal(r.json.renamed, false);
    assert.equal(r.json.new_path, f.newDir);
    assert.equal(r.json.updated.length, 2, "the preview must still name every path the rename would rewrite");
    assert.ok(existsSync(f.dir), "dry-run must not rename");
    assert.ok(!existsSync(f.newDir), "dry-run must not rename");
    assert.equal(readFileSync(join(f.dir, "draft_meta_info.json"), "utf-8"), metaBefore, "dry-run must not write");
    assert.equal(readFileSync(join(f.root, "root_meta_info.json"), "utf-8"), indexBefore, "dry-run must not write");
    assert.ok(!existsSync(join(f.root, "root_meta_info.json.bak")), "dry-run must not create backups");
  });

  it("rejects an explicitly named non-canonical file; the canonical file is an alias for the directory", () => {
    const f = storeFixture();
    after(f.cleanup);

    const rejected = spawnCli(["rename", join(f.dir, "draft_meta_info.json"), "Better Name"]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /cannot target draft_meta_info\.json/);

    const accepted = spawnCli(["rename", join(f.dir, "draft_content.json"), "Better Name"]);
    assert.equal(accepted.status, 0, `stderr: ${accepted.stderr}`);
    assert.equal(accepted.json.old_path, f.dir);
    assert.ok(existsSync(f.newDir));
  });

  it("renames a draft outside any known store root, folder + sidecar only", () => {
    const loose = mkdtempSync(join(tmpdir(), "capcut-rename-loose-"));
    after(() => rmSync(loose, { recursive: true, force: true }));
    const dir = join(loose, "Orphan Draft");
    mkdirSync(dir);
    writeFileSync(join(dir, "draft_content.json"), JSON.stringify(contentDraft(null), null, 2));
    writeFileSync(join(dir, "draft_meta_info.json"), JSON.stringify(myEntry(loose, dir)));

    const r = spawnCli(["rename", dir, "Found Draft"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.renamed, true);
    const index = r.json.targets.find((t) => t.file === "root_meta_info.json");
    assert.equal(index.state, "unknown-store-root");
    assert.match(index.detail, /--drafts/, "the report must say how to point rename at the store");
    const meta = JSON.parse(readFileSync(join(loose, "Found Draft", "draft_meta_info.json"), "utf-8"));
    assert.equal(meta.draft_name, "Found Draft");
    assert.ok(!existsSync(join(loose, "root_meta_info.json")), "no index may be invented outside a store");
  });
});
