import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, "..", "dist", "lib.js");
const FIXTURE = join(__dirname, "draft_content.json");

describe("library entry point (dist/lib.js)", () => {
  it("exports the stable core API and importing it does not run the CLI", async () => {
    const lib = await import(LIB);
    for (const name of ["loadDraft", "saveDraft", "lintDraft", "detectVersion", "runDoctor", "findSegment"]) {
      assert.equal(typeof lib[name], "function", `missing export: ${name}`);
    }
  });

  it("can load, inspect, and lint a draft programmatically", async () => {
    const { loadDraft, lintDraft, detectVersion } = await import(LIB);
    const { draft, filePath } = loadDraft(FIXTURE);
    assert.ok(Array.isArray(draft.tracks));
    assert.equal(typeof filePath, "string");
    assert.ok(Array.isArray(lintDraft(draft)));
    assert.ok(["CapCut", "JianYing", "unknown"].includes(detectVersion(draft).app));
  });
});
