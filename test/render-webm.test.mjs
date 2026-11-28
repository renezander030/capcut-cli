import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildRenderPlan, renderDraft } from "../dist/render.js";
import { writeFakeFfmpeg } from "./helpers/fake-ffmpeg.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function fixture(t, extension, options = {}) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const draft = JSON.parse(readFileSync(fix.path, "utf8"));
  const video = join(fix.dir, "video.mp4");
  const audio = join(fix.dir, "audio.wav");
  writeFileSync(video, "");
  writeFileSync(audio, "");
  const segment = (id, material) => ({
    id,
    material_id: material,
    target_timerange: { start: 0, duration: 1000000 },
    source_timerange: { start: 0, duration: 1000000 },
    speed: 1,
    volume: 1,
    visible: true,
    clip: null,
    extra_material_refs: [],
    render_index: 0,
  });
  draft.duration = 1000000;
  draft.canvas_config = { width: 64, height: 64, ratio: "1:1" };
  draft.materials.videos = [{ id: "video", path: video, type: "video" }];
  draft.materials.audios = [{ id: "audio", path: audio, type: "extract_music" }];
  draft.materials.texts = [{ id: "text", content: JSON.stringify({ text: "Caption", styles: [] }) }];
  draft.tracks = [
    { id: "v", type: "video", segments: [segment("v1", "video")] },
    { id: "a", type: "audio", segments: [segment("a1", "audio")] },
    { id: "t", type: "text", segments: [segment("t1", "text")] },
  ];
  return { draft, fix, options: { out: join(fix.dir, `preview.${extension}`), softCaptions: true, ...options } };
}

function plan(t, extension, options = {}) {
  const source = fixture(t, extension, options);
  return buildRenderPlan(source.draft, source.options);
}

const value = (args, option) => args[args.indexOf(option) + 1];

describe("WebM render codecs", () => {
  for (const extension of ["webm", "WEBM"]) {
    it(`chooses VP9, Opus and WebVTT for .${extension}`, (t) => {
      const { args } = plan(t, extension);
      assert.equal(value(args, "-c:v"), "libvpx-vp9");
      assert.equal(value(args, "-c:a"), "libopus");
      assert.equal(value(args, "-c:s"), "webvtt");
      assert.equal(args.includes("-preset"), false);
      assert.equal(value(args, "-b:v"), "0");
    });
  }

  it("preserves MP4 H264/AAC/mov_text and preset defaults", (t) => {
    const { args } = plan(t, "mp4");
    assert.equal(value(args, "-c:v"), "libx264");
    assert.equal(value(args, "-c:a"), "aac");
    assert.equal(value(args, "-c:s"), "mov_text");
    assert.equal(value(args, "-preset"), "veryfast");
  });

  it("refuses an explicit incompatible WebM video encoder during planning", (t) => {
    assert.throws(() => plan(t, "webm", { encoder: "libx264" }), /WebM.*(?:VP8|VP9|AV1)/i);
  });

  it("accepts explicit VP8 without adding x264-only preset arguments", (t) => {
    const { args } = plan(t, "webm", { encoder: "libvpx" });
    assert.equal(value(args, "-c:v"), "libvpx");
    assert.equal(args.includes("-preset"), false);
  });

  it("keeps explicit bitrate mode distinct from VP9 constant quality", (t) => {
    const { args } = plan(t, "webm", { videoBitrate: "2M" });
    assert.equal(value(args, "-c:v"), "libvpx-vp9");
    assert.equal(value(args, "-b:v"), "2M");
    assert.equal(args.filter((arg) => arg === "-b:v").length, 1);
    assert.equal(args.includes("-crf"), false);
  });

  it("refuses a build missing the default VP9 encoder before producing output", {
    skip: process.platform === "win32",
  }, (t) => {
    const source = fixture(t, "webm");
    const ffmpegCmd = writeFakeFfmpeg(source.fix.dir);
    assert.throws(
      () => renderDraft(source.draft, source.fix.path, { ...source.options, ffmpegCmd }),
      /has no 'libvpx-vp9' encoder/,
    );
    assert.equal(existsSync(source.options.out), false);
  });

  it("refuses a WebM build missing Opus when the timeline has audio", { skip: process.platform === "win32" }, (t) => {
    const source = fixture(t, "webm");
    const ffmpegCmd = writeFakeFfmpeg(source.fix.dir, { encoders: ["libvpx-vp9", "webvtt"] });
    assert.throws(
      () => renderDraft(source.draft, source.fix.path, { ...source.options, ffmpegCmd }),
      /has no 'libopus' encoder/,
    );
    assert.equal(existsSync(source.options.out), false);
  });
});
