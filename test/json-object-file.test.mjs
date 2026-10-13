import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseJsonObject, readJsonObjectFile } from "../dist/bom.js";

// register, rename and media registration all read CapCut metadata files the
// same way: "missing" (raw null) and "corrupt" (raw set, obj null) are
// different outcomes for them, and a BOM never makes a file corrupt.
describe("readJsonObjectFile: missing vs corrupt metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "capcut-json-object-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reports an absent file as raw null and obj null", () => {
    assert.deepEqual(readJsonObjectFile(join(dir, "absent.json")), { raw: null, obj: null });
  });

  it("strips a BOM from raw and parses the object", () => {
    const path = join(dir, "bom.json");
    writeFileSync(path, '﻿{"draft_id":"A"}');
    assert.deepEqual(readJsonObjectFile(path), { raw: '{"draft_id":"A"}', obj: { draft_id: "A" } });
  });

  it("keeps raw but no obj for an array, a scalar or broken JSON", () => {
    for (const [name, text] of [
      ["array.json", "[1,2]"],
      ["scalar.json", "42"],
      ["broken.json", "{not json"],
    ]) {
      const path = join(dir, name);
      writeFileSync(path, text);
      assert.deepEqual(readJsonObjectFile(path), { raw: text, obj: null }, name);
    }
    assert.equal(parseJsonObject("null"), null);
  });
});
