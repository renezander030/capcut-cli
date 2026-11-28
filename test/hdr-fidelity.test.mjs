import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseMediaProbe } from "../dist/probe.js";
import { assertFaithful, fidelityCensus } from "../dist/render.js";

const probe = (video) =>
  parseMediaProbe(JSON.stringify({ streams: [{ codec_type: "video", width: 64, height: 64, ...video }] }));
const draft = () => {
  const value = JSON.parse(readFileSync(new URL("./draft_content.json", import.meta.url), "utf8"));
  value.tracks = [
    {
      id: "video",
      type: "video",
      segments: [
        {
          id: "hdr",
          material_id: "source",
          target_timerange: { start: 0, duration: 1000000 },
          source_timerange: { start: 0, duration: 1000000 },
          extra_material_refs: [],
        },
      ],
    },
  ];
  value.duration = 1000000;
  value.materials.videos = [{ id: "source", path: "/example/tagged.mp4", type: "video" }];
  return value;
};

describe("HDR and wide-gamut proxy fidelity", () => {
  it("retains PQ, gamut and matrix metadata from the real ffprobe schema", () => {
    const result = probe({ color_transfer: "smpte2084", color_primaries: "bt2020", color_space: "bt2020nc" });
    assert.equal(result.colorTransfer, "smpte2084");
    assert.equal(result.colorPrimaries, "bt2020");
    assert.equal(result.colorSpace, "bt2020nc");
  });

  it("retains the Dolby Vision configuration signal independently of the transfer label", () => {
    const result = probe({ side_data_list: [{ side_data_type: "DOVI configuration record", dv_profile: 8 }] });
    assert.equal(result.dolbyVision, true);
  });

  for (const source of [
    { colorTransfer: "smpte2084" },
    { colorTransfer: "arib-std-b67" },
    { colorPrimaries: "bt2020" },
    { colorPrimaries: "smpte432" },
    { dolbyVision: true },
  ]) {
    it(`reports unsupported source color and strict refusal for ${JSON.stringify(source)}`, () => {
      const census = fidelityCensus(draft(), { videoProbe: new Map([["/example/tagged.mp4", source]]) });
      assert.equal(census.faithful, false);
      assert.deepEqual(census.dropped.hdr_color.segment_ids, ["hdr"]);
      assert.throws(() => assertFaithful(census), /hdr_color/);
    });
  }

  it("reports unavailable color evidence without inventing HDR or SDR verification", () => {
    const census = fidelityCensus(draft(), { videoProbe: new Map([["/example/tagged.mp4", null]]) });
    assert.equal(census.dropped.hdr_color, undefined);
    assert.deepEqual(census.source_color.unknown_paths, ["/example/tagged.mp4"]);
    assert.equal(census.source_color.probed, 0);
  });
});
