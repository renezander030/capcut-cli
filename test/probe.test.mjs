import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { normalizeRotation, parseMediaProbe, probeMedia } from "../dist/probe.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const hasFfprobe = spawnSync("ffprobe", ["-version"], { encoding: "utf-8" }).status === 0;

const REAL_MEDIA = join(process.cwd(), "media", "two-sisters-vietnam-short.mp4"); // 64x64

describe("probe: full media metadata", () => {
  it("reads width/height off the first video stream, unrotated", () => {
    const parsed = parseMediaProbe(JSON.stringify({ streams: [{ codec_type: "video", width: 1920, height: 1080 }] }));
    assert.equal(parsed.width, 1920);
    assert.equal(parsed.height, 1080);
    assert.equal(parsed.rotation, 0);
  });

  it("reads rotation from a Display Matrix side_data entry (newer ffmpeg) and swaps W/H", () => {
    const parsed = parseMediaProbe(
      JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: 1920,
            height: 1080,
            side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
          },
        ],
      }),
    );
    assert.equal(parsed.rotation, 270);
    // A 90/270 rotation reports the on-screen (portrait) dimensions.
    assert.equal(parsed.width, 1080);
    assert.equal(parsed.height, 1920);
  });

  it("returns null when the container has neither a video nor an audio stream", () => {
    assert.equal(parseMediaProbe(JSON.stringify({ streams: [{ codec_type: "subtitle" }] })), null);
  });

  it("returns null on malformed JSON", () => {
    assert.equal(parseMediaProbe("not json"), null);
  });

  it("parses duration, fps, codecs, dimensions, rotation, and audio channels", () => {
    const parsed = parseMediaProbe(
      JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            avg_frame_rate: "30000/1001",
            tags: { rotate: "90" },
          },
          { codec_type: "audio", codec_name: "aac", channels: 2 },
        ],
        format: { duration: "12.5" },
      }),
    );
    assert.equal(parsed.width, 1080);
    assert.equal(parsed.height, 1920);
    assert.equal(parsed.durationUs, 12_500_000);
    // no per-stream duration in this fixture -> video-stream duration unknown
    assert.equal(parsed.videoDurationUs, null);
    assert.ok(Math.abs(parsed.fps - 29.97) < 0.01);
    assert.equal(parsed.audioChannels, 2);
    assert.equal(parsed.videoCodec, "h264");
    assert.equal(parsed.audioCodec, "aac");
  });

  it("reads the video stream's own duration separately from the container's", () => {
    const parsed = parseMediaProbe(
      JSON.stringify({
        streams: [
          { codec_type: "video", codec_name: "h264", width: 160, height: 120, duration: "6.000000" },
          { codec_type: "audio", codec_name: "aac", channels: 1, duration: "8.000000" },
        ],
        format: { duration: "8.000000" },
      }),
    );
    assert.equal(parsed.durationUs, 8_000_000, "container duration = longest stream");
    assert.equal(parsed.videoDurationUs, 6_000_000, "video stream duration must not include the audio tail");
  });
});

describe("probe: normalizeRotation", () => {
  it("normalizes negatives and overflows to 0/90/180/270", () => {
    assert.equal(normalizeRotation(-90), 270);
    assert.equal(normalizeRotation(450), 90);
    assert.equal(normalizeRotation(360), 0);
    assert.equal(normalizeRotation(-270), 90);
  });
});

describe("add-video: dimension resolution", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  function dummyMedia(name) {
    const p = join(fix.dir, name);
    writeFileSync(p, "not a real video");
    return p;
  }

  it("honors explicit --width/--height (no probe needed)", () => {
    const media = dummyMedia("flags.mp4");
    const r = spawnCli(["add-video", fix.path, media, "0", "1s", "--width", "1080", "--height", "1920"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.width, 1080);
    assert.equal(r.json.height, 1920);
    assert.equal(r.json.dimension_source, "flags");
  });

  it("falls back to 1920x1080 + warning when dimensions cannot be probed", () => {
    const media = dummyMedia("garbage.mp4");
    const r = spawnCli(["add-video", fix.path, media, "0", "1s"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.width, 1920);
    assert.equal(r.json.height, 1080);
    assert.equal(r.json.dimension_source, "default");
    assert.match(r.json.warning, /ffprobe|--width/);
  });

  it("does not cap a photo timeline duration to ffprobe's single-frame duration", () => {
    const media = dummyMedia("still.jpg");
    const r = spawnCli(["add-video", fix.path, media, "0", "3s", "--track-name", "still"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.duration_us, 3_000_000);
    const written = JSON.parse(readFileSync(fix.path, "utf-8"));
    const segment = written.tracks.find((track) => track.name === "still").segments[0];
    const material = written.materials.videos.find((item) => item.id === segment.material_id);
    assert.equal(material.type, "photo");
  });

  it("auto-probes a real file via ffprobe", (t) => {
    if (!hasFfprobe) return t.skip("ffprobe not installed");
    const probed = probeMedia(REAL_MEDIA);
    if (!probed?.width || !probed.height) return t.skip("test media not available");
    const r = spawnCli(["add-video", fix.path, REAL_MEDIA, "0", "1s", "--track-name", "probe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dimension_source, "ffprobe");
    assert.equal(r.json.width, probed.width);
    assert.equal(r.json.height, probed.height);
  });

  it("uses probed duration when duration is omitted", (t) => {
    if (!hasFfprobe) return t.skip("ffprobe not installed");
    const media = probeMedia(REAL_MEDIA);
    if (!media?.durationUs) return t.skip("test media not available");
    const r = spawnCli(["add-video", fix.path, REAL_MEDIA, "0", "--track-name", "auto-duration"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.duration_source, "ffprobe");
    assert.equal(r.json.duration_us, media.durationUs);
  });
});
