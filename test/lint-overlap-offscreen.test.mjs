import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LINT_OPTIONS, fixDraft, lintDraft } from "../dist/lint.js";

const opts = { ...DEFAULT_LINT_OPTIONS, checkLocalPaths: false, probeMedia: false };

function seg(id, materialId, start, duration, extra = {}) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start, duration },
    source_timerange: { start: 0, duration },
    speed: 1,
    volume: 1,
    visible: true,
    clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
    extra_material_refs: [],
    render_index: 0,
    ...extra,
  };
}

function draftWith(tracks, videos = [{ id: "v", type: "video", path: "", duration: 60_000_000 }]) {
  return {
    fps: 30,
    duration: 10_000_000,
    canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
    materials: {
      videos,
      audios: [{ id: "a", type: "extract_music", path: "", duration: 60_000_000 }],
      texts: [],
      speeds: [],
    },
    tracks,
  };
}

function track(type, name, segments) {
  return { id: name, type, name, attribute: 0, segments };
}

const codes = (issues, code) => issues.filter((i) => i.code === code);

describe("lint segment-overlap", () => {
  it("fixes a 1us rounding overlap between back-to-back clips", () => {
    const draft = draftWith([
      track("video", "main", [seg("clip-a", "v", 0, 2_000_001), seg("clip-b", "v", 2_000_000, 2_000_000)]),
    ]);
    const [issue] = codes(lintDraft(draft, opts), "segment-overlap");
    assert.equal(issue.severity, "error");
    assert.equal(issue.fixable, true);
    assert.equal(issue.location.segment_id, "clip-a");
    assert.match(issue.message, /clip-b/);
    assert.match(issue.message, /1us on video track "main"/);

    const result = fixDraft(draft, opts);
    assert.ok(result.fixed.some((i) => i.code === "segment-overlap"));
    assert.equal(codes(result.remaining, "segment-overlap").length, 0);
    const a = draft.tracks[0].segments[0];
    assert.equal(a.target_timerange.duration, 2_000_000);
    assert.equal(a.source_timerange.duration, 2_000_000);
    assert.equal(draft.tracks[0].segments[1].target_timerange.start, 2_000_000);
  });

  it("keeps the source span proportional to speed when shortening", () => {
    const fast = seg("fast", "v", 0, 1_000_010, { speed: 2, source_timerange: { start: 0, duration: 2_000_020 } });
    const draft = draftWith([track("video", "main", [fast, seg("next", "v", 1_000_000, 1_000_000)])]);
    fixDraft(draft, opts);
    assert.equal(fast.target_timerange.duration, 1_000_000);
    assert.equal(fast.source_timerange.duration, 2_000_000);
  });

  it("reports a 2s overlap on an audio track without fixing it", () => {
    const draft = draftWith([
      track("audio", "music", [seg("bed-a", "a", 0, 5_000_000), seg("bed-b", "a", 3_000_000, 4_000_000)]),
    ]);
    const [issue] = codes(lintDraft(draft, opts), "segment-overlap");
    assert.equal(issue.fixable, false);
    assert.match(issue.message, /2000000us on audio track "music"/);
    assert.match(issue.message, /--fix leaves it/);

    const result = fixDraft(draft, opts);
    assert.equal(codes(result.remaining, "segment-overlap").length, 1);
    assert.equal(draft.tracks[0].segments[0].target_timerange.duration, 5_000_000);
  });

  it("leaves text tracks to caption-overlap", () => {
    const draft = draftWith([
      track("text", "subs", [seg("cap-a", "t", 0, 2_000_001), seg("cap-b", "t", 2_000_000, 1_000_000)]),
    ]);
    const issues = lintDraft(draft, opts);
    assert.equal(codes(issues, "segment-overlap").length, 0);
    assert.equal(codes(issues, "caption-overlap").length, 1);
  });

  it("stays quiet on touching and gapped segments", () => {
    const draft = draftWith([
      track("sticker", "stickers", [seg("s1", "x", 0, 1_000_000), seg("s2", "x", 1_000_000, 1_000_000)]),
      track("effect", "fx", [seg("e1", "x", 0, 1_000_000), seg("e2", "x", 1_500_000, 1_000_000)]),
    ]);
    assert.equal(codes(lintDraft(draft, opts), "segment-overlap").length, 0);
  });
});

