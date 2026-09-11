import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// init's store seeding (#67, #111): the bundled template stamps CapCut 6.5.0
// and none of the schema markers the app writes, and 8.4 / 8.5 / 8.7 Windows /
// 9.3 refuse such a draft as "from an unusual path". When the drafts folder
// holds a project from a newer app major, the skeleton comes from that
// project instead — markers and settings kept, content emptied.

function appDraft(overrides = {}) {
  return {
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    color_space: 0,
    config: { adjust_max_index: 1, maintrack_adsorb: true },
    cover: "cover.jpg",
    create_time: 1_700_000_000,
    duration: 3_000_000,
    extra_info: null,
    fps: 60,
    free_render_index_mode_on: false,
    group_container: null,
    id: "APP-DRAFT-ID",
    keyframe_graph_list: [{ id: "kg" }],
    keyframes: { videos: [{ id: "kf1" }], texts: [] },
    last_modified_platform: { app_id: 359289, app_source: "cc", app_version: "9.3.0", os: "mac" },
    materials: {
      videos: [{ id: "V1", type: "video", path: "/tmp/x.mp4", duration: 3_000_000, local_material_id: "E1" }],
      texts: [],
      speeds: [],
    },
    mutable_config: null,
    name: "App Project",
    new_version: "183.0.0",
    platform: { app_id: 359289, app_source: "cc", app_version: "9.3.0", os: "mac" },
    relationships: [{ id: "r1" }],
    render_index_track_mode_on: true,
    retouch_cover: null,
    source: "default",
    static_cover_image_path: "/x/cover.jpg",
    time_marks: null,
    tracks: [
      {
        id: "T1",
        type: "video",
        name: "video",
        attribute: 0,
        segments: [
          {
            id: "S1",
            material_id: "V1",
            target_timerange: { start: 0, duration: 3_000_000 },
            source_timerange: { start: 0, duration: 3_000_000 },
          },
        ],
      },
    ],
    update_time: 1_700_000_100,
    version: 360000,
    ...overrides,
  };
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-init-seed-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A drafts folder holding one app-authored project (nested Timelines/, mirror, sidecar, backups). */
function storeWithAppProject(dir, overrides = {}) {
  const project = join(dir, "APP-DRAFT-ID");
  mkdirSync(join(project, "Timelines", "TL-1"), { recursive: true });
  const draft = appDraft(overrides);
  writeFileSync(join(project, "draft_info.json"), JSON.stringify(draft));
  writeFileSync(join(project, "template-2.tmp"), JSON.stringify(draft));
  writeFileSync(join(project, "draft_info.json.bak"), "{}");
  writeFileSync(join(project, "draft_settings"), "settings");
  writeFileSync(
    join(project, "draft_meta_info.json"),
    JSON.stringify({ draft_id: draft.id, draft_name: draft.name, draft_materials: [{ type: 0, value: [] }] }),
  );
  writeFileSync(join(project, "Timelines", "project.json"), JSON.stringify({ main_timeline_id: "TL-1" }));
  writeFileSync(join(project, "Timelines", "TL-1", "draft_info.json"), JSON.stringify(draft));
  writeFileSync(
    join(dir, "root_meta_info.json"),
    JSON.stringify({
      all_draft_store: [
        {
          draft_fold_path: project,
          draft_id: draft.id,
          draft_json_file: join(project, "draft_info.json"),
          draft_name: draft.name,
          draft_root_path: dir,
          tm_draft_create: 1,
          tm_draft_modified: 1,
          tm_draft_removed: 0,
          tm_duration: 3_000_000,
        },
      ],
    }),
  );
  return project;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("capcut init — store seeding (#67, #111)", () => {
  it("seeds the skeleton from the store's newest app-authored project when it outgrows the bundled template", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const donor = storeWithAppProject(dir);

    const r = spawnCli(["init", "new-one", "--drafts", dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.template.source, "store");
    assert.equal(r.json.template.app_version, "9.3.0");
    assert.equal(r.json.template.path, donor);
    assert.ok(r.json.template.reset.includes("tracks"));
    assert.ok(r.json.template.reset.includes("materials"));
    assert.match(r.stderr, /Skeleton seeded from the store's CapCut 9\.3\.0 project/);
    assert.doesNotMatch(r.stderr, /issues #67, #111/, "the seeded draft needs no #67 warning");

    const draftDir = r.json.draft_path;
    // The bundled template's file set plus the >= 8.7 mirror the donor keeps — and no nested Timelines/.
    for (const file of ["draft_info.json", "draft_content.json", "template-2.tmp", "draft_meta_info.json"]) {
      assert.ok(existsSync(join(draftDir, file)), `${file} should exist`);
    }
    assert.ok(!existsSync(join(draftDir, "Timelines")), "the donor's Timelines/ must not travel");
    assert.ok(!existsSync(join(draftDir, "draft_settings")), "seeding writes timeline documents only");

    const info = readJson(join(draftDir, "draft_info.json"));
    const content = readJson(join(draftDir, "draft_content.json"));
    assert.deepEqual(content, info, "both root mirrors carry the same skeleton");
    // Markers and settings from the donor.
    assert.equal(info.version, 360000);
    assert.equal(info.new_version, "183.0.0");
    assert.equal(info.platform.app_version, "9.3.0");
    assert.equal(info.platform.os, "mac");
    assert.equal(info.last_modified_platform.app_version, "9.3.0");
    assert.equal(info.color_space, 0);
    assert.equal(info.render_index_track_mode_on, true);
    assert.deepEqual(info.config, { adjust_max_index: 1, maintrack_adsorb: true });
    // Content emptied.
    assert.deepEqual(info.tracks, []);
    assert.deepEqual(info.materials.videos, []);
    for (const [key, value] of Object.entries(info.materials)) {
      assert.ok(Array.isArray(value) && value.length === 0, `materials.${key} should be an empty array`);
    }
    assert.deepEqual(info.keyframes, { videos: [], texts: [] });
    assert.deepEqual(info.keyframe_graph_list, []);
    assert.deepEqual(info.relationships, []);
    assert.equal(info.cover, null);
    assert.equal(info.static_cover_image_path, "");
    assert.equal(info.duration, 0);
    // Identity is the new draft's; canvas and fps are the template's defaults, not the portrait donor's.
    assert.notEqual(info.id, "APP-DRAFT-ID");
    assert.equal(info.name, "new-one");
    assert.deepEqual(info.canvas_config, { width: 1920, height: 1080, ratio: "16:9" });
    assert.equal(info.fps, 30);
    // The sidecar is the new draft's own, not a copy of the donor's.
    const sidecar = readJson(join(draftDir, "draft_meta_info.json"));
    assert.equal(sidecar.draft_id, info.id);
    assert.equal(sidecar.draft_name, "new-one");
  });

  it("keeps the --ratio override on a seeded draft", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    storeWithAppProject(dir);
    const r = spawnCli(["init", "portrait", "--drafts", dir, "--ratio", "9:16"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.template.source, "store");
    const info = readJson(join(r.json.draft_path, "draft_info.json"));
    assert.deepEqual(info.canvas_config, { width: 1080, height: 1920, ratio: "9:16" });
  });

  it("--template bundled keeps the bundled template and still warns (#67)", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    storeWithAppProject(dir);
    const r = spawnCli(["init", "bundled-one", "--drafts", dir, "--template", "bundled"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.template.source, "path");
    assert.equal(r.json.template.app_version, "6.5.0");
    assert.match(r.stderr, /issues #67, #111/);
    assert.match(r.stderr, /--template auto/);
    const info = readJson(join(r.json.draft_path, "draft_info.json"));
    assert.equal(info.platform.app_version, "6.5.0");
    assert.equal(info.version, undefined);
  });

  it("does not seed from a store whose projects share the template's major", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    storeWithAppProject(dir, {
      platform: { app_id: 359289, app_source: "cc", app_version: "6.2.8", os: "mac" },
      last_modified_platform: { app_id: 359289, app_source: "cc", app_version: "6.2.8", os: "mac" },
    });
    const r = spawnCli(["init", "same-major", "--drafts", dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.template.source, "path");
    assert.doesNotMatch(r.stderr, /issues #67, #111/);
    const info = readJson(join(r.json.draft_path, "draft_info.json"));
    assert.equal(info.platform.app_version, "6.5.0");
  });

  it("--template auto seeds even when the store's projects share the template's major", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    storeWithAppProject(dir, {
      platform: { app_id: 359289, app_source: "cc", app_version: "6.2.8", os: "mac" },
      last_modified_platform: { app_id: 359289, app_source: "cc", app_version: "6.2.8", os: "mac" },
    });
    const r = spawnCli(["init", "forced", "--drafts", dir, "--template", "auto"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.template.source, "store");
    assert.equal(r.json.template.app_version, "6.2.8");
  });

  it("prefers an app-authored project over a newer-looking CLI-built one", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const donor = storeWithAppProject(dir);
    // A markerless draft (the pre-0.23 bundled shape) claiming a newer app_version must not be the seed.
    const cliDir = join(dir, "cli-made");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(cliDir, "draft_content.json"),
      JSON.stringify({
        id: "CLI-ID",
        name: "cli-made",
        duration: 0,
        fps: 30,
        canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
        platform: { app_source: "cc", app_version: "9.9.0", os: "mac" },
        tracks: [],
        materials: { videos: [], texts: [] },
      }),
    );
    const r = spawnCli(["init", "picky", "--drafts", dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.template.source, "store");
    assert.equal(r.json.template.path, donor);
    assert.equal(r.json.template.app_version, "9.3.0");
  });

  it("copies an explicit --template directory without Timelines/, .bak files or the donor's sidecar, stamping every mirror", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const donor = storeWithAppProject(dir);
    const target = join(dir, "second-store");
    mkdirSync(target);

    const r = spawnCli(["init", "copied", "--drafts", target, "--template", donor]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.template.source, "path");
    assert.equal(r.json.template.path, donor);
    assert.ok(r.json.template.skipped.includes("Timelines"), `skipped: ${r.json.template.skipped}`);
    assert.ok(r.json.template.skipped.includes("draft_info.json.bak"));
    assert.ok(r.json.template.skipped.includes("draft_meta_info.json"));

    const draftDir = r.json.draft_path;
    assert.ok(!existsSync(join(draftDir, "Timelines")));
    assert.ok(!existsSync(join(draftDir, "draft_info.json.bak")));
    assert.ok(existsSync(join(draftDir, "draft_settings")), "settings files still travel");
    const info = readJson(join(draftDir, "draft_info.json"));
    const mirror = readJson(join(draftDir, "template-2.tmp"));
    assert.equal(info.name, "copied");
    assert.notEqual(info.id, "APP-DRAFT-ID");
    assert.equal(mirror.id, info.id, "template-2.tmp carries the same new id");
    assert.equal(mirror.name, "copied");
    // An explicit template keeps its content (a template may be a starting timeline on purpose).
    assert.equal(info.tracks.length, 1);
    // The sidecar is freshly written for the new draft.
    const sidecar = readJson(join(draftDir, "draft_meta_info.json"));
    assert.equal(sidecar.draft_id, info.id);
  });
});

describe("capcut register on drafts this CLI created (#111 isolation control)", () => {
  it("derives the id of a bundled-template draft: both root mirrors are stamped at init", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const init = spawnCli(["init", "probe", "--drafts", dir, "--template", "bundled"]);
    assert.equal(init.status, 0, `stderr: ${init.stderr}`);
    const info = readJson(join(init.json.draft_path, "draft_info.json"));
    const content = readJson(join(init.json.draft_path, "draft_content.json"));
    assert.equal(content.id, info.id, 'draft_content.json used to keep id ""');
    assert.equal(content.name, "probe");

    const r = spawnCli(["register", init.json.draft_path]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.draft_id, info.id);
    assert.equal(r.json.needs_repair, false);
  });

  it('falls back to the sidecar\'s draft_id for a draft an older release stamped with id ""', (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const project = join(dir, "old-style");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "draft_content.json"),
      JSON.stringify({
        id: "",
        name: "",
        duration: 0,
        fps: 30,
        canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
        platform: { app_source: "cc", app_version: "6.5.0", os: "mac" },
        tracks: [],
        materials: { videos: [], texts: [] },
      }),
    );
    writeFileSync(
      join(project, "draft_meta_info.json"),
      JSON.stringify({
        draft_fold_path: project,
        draft_id: "OLD-SIDECAR-ID",
        draft_json_file: join(project, "draft_content.json"),
        draft_name: "old-style",
        draft_root_path: dir,
        tm_draft_create: 1,
        tm_draft_modified: 1,
        tm_draft_removed: 0,
        tm_duration: 0,
      }),
    );
    writeFileSync(join(dir, "root_meta_info.json"), JSON.stringify({ all_draft_store: [] }));

    const r = spawnCli(["register", project]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.draft_id, "OLD-SIDECAR-ID");
    assert.match(r.json.identity_source, /draft_meta_info\.json/);
    assert.equal(r.json.needs_repair, true, "the root index entry is still missing and gets planned");
  });
});
