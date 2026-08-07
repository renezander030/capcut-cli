import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function firstTextSegment(path) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  return draft.tracks.find((t) => t.type === "text").segments[0].id;
}

const read = (p) => readFileSync(p, "utf-8");

// A write publishes the SAME pre-write bytes under two recovery names: the
// single `.bak` and the newest rolling history snapshot. They are now one
// file with two names where the filesystem allows it, so these pin that
// neither recovery path can see the other's later state.
describe("the .bak and the newest snapshot", () => {
  it("hold identical bytes, and both are the pre-write draft", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const original = read(fix.path);
    const seg = firstTextSegment(fix.path);

    assert.equal(spawnCli(["set-text", fix.path, seg, "first"]).status, 0);
    const bak = read(`${fix.path}.bak`);
    const snaps = spawnCli(["restore", fix.path, "--list"]).json.snapshots;
    assert.equal(snaps.length, 1);
    assert.equal(bak, original, ".bak must hold the pre-write draft");
    assert.equal(read(snaps[0].path), original, "step 1 must hold the same");
    assert.equal(read(snaps[0].path), bak);
  });

  it("does not let a later write reach back into an older snapshot", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const seg = firstTextSegment(fix.path);
    const states = [read(fix.path)];
    for (const text of ["one", "two", "three"]) {
      assert.equal(spawnCli(["set-text", fix.path, seg, text]).status, 0);
      states.push(read(fix.path));
    }

    // states[i] is what the draft held before write i+1. Newest snapshot first.
    const snaps = spawnCli(["restore", fix.path, "--list"]).json.snapshots;
    assert.equal(snaps.length, 3);
    for (const snap of snaps) {
      assert.equal(read(snap.path), states[3 - snap.step], `step ${snap.step} must be frozen at its own write`);
    }
    assert.equal(read(`${fix.path}.bak`), states[2], ".bak tracks the LAST write only");
    // The .bak was replaced twice after the first snapshot was taken; the
    // first snapshot must still be the original draft.
    assert.equal(read(snaps[2].path), states[0]);
  });

  it("restores identically through the .bak flow and through --step 1", () => {
    const viaBak = tmpDraft();
    const viaStep = tmpDraft();
    after(viaBak.cleanup);
    after(viaStep.cleanup);
    const original = read(viaBak.path);

    for (const fix of [viaBak, viaStep]) {
      const seg = firstTextSegment(fix.path);
      assert.equal(spawnCli(["set-text", fix.path, seg, "one"]).status, 0);
      assert.equal(spawnCli(["set-text", fix.path, seg, "two"]).status, 0);
    }
    const afterOne = read(`${viaBak.path}.bak`);

    assert.equal(spawnCli(["restore", viaBak.path]).status, 0);
    assert.equal(spawnCli(["restore", viaStep.path, "--step", "1"]).status, 0);
    assert.equal(read(viaBak.path), afterOne);
    assert.equal(read(viaStep.path), read(viaBak.path), "both recovery paths must land on the same bytes");

    // And rolling all the way back reaches the original.
    assert.equal(spawnCli(["restore", viaStep.path, "--step", "2"]).status, 0);
    assert.equal(read(viaStep.path), original);
  });

  it("keeps the .bak intact when a later write replaces it", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const seg = firstTextSegment(fix.path);
    assert.equal(spawnCli(["set-text", fix.path, seg, "one"]).status, 0);
    const firstSnapshot = spawnCli(["restore", fix.path, "--list"]).json.snapshots[0].path;
    const frozen = read(firstSnapshot);

    assert.equal(spawnCli(["set-text", fix.path, seg, "two"]).status, 0);
    assert.equal(read(firstSnapshot), frozen, "replacing .bak must not touch the snapshot that shares its bytes");
    assert.notEqual(read(`${fix.path}.bak`), frozen);
    assert.equal(existsSync(`${fix.path}.bak`), true);
  });
});
