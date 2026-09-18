import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// A JianYing 6.0+ drafts folder: every project the app wrote is an encrypted
// payload the CLI deliberately does not read (docs/jianying-encryption.md).
// Seeding (init-seed.test.mjs) has nothing to work with there, so init falls
// back to the bundled template — and must say so, count what it skipped, and
// let lint name the draft as unverified for that app rather than stale.

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-init-encrypted-"));
  writeFileSync(join(dir, "root_meta_info.json"), JSON.stringify({ all_draft_store: [] }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// What an encrypted timeline document looks like to the CLI: bytes that are
// not JSON and do not start with "{" (a corrupted plaintext draft would).
const ENCRYPTED_PAYLOAD = Buffer.concat([Buffer.from([0x8f, 0x2a, 0x11]), Buffer.alloc(253, 0xa7)]);

function encryptedProject(dir, name) {
  const project = join(dir, name);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "draft_content.json"), ENCRYPTED_PAYLOAD);
  writeFileSync(join(project, "draft_info.json"), ENCRYPTED_PAYLOAD);
  writeFileSync(
    join(project, "draft_meta_info.json"),
    JSON.stringify({ draft_id: `${name}-ID`, draft_name: name, draft_materials: [] }),
  );
  return project;
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
      last_modified_platform: { app_id: 359289, app_source: "cc", app_version: appVersion, os: "mac" },
      new_version: "183.0.0",
      platform: { app_id: 359289, app_source: "cc", app_version: appVersion, os: "mac" },
      render_index_track_mode_on: true,
      source: "default",
      version: 360000,
      tracks: [],
      materials: { videos: [], texts: [] },
    }),
  );
  writeFileSync(
    join(project, "draft_meta_info.json"),
    JSON.stringify({ draft_id: `${name}-ID`, draft_name: name, draft_materials: [] }),
  );
  return project;
}

describe("capcut init — a drafts folder whose projects are all encrypted", () => {
  it("falls back to the bundled template and names the projects it could not seed from", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    encryptedProject(dir, "encrypted-a");
    encryptedProject(dir, "encrypted-b");

    const r = spawnCli(["init", "fresh", "--drafts", dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.template.source, "path");
    assert.deepEqual(r.json.template.store, { projects: 2, readable: 0, markerless: 0, encrypted: 2, unreadable: 0 });
    assert.match(r.json.template.warning, /holds 2 project\(s\) and all 2 are encrypted/);
    assert.match(r.json.template.warning, /docs\/jianying-encryption\.md/);
    assert.match(r.stderr, /WARNING: This drafts folder holds 2 project\(s\) and all 2 are encrypted/);
  });

  it("keeps quiet when a readable project seeds the draft beside encrypted ones", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    appProject(dir, "app-project");
    encryptedProject(dir, "encrypted-a");

    const r = spawnCli(["init", "fresh", "--drafts", dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.template.source, "store");
    assert.equal(r.json.template.app_version, "9.3.0");
    assert.deepEqual(r.json.template.store, { projects: 2, readable: 1, markerless: 0, encrypted: 1, unreadable: 0 });
    assert.equal(r.json.template.warning, undefined);
    assert.doesNotMatch(r.stderr, /WARNING:/);
  });

  it("keeps quiet when the caller opted out of seeding", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    encryptedProject(dir, "encrypted-a");

    const r = spawnCli(["init", "fresh", "--drafts", dir, "--template", "bundled"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.template.source, "path");
    assert.equal(r.json.template.store.encrypted, 1, "the scan is still reported");
    assert.equal(r.json.template.warning, undefined);
    assert.doesNotMatch(r.stderr, /WARNING:/);
  });

  it("tells a broken plaintext document apart from an encrypted one", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    encryptedProject(dir, "encrypted-a");
    const broken = join(dir, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "draft_content.json"), '{"tracks": [');

    const r = spawnCli(["init", "fresh", "--drafts", dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.template.store, { projects: 2, readable: 0, markerless: 0, encrypted: 1, unreadable: 1 });
    assert.match(r.json.template.warning, /holds 2 project\(s\) and 1 of the 2 are encrypted/);
  });
});

describe("capcut lint — template-unverified-store", () => {
  it("names the bundled-template draft as unverified for the app that wrote the encrypted projects", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    encryptedProject(dir, "encrypted-a");
    encryptedProject(dir, "encrypted-b");
    const init = spawnCli(["init", "fresh", "--drafts", dir]);
    assert.equal(init.status, 0, `stderr: ${init.stderr}`);

    const r = spawnCli(["lint", init.json.draft_path, "--no-check-paths"]);
    assert.equal(r.status, 0, "an info-level finding does not fail CI");
    const found = r.json.issues.filter((i) => i.code === "template-unverified-store");
    assert.equal(found.length, 1, `expected template-unverified-store; got: ${JSON.stringify(r.json.issues)}`);
    assert.equal(found[0].severity, "info");
    assert.equal(found[0].fixable, false);
    assert.match(found[0].message, /2 project\(s\) in this drafts folder are encrypted \(JianYing 6\.0\+\)/);
    assert.equal(r.json.issues.filter((i) => i.code === "template-stale").length, 0, "not stale: nothing to compare");
  });

  it("stays silent for a draft the store's readable project seeded", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    appProject(dir, "app-project");
    encryptedProject(dir, "encrypted-a");
    const init = spawnCli(["init", "fresh", "--drafts", dir]);
    assert.equal(init.status, 0, `stderr: ${init.stderr}`);

    const r = spawnCli(["lint", init.json.draft_path, "--no-check-paths"]);
    assert.equal(r.json.issues.filter((i) => i.code === "template-unverified-store").length, 0);
  });
});

describe("capcut quickstart — a drafts folder whose projects are all encrypted", () => {
  it("carries the fallback note in its create step", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    encryptedProject(dir, "encrypted-a");
    const srt = join(dir, "subs.srt");
    writeFileSync(srt, "1\n00:00:01,000 --> 00:00:03,000\nHello\n\n2\n00:00:03,500 --> 00:00:05,000\nWorld\n");

    const r = spawnCli(["quickstart", "qs", "--srt", srt, "--drafts", dir]);
    assert.ok(r.json, `no JSON; stderr: ${r.stderr}`);
    const create = r.json.steps.find((s) => s.step === "create");
    assert.ok(create, "create step present");
    assert.match(create.detail, /holds 1 project\(s\) and all 1 are encrypted/);
    assert.match(r.json.template.warning, /encrypted/);
  });
});
