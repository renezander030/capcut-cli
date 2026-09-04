import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractText } from "../dist/draft.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// `export-timeline --captions markers`: caption cues travel as OTIO timeline
// markers on the Stack (OTIO has no title schema — OpenTimelineIO#62, open
// since 2017), and `import-timeline` rebuilds the text track from them.

function textCues(path) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  const cues = [];
  for (const track of draft.tracks) {
    if (track.type !== "text") continue;
    for (const seg of track.segments) {
      const mat = draft.materials.texts.find((m) => m.id === seg.material_id);
      const text = mat && typeof mat.content === "string" ? extractText(mat.content) : "";
      if (text)
        cues.push({
          track: track.name,
          text,
          start: seg.target_timerange.start,
          duration: seg.target_timerange.duration,
        });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}

describe("export-timeline --captions markers", () => {
  it("default output is unchanged: no markers, text tracks skipped with the pointer", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const r = spawnCli(["export-timeline", fix.path]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.tracks.markers, []);
    assert.match(r.stderr, /--captions markers/);
  });

  it("writes one Marker.1 per caption cue on the Stack, with the cue text as name and capcut metadata", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const cues = textCues(fix.path);
    assert.ok(cues.length > 0, "fixture must carry captions");
    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    const rate = draft.fps || 30;

    const r = spawnCli(["export-timeline", fix.path, "--captions", "markers"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const markers = r.json.tracks.markers;
    assert.equal(markers.length, cues.length);
    for (const [i, marker] of markers.entries()) {
      assert.equal(marker.OTIO_SCHEMA, "Marker.1");
      assert.equal(marker.color, "YELLOW");
      assert.equal(marker.name, cues[i].text);
      assert.equal(marker.metadata.capcut.kind, "caption");
      assert.equal(marker.metadata.capcut.text, cues[i].text);
      assert.equal(marker.metadata.capcut.track, cues[i].track);
      assert.equal(marker.metadata.Resolve_OTIO.Note, cues[i].text);
      assert.equal(marker.marked_range.OTIO_SCHEMA, "TimeRange.1");
      assert.equal(marker.marked_range.start_time.rate, rate);
      assert.equal(marker.marked_range.start_time.value, Math.round((cues[i].start / 1e6) * rate));
      assert.ok(marker.marked_range.duration.value >= 1);
    }
    // No text track is reported as skipped when it travelled as markers.
    assert.ok(!r.stderr.includes("OTIO has no standard title schema"), r.stderr);
  });

  it("--out reports the marker count and refuses an unknown mode", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const dir = mkdtempSync(join(tmpdir(), "capcut-otio-captions-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const outFile = join(dir, "cut.otio");
    const r = spawnCli(["export-timeline", fix.path, "--out", outFile, "--captions", "markers"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.captions, textCues(fix.path).length);
    const plain = spawnCli(["export-timeline", fix.path, "--out", outFile]);
    assert.equal(plain.json.captions, undefined, "the default JSON keeps its shape");
    const bad = spawnCli(["export-timeline", fix.path, "--captions", "burn"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--captions must be skip\|markers/);
  });

  it("import-timeline rebuilds the text track from the caption markers, reports foreign markers", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const dir = mkdtempSync(join(tmpdir(), "capcut-otio-roundtrip-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const otioPath = join(dir, "cut.otio");
    const exp = spawnCli(["export-timeline", fix.path, "--out", otioPath, "--captions", "markers"]);
    assert.equal(exp.status, 0, `stderr: ${exp.stderr}`);

    // Add an editor's own marker (no capcut metadata): it must be reported, not imported.
    const doc = JSON.parse(readFileSync(otioPath, "utf-8"));
    doc.tracks.markers.push({
      OTIO_SCHEMA: "Marker.1",
      color: "RED",
      marked_range: doc.tracks.markers[0].marked_range,
      metadata: {},
      name: "editor note",
    });
    writeFileSync(otioPath, JSON.stringify(doc));

    const outDir = join(dir, "rebuilt");
    const imp = spawnCli(["import-timeline", otioPath, "--out", outDir]);
    assert.equal(imp.status, 0, `stderr: ${imp.stderr}`);
    const expected = textCues(fix.path);
    assert.equal(imp.json.captions, expected.length);
    assert.ok(
      imp.json.skipped.some(
        (s) => s.type === "markers" && /1 timeline marker\(s\) without capcut caption metadata/.test(s.reason),
      ),
      JSON.stringify(imp.json.skipped),
    );

    const rebuilt = textCues(join(outDir, "draft_content.json"));
    assert.equal(rebuilt.length, expected.length);
    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    const frameUs = 1e6 / (draft.fps || 30);
    for (const [i, cue] of rebuilt.entries()) {
      assert.equal(cue.text, expected[i].text);
      assert.equal(cue.track, expected[i].track, "cues land back on the recorded track name");
      assert.ok(
        Math.abs(cue.start - expected[i].start) <= frameUs,
        `start within a frame: ${cue.start} vs ${expected[i].start}`,
      );
      assert.ok(Math.abs(cue.duration - expected[i].duration) <= frameUs, "duration within a frame");
    }
  });

  it("a document without caption markers imports exactly as before (no captions key)", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const dir = mkdtempSync(join(tmpdir(), "capcut-otio-plain-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const otioPath = join(dir, "cut.otio");
    assert.equal(spawnCli(["export-timeline", fix.path, "--out", otioPath]).status, 0);
    const imp = spawnCli(["import-timeline", otioPath, "--out", join(dir, "rebuilt")]);
    assert.equal(imp.status, 0, `stderr: ${imp.stderr}`);
    assert.equal(imp.json.captions, undefined);
    assert.equal(textCues(join(dir, "rebuilt", "draft_content.json")).length, 0);
  });

  it("describe advertises --captions on export-timeline", () => {
    const r = spawnCli(["describe"]);
    const spec = r.json.commands.find((c) => c.name === "export-timeline");
    const opt = spec.options.find((o) => o.flags.includes("--captions"));
    assert.deepEqual(opt.values, ["skip", "markers"]);
    assert.equal(opt.default, "skip");
  });
});
