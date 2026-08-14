import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { keyframeProperties, keyframePropertyTypes } from "../dist/decorators.js";
import { DEFAULT_LINT_OPTIONS, lintDraft } from "../dist/lint.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const US = 1_000_000;

// Minimal in-memory draft. lintDraft is pure over a Draft object, so these
// rules are asserted without spawning the CLI or touching disk.
function draftWith({ canvas = { width: 1920, height: 1080, ratio: "16:9" }, texts = [], tracks = [] } = {}) {
  return {
    fps: 30,
    duration: 10 * US,
    canvas_config: canvas,
    materials: { texts, videos: [], audios: [], speeds: [], texts_ranges: [] },
    tracks,
  };
}

function textMaterial(id, text) {
  return { id, type: "text", content: JSON.stringify({ text, styles: [] }) };
}

function textSegment(id, materialId, startUs, durationUs, transform) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start: startUs, duration: durationUs },
    source_timerange: { start: 0, duration: durationUs },
    speed: 1,
    extra_material_refs: [],
    ...(transform ? { clip: { alpha: 1, scale: { x: 1, y: 1 }, transform } } : {}),
  };
}

function textTrack(segments) {
  return { id: "text-track", type: "text", name: "captions", attribute: 0, segments };
}

const lint = (draft, opts = {}) =>
  lintDraft(draft, { ...DEFAULT_LINT_OPTIONS, checkLocalPaths: false, probeMedia: false, ...opts });
const codes = (issues, code) => issues.filter((i) => i.code === code);

describe("caption reading speed (caption-too-fast)", () => {
  it("flags a caption whose characters go by faster than the ceiling", () => {
    // 45 visible characters in 1.2s = 37.5 chars/s, well past the default 20 —
    // and under the 7s cue-too-long cap, so no existing rule sees it.
    const text = "a".repeat(45);
    const draft = draftWith({
      texts: [textMaterial("m1", text)],
      tracks: [textTrack([textSegment("cap-1-aaaa-bbbb-cccc-dddddddddddd", "m1", 0, 1_200_000)])],
    });
    const issues = lint(draft);
    assert.equal(codes(issues, "cue-too-long").length, 0, "the absolute-duration rule must stay silent");
    const fast = codes(issues, "caption-too-fast");
    assert.equal(fast.length, 1, `expected one caption-too-fast; got ${JSON.stringify(issues)}`);
    assert.equal(fast[0].severity, "warning");
    assert.equal(fast[0].fixable, false, "more screen time or fewer words is an authoring decision");
    assert.match(fast[0].message, /37\.5 chars\/s/);
    assert.ok(fast[0].suggested_command.includes("cap-1"), "names the segment to retime");
  });

  it("stays silent at a comfortable reading speed", () => {
    const draft = draftWith({
      texts: [textMaterial("m1", "a short caption")],
      tracks: [textTrack([textSegment("cap-2-aaaa-bbbb-cccc-dddddddddddd", "m1", 0, 3 * US)])],
    });
    assert.equal(codes(lint(draft), "caption-too-fast").length, 0);
  });

  it("does not count whitespace as read characters", () => {
    // 20 letters + 19 spaces over 1.2s. Counting whitespace would put this at
    // 32 chars/s and flag it; counting only visible characters keeps it at ~16.
    const text = "a ".repeat(20).trim();
    const draft = draftWith({
      texts: [textMaterial("m1", text)],
      tracks: [textTrack([textSegment("cap-3-aaaa-bbbb-cccc-dddddddddddd", "m1", 0, 1_200_000)])],
    });
    assert.equal(codes(lint(draft), "caption-too-fast").length, 0);
  });

  it("is disabled by maxCharsPerSecond: 0", () => {
    const draft = draftWith({
      texts: [textMaterial("m1", "a".repeat(45))],
      tracks: [textTrack([textSegment("cap-4-aaaa-bbbb-cccc-dddddddddddd", "m1", 0, 1_200_000)])],
    });
    assert.equal(codes(lint(draft, { maxCharsPerSecond: 0 }), "caption-too-fast").length, 0);
  });
});

describe("vertical safe area (caption-outside-safe-area)", () => {
  const vertical = { width: 1080, height: 1920, ratio: "9:16" };

  it("flags a caption parked near the bottom edge of a 9:16 canvas", () => {
    const draft = draftWith({
      canvas: vertical,
      texts: [textMaterial("m1", "hi")],
      tracks: [textTrack([textSegment("safe-1-aaa-bbbb-cccc-dddddddddddd", "m1", 0, 2 * US, { x: 0, y: -0.93 })])],
    });
    const found = codes(lint(draft), "caption-outside-safe-area");
    assert.equal(found.length, 1, `expected one safe-area issue; got ${JSON.stringify(lint(draft))}`);
    assert.match(found[0].message, /1080x1920/);
    assert.equal(found[0].fixable, false);
  });

  it("flags the top edge too — both bands carry platform UI", () => {
    const draft = draftWith({
      canvas: vertical,
      texts: [textMaterial("m1", "hi")],
      tracks: [textTrack([textSegment("safe-2-aaa-bbbb-cccc-dddddddddddd", "m1", 0, 2 * US, { x: 0, y: 0.93 })])],
    });
    assert.equal(codes(lint(draft), "caption-outside-safe-area").length, 1);
  });

  it("stays silent inside the safe band", () => {
    const draft = draftWith({
      canvas: vertical,
      texts: [textMaterial("m1", "hi")],
      tracks: [textTrack([textSegment("safe-3-aaa-bbbb-cccc-dddddddddddd", "m1", 0, 2 * US, { x: 0, y: -0.4 })])],
    });
    assert.equal(codes(lint(draft), "caption-outside-safe-area").length, 0);
  });

  it("never fires on a landscape canvas, where the rule has no meaning", () => {
    const draft = draftWith({
      canvas: { width: 1920, height: 1080, ratio: "16:9" },
      texts: [textMaterial("m1", "hi")],
      tracks: [textTrack([textSegment("safe-4-aaa-bbbb-cccc-dddddddddddd", "m1", 0, 2 * US, { x: 0, y: -0.99 })])],
    });
    assert.equal(codes(lint(draft), "caption-outside-safe-area").length, 0);
  });

  it("ignores a segment that carries no transform", () => {
    const draft = draftWith({
      canvas: vertical,
      texts: [textMaterial("m1", "hi")],
      tracks: [textTrack([textSegment("safe-5-aaa-bbbb-cccc-dddddddddddd", "m1", 0, 2 * US)])],
    });
    assert.equal(codes(lint(draft), "caption-outside-safe-area").length, 0);
  });
});

