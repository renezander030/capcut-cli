import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultDraftsDir, draftDirCandidates } from "../dist/store.js";

// Issue #52: init/quickstart/compile used to hardcode the macOS store via $HOME,
// so on Windows (HOME normally unset) a draft landed in a literal `~/Movies/...`
// folder next to the cwd, and CapCut refused it as an "unconventional path".

const savedDraftDir = process.env.CAPCUT_DRAFT_DIR;
const savedHome = process.env.HOME;
const tmp = mkdtempSync(join(tmpdir(), "capcut-drafts-"));

function restoreEnv() {
  if (savedDraftDir === undefined) delete process.env.CAPCUT_DRAFT_DIR;
  else process.env.CAPCUT_DRAFT_DIR = savedDraftDir;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
}

after(() => {
  restoreEnv();
  rmSync(tmp, { recursive: true, force: true });
});

describe("defaultDraftsDir", () => {
  it("honors CAPCUT_DRAFT_DIR over the per-OS default", () => {
    process.env.CAPCUT_DRAFT_DIR = tmp;
    assert.equal(defaultDraftsDir(), tmp);
    restoreEnv();
  });

  it("trims a padded CAPCUT_DRAFT_DIR and ignores an empty one", () => {
    process.env.CAPCUT_DRAFT_DIR = `  ${tmp}  `;
    assert.equal(defaultDraftsDir(), tmp);
    process.env.CAPCUT_DRAFT_DIR = "   ";
    assert.equal(defaultDraftsDir(), draftDirCandidates()[0]?.path ?? null);
    restoreEnv();
  });

  it("resolves this platform's own store, and never HOME on Windows", () => {
    delete process.env.CAPCUT_DRAFT_DIR;
    process.env.HOME = "/nonexistent-home-for-test";
    const dir = defaultDraftsDir();
    if (process.platform === "win32") {
      // The regression: LOCALAPPDATA (or USERPROFILE) drives the Windows store.
      assert.ok(dir, "Windows must resolve a store");
      assert.ok(!dir.replace(/\\/g, "/").startsWith("/nonexistent-home-for-test"), dir);
    } else if (process.platform === "darwin") {
      // macOS keeps its store under the user's home, which is correct there.
      assert.match(dir?.replace(/\\/g, "/") ?? "", /com\.lveditor\.draft$/);
    } else {
      // No desktop editor: callers must be told to pass a path, not guess one.
      assert.equal(dir, null);
    }
    restoreEnv();
  });

  it("returns absolute candidate paths under com.lveditor.draft, or none", () => {
    for (const c of draftDirCandidates()) {
      assert.ok(c.label && c.path);
      assert.match(c.path.replace(/\\/g, "/"), /com\.lveditor\.draft$/);
    }
  });
});
