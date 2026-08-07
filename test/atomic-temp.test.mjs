import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { writeAtomic } from "../dist/draft.js";

// Every mutating command stages its write in a temp file next to the target,
// then renames. The name used to be `<target>.capcut-cli-<pid>-<now>.tmp` and
// the open was a plain "w": predictable AND symlink-following, so anyone able
// to create files in the draft folder (a synced CapCut store, a shared box)
// could pre-place a symlink at the path the next save would pick and turn
// every draft save into a write anywhere that user could reach.
//
// Freezing the clock in-process makes the old scheme fully deterministic —
// pid and `Date.now()` are then both known — so the exact paths it would have
// picked can be planted. Crypto randomness keeps the write off them; the
// exclusive open ("wx", O_EXCL) refuses them even on a collision.
const FROZEN_MS = 1_700_000_000_000;

// The bare name is `writeAtomic`'s; the `-<index>` variants are the ones the
// multi-file draft save used, one per target it staged.
function legacyTempPaths(target) {
  return ["", "-0", "-1", "-2"].map((suffix) => `${target}.capcut-cli-${process.pid}-${FROZEN_MS}${suffix}.tmp`);
}

describe("atomic write: temp files are unpredictable and exclusively created", () => {
  const dirs = [];
  const realNow = Date.now;
  after(() => {
    Date.now = realNow;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "capcut-atomic-"));
    dirs.push(dir);
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "untouched");
    return { dir, victim };
  }

  it("never writes through a symlink planted at the predictable temp path", () => {
    const { dir, victim } = setup();
    const target = join(dir, "draft_content.json");
    writeFileSync(target, '{"old":true}');
    const planted = legacyTempPaths(target);
    for (const path of planted) symlinkSync(victim, path);

    Date.now = () => FROZEN_MS;
    try {
      writeAtomic(target, '{"new":true}');
    } finally {
      Date.now = realNow;
    }

    assert.equal(readFileSync(victim, "utf-8"), "untouched", "the save was redirected through a planted symlink");
    assert.equal(readFileSync(target, "utf-8"), '{"new":true}', "the real target did not receive the write");
    // Nothing was staged at a planted path: each is still the symlink we made.
    for (const path of planted) assert.ok(lstatSync(path).isSymbolicLink(), `${path} was written as a real file`);
  });

  it("still creates a target that does not exist yet, clock frozen or not", () => {
    const { dir, victim } = setup();
    const target = join(dir, "fresh.json");
    for (const path of legacyTempPaths(target)) symlinkSync(victim, path);

    Date.now = () => FROZEN_MS;
    try {
      writeAtomic(target, "content");
      // A second write at the same instant must not collide with the first.
      writeAtomic(target, "content again");
    } finally {
      Date.now = realNow;
    }

    assert.equal(readFileSync(target, "utf-8"), "content again");
    assert.equal(readFileSync(victim, "utf-8"), "untouched");
  });
});