describe("speed consistency", () => {
  const videoSeg = (id, { speed, sourceUs, targetUs, refs = [] }) => ({
    id,
    material_id: "vid-1",
    speed,
    target_timerange: { start: 0, duration: targetUs },
    source_timerange: { start: 0, duration: sourceUs },
    extra_material_refs: refs,
  });
  it("flags a segment whose timeranges contradict its declared speed", () => {
    const draft = draftWith({
      tracks: [
        {
          id: "v",
          type: "video",
          name: "main",
          attribute: 0,
          segments: [videoSeg("spd-1-aaa-bbbb-cccc-dddddddddddd", { speed: 1.5, sourceUs: 1 * US, targetUs: 1 * US })],
        },
      ],
    });
    const found = codes(lint(draft), "speed-timerange-mismatch");
    assert.equal(found.length, 1, `expected a mismatch; got ${JSON.stringify(lint(draft))}`);
    assert.match(found[0].message, /declares speed 1\.5 but its timeranges imply 1\.000/);
  });

  it("accepts a consistent 1.5x segment", () => {
    const draft = draftWith({
      tracks: [
        {
          id: "v",
          type: "video",
          name: "main",
          attribute: 0,
          segments: [
            videoSeg("spd-2-aaa-bbbb-cccc-dddddddddddd", { speed: 1.5, sourceUs: 1_500_000, targetUs: 1 * US }),
          ],
        },
      ],
    });
    assert.equal(codes(lint(draft), "speed-timerange-mismatch").length, 0);
  });

  it("tolerates sub-frame rounding rather than flagging every trimmed clip", () => {
    // 1_000_001us of source over 1_000_000us at speed 1 — 0.0001% off.
    const draft = draftWith({
      tracks: [
        {
          id: "v",
          type: "video",
          name: "main",
          attribute: 0,
          segments: [videoSeg("spd-3-aaa-bbbb-cccc-dddddddddddd", { speed: 1, sourceUs: 1_000_001, targetUs: 1 * US })],
        },
      ],
    });
    assert.equal(codes(lint(draft), "speed-timerange-mismatch").length, 0);
  });

  it("flags a segment whose linked speed material disagrees with it", () => {
    const draft = draftWith({
      tracks: [
        {
          id: "v",
          type: "video",
          name: "main",
          attribute: 0,
          segments: [
            videoSeg("spd-4-aaa-bbbb-cccc-dddddddddddd", {
              speed: 1,
              sourceUs: 1 * US,
              targetUs: 1 * US,
              refs: ["spd-mat"],
            }),
          ],
        },
      ],
    });
    draft.materials.speeds = [{ id: "spd-mat", type: "speed", speed: 2 }];
    const found = codes(lint(draft), "speed-material-mismatch");
    assert.equal(found.length, 1, `expected a material mismatch; got ${JSON.stringify(lint(draft))}`);
    assert.match(found[0].message, /the app reads the material/);
  });

  it("stays silent when segment and material agree", () => {
    const draft = draftWith({
      tracks: [
        {
          id: "v",
          type: "video",
          name: "main",
          attribute: 0,
          segments: [
            videoSeg("spd-5-aaa-bbbb-cccc-dddddddddddd", {
              speed: 2,
              sourceUs: 2 * US,
              targetUs: 1 * US,
              refs: ["spd-mat"],
            }),
          ],
        },
      ],
    });
    draft.materials.speeds = [{ id: "spd-mat", type: "speed", speed: 2 }];
    assert.equal(codes(lint(draft), "speed-material-mismatch").length, 0);
  });
});

describe("keyframe property_type docs match the code (#80)", () => {
  it("every row of the schema table names the identifier PROPERTY_MAP writes", () => {
    const docs = readFileSync(join(__dirname, "..", "docs", "draft-schema", "03-keyframes-and-animations.md"), "utf-8");
    const cliProps = keyframeProperties();
    const onDisk = keyframePropertyTypes();
    const expected = new Map(cliProps.map((p, i) => [p, onDisk[i]]));

    let checked = 0;
    for (const line of docs.split("\n")) {
      // | `position_x` | `KFTypePositionX` | ... |
      const m = line.match(/^\|\s*`([a-z_]+)`\s*\|\s*`([A-Za-z_]+)`\s*\|/);
      if (!m) continue;
      const [, prop, documented] = m;
      if (!expected.has(prop)) continue;
      assert.equal(
        documented,
        expected.get(prop),
        `docs say ${prop} -> ${documented}, PROPERTY_MAP writes ${expected.get(prop)}`,
      );
      checked++;
    }
    assert.equal(
      checked,
      cliProps.length,
      `expected a documented row per property; matched ${checked}/${cliProps.length}`,
    );
  });
});
