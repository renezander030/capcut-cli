import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LINT_OPTIONS, fixDraft, lintDraft } from "../dist/lint.js";

function draftAt(start, duration) {
  return {
    fps: 30,
    duration: start + duration,
    canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
    materials: {
      videos: [{ id: "video", type: "video", path: "", duration: 1_000_000 }],
      audios: [],
      texts: [],
      speeds: [],
    },
    tracks: [
      {
        id: "track",
        type: "video",
        name: "main",
        attribute: 0,
        segments: [
          {
            id: "segment-off-grid",
            material_id: "video",
            target_timerange: { start, duration },
            source_timerange: { start: 0, duration },
            speed: 1,
            extra_material_refs: [],
          },
        ],
      },
    ],
  };
}

const opts = {
  ...DEFAULT_LINT_OPTIONS,
  checkLocalPaths: false,
  probeMedia: false,
  frameGrid: true,
};

describe("lint --frame-grid", () => {
  it("reports off-grid segment boundaries only when explicitly enabled", () => {
    const draft = draftAt(33_000, 33_667);
    assert.equal(
      lintDraft(draft, { ...opts, frameGrid: false }).filter((issue) => issue.code === "segment-off-frame-grid").length,
      0,
    );
    const issues = lintDraft(draft, opts).filter((issue) => issue.code === "segment-off-frame-grid");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].fixable, true);
  });

  it("does not tolerate a one-microsecond boundary drift", () => {
    const draft = draftAt(33_334, 33_333);
    assert.equal(lintDraft(draft, opts).filter((issue) => issue.code === "segment-off-frame-grid").length, 1);
  });

  it("snaps start and end together, then derives duration", () => {
    const draft = draftAt(33_000, 33_667); // end is already the two-frame boundary
    const result = fixDraft(draft, opts);
    const segment = draft.tracks[0].segments[0];
    assert.equal(segment.target_timerange.start, 33_333);
    assert.equal(segment.target_timerange.duration, 33_334);
    assert.equal(segment.source_timerange.duration, 33_334);
    assert.ok(result.fixed.some((issue) => issue.code === "segment-off-frame-grid"));
    assert.ok(!result.remaining.some((issue) => issue.code === "segment-off-frame-grid"));
  });

  it("keeps a root duration that followed the old timeline end in sync", () => {
    const draft = draftAt(33_000, 33_000);
    fixDraft(draft, opts);
    assert.equal(draft.duration, 66_667);
  });
});
