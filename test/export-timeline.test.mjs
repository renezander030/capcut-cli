import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { draftToOtio } from "../dist/interchange.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function segment(id, materialId, targetStartUs, targetDurUs, extra = {}) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start: targetStartUs, duration: targetDurUs },
    source_timerange: { start: 0, duration: targetDurUs },
    speed: 1,
    volume: 1,
    visible: true,
    clip: null,
    extra_material_refs: [],
    render_index: 0,
    ...extra,
  };
}

function draft() {
  return {
    id: "d1",
    name: "otio-test",
    duration: 3_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    tracks: [
      {
        id: "TV",
        type: "video",
        name: "Video 1",
        attribute: 0,
        segments: [
          segment("seg-a", "vid-1", 0, 1_000_000),
          segment("seg-b", "vid-2", 2_000_000, 1_000_000, {
            speed: 2,
            source_timerange: { start: 500_000, duration: 2_000_000 },
          }),
        ],
      },
      { id: "TA", type: "audio", name: "Audio 1", attribute: 0, segments: [segment("seg-c", "aud-1", 0, 3_000_000)] },
      { id: "TT", type: "text", name: "Subtitles", attribute: 0, segments: [segment("seg-d", "txt-1", 0, 1_000_000)] },
    ],
    materials: {
      videos: [
        {
          id: "vid-1",
          path: "/media/a.mp4",
          material_name: "a.mp4",
          type: "video",
          duration: 5_000_000,
          width: 1080,
          height: 1920,
        },
        { id: "vid-2", path: "", material_name: "missing", type: "video", duration: 0, width: 0, height: 0 },
      ],
      audios: [{ id: "aud-1", path: "/media/song.mp3", name: "song.mp3", duration: 10_000_000, type: "audio" }],
      texts: [
        {
          id: "txt-1",
          type: "text",
          content: JSON.stringify({ text: "hi", styles: [] }),
          font_size: 15,
          text_color: "#fff",
          alignment: 1,
        },
      ],
      speeds: [],
      material_animations: [],
      audio_fades: [],
      transitions: [],
    },
  };
}

describe("export-timeline (OTIO)", () => {
  describe("draftToOtio", () => {
    it("emits the stable OTIO schema set with video+audio tracks and reported skips", () => {
      const { doc, stats } = draftToOtio(draft());
      assert.equal(doc.OTIO_SCHEMA, "Timeline.1");
      assert.equal(doc.tracks.OTIO_SCHEMA, "Stack.1");
      assert.deepEqual(
        doc.tracks.children.map((t) => t.kind),
        ["Video", "Audio"],
      );
      assert.equal(stats.tracks, 2);
      assert.equal(stats.clips, 3);
      assert.equal(stats.skipped.length, 1);
      assert.equal(stats.skipped[0].type, "text");
      assert.match(stats.skipped[0].reason, /export-srt/);
    });

    it("inserts gaps in frames and maps speed to LinearTimeWarp", () => {
      const { doc, stats } = draftToOtio(draft());
      const video = doc.tracks.children[0];
      assert.deepEqual(
        video.children.map((c) => c.OTIO_SCHEMA),
        ["Clip.1", "Gap.1", "Clip.1"],
      );
      assert.equal(stats.gaps, 1);
      const gap = video.children[1];
      assert.equal(gap.source_range.duration.value, 30, "1s gap at 30fps = 30 frames");

      const fast = video.children[2];
      assert.equal(fast.effects.length, 1);
      assert.equal(fast.effects[0].OTIO_SCHEMA, "LinearTimeWarp.1");
      assert.equal(fast.effects[0].time_scalar, 2);
      assert.equal(fast.source_range.start_time.value, 15, "0.5s source offset = 15 frames");
      assert.equal(fast.source_range.duration.value, 60, "2s of source media = 60 frames");
      assert.equal(fast.media_reference.OTIO_SCHEMA, "MissingReference.1", "empty path must not fake a file");
    });

    it("carries media paths, available ranges, and capcut metadata", () => {
      const { doc } = draftToOtio(draft());
      const clip = doc.tracks.children[0].children[0];
      assert.equal(clip.media_reference.OTIO_SCHEMA, "ExternalReference.1");
      assert.equal(clip.media_reference.target_url, "/media/a.mp4");
      assert.equal(clip.media_reference.available_range.duration.value, 150, "5s media at 30fps");
      assert.equal(clip.metadata.capcut.segment_id, "seg-a");
    });

    it("is deterministic — same draft, byte-identical document", () => {
      const one = JSON.stringify(draftToOtio(draft()).doc);
      const two = JSON.stringify(draftToOtio(draft()).doc);
      assert.equal(one, two);
    });
  });

  describe("command (e2e)", () => {
    it("prints the OTIO document on stdout and reports skipped text tracks on stderr", () => {
      const fix = tmpDraft();
      try {
        const r = spawnCli(["export-timeline", fix.path]);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        const doc = JSON.parse(r.stdout);
        assert.equal(doc.OTIO_SCHEMA, "Timeline.1");
        assert.ok(doc.tracks.children.length >= 2, "fixture has video + audio tracks");
        assert.match(r.stderr, /skipped track/);
        assert.match(r.stderr, /export-srt/);
      } finally {
        fix.cleanup();
      }
    });

    it("--out writes the file and prints a JSON summary; --quiet silences skip notes", () => {
      const fix = tmpDraft();
      try {
        const outPath = join(fix.dir, "cut.otio");
        const r = spawnCli(["export-timeline", fix.path, "--out", outPath, "--quiet"]);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.ok(existsSync(outPath));
        const doc = JSON.parse(readFileSync(outPath, "utf-8"));
        assert.equal(doc.OTIO_SCHEMA, "Timeline.1");
        assert.equal(r.stderr, "", "--quiet must silence the skip notes");
      } finally {
        fix.cleanup();
      }
    });
  });
});
