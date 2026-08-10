import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = pathToFileURL(join(__dirname, "..", "dist", "lib.js")).href;

describe("frame-grid helpers", () => {
  it("maps every measured 30 fps duration to its observed frame", async () => {
    const { framesFor, quantizeToFrame } = await import(LIB);
    const samples = [
      { written: 2_767_000, frames: 83, quantized: [2_766_666, 2_766_667] },
      { written: 3_133_000, frames: 94, quantized: [3_133_333, 3_133_334] },
      { written: 334_000, frames: 10, quantized: [333_333] },
      { written: 866_000, frames: 26, quantized: [866_667] },
      { written: 867_000, frames: 26, quantized: [866_667] },
    ];

    for (const sample of samples) {
      assert.equal(framesFor(sample.written, 30), sample.frames);
      assert.ok(sample.quantized.includes(quantizeToFrame(sample.written, 30)));
    }
  });

  it("keeps a 33 ms sub-frame duration on one frame", async () => {
    const { framesFor, quantizeToFrame } = await import(LIB);

    assert.equal(framesFor(33_000, 30), 1);
    assert.equal(quantizeToFrame(33_000, 30), 33_333);
  });

  it("handles fractional frame rates with finite non-negative results", async () => {
    const { framesFor, quantizeToFrame } = await import(LIB);

    for (const fps of [29.97, 23.976]) {
      assert.ok(Number.isFinite(framesFor(1_000_000, fps)));
      assert.ok(framesFor(1_000_000, fps) >= 0);
      assert.ok(Number.isFinite(quantizeToFrame(1_000_000, fps)));
      assert.ok(quantizeToFrame(1_000_000, fps) >= 0);
    }
  });

  it("falls back to 30 fps for invalid or missing rates", async () => {
    const { framesFor, quantizeToFrame } = await import(LIB);
    const expectedFrames = framesFor(866_000, 30);
    const expectedDuration = quantizeToFrame(866_000, 30);

    for (const fps of [0, -30, undefined, "30", Number.NaN]) {
      assert.equal(framesFor(866_000, fps), expectedFrames);
      assert.equal(quantizeToFrame(866_000, fps), expectedDuration);
    }
  });
});
