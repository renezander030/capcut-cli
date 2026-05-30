import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

describe("capcut available templates", () => {
  it("lists available templates as JSON by default", () => {
    const r = spawnCli(["templates"]);

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json, "stdout should be valid JSON");
    assert.ok(Array.isArray(r.json));

    const slugs = r.json.map((t) => t.slug);

    assert.ok(slugs.includes("caption-pop"));
    assert.ok(slugs.includes("lower-third"));
    assert.ok(slugs.includes("hook-question"));
    assert.ok(slugs.includes("gold-title"));
    assert.ok(slugs.includes("end-card"));
    assert.ok(slugs.includes("subscribe-cta"));
  });

  it("renders a human-readable layout with -H", () => {
    const r = spawnCli(["templates", "-H"]);

    assert.equal(r.status, 0);

    assert.match(r.stdout, /Slug/);
    assert.match(r.stdout, /caption-pop/);
    assert.match(r.stdout, /gold-title/);
  });
});
