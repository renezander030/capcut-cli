import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactPath = join(packageDirectory, "dist/capcut-core.wasm");
const jcoPath = join(packageDirectory, "node_modules/.bin/jco");
const source = readFileSync(join(packageDirectory, "component.js"), "utf8");
assert.doesNotMatch(source, /^\s*import\s/m, "component source must not import host modules");

const wit = spawnSync(jcoPath, ["wit", artifactPath], { encoding: "utf8" });
assert.equal(wit.status, 0, wit.stderr);
assert.doesNotMatch(wit.stdout, /^\s*import\s/m, "component world must have zero imports");
assert.match(wit.stdout, /^\s*export renezander:capcut-core\/capcut-core;\s*$/m);

const artifact = readFileSync(artifactPath);
console.log(
  JSON.stringify(
    {
      ok: true,
      bytes: statSync(artifactPath).size,
      sha256: createHash("sha256").update(artifact).digest("hex"),
      imports: [],
      declaredExports: ["inspect", "lint-portable", "diff"],
    },
    null,
    2,
  ),
);
