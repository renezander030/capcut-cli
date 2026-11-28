import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createCompanionMaterials, registerCompanions, removeSegment } from "../dist/factory.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const US = 1000000;
const segment = (id, material, start, end) => ({
  id,
  material_id: material,
  target_timerange: { start: start * US, duration: (end - start) * US },
  source_timerange: { start: 0, duration: (end - start) * US },
  speed: 1,
  volume: 1,
  visible: true,
  clip: null,
  extra_material_refs: [],
  render_index: 0,
});
function fixture(t) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const draft = JSON.parse(readFileSync(fix.path, "utf8"));
  draft.duration = 6 * US;
  draft.materials.videos = ["head", "cut", "tail"].map((id) => ({
    id: `m-${id}`,
    type: "video",
    path: `/example/${id}.mp4`,
  }));
  const caption = [
    ["before", 0, 1],
    ["left", 1, 3],
    ["inside", 2.5, 3.5],
    ["cover", 1, 5],
    ["right", 3, 5],
    ["after", 5, 6],
  ];
  draft.materials.texts = caption.map(([id]) => ({
    id: `m-${id}`,
    type: "text",
    content: JSON.stringify({ text: id, styles: [] }),
  }));
  draft.tracks = [
    {
      id: "video",
      type: "video",
      name: "video",
      attribute: 0,
      segments: [segment("head", "m-head", 0, 2), segment("cut", "m-cut", 2, 4), segment("tail", "m-tail", 4, 6)],
    },
    {
      id: "captions",
      type: "text",
      name: "captions",
      attribute: 0,
      segments: caption.map(([id, start, end]) => segment(id, `m-${id}`, start, end)),
    },
  ];
  return { ...fix, draft };
}
const options = { ripple: true, rippleCaptions: true };

