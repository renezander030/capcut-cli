import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// Minimal draft referencing one local media file that exists inside the draft
// dir — the pyCapCut#13 situation is about the SIDECAR, not the media itself.
function draft(dir, { withMedia = true } = {}) {
  if (withMedia) writeFileSync(join(dir, "clip.mp4"), "stub");
  return {
    id: "guid-meta",
    name: "meta-draft",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "8.7.0", os: "windows" },
    tracks: [
      {
        id: "T-main",
        type: "video",
        name: "video",
        attribute: 0,
        segments: withMedia
          ? [
              {
                id: "SEG-1",
                material_id: "V1",
                target_timerange: { start: 0, duration: 1_000_000 },
                source_timerange: { start: 0, duration: 1_000_000 },
              },
            ]
          : [],
      },
    ],
    materials: {
      videos: withMedia ? [{ id: "V1", type: "video", path: join(dir, "clip.mp4"), duration: 1_000_000 }] : [],
      texts: [],
      speeds: [],
    },
  };
}

function fixture({ meta, withMedia = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-lint-meta-"));
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(draft(dir, { withMedia }), null, 2));
  if (meta !== undefined) writeFileSync(join(dir, "draft_meta_info.json"), JSON.stringify(meta, null, 2));
  return { dir, path: join(dir, "draft_content.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("lint media-unregistered (pyCapCut#13, observe-only)", () => {
  it("fires as info when draft_materials registers nothing, without failing the exit code", () => {
    const f = fixture({ meta: { draft_materials: [] } });
    after(f.cleanup);
    const r = spawnCli(["lint", f.path, "--no-probe"]);
    assert.equal(r.status, 0, `info severity must never fail CI — stderr: ${r.stderr}`);
    const issue = r.json.issues.find((i) => i.code === "media-unregistered");
    assert.ok(issue, "the empty sidecar must be surfaced");
    assert.equal(issue.severity, "info");
    assert.equal(issue.fixable, false, "the registration write is deliberately out of scope");
    assert.match(issue.suggested_command, /capcut fixture/);
  });

  it("stays silent when draft_materials is not provably empty", () => {
    const f = fixture({ meta: { draft_materials: [{ type: 0, value: [{ id: "m1" }] }] } });
    after(f.cleanup);
    const r = spawnCli(["lint", f.path, "--no-probe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!r.json.issues.some((i) => i.code === "media-unregistered"));
  });

  it("stays silent when there is no draft_meta_info.json at all (diagnose's finding, not lint's)", () => {
    const f = fixture({});
    after(f.cleanup);
    const r = spawnCli(["lint", f.path, "--no-probe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!r.json.issues.some((i) => i.code === "media-unregistered"));
  });

  it("fires on a sidecar that carries no draft_materials key", () => {
    const f = fixture({ meta: { other_key: 1 } });
    after(f.cleanup);
    const r = spawnCli(["lint", f.path, "--no-probe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const issue = r.json.issues.find((i) => i.code === "media-unregistered");
    assert.ok(issue);
    assert.match(issue.message, /no `draft_materials` key/);
  });

  it("never fires when the timeline references no local media", () => {
    const f = fixture({ meta: { draft_materials: [] }, withMedia: false });
    after(f.cleanup);
    const r = spawnCli(["lint", f.path, "--no-probe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!r.json.issues.some((i) => i.code === "media-unregistered"));
  });
});
