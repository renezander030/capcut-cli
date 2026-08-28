import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

describe("catalogue (cross-category resource lookup)", () => {
  it("finds a bundled entry by exact slug and returns its resource id", () => {
    const r = spawnCli(["catalogue", "circle", "--kind", "masks"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(Array.isArray(r.json));
    const hit = r.json.find((m) => m.slug === "circle" && m.category === "masks");
    assert.ok(hit, "the circle mask must be found");
    assert.equal(hit.source, "bundled");
    assert.ok(hit.resource_id, "the whole point is the resource id");
  });

  it("searches every category by substring, exact matches first", () => {
    const r = spawnCli(["catalogue", "circle"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json.length >= 1);
    assert.equal(r.json[0].slug, "circle", "exact slug match must rank before substring matches");
  });

  it("reverse lookup: pasting a resource id answers what it is", () => {
    const bySlug = spawnCli(["catalogue", "circle", "--kind", "masks"]);
    const id = bySlug.json.find((m) => m.slug === "circle").resource_id;
    const r = spawnCli(["catalogue", id]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json[0].slug, "circle");
    assert.equal(r.json[0].resource_id, id);
  });

  it("--limit caps the result list", () => {
    const r = spawnCli(["catalogue", "i", "--limit", "3"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json.length <= 3);
  });

  it("rejects an unknown --kind with the category list", () => {
    const r = spawnCli(["catalogue", "circle", "--kind", "nonsense"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /masks/);
  });

  it("finds harvest-enums user-catalogue entries and labels their source", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-catalogue-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const cataloguePath = join(dir, "user-enums.json");
    writeFileSync(
      cataloguePath,
      JSON.stringify({
        version: 1,
        entries: [{ kind: "masks", slug: "snowfly-window", name: "Snowfly Window", resource_id: "9999999001" }],
      }),
    );

    const r = spawnCli(["catalogue", "snowfly"], { env: { CAPCUT_CLI_USER_ENUMS: cataloguePath } });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const hit = r.json.find((m) => m.slug === "snowfly-window");
    assert.ok(hit, "harvested entries must be searchable by name");
    assert.equal(hit.source, "user");
    assert.equal(hit.resource_id, "9999999001");
    assert.equal(hit.category, "masks");
  });

  it("-H prints a table with the resource id column", () => {
    const r = spawnCli(["catalogue", "circle", "--kind", "masks", "-H"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Resource ID/);
    assert.match(r.stdout, /circle/);
  });
});