describe("explicit caption-aware ripple", () => {
  it("maps crossing caption endpoints, drops contained cues, shifts later content and preserves surviving text", (t) => {
    const { draft } = fixture(t);
    const content = new Map(draft.materials.texts.map((material) => [material.id, material.content]));
    const result = removeSegment(draft, "cut", options);
    assert.equal(draft.duration, 4 * US);
    assert.equal(result.rippleShifted, 2);
    assert.deepEqual(result.captionAdjustments, { trimmed: 3, dropped: 1, retained_text_unchanged: true });
    assert.deepEqual(
      draft.tracks[1].segments.map((item) => [
        item.id,
        item.target_timerange.start / US,
        item.target_timerange.duration / US,
      ]),
      [
        ["before", 0, 1],
        ["left", 1, 1],
        ["cover", 1, 2],
        ["right", 2, 1],
        ["after", 3, 1],
      ],
    );
    for (const material of draft.materials.texts) assert.equal(material.content, content.get(material.id));
    assert.equal(
      draft.materials.texts.some((material) => material.id === "m-inside"),
      false,
    );
    assert.equal(draft.tracks[0].segments[1].source_timerange.start, 0);
  });

  it("keeps the default crossing-caption refusal and leaves the draft unchanged", (t) => {
    const { draft } = fixture(t);
    const before = structuredClone(draft);
    assert.throws(() => removeSegment(draft, "cut", { ripple: true }), /crosses .* other segment/);
    assert.deepEqual(draft, before);
  });

  for (const type of ["audio", "video"]) {
    it(`keeps a crossing ${type} blocker atomic even when captions could be adjusted`, (t) => {
      const { draft } = fixture(t);
      draft.tracks.push({ id: "blocker", type, name: type, segments: [segment("blocker", "blocker-material", 1, 5)] });
      const before = structuredClone(draft);
      assert.throws(() => removeSegment(draft, "cut", options), /crosses .*blocker/);
      assert.deepEqual(draft, before);
    });
  }

  it("requires ripple before changing any data", (t) => {
    const { draft } = fixture(t);
    const before = structuredClone(draft);
    assert.throws(() => removeSegment(draft, "cut", { rippleCaptions: true }), /requires --ripple/);
    assert.deepEqual(draft, before);
  });

  for (const kind of ["keyframes", "companions"]) {
    it(`refuses to slice a crossing caption with ${kind}`, (t) => {
      const { draft } = fixture(t);
      const caption = draft.tracks[1].segments.find((item) => item.id === "cover");
      if (kind === "keyframes") caption.common_keyframes = [{ keyframe_list: [{ time_offset: US }] }];
      else caption.extra_material_refs = ["caption-resource"];
      const before = structuredClone(draft);
      assert.throws(() => removeSegment(draft, "cut", options), /crosses .*cover/);
      assert.deepEqual(draft, before);
    });
  }

  it("can drop an entire contained caption with companions without slicing its timing", (t) => {
    const { draft } = fixture(t);
    draft.tracks[1].segments = [draft.tracks[1].segments.find((item) => item.id === "inside")];
    draft.tracks[1].segments[0].extra_material_refs = ["caption-resource"];
    const result = removeSegment(draft, "cut", options);
    assert.equal(result.captionAdjustments.dropped, 1);
    assert.deepEqual(draft.tracks.find((track) => track.id === "captions").segments, []);
  });

  it("updates static caption source durations and honors keep-materials", (t) => {
    const { draft } = fixture(t);
    removeSegment(draft, "cut", { ...options, keepMaterials: true });
    const left = draft.tracks[1].segments.find((item) => item.id === "left");
    assert.equal(left.source_timerange.duration, US);
    assert.equal(
      draft.materials.texts.some((material) => material.id === "m-inside"),
      true,
    );
  });

  it("the CLI refuses an uncoupled flag without touching the saved draft", (t) => {
    const fix = fixture(t);
    writeFileSync(fix.path, JSON.stringify(fix.draft));
    const before = readFileSync(fix.path);
    const result = spawnCli(["remove", fix.path, "cut", "--ripple-captions"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires --ripple/);
    assert.deepEqual(readFileSync(fix.path), before);
  });

  it("adjusts imported captions with the factory's neutral companions", (t) => {
    const { draft } = fixture(t);
    const caption = draft.tracks[1].segments.find((item) => item.id === "cover");
    const companions = createCompanionMaterials("text");
    registerCompanions(draft, companions);
    caption.extra_material_refs = companions.ids;
    removeSegment(draft, "cut", options);
    assert.equal(caption.target_timerange.duration, 2 * US);
    assert.deepEqual(caption.extra_material_refs, companions.ids);
  });

  for (const changed of ["speed", "unknown", "keyframe-ref"]) {
    it(`refuses changed imported caption companions: ${changed}`, (t) => {
      const { draft } = fixture(t);
      const caption = draft.tracks[1].segments.find((item) => item.id === "cover");
      const companions = createCompanionMaterials("text");
      registerCompanions(draft, companions);
      caption.extra_material_refs = companions.ids;
      if (changed === "speed") draft.materials.speeds.find((item) => item.id === companions.ids[0]).speed = 2;
      if (changed === "unknown") draft.materials.speeds.find((item) => item.id === companions.ids[0]).surprise = true;
      if (changed === "keyframe-ref") caption.keyframe_refs = ["animated"];
      const before = structuredClone(draft);
      assert.throws(() => removeSegment(draft, "cut", options), /crosses .*cover/);
      assert.deepEqual(draft, before);
    });
  }

  it("retains a static caption's speed factor on its source clock", (t) => {
    const { draft } = fixture(t);
    const caption = draft.tracks[1].segments.find((item) => item.id === "left");
    caption.speed = 2;
    caption.source_timerange.duration *= 2;
    removeSegment(draft, "cut", options);
    assert.equal(caption.target_timerange.duration, US);
    assert.equal(caption.source_timerange.duration, 2 * US);
  });
});
