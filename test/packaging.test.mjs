import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "dist");

// Key order matters as much as the values: `enums` prints entries straight out of
// the parsed table, so a re-serialization that reshuffled fields would change output.
function serialize(value) {
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .map((k) => `${JSON.stringify(k)}:${serialize(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("packaged enums.json", () => {
  const srcRaw = readFileSync(join(repoRoot, "src", "enums.json"), "utf8");
  const distRaw = readFileSync(join(repoRoot, "dist", "enums.json"), "utf8");

  it("carries the source table verbatim, field order included", () => {
    assert.equal(serialize(JSON.parse(distRaw)), serialize(JSON.parse(srcRaw)));
  });

  it("ships without the source indentation", () => {
    assert.ok(!distRaw.includes("\n"), "dist/enums.json should be a single line");
    assert.ok(
      distRaw.length < srcRaw.length,
      `expected the packaged copy to be smaller than ${srcRaw.length} bytes, got ${distRaw.length}`,
    );
  });
});

// Every way a .d.ts can name a sibling module. `tsc` emits inline `import("./x.js").T`
// for inferred types, so a plain `from "..."` scan would under-report the graph.
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/g,
];

function declarationsFor(file) {
  const text = readFileSync(file, "utf8");
  const specs = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      specs.add(match[1]);
      match = pattern.exec(text);
    }
  }
  const resolved = [];
  for (const spec of specs) {
    if (!spec.startsWith(".")) continue; // bare package — not one of ours
    const abs = resolve(dirname(file), spec);
    const candidate = [abs.replace(/\.js$/, ".d.ts"), `${abs}.d.ts`, join(abs, "index.d.ts")].find((c) =>
      existsSync(c),
    );
    assert.ok(candidate, `unresolved relative specifier ${spec} in ${file}`);
    resolved.push(candidate);
  }
  return resolved;
}

/** Declarations a consumer can actually reach through the `exports` types entry. */
function reachableDeclarations() {
  const entry = resolve(distDir, "lib.d.ts");
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    for (const next of declarationsFor(queue.shift())) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return new Set([...seen].map((f) => `dist/${f.slice(distDir.length + 1)}`));
}

describe("packaged type declarations", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const allowlisted = new Set(pkg.files.filter((f) => /^dist\/.+\.d\.ts$/.test(f)));

  it("ships exactly the declarations reachable from the types entry", () => {
    // `files` drops dist/*.d.ts wholesale and re-adds the reachable set. The rest are
    // unresolvable for consumers anyway — `exports` exposes only the lib entry — so
    // shipping them is dead weight. Adding a module to lib.d.ts must extend the list.
    assert.deepEqual([...allowlisted].sort(), [...reachableDeclarations()].sort());
  });

  it("keeps the types entry itself in the tarball", () => {
    assert.ok(allowlisted.has(pkg.types.replace(/^\.\//, "")));
  });
});
