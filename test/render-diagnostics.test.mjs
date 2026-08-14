import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftToOtio } from "../dist/interchange.js";
import { explainFfmpegFailure } from "../dist/render.js";
import { framesFor } from "../dist/time.js";

const US = 1_000_000;

describe("explainFfmpegFailure", () => {
  it("names a missing decoder, the AV1/HEVC case users actually hit", () => {
    const hint = explainFfmpegFailure("[av1 @ 0x55] Unknown decoder 'libdav1d'\nConversion failed!");
    assert.match(hint, /no decoder for 'libdav1d'/);
    assert.match(hint, /AV1\/HEVC/);
  });

  it("recognises the other spelling ffmpeg uses for the same failure", () => {
    const hint = explainFfmpegFailure("Decoder (codec hevc) not found for input stream #0:0");
    assert.match(hint, /no decoder for 'hevc'/);
  });

  it("names a missing encoder and points at doctor", () => {
    const hint = explainFfmpegFailure("Unknown encoder 'libx264'");
    assert.match(hint, /no 'libx264' encoder/);
    assert.match(hint, /capcut doctor/);
  });

  it("names a missing filter and the flags that need it", () => {
    const hint = explainFfmpegFailure("No such filter: 'drawtext'");
    assert.match(hint, /'drawtext'/);
    assert.match(hint, /--burn-captions/);
  });

  it("explains a truncated container", () => {
    assert.match(explainFfmpegFailure("moov atom not found"), /truncated/);
    assert.match(explainFfmpegFailure("Invalid data found when processing input"), /truncated/);
  });

  it("points a missing input at relink", () => {
    const hint = explainFfmpegFailure("clip1.mp4: No such file or directory");
    assert.match(hint, /capcut relink/);
  });

  it("returns an empty string rather than inventing a hint it cannot support", () => {
    assert.equal(explainFfmpegFailure("some future ffmpeg diagnostic nobody has seen"), "");
    assert.equal(explainFfmpegFailure(""), "");
  });
});

describe("draftToOtio frame grid (#82)", () => {
  const draft = (segments) => ({
    fps: 30,
    duration: 10 * US,
    canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
    materials: {
      texts: [],
      videos: [{ id: "vid-1", path: "/tmp/clip.mp4", duration: 10 * US }],
      audios: [],
      speeds: [],
    },
    tracks: [{ id: "v", type: "video", name: "main", attribute: 0, segments }],
  });
  const seg = (id, startUs, durationUs) => ({
    id,
    material_id: "vid-1",
    speed: 1,
    target_timerange: { start: startUs, duration: durationUs },
    source_timerange: { start: 0, duration: durationUs },
    extra_material_refs: [],
  });

  it("never exports a positive-duration clip as zero frames", () => {
    // 10ms at 30fps is 0.3 of a frame. The old local rounding produced a
    // zero-length OTIO clip, which an NLE either drops or refuses outright.
    const { doc } = draftToOtio(draft([seg("tiny-1-aaa-bbbb-cccc-dddddddddddd", 0, 10_000)]));
    const clips = JSON.stringify(doc).match(/"duration":\s*\{[^}]*"value":\s*(-?\d+(\.\d+)?)/g) ?? [];
    assert.ok(clips.length > 0, "the export must contain at least one duration");
    const values = clips.map((c) => Number(c.match(/"value":\s*(-?\d+(\.\d+)?)/)[1]));
    assert.ok(
      values.every((v) => v !== 0),
      `a sub-half-frame clip must not round to zero frames: ${JSON.stringify(values)}`,
    );
  });

  it("agrees with time.ts framesFor, which is now the single frame grid", () => {
    assert.equal(framesFor(10_000, 30), 1, "a positive duration keeps at least one frame");
    assert.equal(framesFor(1 * US, 30), 30);
    assert.equal(framesFor(0, 30), 0);
    // Object.is distinguishes -0, which node:assert/strict compares with.
    assert.ok(Object.is(framesFor(-100, 30), 0), "a near-zero negative must be plain 0, never -0");
  });

  it("serialises no negative zero, which is what -0 would leak into the JSON", () => {
    const { doc } = draftToOtio(draft([seg("neg-1-aaaa-bbbb-cccc-dddddddddddd", 0, 1 * US)]));
    assert.ok(!JSON.stringify(doc).includes("-0,"), "OTIO JSON must not carry -0 values");
  });

  it("still rounds ordinary durations to the expected frame count", () => {
    const { doc, stats } = draftToOtio(draft([seg("ok-1-aaaaa-bbbb-cccc-dddddddddddd", 0, 2 * US)]));
    assert.equal(stats.clips, 1);
    assert.ok(
      JSON.stringify(doc).includes('"value": 60') || JSON.stringify(doc).includes('"value":60'),
      "2s at 30fps = 60 frames",
    );
  });
});
