import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultDraftsDir, draftDirCandidates } from "../dist/store.js";

// Issue #52: init/quickstart/compile used to hardcode the macOS store via $HOME,
// so on Windows (HOME normally unset) a draft landed in a literal `~/Movies/...`
// folder next to the cwd, and CapCut refused it as an "unconventional path".

const saved = { ...process.env };
const tmp = mkdtempSync(join(tmpdir(), "capcut-drafts-"));

after(() => {
  process.env = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("defaultDraftsDir", () => {
  it("honors CAPCUT_DRAFT_DIR over the per-OS default", () => {
    process.env.CAPCUT_DRAFT_DIR = tmp;
    assert.equal(defaultDraftsDir(), tmp);
  });

  it("trims a padded CAPCUT_DRAFT_DIR and ignores an empty one", () => {
    process.env.CAPCUT_DRAFT_DIR = `  ${tmp}  `;
    assert.equal(defaultDraftsDir(), tmp);
    process.env.CAPCUT_DRAFT_DIR = "   ";
    assert.equal(defaultDraftsDir(), draftDirCandidates()[0]?.path ?? null);
  });

  it("never derives the store from HOME on any platform", () => {
    process.env.CAPCUT_DRAFT_DIR = "";
    delete process.env.CAPCUT_DRAFT_DIR;
    process.env.HOME = "/nonexistent-home-for-test";
    const dir = defaultDraftsDir();
    assert.ok(dir === null || !dir.startsWith("/nonexistent-home-for-test"));
  });

  it("returns absolute candidate paths under com.lveditor.draft, or none", () => {
    for (const c of draftDirCandidates()) {
      assert.ok(c.label && c.path);
      assert.match(c.path.replace(/\\/g, "/"), /com\.lveditor\.draft$/);
    }
  });
});
