import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// #110: a text-style operation whose styling keys sit flat on the operation
// (instead of under `style`) crashed compile with "Cannot read properties of
// undefined (reading 'alpha')" — and --check let it through. The pre-flight
// now names the mistake and the keys it found.

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-compile-validation-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function spec(operations) {
  return {
    name: "V",
    width: 1080,
    height: 1920,
    fps: 30,
    ratio: "9:16",
    tracks: [{ type: "text", items: [{ ref: "title", text: "Hook", start: 0, duration: 2 }] }],
    operations,
  };
}

function check(dir, s) {
  const p = join(dir, "spec.json");
  writeFileSync(p, JSON.stringify(s));
  return spawnCli(["compile", p, "--check"]);
}

describe("compile --check payload validation", () => {
  it("rejects text-style styling keys written flat on the operation, naming them", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const r = check(dir, spec([{ op: "text-style", target: "title", alpha: 0.5, shadow: true }]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /operations\[0\]\.style must be an object/);
    // stderr carries the JSON error envelope, so the quotes arrive escaped.
    assert.match(r.stderr, /found alpha, shadow at the operation level; nest them under \\?"style\\?"/);
  });

  it("accepts the nested form", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const r = check(dir, spec([{ op: "text-style", target: "title", style: { alpha: 0.5 } }]));
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.checked, true);
  });

  it("rejects text-ranges without a ranges array", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const r = check(dir, spec([{ op: "text-ranges", target: "title", ranges: { start: 0 } }]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /operations\[0\]\.ranges must be an array/);
  });
});
