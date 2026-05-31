import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

describe("capcut --version", () => {
  it("prints package version with --version", () => {
    const r = spawnCli(["--version"]);

    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), pkg.version);
  });

  it("prints package version with -v", () => {
    const r = spawnCli(["-v"]);

    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), pkg.version);
  });
});
