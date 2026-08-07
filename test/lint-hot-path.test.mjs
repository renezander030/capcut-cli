import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LINT_OPTIONS, fixDraft, lintDraft } from "../dist/lint.js";

function seg(id, materialId, refs = []) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start: 0, duration: 1_000_000 },
    source_timerange: { start: 0, duration: 1_000_000 },
    speed: 1,
    volume: 1,
    visible: true,
    clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
    extra_material_refs: refs,
    render_index: 0,
  };
}

function draftWith(materials, segments) {
  return {
    id: "hot-path",
    name: "hot-path",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "original" },
    materials: { videos: [], audios: [], texts: [], speeds: [], ...materials },
    tracks: [{ id: "t1", type: "video", name: "video", attribute: 0, segments }],
  };
}

// The material-id lookup lint does per segment and per companion ref is served
// from one precomputed set. These lock the set to the same membership rule the
// per-reference scan had: ANY materials.* array, string ids only.
describe("lint material-id resolution", () => {
  it("resolves a segment's material from a non-standard materials.* array", () => {
    const draft = draftWith({ house_made_widgets: [{ id: "widget-1", type: "widget" }] }, [seg("s1", "widget-1")]);
    const issues = lintDraft(draft, { ...DEFAULT_LINT_OPTIONS, checkLocalPaths: false });
    assert.equal(
      issues.filter((i) => i.code === "missing-material").length,
      0,
      `a material in materials.house_made_widgets must resolve: ${JSON.stringify(issues)}`,
    );
  });

  it("still flags a reference no materials array holds", () => {
    const draft = draftWith({ house_made_widgets: [{ id: "widget-1", type: "widget" }] }, [seg("s1", "widget-2")]);
    const issues = lintDraft(draft, { ...DEFAULT_LINT_OPTIONS, checkLocalPaths: false });
    const hit = issues.find((i) => i.code === "missing-material");
    assert.ok(hit, JSON.stringify(issues));
    assert.equal(hit.location.material_id, "widget-2");
  });

  it("never resolves against a material whose id is not a string", () => {
    const draft = draftWith({ videos: [{ id: 7, type: "video" }] }, [seg("s1", "7")]);
    const issues = lintDraft(draft, { ...DEFAULT_LINT_OPTIONS, checkLocalPaths: false });
    assert.ok(
      issues.some((i) => i.code === "missing-material"),
      `a numeric id must not answer a string lookup: ${JSON.stringify(issues)}`,
    );
  });

  it("resolves companion refs across arrays and drops only the unresolvable one under --fix", () => {
    const draft = draftWith(
      { speeds: [{ id: "speed-1", speed: 1 }], canvases: [{ id: "canvas-1", type: "canvas_color" }] },
      [seg("s1", "speed-1", ["canvas-1", "ghost", "speed-1"])],
    );
    const issues = lintDraft(draft, { ...DEFAULT_LINT_OPTIONS, checkLocalPaths: false });
    const dangling = issues.filter((i) => i.code === "dangling-companion-ref");
    assert.equal(dangling.length, 1, JSON.stringify(issues));
    assert.equal(dangling[0].location.material_id, "ghost");

    fixDraft(draft, { ...DEFAULT_LINT_OPTIONS, checkLocalPaths: false });
    assert.deepEqual(draft.tracks[0].segments[0].extra_material_refs, ["canvas-1", "speed-1"]);
  });
});
