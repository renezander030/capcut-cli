import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDraft, saveDraft } from "../dist/draft.js";
import { discoverDraftStore, planTimelineSync } from "../dist/store.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "capcut-8.7-windows-active");
const ID = "C1EFCDF2-B885-48ff-A2F8-C33A6C4F4A52";
const active = `Timelines/${ID}/draft_content.json`;
const read = (path) => JSON.parse(readFileSync(path, "utf-8"));

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-active-"));
  cpSync(fixture, dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("CapCut 8.7.0 Windows active timeline (#50)", () => {
  it("reads the selected nested document and reports root-vs-active divergence", (t) => {
    const dir = setup(t);
    const store = discoverDraftStore(dir);
    assert.equal(store.canonical.name, active);
    assert.equal(store.canonical.draft.materials.texts.length, 1);
    assert.equal(store.diverged, true);
    const r = spawnCli(["diagnose", dir]);
    assert.equal(r.json.diverged, true);
    assert.equal(r.json.active_timeline.id, ID);
    assert.equal(r.json.canonical, active);
    const comparison = r.json.nested_evidence.root_vs_nested.find((item) => item.nested_file === active);
    assert.equal(comparison.root_file, "template-2.tmp");
    assert.equal(comparison.identical, false);
    const version = spawnCli(["version", dir]);
    assert.ok(version.json.support.notes.some((note) => note.includes("active timeline selected")));
  });

  it("stages new media and registers metadata at the project root, and restores the active timeline", (t) => {
    const dir = setup(t);
    const media = join(dir, "clip.mp4");
    writeFileSync(media, "dummy media");
    const r = spawnCli(["add-video", dir, media, "0", "1s"]);
    assert.equal(r.status, 0, r.stderr);
    const material = read(join(dir, active)).materials.videos.find((item) => item.path.startsWith(dir));
    assert.ok(material.path.startsWith(join(dir, "assets", "video")));
    assert.ok(!existsSync(join(dir, "Timelines", ID, "assets")));
    assert.ok(!existsSync(join(dir, "Timelines", ID, "draft_meta_info.json")));
    const meta = read(join(dir, "draft_meta_info.json"));
    assert.ok(meta.draft_materials.flatMap((group) => group.value).some((item) => item.file_Path === material.path));
    const restored = spawnCli(["restore", dir]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(read(join(dir, active)).materials.videos.length, 1);
    assert.equal(discoverDraftStore(dir).diverged, false);
  });

  it("writes the active document and root mirrors, preserving archived timelines and IDs", (t) => {
    const dir = setup(t);
    const archive = join(dir, "Timelines", "archived", "draft_content.json");
    mkdirSync(dirname(archive));
    writeFileSync(archive, JSON.stringify({ ...read(join(dir, active)), id: "archived" }));
    const before = readFileSync(archive, "utf-8");
    const pointer = readFileSync(join(dir, "Timelines", "project.json"), "utf-8");
    const root = read(join(dir, "draft_content.json"));
    root.id = "project-root-id";
    writeFileSync(join(dir, "draft_content.json"), JSON.stringify(root));
    // Synthetic extra mirror: exercise the existing envelope-aware serializer.
    const nestedMirror = join(dir, "Timelines", ID, "template-2.tmp");
    writeFileSync(nestedMirror, JSON.stringify({ keep: "envelope", draft: JSON.stringify(read(join(dir, active))) }));
    const r = spawnCli(["add-text", join(dir, "draft_content.json"), "0", "1s", "PATCHED"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(join(dir, "draft_content.json")).id, "project-root-id");
    assert.equal(read(join(dir, active)).id, ID);
    assert.equal(readFileSync(archive, "utf-8"), before);
    assert.equal(readFileSync(join(dir, "Timelines", "project.json"), "utf-8"), pointer);
    for (const name of [active, "draft_content.json", "template-2.tmp"]) {
      assert.ok(read(join(dir, name)).materials.texts.some((text) => JSON.parse(text.content).text === "PATCHED"));
      assert.ok(existsSync(`${join(dir, name)}.bak`));
    }
    assert.equal(read(nestedMirror).keep, "envelope");
    assert.equal(JSON.parse(read(nestedMirror).draft).id, ID);
    assert.equal(discoverDraftStore(dir).diverged, false);
    assert.throws(() => discoverDraftStore(archive), /inactive timeline/);
  });

  it("sync plans use nested → root and never include archived documents, even with --nested", (t) => {
    const dir = setup(t);
    const archive = join(dir, "Timelines", "archived", "draft_content.json");
    mkdirSync(dirname(archive));
    writeFileSync(archive, readFileSync(join(dir, active)));
    for (const nested of [false, true]) {
      const { plan } = planTimelineSync(dir, { nested });
      assert.equal(plan.canonical, active);
      assert.deepEqual(plan.drifted.sort(), ["draft_content.json", "template-2.tmp"]);
      assert.ok(!plan.targets.some((target) => target.file.includes("archived")));
    }
    const before = readFileSync(archive, "utf-8");
    const r = spawnCli(["sync-timelines", dir, "--nested", "--apply", "--force-write"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(discoverDraftStore(dir).diverged, false);
    assert.equal(readFileSync(archive, "utf-8"), before);
  });

  it("keeps unverified versions and OSes on the existing root selection", (t) => {
    for (const platform of [
      { app_version: "8.7.1", os: "windows", app_source: "cc" },
      { app_version: "8.7.0", os: "mac", app_source: "cc" },
      { app_version: "8.7.0", os: "windows", app_source: "lv" },
    ]) {
      const dir = setup(t);
      for (const file of ["draft_content.json", "template-2.tmp", active]) {
        const d = read(join(dir, file));
        d.platform = platform;
        writeFileSync(join(dir, file), JSON.stringify(d));
      }
      assert.equal(discoverDraftStore(dir).canonical.name, "template-2.tmp");
      assert.equal(discoverDraftStore(dir).activeTimeline, undefined);
    }
  });

  it("does not infer current Windows 8.7.0 authority from an old creation marker", (t) => {
    const dir = setup(t);
    for (const file of ["draft_content.json", "template-2.tmp", active]) {
      const d = read(join(dir, file));
      d.last_modified_platform = { app_source: "cc", app_version: "9.2.8-beta4", os: "mac" };
      writeFileSync(join(dir, file), JSON.stringify(d));
    }
    assert.equal(discoverDraftStore(dir).activeTimeline, undefined);
    assert.equal(discoverDraftStore(dir).canonical.name, "template-2.tmp");
  });

  it("does not redirect through malformed, missing, or escaping pointers", (t) => {
    const dir = setup(t);
    for (const raw of [
      "invalid JSON",
      JSON.stringify({ main_timeline_id: "../../outside" }),
      JSON.stringify({ main_timeline_id: "missing" }),
      JSON.stringify({ main_timeline_id: ID, timelines: [{ id: ID, is_marked_delete: true }] }),
    ]) {
      writeFileSync(join(dir, "Timelines", "project.json"), raw);
      assert.equal(discoverDraftStore(dir).canonical.name, "template-2.tmp");
    }
  });

  it("does not follow a symlink that takes the active document outside the project", (t) => {
    if (process.platform === "win32") return t.skip("symlink creation requires Windows privileges");
    const dir = setup(t);
    const outside = setup(t);
    rmSync(join(dir, "Timelines", ID), { recursive: true });
    symlinkSync(join(outside, "Timelines", ID), join(dir, "Timelines", ID), "dir");
    const before = readFileSync(join(outside, active), "utf-8");
    assert.equal(discoverDraftStore(dir).canonical.name, "template-2.tmp");
    assert.equal(spawnCli(["add-text", dir, "0", "1s", "ROOT ONLY"]).status, 0);
    assert.equal(readFileSync(join(outside, active), "utf-8"), before);
  });

  it("checks the active pointer between load and save and permits repeated saves", (t) => {
    const dir = setup(t);
    process.env.CAPCUT_CLI_APP_VERSIONS = join(dir, "versions.json");
    t.after(() => {
      delete process.env.CAPCUT_CLI_APP_VERSIONS;
    });
    const { filePath, draft } = loadDraft(dir);
    draft.name = "first";
    saveDraft(filePath, draft);
    draft.name = "second";
    saveDraft(filePath, draft);
    assert.equal(read(join(dir, active)).name, "second");
    assert.equal(discoverDraftStore(dir).diverged, false);
    const before = readFileSync(join(dir, active), "utf-8");
    writeFileSync(join(dir, "Timelines", "project.json"), JSON.stringify({ main_timeline_id: "changed" }));
    assert.throws(() => saveDraft(filePath, draft), /active-timeline-changed/);
    assert.equal(readFileSync(join(dir, active), "utf-8"), before);
  });
});
