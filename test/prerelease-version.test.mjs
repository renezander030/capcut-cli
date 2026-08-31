// Issue #102: pre-release markers are dropped by `versionTuple`, so a beta
// compares equal to its own release. That is safe for a hazard gate and unsafe
// for a gate that grants reassurance. These tests pin both directions.
import assert from "node:assert/strict";
import test from "node:test";

import { nestedTimelinesAction, nestedTimelinesWriteWarning } from "../dist/store.js";
import { atLeast, isPreRelease, versionTuple } from "../dist/version.js";

test("isPreRelease distinguishes real CapCut build strings", () => {
  // Both seen on issue #50.
  assert.equal(isPreRelease("9.2.8-beta4"), true);
  assert.equal(isPreRelease("8.4.0-beta6"), true);
  assert.equal(isPreRelease("8.5.0-beta1"), true);

  assert.equal(isPreRelease("8.5.0"), false);
  assert.equal(isPreRelease("6.5.0"), false);
  assert.equal(isPreRelease("5.9"), false);
  assert.equal(isPreRelease(null), false);
  assert.equal(isPreRelease(""), false);
  // Not a version string at all — report absence rather than guess.
  assert.equal(isPreRelease("unknown"), false);
});

test("atLeast keeps numeric semantics so a pre-release still trips hazard gates", () => {
  // Deliberate: a 6.0 beta of JianYing is in the encrypted era and must still
  // match the `>= 6.0 is broken` range rather than slip under it.
  assert.deepEqual(versionTuple("6.0.0-beta2"), [6, 0, 0]);
  assert.equal(atLeast("6.0.0-beta2", "6.0"), true);
  assert.equal(atLeast("9.2.8-beta4", "8.5.0"), true);
});

test("a pre-release does not inherit the 8.5.0 regenerate-from-root reassurance", () => {
  const release = nestedTimelinesWriteWarning("8.5.0");
  assert.match(release, /should survive the next open/);

  const beta = nestedTimelinesWriteWarning("8.5.0-beta1");
  assert.doesNotMatch(beta, /should survive the next open/);
  assert.match(beta, /pre-release build/);
  assert.match(beta, /issue #102/);
});

test("a pre-release above the boundary is not shown the 7.x text either", () => {
  // The bug #68 fixed was showing 7.x prose to users whose own version
  // contradicts it; the pre-release branch must not reintroduce it.
  const beta = nestedTimelinesWriteWarning("9.2.8-beta4");
  assert.doesNotMatch(beta, /CapCut 7\.x/);
  assert.match(beta, /9\.2\.8-beta4/);

  const action = nestedTimelinesAction("9.2.8-beta4");
  assert.doesNotMatch(action, /CapCut 7\.x is reported/);
  assert.match(action, /pre-release build/);
});

test("a pre-release below the boundary keeps the existing cautious text", () => {
  // 8.4.0-beta6 is under 8.5.0 numerically, so nothing changes for it.
  const below = nestedTimelinesWriteWarning("8.4.0-beta6");
  assert.match(below, /issue #50/);
  assert.doesNotMatch(below, /should survive the next open/);
});

test("release builds and unknown versions are unchanged", () => {
  assert.match(nestedTimelinesWriteWarning(null), /CapCut 7\.x/);
  assert.match(nestedTimelinesAction("8.5.0"), /issue #68/);
});
