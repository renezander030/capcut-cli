import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDraft, segmentCount } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDir, tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut save-template + apply-template", () => {
  const fix = tmpDraft();
  const out = tmpDir();
  after(() => {
    fix.cleanup();
    out.cleanup();
  });

  it("save-template writes a JSON file with name/type/segment/material", () => {
    const texts = spawnCli(["texts", fix.path]).json ?? [];
    if (texts.length === 0) return;
    const prefix = texts[0].id.slice(0, 8);
    const outPath = join(out.dir, "tpl.json");
    const r = spawnCli(["save-template", fix.path, prefix, "smoke-title", "--out", outPath]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(outPath));
    const tpl = JSON.parse(readFileSync(outPath, "utf-8"));
    assert.equal(tpl.name, "smoke-title");
    assert.equal(typeof tpl.type, "string");
    assert.ok(tpl.segment, "template should embed the segment");
    assert.ok(tpl.material, "template should embed the material");
  });

  it("apply-template stamps the template into a fresh draft with text override", () => {
    // Use one of the shipped templates (resolved from the package root)
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const tpl = join(repoRoot, "templates", "gold-title.json");
    if (!existsSync(tpl)) return; // shipped templates not present in this checkout

    const before = segmentCount(loadDraft(fix.path));
    const r = spawnCli(["apply-template", fix.path, tpl, "10s", "3s", "STAMPED"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(typeof r.json.segment_id, "string");
    const after = segmentCount(loadDraft(fix.path));
    assert.equal(after, before + 1);
  });
});

describe("shipped templates apply cleanly", () => {
  for (const name of ["gold-title", "end-card", "subscribe-cta", "caption-pop", "lower-third", "hook-question"]) {
    it(`templates/${name}.json roundtrips into a fresh draft`, () => {
      const fix = tmpDraft();
      try {
        const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
        const tpl = join(repoRoot, "templates", `${name}.json`);
        if (!existsSync(tpl)) return; // shipped templates not present
        const r = spawnCli(["apply-template", fix.path, tpl, "0s", "5s", `test-${name}`]);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.equal(r.json.ok, true);
      } finally {
        fix.cleanup();
      }
    });
  }
});
