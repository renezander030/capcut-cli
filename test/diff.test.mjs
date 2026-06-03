import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "draft_content.json");

describe("diff", () => {
  function pair() {
    const dir = mkdtempSync(join(tmpdir(), "capcut-diff-"));
    copyFileSync(FIXTURE, join(dir, "A.json"));
    copyFileSync(FIXTURE, join(dir, "B.json"));
    return {
      dir,
      a: join(dir, "A.json"),
      b: join(dir, "B.json"),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("reports no change for identical drafts", () => {
    const p = pair();
    after(p.cleanup);
    const r = spawnCli(["diff", p.a, p.b]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.changed, false);
  });

  it("detects a text edit as a changed material", () => {
    const p = pair();
    after(p.cleanup);
    const id = spawnCli(["texts", p.b]).json[0].id;
    spawnCli(["set-text", p.b, id, "EDITED", "-q"]);
    const r = spawnCli(["diff", p.a, p.b]);
    assert.equal(r.json.changed, true);
    assert.equal(r.json.materials.changed.length, 1);
  });

  it("detects a segment timing change", () => {
    const p = pair();
    after(p.cleanup);
    const seg = spawnCli(["segments", p.b]).json[0];
    spawnCli(["shift", p.b, seg.id, "+1s", "-q"]);
    const r = spawnCli(["diff", p.a, p.b]);
    const changed = r.json.segments.changed.find((c) => seg.id.startsWith(c.id) || c.id === seg.id);
    assert.ok(changed, "the shifted segment should appear in segments.changed");
    assert.ok(changed.fields.includes("start"));
  });

  it("detects an added material", () => {
    const p = pair();
    after(p.cleanup);
    const d = JSON.parse(readFileSync(p.b, "utf-8"));
    d.materials.texts.push({ id: "NEW_MAT" });
    writeFileSync(p.b, JSON.stringify(d, null, 2));
    const r = spawnCli(["diff", p.a, p.b]);
    assert.ok(r.json.materials.added.includes("NEW_MAT"));
  });
});
