import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "draft_content.json");

describe("projects", () => {
  function makeRoot() {
    const root = mkdtempSync(join(tmpdir(), "capcut-projroot-"));
    for (const name of ["projA", "projB"]) {
      mkdirSync(join(root, name));
      copyFileSync(FIXTURE, join(root, name, "draft_content.json"));
    }
    mkdirSync(join(root, "notAProject")); // no draft file -> excluded
    return root;
  }

  it("lists only folders that contain a draft file", () => {
    const root = makeRoot();
    after(() => rmSync(root, { recursive: true, force: true }));
    const r = spawnCli(["projects", "--drafts", root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.count, 2);
    const folders = r.json.projects.map((p) => p.folder).sort();
    assert.deepEqual(folders, ["projA", "projB"]);
  });

  it("filters by name substring", () => {
    const root = makeRoot();
    after(() => rmSync(root, { recursive: true, force: true }));
    const r = spawnCli(["projects", "projA", "--drafts", root]);
    assert.equal(r.json.count, 1);
    assert.equal(r.json.projects[0].folder, "projA");
  });

  it("--names reads each draft's name field", () => {
    const root = makeRoot();
    after(() => rmSync(root, { recursive: true, force: true }));
    const r = spawnCli(["projects", "--drafts", root, "--names"]);
    assert.ok(r.json.projects.every((p) => Object.hasOwn(p, "name") || p.name === undefined));
    // the fixture has a name; at least one project should expose it
    assert.ok(r.json.projects.some((p) => typeof p.name === "string" && p.name.length > 0));
  });
});