describe("lint segment-offscreen", () => {
  const clip = (over) => ({ alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, ...over });

  it("keeps an on-screen segment clean, including one partly off the edge", () => {
    const draft = draftWith([
      track("video", "main", [seg("centre", "v", 0, 1_000_000)]),
      track("video", "pip", [
        seg("corner", "v", 0, 1_000_000, { clip: clip({ scale: { x: 0.3, y: 0.3 }, transform: { x: 1.2, y: 0.9 } }) }),
      ]),
      track("text", "subs", [seg("caption", "t", 0, 1_000_000, { clip: clip({ transform: { x: 0, y: -0.8 } }) })]),
    ]);
    assert.equal(codes(lintDraft(draft, opts), "segment-offscreen").length, 0);
  });

  it("flags a clip whose box sits entirely outside the canvas", () => {
    // 0.3 scale on a 1920-wide canvas: box half-width is 0.3 canvas
    // half-widths, so the clip leaves the canvas once |x| >= 1.3.
    const draft = draftWith([
      track("video", "pip", [
        seg("gone", "v", 0, 1_000_000, { clip: clip({ scale: { x: 0.3, y: 0.3 }, transform: { x: 1.35, y: 0 } }) }),
      ]),
    ]);
    const [issue] = codes(lintDraft(draft, opts), "segment-offscreen");
    assert.equal(issue.severity, "warning");
    assert.equal(issue.fixable, false);
    assert.equal(issue.location.segment_id, "gone");
    assert.match(issue.message, /outside canvas/);
  });

  it("uses the material size: a portrait clip on a landscape canvas leaves sooner", () => {
    // 1080x1920 fitted into 1920x1080 is 607.5px wide (0.316 of the canvas),
    // so at x = 1.5 it is fully off; a canvas-filling assumption would not be.
    const videos = [{ id: "portrait", type: "video", path: "", duration: 60_000_000, width: 1080, height: 1920 }];
    const draft = draftWith(
      [track("video", "pip", [seg("tall", "portrait", 0, 1_000_000, { clip: clip({ transform: { x: 1.5, y: 0 } }) })])],
      videos,
    );
    assert.match(codes(lintDraft(draft, opts), "segment-offscreen")[0].message, /outside canvas/);
    // Same position with unknown size: assumed to fill the canvas, still visible.
    const unknown = draftWith([
      track("video", "pip", [seg("tall", "v", 0, 1_000_000, { clip: clip({ transform: { x: 1.5, y: 0 } }) })]),
    ]);
    assert.equal(codes(lintDraft(unknown, opts), "segment-offscreen").length, 0);
  });

  it("flags zero scale and zero opacity", () => {
    const draft = draftWith([
      track("sticker", "stickers", [
        seg("flat", "x", 0, 1_000_000, { clip: clip({ scale: { x: 1, y: 0 } }) }),
        seg("clear", "x", 1_000_000, 1_000_000, { clip: clip({ alpha: 0 }) }),
      ]),
    ]);
    const issues = codes(lintDraft(draft, opts), "segment-offscreen");
    assert.equal(issues.length, 2);
    assert.match(issues.find((i) => i.location.segment_id === "flat").message, /zero scale/);
    assert.match(issues.find((i) => i.location.segment_id === "clear").message, /zero opacity/);
  });

  it("skips a reason whose property is keyframed", () => {
    const keyframes = (type) => [{ id: "k", property_type: type, keyframe_list: [{ id: "k1", time_offset: 0 }] }];
    const draft = draftWith([
      track("video", "pip", [
        seg("fade-in", "v", 0, 1_000_000, { clip: clip({ alpha: 0 }), common_keyframes: keyframes("KFTypeAlpha") }),
        seg("slide-in", "v", 1_000_000, 1_000_000, {
          clip: clip({ transform: { x: 3, y: 0 } }),
          common_keyframes: keyframes("KFTypePositionX"),
        }),
      ]),
    ]);
    assert.equal(codes(lintDraft(draft, opts), "segment-offscreen").length, 0);
  });

  it("ignores audio tracks", () => {
    const draft = draftWith([track("audio", "music", [seg("bed", "a", 0, 1_000_000, { clip: clip({ alpha: 0 }) })])]);
    assert.equal(codes(lintDraft(draft, opts), "segment-offscreen").length, 0);
  });
});
