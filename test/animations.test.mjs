import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addImageAnim, addTextAnim } from "../dist/decorators.js";

const US = 1_000_000;
function draft(duration = 4 * US) {
  return {
    tracks: [
      {
        id: "t",
        type: "video",
        segments: [{ id: "s1", target_timerange: { start: 0, duration }, extra_material_refs: [] }],
      },
    ],
    materials: {},
  };
}
const ENTRY_KEYS = [
  "anim_adjust_params",
  "category_id",
  "category_name",
  "duration",
  "id",
  "material_type",
  "name",
  "panel",
  "path",
  "platform",
  "request_id",
  "resource_id",
  "source_platform",
  "start",
  "third_resource_id",
  "type",
];

describe("animations — addImageAnim / addTextAnim", () => {
  it("writes image animations into one container, outros anchored to the segment end", () => {
    const d = draft();
    const r = addImageAnim(d, "s1", {
      intro: "fade-in",
      outro: "rgb-scanlines",
      combo: "stretch-and-distort",
      comboDurationUs: 2 * US,
    });
    assert.equal(d.materials.material_animations.length, 1);
    const [container] = d.materials.material_animations;
    assert.deepEqual(d.tracks[0].segments[0].extra_material_refs, [container.id]);
    assert.equal(r.material_id, container.id);
    assert.deepEqual(
      r.added.map((a) => [a.type, a.start_us, a.duration_us]),
      [
        ["in", 0, 500_000],
        ["out", 3 * US, US],
        ["group", 0, 2 * US],
      ],
    );
    for (const entry of container.animations) {
      assert.deepEqual(Object.keys(entry), ENTRY_KEYS);
      assert.equal(entry.material_type, "video");
      assert.equal(entry.panel, "video");
      assert.equal(entry.platform, "all");
      assert.equal(entry.source_platform, 1);
    }
  });

  it("writes text animations with the text panel shape", () => {
    const d = draft();
    const r = addTextAnim(d, "s1", { intro: "typewriter", outro: "blur", outroDurationUs: 800_000 });
    const entries = d.materials.material_animations[0].animations;
    assert.deepEqual(
      entries.map((e) => [e.type, e.category_id, e.material_type, e.panel, e.path, e.third_resource_id]),
      [
        ["in", "in_fav", "text", "", "", ""],
        ["out", "out_fav", "text", "", "", ""],
      ],
    );
    assert.equal(r.added[1].start_us, 4 * US - 800_000);
    for (const entry of entries) assert.deepEqual(Object.keys(entry), ENTRY_KEYS);
  });

  it("holds one animation per slot and refuses durations longer than the segment", () => {
    const d = draft();
    addImageAnim(d, "s1", { intro: "fade-in" });
    assert.throws(() => addImageAnim(d, "s1", { intro: "zoom-1" }), {
      message: "segment already has a in video animation",
    });
    assert.throws(() => addTextAnim(d, "s1", { intro: "typewriter" }), {
      message: "segment already has a in text animation",
    });
    assert.throws(() => addTextAnim(draft(), "s1", { intro: "typewriter", introDurationUs: 4 * US + 1 }), {
      message: "duration (4000001us) exceeds segment duration (4000000us)",
    });
  });

  it("names the catalogue to list on an unknown slug", () => {
    assert.throws(() => addImageAnim(draft(), "s1", { combo: "nope" }, "jianying"), {
      message: "Unknown image group animation: nope. Run 'capcut enums --image-combos --jianying' for the full list.",
    });
    assert.throws(() => addTextAnim(draft(), "s1", { outro: "nope" }), {
      message: "Unknown text outro: nope. Run 'capcut enums --text-outros' for the full list.",
    });
  });
});
