import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fixDraft, lintDraft } from "../dist/lint.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const fixture = () => JSON.parse(readFileSync(new URL("./draft_content.json", import.meta.url), "utf-8"));
const opts = {
  maxCharsPerLine: 999,
  maxCueDurationUs: 1e12,
  minGapBetweenCaptionsUs: 0,
  checkLocalPaths: false,
  probeMedia: false,
};
const codes = (draft, code) => lintDraft(draft, opts).filter((issue) => issue.code === code);
const keyframes = (property, offsets) => ({
  id: "kf",
  material_id: "",
  property_type: property,
  keyframe_list: offsets.map((time_offset) => ({ id: `k${time_offset}`, time_offset, values: [1] })),
});

describe("lint — keyframes on trimmed or speed-changed clips", () => {
  it("notes keyframes on a clip played at another speed or trimmed at its head", () => {
    const draft = fixture();
    const [sped, plain] = draft.tracks.find((t) => t.type === "video").segments;
    sped.common_keyframes = [keyframes("KFTypePositionX", [0, 1_000_000])]; // 1.5x in the fixture
    plain.common_keyframes = [keyframes("UNIFORM_SCALE", [0, 2_000_000])];
    plain.source_timerange.start = 500_000;
    const issues = codes(draft, "keyframe-trimmed-clock");
    assert.deepEqual(
      issues.map((issue) => [issue.location.segment_id, issue.severity, issue.fixable]),
      [
        [sped.id, "info", false],
        [plain.id, "info", false],
      ],
    );
    assert.match(issues[0].message, /plays at 1\.5x/);
    assert.match(issues[1].message, /starts 500000us into its media/);
  });

  it("stays quiet for untrimmed 1x clips and for volume-only keyframes", () => {
    const draft = fixture();
    const [sped, plain] = draft.tracks.find((t) => t.type === "video").segments;
    sped.common_keyframes = [keyframes("KFTypeVolume", [0, 1_000_000])];
    plain.common_keyframes = [keyframes("KFTypeAlpha", [0, 1_000_000])];
    assert.deepEqual(codes(draft, "keyframe-trimmed-clock"), []);
  });
});

describe("lint — UNIFORM_SCALE on JianYing 11.6+", () => {
  const withZoom = (source, version) => {
    const draft = fixture();
    draft.platform = { ...(draft.platform ?? {}), app_source: source, app_version: version };
    draft.tracks.find((t) => t.type === "video").segments[1].common_keyframes = [keyframes("UNIFORM_SCALE", [0, 1])];
    return draft;
  };

  it("notes UNIFORM_SCALE zooms on JianYing 11.6 and later", () => {
    const issues = codes(withZoom("lv", "11.6.0"), "uniform-scale-keyframe");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, "info");
    assert.match(issues[0].message, /JianYing 11\.6\.0 has been reported to ignore them/);
  });

  it("says nothing for CapCut or older JianYing", () => {
    assert.deepEqual(codes(withZoom("cc", "11.6.0"), "uniform-scale-keyframe"), []);
    assert.deepEqual(codes(withZoom("lv", "10.8.0"), "uniform-scale-keyframe"), []);
  });
});

describe("lint — has_sound_separated with no separated audio", () => {
  it("warns when a copied mark would leave the clip silent, and --fix clears it", () => {
    const draft = fixture();
    draft.materials.videos[0].has_sound_separated = true;
    const [issue] = codes(draft, "sound-separated-orphan");
    assert.equal(issue.severity, "warning");
    assert.equal(issue.fixable, true);
    assert.equal(issue.location.material_id, draft.materials.videos[0].id);
    const { fixed } = fixDraft(draft, opts);
    assert.ok(fixed.some((f) => f.code === "sound-separated-orphan"));
    assert.equal(draft.materials.videos[0].has_sound_separated, false);
  });

  it("leaves a draft alone whose sound really was split in the app", () => {
    const draft = fixture();
    draft.materials.videos[0].has_sound_separated = true;
    draft.materials.audios[0].type = "extract_music";
    assert.deepEqual(codes(draft, "sound-separated-orphan"), []);
    fixDraft(draft, opts);
    assert.equal(draft.materials.videos[0].has_sound_separated, true);
  });

  it("does the same through lint --fix on disk", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    draft.materials.videos[1].has_sound_separated = true;
    writeFileSync(fix.path, JSON.stringify(draft));
    const before = spawnCli(["lint", fix.path, "--no-probe"]);
    assert.ok(
      before.json.issues.some((issue) => issue.code === "sound-separated-orphan"),
      before.stdout,
    );
    const fixed = spawnCli(["lint", fix.path, "--fix", "--no-probe"]);
    assert.ok(
      fixed.json.fixed.some((issue) => issue.code === "sound-separated-orphan"),
      fixed.stdout,
    );
    assert.equal(JSON.parse(readFileSync(fix.path, "utf-8")).materials.videos[1].has_sound_separated, false);
  });
});
