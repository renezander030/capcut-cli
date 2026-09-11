import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// Drafts the pre-0.23 bundled template stamped (app_version 6.5.0, no
// version / new_version markers) are refused by CapCut 8.4+ / 8.7 Windows /
// 9.3 as "from an unusual path" (#67, #111). lint names them (template-stale)
// when the store holds newer projects, and `migrate --from-store` / `--like`
// restamp the markers from a project the app wrote instead of recreating the
// draft.

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-template-stale-"));
  // A drafts folder is recognised by its root index; without it lint treats
  // the draft as living outside any store and never looks for siblings.
  writeFileSync(join(dir, "root_meta_info.json"), JSON.stringify({ all_draft_store: [] }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function appProject(dir, name, appVersion = "9.3.0") {
  const project = join(dir, name);
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "draft_info.json"),
    JSON.stringify({
      id: `${name}-ID`,
      name,
      duration: 0,
      fps: 30,
      canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
      color_space: 0,
      config: { maintrack_adsorb: true },
      free_render_index_mode_on: false,
      last_modified_platform: { app_id: 359289, app_source: "cc", app_version: appVersion, os: "windows" },
      new_version: "183.0.0",
      platform: { app_id: 359289, app_source: "cc", app_version: appVersion, os: "windows" },
      render_index_track_mode_on: true,
      source: "default",
      version: 360000,
      tracks: [],
      materials: { videos: [], texts: [] },
    }),
  );
  return project;
}

function cliProject(dir, name) {
  const project = join(dir, name);
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "draft_content.json"),
    JSON.stringify({
      id: `${name}-ID`,
      name,
      duration: 0,
      fps: 30,
      canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
      platform: { app_source: "cc", app_version: "6.5.0", os: "mac" },
      tracks: [],
      materials: { videos: [], texts: [] },
    }),
  );
  writeFileSync(join(project, "draft_meta_info.json"), JSON.stringify({ draft_id: `${name}-ID`, draft_name: name }));
  return project;
}

function readContent(project) {
  return JSON.parse(readFileSync(join(project, "draft_content.json"), "utf-8"));
}

describe("template-stale + migrate --from-store / --like", () => {
  it("lint warns on a markerless 6.5.0 draft in a 9.3.0 store and migrate --from-store restamps it", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    appProject(dir, "real");
    const old = cliProject(dir, "old");

    const before = spawnCli(["lint", old, "--no-probe"]);
    assert.equal(before.status, 1, `warning => exit 1: ${before.stderr}`);
    const issue = before.json.issues.find((i) => i.code === "template-stale");
    assert.ok(issue, JSON.stringify(before.json.issues));
    assert.equal(issue.severity, "warning");
    assert.match(issue.message, /9\.3\.0/);
    assert.match(issue.suggested_command, /migrate <project> --from-store/);

    const migrate = spawnCli(["migrate", old, "--from-store"]);
    assert.equal(migrate.status, 0, `stderr: ${migrate.stderr}`);
    assert.equal(migrate.json.ok, true);
    assert.equal(migrate.json.donor_app_version, "9.3.0");
    for (const field of [
      "version",
      "new_version",
      "last_modified_platform",
      "color_space",
      "render_index_track_mode_on",
    ]) {
      assert.ok(migrate.json.added.includes(field), `${field} should be added: ${JSON.stringify(migrate.json)}`);
    }
    assert.ok(migrate.json.restamped.includes("platform"));
    assert.ok(migrate.json.added.includes("config"), "settings the draft lacked are filled in");
    const after = readContent(old);
    assert.equal(after.version, 360000);
    assert.equal(after.new_version, "183.0.0");
    assert.equal(after.platform.app_version, "9.3.0");
    assert.equal(after.platform.os, "windows");
    assert.deepEqual(after.tracks, [], "content untouched");

    const clean = spawnCli(["lint", old, "--no-probe"]);
    assert.ok(!clean.json.issues.some((i) => i.code === "template-stale"), JSON.stringify(clean.json.issues));
    assert.equal(clean.status, 0);

    const again = spawnCli(["migrate", old, "--from-store"]);
    assert.equal(again.status, 0);
    assert.deepEqual(again.json.restamped, []);
    assert.deepEqual(again.json.added, []);
  });

  it("migrate --like restamps from a named donor", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const donor = appProject(dir, "donor", "8.7.0");
    const old = cliProject(dir, "old");
    const r = spawnCli(["migrate", old, "--like", donor]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.donor, donor);
    assert.equal(readContent(old).platform.app_version, "8.7.0");
  });

  it("refuses --from-store when the store holds no app-authored project", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    cliProject(dir, "other");
    const old = cliProject(dir, "old");
    const r = spawnCli(["migrate", old, "--from-store"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No app-authored project/);
    assert.equal(readContent(old).platform.app_version, "6.5.0", "nothing written");
  });

  it("does not warn when the store's projects share the draft's major", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    appProject(dir, "real", "6.2.8");
    const old = cliProject(dir, "old");
    const r = spawnCli(["lint", old, "--no-probe"]);
    assert.ok(!r.json.issues.some((i) => i.code === "template-stale"), JSON.stringify(r.json.issues));
  });
});
