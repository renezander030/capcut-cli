import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

// README's portable download commands name a release file; they must name the version being released.
it("README's portable download examples name the package version", () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const named = [...readme.matchAll(/capcut-cli-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(?:linux|darwin|win)-/g)].map(
    (m) => m[1],
  );
  assert.ok(named.length > 0, "README names no portable archive");
  assert.deepEqual([...new Set(named)], [version]);
});
