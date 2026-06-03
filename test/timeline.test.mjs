import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("timeline", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("JSON default returns lanes with computed columns", () => {
    const r = spawnCli(["timeline", fix.path]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(Array.isArray(r.json.tracks) && r.json.tracks.length > 0);
    assert.equal(r.json.cols, 60);
    for (const t of r.json.tracks) {
      assert.ok(typeof t.type === "string");
      for (const s of t.segments) {
        assert.ok(Number.isInteger(s.col_start) && Number.isInteger(s.col_end));
        assert.ok(s.col_end > s.col_start, "every segment must occupy at least one column");
        assert.ok(s.col_end <= r.json.cols);
      }
    }
  });

  it("respects --cols", () => {
    const r = spawnCli(["timeline", fix.path, "--cols", "20"]);
    assert.equal(r.json.cols, 20);
    for (const t of r.json.tracks) for (const s of t.segments) assert.ok(s.col_end <= 20);
  });

  it("-H renders ASCII bars with one row per track", () => {
    const r = spawnCli(["timeline", fix.path, "-H"]);
    assert.equal(r.status, 0);
    const rows = r.stdout.trimEnd().split("\n");
    assert.equal(rows.length, 3, "fixture has 3 tracks");
    assert.match(r.stdout, /█/, "should contain bar characters");
    assert.match(rows[0], /video/);
  });
});
