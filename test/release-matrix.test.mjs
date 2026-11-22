import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PORTABLE_TARGETS } from "../scripts/build-portable.mjs";

// The release builds every portable target the builder knows, each on a named runner image, so a runner's
// "-latest" move never changes what a published archive was built on.
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);
const matrix = [...release.matchAll(/^\s*- \{ os: ([^,]+), target: ([^ }]+) \}/gm)].map((m) => ({
  os: m[1],
  target: m[2],
}));

describe("release portable matrix", () => {
  it("names a versioned runner image for every native build", () => {
    assert.ok(matrix.length > 0);
    for (const { os, target } of matrix) assert.doesNotMatch(os, /-latest$/, `${target} builds on ${os}`);
  });

  it("covers each portable target once; linux-x64 is built in the release job", () => {
    assert.match(release, /pack:portable[^\n]*\n[\s\S]*linux-x64/);
    assert.deepEqual([...matrix.map((m) => m.target), "linux-x64"].sort(), [...PORTABLE_TARGETS].sort());
  });
});
