import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// media-outside-draft names the macOS permission case: media under
// ~/Desktop, ~/Documents or ~/Downloads is readable by the shell that wrote
// the draft and not necessarily by the app — JianYing 11.4 prompts "no access
// permission" / relink although the path is valid
// (GuanYixuan/pyJianYingDraft#198). Staging into the draft is the fix.

function outsideIssue(path) {
  const fix = tmpDraft();
  const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
  draft.materials.videos[0].path = path;
  writeFileSync(fix.path, JSON.stringify(draft));
  const r = spawnCli(["lint", fix.path, "--no-probe"]);
  fix.cleanup();
  return r.json.issues.find((i) => i.code === "media-outside-draft" && i.location.path === path);
}

describe("lint media-outside-draft — macOS permission-protected folders", () => {
  it("names the permission cause and the staging fix for a Desktop path", () => {
    const issue = outsideIssue("/Users/tester/Desktop/shoot/clip.mp4");
    assert.ok(issue, "media-outside-draft expected");
    assert.match(issue.message, /~\/Desktop is a macOS permission-protected folder/);
    assert.match(issue.message, /pyJianYingDraft#198/);
    assert.match(issue.message, /lint <project> --fix/);
  });

  it("keeps the plain message for other absolute paths", () => {
    const issue = outsideIssue("/Volumes/Footage/clip.mp4");
    assert.ok(issue, "media-outside-draft expected");
    assert.doesNotMatch(issue.message, /permission-protected/);
  });
});
