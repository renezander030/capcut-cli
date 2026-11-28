import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function fixture(t, speed = 1) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const draft = JSON.parse(readFileSync(fix.path, "utf8"));
  const video = join(fix.dir, "source.mp4");
  writeFileSync(video, "");
  const segment = (id, material, start, duration, rate = 1) => ({
    id,
    material_id: material,
    target_timerange: { start, duration },
    source_timerange: { start: 0, duration: duration * rate },
    speed: rate,
    volume: 1,
    visible: true,
    clip: null,
    extra_material_refs: [],
    render_index: 0,
  });
  draft.duration = 6000000;
  draft.fps = 10;
  draft.canvas_config = { width: 64, height: 64, ratio: "1:1" };
  draft.materials.videos = [{ id: "video", path: video, type: "video", duration: 6000000 * speed }];
  draft.materials.texts = [{ id: "caption", type: "text", content: JSON.stringify({ text: "Caption", styles: [] }) }];
  draft.tracks = [
    { id: "v", type: "video", name: "video", segments: [segment("clip", "video", 0, 6000000, speed)] },
    { id: "t", type: "text", name: "caption", segments: [segment("cue", "caption", 1000000, 4000000)] },
  ];
  writeFileSync(fix.path, JSON.stringify(draft));
  return { ...fix, before: readFileSync(fix.path), output: join(fix.dir, "preview.mp4") };
}
function preview(fix, ...flags) {
  return spawnCli(["render", fix.path, "--dry-run", "--soft-captions", "--out", fix.output, ...flags]);
}

describe("render a selected timeline range", () => {
  it("clips and rebases video/captions on an in-memory copy", (t) => {
    const fix = fixture(t);
    const result = preview(fix, "--start", "2", "--end", "4");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json.source_range, { start_us: 2000000, end_us: 4000000, duration_us: 2000000 });
    assert.equal(result.json.fidelity.expected_duration_us, 2000000);
    assert.match(result.json.filterComplex, /trim=start=2:duration=2/);
    assert.match(result.json.softCaptions.srt, /00:00:00,000 --> 00:00:02,000/);
    assert.deepEqual(readFileSync(fix.path), fix.before);
    assert.equal(existsSync(fix.output), false);
  });

  it("retains the source clock of speed-changed clips", (t) => {
    const fix = fixture(t, 2);
    const result = preview(fix, "--start", "2", "--end", "4");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.json.filterComplex, /trim=start=4:duration=4/);
    assert.match(result.json.filterComplex, /setpts=\(PTS-STARTPTS\)\/2/);
    assert.equal(result.json.fidelity.expected_duration_us, 2000000);
    assert.deepEqual(readFileSync(fix.path), fix.before);
  });

  it("defaults an omitted end to the timeline end", (t) => {
    const fix = fixture(t);
    const result = preview(fix, "--start", "2");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json.source_range, { start_us: 2000000, end_us: 6000000, duration_us: 4000000 });
  });

  it("defaults an omitted start to zero", (t) => {
    const fix = fixture(t);
    const result = preview(fix, "--end", "4");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json.source_range, { start_us: 0, end_us: 4000000, duration_us: 4000000 });
  });

  it("accepts the existing seconds/milliseconds time formats", (t) => {
    const fix = fixture(t);
    const result = preview(fix, "--start", "1.5s", "--end", "2500ms");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json.source_range, { start_us: 1500000, end_us: 2500000, duration_us: 1000000 });
  });

  for (const [start, end] of [
    ["-1", "2"],
    ["2", "2"],
    ["4", "2"],
    ["0", "7"],
    ["oops", "3"],
  ]) {
    it(`refuses invalid range ${start}..${end} without output or source writes`, (t) => {
      const fix = fixture(t);
      const result = preview(fix, "--start", start, "--end", end);
      assert.notEqual(result.status, 0);
      assert.deepEqual(readFileSync(fix.path), fix.before);
      assert.equal(existsSync(fix.output), false);
    });
  }

  it("preserves full-timeline defaults when no range was selected", (t) => {
    const fix = fixture(t);
    const result = preview(fix);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.source_range, undefined);
    assert.equal(result.json.fidelity.expected_duration_us, 6000000);
    assert.deepEqual(readFileSync(fix.path), fix.before);
  });
});
