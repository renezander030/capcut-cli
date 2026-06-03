import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// #15: a global --dry-run that previews any mutating command without writing.
describe("global --dry-run (#15)", () => {
  const segId = (path) => JSON.parse(readFileSync(path, "utf-8")).tracks.find((t) => t.type === "video").segments[0].id;

  it("leaves the draft and its .bak untouched, and stamps dryRun:true", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const before = readFileSync(fix.path, "utf-8");

    const r = spawnCli(["speed", fix.path, segId(fix.path), "2.0", "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json.ok);
    assert.equal(r.json.dryRun, true);

    assert.equal(readFileSync(fix.path, "utf-8"), before, "draft must be byte-identical after --dry-run");
    assert.equal(existsSync(`${fix.path}.bak`), false, "no .bak should be written in --dry-run");
  });

  it("a real write changes the file and carries no dryRun marker", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const before = readFileSync(fix.path, "utf-8");

    const r = spawnCli(["speed", fix.path, segId(fix.path), "1.25"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dryRun, undefined);
    assert.notEqual(readFileSync(fix.path, "utf-8"), before, "a real write must change the file");
  });
});
