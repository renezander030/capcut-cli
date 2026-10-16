import assert from "node:assert/strict";
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const read = (p) => readFileSync(p, "utf-8");

function firstTextSegment(path) {
  const draft = JSON.parse(read(path));
  return draft.tracks.find((t) => t.type === "text").segments[0].id;
}

// What the app does on save (issue #151): it rewrites `<draft>.bak` in place,
// keeping the file, with content that already includes the CLI's edit.
function appRewritesBak(path) {
  writeFileSync(`${path}.bak`, read(path), "utf-8");
}

describe("restore — recovery files are checked against the write journal", () => {
  it("keeps the history snapshot when the app rewrites the .bak in place", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const original = read(fix.path);
    assert.equal(spawnCli(["set-text", fix.path, firstTextSegment(fix.path), "edited"]).status, 0);

    appRewritesBak(fix.path);
    const snapshot = spawnCli(["restore", fix.path, "--list"]).json.snapshots[0];
    assert.equal(read(snapshot.path), original, "the snapshot is its own file, not a second name for .bak");
    assert.equal(snapshot.integrity, "intact");

    const r = spawnCli(["restore", fix.path, "--step", "1"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.integrity, "intact");
    assert.equal(read(fix.path), original);
  });

  it("refuses a .bak the app rewrote and points at the intact snapshot", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    assert.equal(spawnCli(["set-text", fix.path, firstTextSegment(fix.path), "edited"]).status, 0);
    const edited = read(fix.path);
    appRewritesBak(fix.path);

    const r = spawnCli(["restore", fix.path]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /refused \[backup-changed\]/);
    assert.match(r.stderr + r.stdout, /--step 1/);
    assert.equal(read(fix.path), edited, "a refused restore writes nothing");

    const forced = spawnCli(["restore", fix.path, "--force-write"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(forced.json.integrity, "changed");
  });

  it("refuses a changed snapshot unless --force-write", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const seg = firstTextSegment(fix.path);
    assert.equal(spawnCli(["set-text", fix.path, seg, "one"]).status, 0);
    assert.equal(spawnCli(["set-text", fix.path, seg, "two"]).status, 0);
    const snaps = spawnCli(["restore", fix.path, "--list"]).json.snapshots;
    writeFileSync(snaps[1].path, read(fix.path), "utf-8");

    const list = spawnCli(["restore", fix.path, "--list"]).json.snapshots;
    assert.deepEqual(
      list.map((s) => s.integrity),
      ["intact", "changed"],
    );
    const before = read(fix.path);
    const r = spawnCli(["restore", fix.path, "--step", "2"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /refused \[snapshot-changed\]: snapshot step 2/);
    assert.equal(read(fix.path), before);
    assert.equal(spawnCli(["restore", fix.path, "--step", "2", "--force-write"]).status, 0);
  });

  it("detects a pre-0.30.0 snapshot that shares its bytes with the .bak", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    assert.equal(spawnCli(["set-text", fix.path, firstTextSegment(fix.path), "edited"]).status, 0);
    const snapshot = spawnCli(["restore", fix.path, "--list"]).json.snapshots[0].path;
    rmSync(snapshot);
    linkSync(`${fix.path}.bak`, snapshot); // how older versions published the snapshot
    appRewritesBak(fix.path);
    assert.equal(spawnCli(["restore", fix.path, "--list"]).json.snapshots[0].integrity, "changed");
  });

  it("restores history without a journal entry as unverified", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const original = read(fix.path);
    assert.equal(spawnCli(["set-text", fix.path, firstTextSegment(fix.path), "edited"]).status, 0);
    const snapshot = spawnCli(["restore", fix.path, "--list"]).json.snapshots[0].path;
    rmSync(snapshot.replace(/\.\d+\.snap$/, ".journal.jsonl"));

    const r = spawnCli(["restore", fix.path]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.integrity, "unverified");
    assert.equal(read(fix.path), original);
  });
});
