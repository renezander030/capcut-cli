import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "draft_content.json");

describe("config (.capcutrc)", () => {
  function cwdWith(rc) {
    const dir = mkdtempSync(join(tmpdir(), "capcut-cfg-"));
    writeFileSync(join(dir, ".capcutrc"), JSON.stringify(rc));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("config reports the resolved file and effective defaults", () => {
    const c = cwdWith({ jianying: true, cols: 30, drafts: "/tmp/foo" });
    after(c.cleanup);
    const r = spawnCli(["config"], { cwd: c.dir });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json.path?.endsWith(".capcutrc"));
    assert.equal(r.json.effective.jianying, true);
    assert.equal(r.json.effective.cols, 30);
    assert.equal(r.json.effective.drafts, "/tmp/foo");
  });

  it("a config 'drafts' default is used by `projects` when --drafts is absent", () => {
    // a projects root with one valid project
    const root = mkdtempSync(join(tmpdir(), "capcut-cfgroot-"));
    mkdirSync(join(root, "projX"));
    copyFileSync(FIXTURE, join(root, "projX", "draft_content.json"));
    const c = cwdWith({ drafts: root });
    after(() => {
      c.cleanup();
      rmSync(root, { recursive: true, force: true });
    });

    const r = spawnCli(["projects"], { cwd: c.dir });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.count, 1);
    assert.equal(r.json.projects[0].folder, "projX");
  });

  it("a CLI flag overrides the config default", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "capcut-other-"));
    const c = cwdWith({ drafts: "/nonexistent/from/config" });
    after(() => {
      c.cleanup();
      rmSync(otherRoot, { recursive: true, force: true });
    });
    // --drafts points at an empty (but existing) dir -> count 0, proving config's path was overridden
    const r = spawnCli(["projects", "--drafts", otherRoot], { cwd: c.dir });
    assert.equal(r.status, 0);
    assert.equal(r.json.count, 0);
  });
});
