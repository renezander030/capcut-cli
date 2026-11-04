import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut translate", () => {
  describe("--dry-run", () => {
    const fix = tmpDraft();
    const outDir = mkdtempSync(join(tmpdir(), "capcut-translate-"));
    const outPath = join(outDir, "translated.json");
    after(() => {
      fix.cleanup();
      rmSync(outDir, { recursive: true, force: true });
    });

    it("lists all text materials without calling the API", () => {
      const r = spawnCli(["translate", fix.path, "--to", "Spanish", "--out", outPath, "--dry-run"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(r.json.ok);
      assert.equal(r.json.dry_run, true);
      assert.equal(r.json.to, "Spanish");
      assert.ok(r.json.count >= 1);
      assert.ok(Array.isArray(r.json.pairs));
      assert.equal(r.json.pairs[0].original, r.json.pairs[0].translated);
      assert.ok(existsSync(outPath), "dry-run still writes the cloned (untranslated) draft");
    });

    it("leaves the original draft untouched", () => {
      const beforeBytes = readFileSync(fix.path);
      spawnCli(["translate", fix.path, "--to", "French", "--out", outPath, "--dry-run"]);
      const afterBytes = readFileSync(fix.path);
      assert.equal(beforeBytes.toString("utf-8"), afterBytes.toString("utf-8"));
    });
  });

  describe("error paths", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("requires --to", () => {
      const r = spawnCli(["translate", fix.path, "--out", "/tmp/x.json", "--dry-run"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Missing --to/);
    });

    it("requires --out", () => {
      const r = spawnCli(["translate", fix.path, "--to", "Spanish", "--dry-run"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Missing --out/);
    });

    it("hints at --cloud when API key is missing", () => {
      const outDir = mkdtempSync(join(tmpdir(), "capcut-translate-err-"));
      const outPath = join(outDir, "out.json");
      try {
        const r = spawnCli(["translate", fix.path, "--to", "Spanish", "--out", outPath], {
          env: { ...process.env, ANTHROPIC_API_KEY: "" },
        });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /--cloud/);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    });
  });
});
