import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderOutcome } from "../dist/render.js";

// renderOutcome holds render's exit rules and notes; the CLI prints the notes and fails with the error.
const result = (verification, extra = {}) => ({
  output: "/out/p.mp4",
  fidelity: { faithful: true, expected_duration_us: 4_000_000, dropped: {} },
  verification,
  ...extra,
});
const measured = (duration_us, extra = {}) => ({
  verified: true,
  duration_us,
  expected_duration_us: 4_000_000,
  drift_us: duration_us - 4_000_000,
  tolerance_us: 33_333,
  within_tolerance: Math.abs(duration_us - 4_000_000) <= 33_333,
  ...extra,
});

describe("renderOutcome", () => {
  it("a file of the draft's length passes quietly", () => {
    assert.deepEqual(renderOutcome(result(measured(4_000_000))), { notes: [] });
  });

  it("a short file fails, with or without --verify", () => {
    for (const verify of [false, true]) {
      assert.match(renderOutcome(result(measured(3_500_000)), { verify }).error, /drifts -500000us/);
    }
  });

  it("an unmeasured file fails only with --verify", () => {
    const unmeasured = {
      verified: false,
      reason: "ffprobe is unavailable",
      expected_duration_us: 4_000_000,
      tolerance_us: 1,
    };
    assert.equal(renderOutcome(result(unmeasured)).error, undefined);
    assert.match(
      renderOutcome(result(unmeasured), { verify: true }).error,
      /could not be verified: ffprobe is unavailable/,
    );
  });

  it("a gapped draft is held to its gaps-closed length; --verify fails it", () => {
    const match = measured(3_000_000, {
      proxy: { duration_us: 3_000_000, reasons: ["main_track_gaps"], drift_us: 0, within_tolerance: true },
    });
    const ok = renderOutcome(result(match));
    assert.equal(ok.error, undefined);
    assert.match(ok.notes[0], /closes main-track gaps .*it plays 3000000us/);
    assert.match(renderOutcome(result(match), { verify: true }).error, /drifts -1000000us/);
    const short = measured(2_000_000, {
      proxy: { duration_us: 3_000_000, reasons: ["main_track_gaps"], drift_us: -1_000_000, within_tolerance: false },
    });
    assert.match(renderOutcome(result(short)).error, /-1000000us off the 3000000us the proxy plays/);
  });

  it("names missing fonts and a multi-stream source unless a track was chosen", () => {
    const r = result(undefined, {
      fidelity: {
        faithful: false,
        expected_duration_us: 4_000_000,
        dropped: { missing_fonts: { count: 1, segment_ids: ["t"], hint: "", fonts: ["/f/A.ttf"] } },
      },
      audio_sources: [{ path: "/m/two.m4a", streams: 2, used: 0, channel: null }],
    });
    assert.deepEqual(renderOutcome(r).notes, [
      "Note: font /f/A.ttf is missing or unusable here; its captions are drawn in ffmpeg's default face.",
      "Note: /m/two.m4a has 2 audio streams; stream 0 played (choose another with --audio-track <n>).",
    ]);
    assert.equal(renderOutcome(r, { audioTrack: 1 }).notes.length, 1);
  });
});
