import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// A draft built the way the PIP + local-mask workflow (discussion #43,
// issues #44/#77/#78) builds one: a main video track, a duplicate on an upper
// video track carrying the mask and the transform keyframes.
function pipDraft(dir, { orphanMask = false, missingMedia = false } = {}) {
  const mediaPath = join(dir, missingMedia ? "gone.mp4" : "clip.mp4");
  if (!missingMedia) writeFileSync(join(dir, "clip.mp4"), "stub");
  const segBase = {
    target_timerange: { start: 0, duration: 1_000_000 },
    source_timerange: { start: 0, duration: 1_000_000 },
  };
  return {
    id: "guid-pip",
    name: "pip-draft",
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
        segments: [{ ...segBase, id: "SEG-MAIN", material_id: "V1" }],
      },
      {
        id: "T-pip",
        type: "video",
        name: "video-pip",
        attribute: 0,
        segments: [
          {
            ...segBase,
            id: "SEG-PIP",
            material_id: "V2",
            extra_material_refs: orphanMask ? [] : ["MASK-1"],
            common_keyframes: [
              {
                id: "KFL-1",
                property_type: "KFTypePositionX",
                keyframe_list: [
                  { id: "KF-1", time_offset: 0, values: [0] },
                  { id: "KF-2", time_offset: 500_000, values: [0.4] },
                ],
              },
            ],
          },
        ],
      },
    ],
    materials: {
      videos: [
        { id: "V1", type: "video", path: mediaPath, duration: 1_000_000 },
        { id: "V2", type: "video", path: mediaPath, duration: 1_000_000 },
      ],
      texts: [],
      speeds: [],
      common_mask: [{ id: "MASK-1", type: "mask", resource_type: "circle", name: "circle" }],
    },
  };
}

function fixture(opts) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-lint-pip-"));
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(pipDraft(dir, opts), null, 2));
  return { dir, path: join(dir, "draft_content.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("lint --pip (issue #78)", () => {
  it("counts overlays, overlay keyframes and attached masks on a known layout", () => {
    const f = fixture();
    after(f.cleanup);
    const r = spawnCli(["lint", f.path, "--pip", "--no-probe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.pip_report, {
      overlays: 1,
      overlay_keyframes: 2,
      masks_attached: 1,
      masks_orphaned: 0,
      missing_media: [],
    });
    assert.ok(!r.json.issues.some((i) => i.code === "mask-orphaned"));
  });

  it("fails the exit code and reports the mask when it never got attached", () => {
    const f = fixture({ orphanMask: true });
    after(f.cleanup);
    const r = spawnCli(["lint", f.path, "--pip", "--no-probe"]);
    assert.equal(r.status, 1, `an orphaned mask is a warning and must fail CI — stderr: ${r.stderr}`);
    assert.equal(r.json.pip_report.masks_orphaned, 1);
    assert.equal(r.json.pip_report.masks_attached, 0);
    const issue = r.json.issues.find((i) => i.code === "mask-orphaned");
    assert.ok(issue, "the orphaned mask must be a loud issue, not only a count");
    assert.equal(issue.severity, "warning");
    assert.equal(issue.location.material_id, "MASK-1");
    assert.match(issue.message, /capcut mask /);
  });

  it("reports missing media by path, not just as a count", () => {
    const f = fixture({ missingMedia: true });
    after(f.cleanup);
    const r = spawnCli(["lint", f.path, "--pip", "--no-probe"]);
    assert.equal(r.status, 2, "missing media is an error");
    assert.equal(r.json.pip_report.missing_media.length, 1);
    assert.match(r.json.pip_report.missing_media[0], /gone\.mp4$/);
  });

  it("without --pip the report is absent and no mask-orphaned issue fires", () => {
    const f = fixture({ orphanMask: true });
    after(f.cleanup);
    const r = spawnCli(["lint", f.path, "--no-probe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.pip_report, undefined);
    assert.ok(!r.json.issues.some((i) => i.code === "mask-orphaned"));
  });

  it("-H prints the report line for humans", () => {
    const f = fixture();
    after(f.cleanup);
    const r = spawnCli(["lint", f.path, "--pip", "--no-probe", "-H"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /pip: 1 overlay\(s\) · 2 overlay keyframe\(s\) · 1 mask\(s\) attached · 0 orphaned/);
  });
});
