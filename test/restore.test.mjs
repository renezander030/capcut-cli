import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// #16: `restore` undoes the last write by copying <draft>.bak back over the draft.
describe("restore (#16)", () => {
  const segId = (path) => JSON.parse(readFileSync(path, "utf-8")).tracks.find((t) => t.type === "video").segments[0].id;

  it("reverts the draft to its pre-write state", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const original = readFileSync(fix.path, "utf-8");

    const w = spawnCli(["speed", fix.path, segId(fix.path), "2.0"]);
    assert.equal(w.status, 0, `stderr: ${w.stderr}`);
    assert.notEqual(readFileSync(fix.path, "utf-8"), original, "write should change the file first");

    const r = spawnCli(["restore", fix.path]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json.ok);
    assert.equal(readFileSync(fix.path, "utf-8"), original, "restore should bring back the original bytes");
  });

  it("exits non-zero with a clear message when no .bak exists", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const r = spawnCli(["restore", fix.path]);
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /No backup found/);
  });

  it("honors --dry-run: reports without restoring", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    spawnCli(["speed", fix.path, segId(fix.path), "2.0"]);
    const mutated = readFileSync(fix.path, "utf-8");

    const r = spawnCli(["restore", fix.path, "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dryRun, true);
    assert.equal(readFileSync(fix.path, "utf-8"), mutated, "--dry-run restore must not change the file");
  });
});
