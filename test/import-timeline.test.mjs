import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { draftToOtio, otioToImportPlan } from "../dist/interchange.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// Frame-aligned fixture (30 fps): every time is a whole number of frames, so
// the export -> import round trip must reproduce the ranges EXACTLY.
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

// `realVideoPath`: an on-disk file for the staging path; the other clips
// reference media that does not exist (placeholder path) or none at all.
function fixtureTracksAndMaterials(realVideoPath) {
  return {
    fps: 30,
    duration: 3_000_000,
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
      {
        id: "TA",
        type: "audio",
        name: "Audio 1",
        attribute: 0,
        segments: [segment("seg-c", "aud-1", 0, 3_000_000, { volume: 0.5 })],
      },
    ],
    materials: {
      videos: [
        {
          id: "vid-1",
          path: realVideoPath,
          material_name: "clip.mp4",
          type: "video",
          duration: 5_000_000,
          width: 1080,
          height: 1920,
        },
        { id: "vid-2", path: "", material_name: "missing", type: "video", duration: 0, width: 0, height: 0 },
      ],
      audios: [{ id: "aud-1", path: "/media/song.mp3", name: "song.mp3", duration: 10_000_000, type: "audio" }],
      texts: [],
      speeds: [],
      material_animations: [],
      audio_fades: [],
      transitions: [],
    },
  };
}

// Rewrite the canonical fixture's timeline with the controlled frame-aligned
// content above, keeping every other draft field loadDraft/saveDraft expect.
function seedFixtureDraft(fix, realVideoPath) {
  const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
  Object.assign(draft, fixtureTracksAndMaterials(realVideoPath));
  writeFileSync(fix.path, JSON.stringify(draft), "utf-8");
  return draft;
}

function timelineShape(draft) {
  return draft.tracks
    .filter((t) => t.type === "video" || t.type === "audio")
    .map((t) => ({
      type: t.type,
      segments: t.segments.map((s) => ({
        target: s.target_timerange,
        source: s.source_timerange,
        speed: s.speed,
        volume: s.volume,
      })),
    }));
}

