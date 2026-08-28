import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// A draft far beyond the registry's version evidence: the write-time version
// boundary must refuse it.
function beyondRangeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-gate-ids-"));
  const draft = {
    id: "guid-gate",
    name: "gate-draft",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "99.9.9", os: "windows" },
    tracks: [],
    materials: { videos: [], audios: [], texts: [], speeds: [] },
  };
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(draft, null, 2));
  return { dir, path: join(dir, "draft_content.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("write-refusal gate ids (issue #50 side finding)", () => {
  it("the version boundary names its gate, so a pasted stderr line is unambiguous", () => {
    const f = beyondRangeFixture();
    after(f.cleanup);
    const before = readFileSync(f.path, "utf-8");

    const r = spawnCli(["add-text", f.path, "0", "1s", "hello"]);
    assert.notEqual(r.status, 0, "a beyond-range draft must refuse the write");
    assert.match(r.stderr, /refused \[version-boundary\]/);
    assert.ok(!r.stderr.includes("[editor-open]"), "only the gate that fired may be named");
    assert.equal(readFileSync(f.path, "utf-8"), before, "refusal must not write");
  });
});
