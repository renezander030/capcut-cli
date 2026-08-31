import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { __test } from "../component.js";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = resolve(packageDirectory, "../../test/draft_content.json");
const fixtureJson = readFileSync(fixturePath, "utf8");

function unwrap(result) {
  return JSON.parse(result);
}

describe("capcut-core pure contract", () => {
  it("inspects the repository fixture", () => {
    const result = unwrap(__test.inspect(fixtureJson));
    assert.equal(result.id, "test-project-001");
    assert.equal(result.tracks, 3);
    assert.equal(result.segments, 6);
    assert.deepEqual(result.material_summary, [
      { type: "texts", count: 3 },
      { type: "videos", count: 2 },
      { type: "audios", count: 1 },
      { type: "speeds", count: 1 },
    ]);
  });

  it("runs the declared portable lint subset", () => {
    const broken = JSON.parse(fixtureJson);
    broken.canvas_config = { ...broken.canvas_config, width: 1080, height: 1920 };
    const textTrack = broken.tracks.find((track) => track.type === "text");
    const [first, second, third] = textTrack.segments;
    const firstText = broken.materials.texts.find((material) => material.id === first.material_id);

    first.target_timerange.duration = 8_000_000;
    first.clip = { ...(first.clip ?? {}), transform: { ...(first.clip?.transform ?? {}), y: 0.9 } };
    firstText.content = JSON.stringify({ text: "X".repeat(200), styles: [] });
    second.target_timerange.start = 1_000_000;
    second.material_id = "missing-material-id";
    third.extra_material_refs = ["missing-companion-id"];

    const report = unwrap(__test.lintPortable(JSON.stringify(broken)));
    assert.equal(report.scope, "portable-subset");
    assert.deepEqual(report.checks, [
      "missing-material",
      "dangling-companion-ref",
      "cue-too-long",
      "caption-too-fast",
      "caption-outside-safe-area",
      "caption-overlap",
    ]);
    assert.deepEqual(
      new Set(report.issues.map((issue) => issue.code)),
      new Set(report.checks),
    );
    assert.equal(report.ok, false);
  });

  it("detects material, timing, speed, volume, and content changes", () => {
    const after = JSON.parse(fixtureJson);
    after.materials.texts[0].content = JSON.stringify({ text: "EDITED", styles: [] });
    after.tracks[0].segments[0].target_timerange.start += 1_000_000;
    after.tracks[0].segments[0].speed = 1.25;
    after.tracks[0].segments[0].volume = 0.5;
    const report = unwrap(__test.diff(fixtureJson, JSON.stringify(after)));
    assert.equal(report.changed, true);
    assert.deepEqual(report.materials.changed, [after.materials.texts[0].id]);
    assert.deepEqual(report.segments.changed[0].fields, ["start", "speed", "volume"]);
  });

  it("rejects malformed input without ambient recovery paths", () => {
    assert.throws(() => __test.inspect("not-json"), /not valid JSON/);
  });
});
