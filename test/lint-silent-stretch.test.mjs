import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_LINT_OPTIONS, lintDraft } from "../dist/lint.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

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
    clip: null,
    extra_material_refs: [],
    render_index: 0,
    ...extra,
  };
}

const track = (type, name, segments, attribute = 0) => ({ id: name, type, name, attribute, segments });

// A 30 s draft whose music bed stops from 10 s to 18 s.
function bedWithGap(extraTracks = [], videos = []) {
  return {
    fps: 30,
    duration: 30_000_000,
    canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
    materials: {
      videos: [
        { id: "v", type: "video", path: "", duration: 60_000_000 },
        { id: "p", type: "photo", path: "", duration: 10_800_000_000 },
        ...videos,
      ],
      audios: [{ id: "m", type: "extract_music", path: "", duration: 60_000_000 }],
      texts: [],
      speeds: [],
    },
    tracks: [
      track("audio", "music", [seg("bed-a", "m", 0, 10_000_000), seg("bed-b", "m", 18_000_000, 12_000_000)]),
      ...extraTracks,
    ],
  };
}

const stretches = (draft, minUs) =>
  lintDraft(draft, { ...opts, minSilentUs: minUs })
    .filter((issue) => issue.code === "silent-stretch")
    .map((issue) => issue.message.match(/from (\S+) to (\S+) \((\S+),/).slice(1));

const cover = (materialId, extra = {}, attribute = 0) => [
  track("video", "main", [seg("clip", materialId, 9_000_000, 10_000_000, extra)], attribute),
];

describe("lint silent-stretch — ranges where nothing audible plays", () => {
  it("does not run without --min-silent-secs", () => {
    assert.deepEqual(
      lintDraft(bedWithGap(), opts).filter((issue) => issue.code === "silent-stretch"),
      [],
    );
  });

  it("reports the gap in a music bed once it is at least the limit", () => {
    const [issue] = lintDraft(bedWithGap(), { ...opts, minSilentUs: 5_000_000 }).filter(
      (i) => i.code === "silent-stretch",
    );
    assert.equal(issue.severity, "warning");
    assert.equal(issue.fixable, false);
    assert.equal(
      issue.message,
      "Nothing audible plays from 10s to 18s (8s, at least the 5s --min-silent-secs limit): " +
        "no audio clip above volume 0 and no video clip with its own sound covers it",
    );
    assert.deepEqual(stretches(bedWithGap(), 8_000_000), [["10s", "18s", "8s"]], "exactly the limit counts");
    assert.deepEqual(stretches(bedWithGap(), 9_000_000), []);
  });

  it("a video clip that carries sound covers the gap, unless its track is muted", () => {
    assert.deepEqual(stretches(bedWithGap(cover("v")), 5_000_000), []);
    assert.deepEqual(stretches(bedWithGap(cover("v", {}, 1)), 5_000_000), [["10s", "18s", "8s"]]);
  });

  it("counts a clip as silent only when the draft says so", () => {
    // Silent: a photo, a clip whose sound was separated, a clip at volume 0.
    const separated = { id: "s", type: "video", path: "", duration: 60_000_000, has_sound_separated: true };
    assert.deepEqual(stretches(bedWithGap(cover("p")), 5_000_000), [["10s", "18s", "8s"]]);
    assert.deepEqual(stretches(bedWithGap(cover("s"), [separated]), 5_000_000), [["10s", "18s", "8s"]]);
    assert.deepEqual(stretches(bedWithGap(cover("v", { volume: 0 })), 5_000_000), [["10s", "18s", "8s"]]);
    // Unsure, so counted as sound: a material the draft does not hold, and a
    // muted clip whose volume is keyframed.
    assert.deepEqual(stretches(bedWithGap(cover("unknown")), 5_000_000), []);
    const keyed = {
      volume: 0,
      common_keyframes: [{ property_type: "KFTypeVolume", keyframe_list: [{ id: "k", time_offset: 0, values: [1] }] }],
    };
    assert.deepEqual(stretches(bedWithGap(cover("v", keyed)), 5_000_000), []);
  });

  it("a muted music track leaves only what else plays, inside the timeline's end", () => {
    const draft = bedWithGap([track("text", "subs", [seg("cap", "t", 0, 20_000_000)])]);
    draft.tracks[0].attribute = 1;
    draft.duration = 60_000_000; // longer than anything on the timeline
    assert.deepEqual(stretches(draft, 5_000_000), [["0s", "30s", "30s"]]);
    draft.tracks[0].attribute = 0;
    draft.tracks[0].segments = [seg("bed", "m", 5_000_000, 10_000_000)];
    assert.deepEqual(
      stretches(draft, 3_000_000),
      [
        ["0s", "5s", "5s"],
        ["15s", "20s", "5s"],
      ],
      "leading and trailing silence, the end being the last segment on any track",
    );
  });
});

describe("lint silent-stretch — on the command line", () => {
  it("--min-silent-secs warns with exit 1; without it the result is unchanged", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    draft.tracks.find((tr) => tr.type === "video").attribute = 1; // muted
    const [bed] = draft.tracks.find((tr) => tr.type === "audio").segments;
    bed.target_timerange = { start: 4_000_000, duration: 6_000_000 };
    bed.source_timerange = { start: 0, duration: 6_000_000 };
    writeFileSync(fix.path, JSON.stringify(draft));

    const plain = spawnCli(["lint", fix.path, "--no-check-paths", "--no-probe"]);
    assert.equal(plain.status, 0, plain.stdout);
    assert.equal(plain.json.summary.total, 0);

    const gated = spawnCli(["lint", fix.path, "--no-check-paths", "--no-probe", "--min-silent-secs", "3"]);
    assert.equal(gated.status, 1, gated.stdout);
    assert.deepEqual(
      gated.json.issues.map((issue) => [issue.code, issue.severity]),
      [["silent-stretch", "warning"]],
    );
    assert.match(gated.json.issues[0].message, /^Nothing audible plays from 0s to 4s \(4s,/);

    const refused = spawnCli(["lint", fix.path, "--min-silent-secs", "0"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--min-silent-secs must be a number of seconds > 0/);
  });
});
