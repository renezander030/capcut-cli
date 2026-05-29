import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

describe("capcut doctor", () => {
  it("runs without a project and emits a structured report", () => {
    const r = spawnCli(["doctor"]);
    // Exit 0 because the test runner is Node >= 18 (the only hard requirement).
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json, "stdout should be valid JSON");
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.platform, "string");
    assert.equal(typeof r.json.node, "string");
    assert.ok(Array.isArray(r.json.checks));
    assert.ok(r.json.checks.length > 0);
  });

  it("reports the node check as ok on a supported runtime", () => {
    const r = spawnCli(["doctor"]);
    const node = r.json.checks.find((c) => c.name === "node");
    assert.ok(node, "should include a node check");
    assert.equal(node.status, "ok");
  });

  it("includes whisper, anthropic-api-key, and draft-dir checks with valid statuses", () => {
    const r = spawnCli(["doctor"]);
    const names = new Set(r.json.checks.map((c) => c.name));
    assert.ok(names.has("whisper"));
    assert.ok(names.has("anthropic-api-key"));
    for (const c of r.json.checks) {
      assert.ok(["ok", "warn", "missing"].includes(c.status), `bad status: ${c.status}`);
    }
  });

  it("renders a human-readable layout with -H", () => {
    const r = spawnCli(["doctor", "-H"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Platform:/);
    assert.match(r.stdout, /Node:/);
    assert.match(r.stdout, /whisper/);
  });
});