describe("import-timeline (OTIO)", () => {
  describe("otioToImportPlan", () => {
    it("inverts the exporter's LinearTimeWarp/gap/reference mapping exactly", () => {
      const fix = tmpDraft();
      try {
        const draft = seedFixtureDraft(fix, "/media/a.mp4");
        const { doc } = draftToOtio(draft);
        const plan = otioToImportPlan(doc);

        assert.equal(plan.rate, 30);
        assert.equal(plan.tracks.length, 2);
        assert.equal(plan.clips, 3);
        assert.equal(plan.gaps, 1);
        assert.deepEqual(plan.skipped, []);

        const [video, audio] = plan.tracks;
        assert.equal(video.kind, "video");
        assert.equal(audio.kind, "audio");

        // Gap consumed as a timeline offset: second clip starts after 1s clip + 1s gap.
        const fast = video.clips[1];
        assert.equal(fast.targetStartUs, 2_000_000);
        // speed = time_scalar; timeline duration = source duration / time_scalar.
        assert.equal(fast.speed, 2);
        assert.equal(fast.sourceStartUs, 500_000);
        assert.equal(fast.sourceDurationUs, 2_000_000);
        assert.equal(fast.targetDurationUs, 1_000_000);
        // MissingReference -> no media path (placeholder downstream).
        assert.equal(fast.mediaPath, null);

        const first = video.clips[0];
        assert.equal(first.mediaPath, "/media/a.mp4");
        assert.equal(first.mediaDurationUs, 5_000_000, "available_range round-trips to the material duration");
        assert.equal(audio.clips[0].volume, 0.5, "metadata.capcut.volume rides back in");
      } finally {
        fix.cleanup();
      }
    });

    it("rejects a document that is not an OTIO Timeline.1", () => {
      assert.throws(() => otioToImportPlan({ hello: "world" }), /not an OpenTimelineIO Timeline\.1/);
      assert.throws(() => otioToImportPlan([1, 2]), /not an OpenTimelineIO Timeline\.1/);
    });

    it("REPORTS every unsupported OTIO feature, never silently drops it", () => {
      const rt = (value) => ({ OTIO_SCHEMA: "RationalTime.1", rate: 30, value });
      const range = (start, dur) => ({ OTIO_SCHEMA: "TimeRange.1", start_time: rt(start), duration: rt(dur) });
      const doc = {
        OTIO_SCHEMA: "Timeline.1",
        global_start_time: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: 90 },
        name: "unsupported-features",
        tracks: {
          OTIO_SCHEMA: "Stack.1",
          children: [
            { OTIO_SCHEMA: "Stack.1", children: [], name: "nested" },
            { OTIO_SCHEMA: "Track.1", kind: "Title", name: "titles", children: [] },
            {
              OTIO_SCHEMA: "Track.1",
              kind: "Video",
              name: "V1",
              children: [
                { OTIO_SCHEMA: "Transition.1", name: "cross-dissolve" },
                {
                  OTIO_SCHEMA: "Clip.1",
                  name: "gen",
                  source_range: range(0, 30),
                  effects: [{ OTIO_SCHEMA: "FreezeFrame.1", name: "freeze" }],
                  markers: [{ OTIO_SCHEMA: "Marker.2", name: "note" }],
                  media_reference: { OTIO_SCHEMA: "GeneratorReference.1", generator_kind: "SMPTEBars" },
                },
              ],
            },
          ],
        },
      };
      const plan = otioToImportPlan(doc);
      const types = plan.skipped.map((s) => s.type).sort();
      assert.deepEqual(types, [
        "FreezeFrame.1",
        "GeneratorReference.1",
        "Stack.1",
        "Title",
        "Transition.1",
        "global_start_time",
        "markers",
      ]);
      // The clip itself still imports — as a placeholder at speed 1.
      assert.equal(plan.clips, 1);
      const clip = plan.tracks.find((t) => t.clips.length > 0).clips[0];
      assert.equal(clip.mediaPath, null);
      assert.equal(clip.speed, 1);
    });
  });

  describe("round trip (e2e): export-timeline -> import-timeline --out", () => {
    it("reproduces track/segment counts, target ranges, source ranges, and speeds", () => {
      const fix = tmpDraft();
      try {
        const media = join(fix.dir, "clip.mp4");
        writeFileSync(media, "media-bytes");
        const original = seedFixtureDraft(fix, media);

        const otioPath = join(fix.dir, "cut.otio");
        assert.equal(spawnCli(["export-timeline", fix.path, "--out", otioPath, "--quiet"]).status, 0);

        const outDir = join(fix.dir, "Imported");
        const r = spawnCli(["import-timeline", otioPath, "--out", outDir]);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.equal(r.json.ok, true);
        assert.equal(r.json.mode, "out");
        assert.equal(r.json.tracks, 2);
        assert.equal(r.json.clips, 3);
        assert.equal(r.json.gaps, 1);
        assert.deepEqual(r.json.skipped, []);
        assert.equal(r.json.duration_us, 3_000_000);

        const imported = JSON.parse(readFileSync(join(outDir, "draft_content.json"), "utf-8"));
        assert.deepEqual(
          timelineShape(imported),
          timelineShape(original),
          "imported timeline must be structurally equivalent to the exported draft",
        );
        assert.equal(imported.fps, 30, "fps follows the OTIO rate");
        assert.equal(imported.duration, original.duration);
      } finally {
        fix.cleanup();
      }
    });

    it("stages on-disk media into assets/ (the add-video copy) and keeps placeholders for the rest", () => {
      const fix = tmpDraft();
      try {
        const media = join(fix.dir, "clip.mp4");
        writeFileSync(media, "media-bytes");
        seedFixtureDraft(fix, media);
        const otioPath = join(fix.dir, "cut.otio");
        assert.equal(spawnCli(["export-timeline", fix.path, "--out", otioPath, "--quiet"]).status, 0);

        const outDir = join(fix.dir, "Imported");
        const r = spawnCli(["import-timeline", otioPath, "--out", outDir]);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);

        // The existing file was staged; material points at the copy.
        const staged = join(outDir, "assets", "video", "clip.mp4");
        assert.ok(existsSync(staged), "on-disk media must be copied into assets/video/");
        const imported = JSON.parse(readFileSync(join(outDir, "draft_content.json"), "utf-8"));
        const paths = imported.materials.videos.map((m) => m.path);
        assert.ok(paths.includes(staged), `expected ${staged} in ${JSON.stringify(paths)}`);
        // MissingReference -> empty-path placeholder; absent ExternalReference
        // media keeps its original path verbatim for relink/replace-media.
        assert.ok(paths.includes(""), "MissingReference becomes an empty-path placeholder material");
        assert.ok(
          imported.materials.audios.some((m) => m.path === "/media/song.mp3"),
          "missing external media keeps its original path",
        );
        // Both are REPORTED — in JSON and on stderr with the replace-media hint.
        assert.equal(r.json.placeholders.length, 2);
        assert.match(r.stderr, /replace-media/);
      } finally {
        fix.cleanup();
      }
    });
  });

  describe("--into (append onto an existing draft)", () => {
    it("appends fresh tracks, never touches existing segments, and de-collides track names", () => {
      const source = tmpDraft();
      const target = tmpDraft();
      try {
        const media = join(source.dir, "clip.mp4");
        writeFileSync(media, "media-bytes");
        seedFixtureDraft(source, media);
        const otioPath = join(source.dir, "cut.otio");
        assert.equal(spawnCli(["export-timeline", source.path, "--out", otioPath, "--quiet"]).status, 0);

        const before = JSON.parse(readFileSync(target.path, "utf-8"));
        const beforeSegments = JSON.stringify(before.tracks.map((t) => t.segments));

        const first = spawnCli(["import-timeline", otioPath, "--into", target.path]);
        assert.equal(first.status, 0, `stderr: ${first.stderr}`);
        assert.equal(first.json.mode, "into");
        assert.equal(first.json.tracks, 2);

        // Import the same timeline AGAIN: names collide with the first import
        // and must de-collide instead of merging (merging could overlap).
        const second = spawnCli(["import-timeline", otioPath, "--into", target.path]);
        assert.equal(second.status, 0, `stderr: ${second.stderr}`);

        const after = JSON.parse(readFileSync(target.path, "utf-8"));
        assert.equal(after.tracks.length, before.tracks.length + 4, "each import adds its own fresh tracks");
        const names = after.tracks.filter((t) => t.type === "video").map((t) => t.name);
        assert.ok(
          names.includes("Video 1") && names.includes("Video 1 (2)"),
          `expected de-collided names, got ${names}`,
        );

        // Pre-existing segments byte-equivalent (ids, timing, everything).
        const untouched = after.tracks.filter((t) => before.tracks.some((bt) => bt.id === t.id)).map((t) => t.segments);
        assert.equal(JSON.stringify(untouched), beforeSegments);
      } finally {
        source.cleanup();
        target.cleanup();
      }
    });

    it("--dry-run leaves the target draft byte-identical", () => {
      const source = tmpDraft();
      const target = tmpDraft();
      try {
        seedFixtureDraft(source, "/media/a.mp4");
        const otioPath = join(source.dir, "cut.otio");
        assert.equal(spawnCli(["export-timeline", source.path, "--out", otioPath, "--quiet"]).status, 0);
        const before = readFileSync(target.path, "utf-8");
        const r = spawnCli(["import-timeline", otioPath, "--into", target.path, "--dry-run"]);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.equal(r.json.dryRun, true);
        assert.equal(readFileSync(target.path, "utf-8"), before, "draft must be byte-identical after --dry-run");
      } finally {
        source.cleanup();
        target.cleanup();
      }
    });
  });

  describe("input validation", () => {
    it("requires exactly one of --out / --into, an existing file, and valid OTIO JSON", () => {
      const fix = tmpDraft();
      try {
        const otioPath = join(fix.dir, "cut.otio");
        assert.equal(spawnCli(["export-timeline", fix.path, "--out", otioPath, "--quiet"]).status, 0);

        assert.equal(spawnCli(["import-timeline", otioPath]).status, 1, "neither --out nor --into");
        assert.equal(
          spawnCli(["import-timeline", otioPath, "--out", join(fix.dir, "A"), "--into", fix.path]).status,
          1,
          "--out and --into together",
        );
        assert.equal(spawnCli(["import-timeline", join(fix.dir, "nope.otio"), "--into", fix.path]).status, 1);

        const badJson = join(fix.dir, "bad.otio");
        writeFileSync(badJson, "{not json");
        assert.equal(spawnCli(["import-timeline", badJson, "--into", fix.path]).status, 1);

        const notOtio = join(fix.dir, "not-otio.json");
        writeFileSync(notOtio, JSON.stringify({ tracks: [] }));
        const r = spawnCli(["import-timeline", notOtio, "--into", fix.path]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /Timeline\.1/);
      } finally {
        fix.cleanup();
      }
    });
  });

  // INVARIANT: with import-timeline out of play, the write path it touches
  // (add-video/add-audio grew an internal placeholder option) must behave
  // exactly as v0.16.1 — file staged into assets/, material shaped as before.
  describe("untouched path: add-video writes stay identical to v0.16.1", () => {
    it("stages the file and writes the exact v0.16.1 video material field set", () => {
      const fix = tmpDraft();
      try {
        const media = join(fix.dir, "clip.mp4");
        writeFileSync(media, "media-bytes");
        const r = spawnCli(["add-video", fix.path, media, "0", "1s", "--no-probe"]);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);

        const staged = join(fix.dir, "assets", "video", "clip.mp4");
        assert.ok(existsSync(staged), "add-video must still stage into assets/video/");

        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        const material = draft.materials.videos.find((m) => m.id === r.json.material_id);
        assert.equal(material.path, staged);
        assert.equal(material.material_name, "clip.mp4");
        // Field ORDER is byte-order in the serialized draft: the exact
        // v0.16.1 key sequence, proving the placeholder branch changed
        // nothing when it is not in play.
        assert.deepEqual(Object.keys(material), [
          "id",
          "path",
          "material_name",
          "type",
          "duration",
          "width",
          "height",
          "category_id",
          "category_name",
          "check_flag",
          "crop",
          "has_audio",
          "extra_type_option",
          "formula_id",
          "freeze",
          "intensifies_audio_path",
          "intensifies_path",
          "is_ai_generate_content",
          "is_copyright",
          "is_text_edit_overdub",
          "is_unified_beauty_mode",
          "local_id",
          "local_material_id",
          "material_url",
          "media_path",
          "object_locked",
          "origin_material_id",
          "request_id",
          "reverse_path",
          "source_platform",
          "stable",
          "team_id",
          "video_algorithm",
        ]);
      } finally {
        fix.cleanup();
      }
    });
  });
});
