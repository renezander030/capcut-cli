import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildRenderPlan, probeFfmpegCapabilities } from "../dist/render.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const US = 1_000_000;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;

// A minimal but real draft shape: 2 video segments (main track), 1 audio, 1 text.
function buildDraft(dir, { withText = true } = {}) {
  const v1 = join(dir, "clip1.mp4");
  const v2 = join(dir, "clip2.mp4");
  const a1 = join(dir, "music.mp3");
  for (const p of [v1, v2, a1]) writeFileSync(p, "");
  const seg = (matId, start, dur, extra = {}) => ({
    id: `seg-${matId}`,
    material_id: matId,
    target_timerange: { start, duration: dur },
    source_timerange: { start: 0, duration: dur },
    speed: 1,
    volume: 1,
    visible: true,
    clip: null,
    extra_material_refs: [],
    render_index: 0,
    ...extra,
  });
  const tracks = [
    {
      id: "tv",
      type: "video",
      name: "video",
      attribute: 0,
      segments: [seg("mv1", 0, 2 * US), seg("mv2", 2 * US, 2 * US, { speed: 2 })],
    },
    { id: "ta", type: "audio", name: "audio", attribute: 0, segments: [seg("ma1", 0, 4 * US, { volume: 0.4 })] },
  ];
  if (withText) {
    tracks.push({
      id: "tt",
      type: "text",
      name: "captions",
      attribute: 0,
      segments: [seg("mt1", 0, 2 * US)],
    });
  }
  return {
    id: "d",
    name: "t",
    duration: 4 * US,
    fps: 30,
    canvas_config: { width: 720, height: 1280, ratio: "9:16" },
    tracks,
    materials: {
      videos: [
        { id: "mv1", path: v1, type: "video", material_name: "clip1.mp4", duration: 2 * US, width: 320, height: 240 },
        { id: "mv2", path: v2, type: "video", material_name: "clip2.mp4", duration: 2 * US, width: 320, height: 240 },
      ],
      audios: [{ id: "ma1", path: a1, name: "music", type: "extract_music", duration: 4 * US }],
      texts: [{ id: "mt1", type: "text", content: JSON.stringify({ text: "Hook line" }) }],
      speeds: [],
      material_animations: [],
      audio_fades: [],
      transitions: [],
    },
  };
}

describe("render — plan (buildRenderPlan, pure)", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "capcut-render-plan-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("flattens main video track + mixes audio with correct proxy dims", () => {
    const s = setup();
    after(s.cleanup);
    const plan = buildRenderPlan(buildDraft(s.dir), { out: join(s.dir, "p.mp4"), scale: 0.5 });
    assert.equal(plan.videoSegments, 2);
    assert.equal(plan.audioSegments, 1);
    assert.equal(plan.inputs.length, 3);
    assert.equal(plan.width, 360); // 720 * 0.5
    assert.equal(plan.height, 640); // 1280 * 0.5
    assert.equal(plan.skipped.length, 0);
    assert.match(plan.filterComplex, /concat=n=2:v=1:a=0/);
    // per-segment speed shows up as a setpts divisor on the sped-up clip
    assert.match(plan.filterComplex, /setpts=\(PTS-STARTPTS\)\/2/);
    assert.ok(plan.args.includes("-filter_complex"));
    assert.equal(plan.args[plan.args.length - 1], join(s.dir, "p.mp4"));
  });

  it("omits text overlays unless --burn-captions", () => {
    const s = setup();
    after(s.cleanup);
    const off = buildRenderPlan(buildDraft(s.dir), { out: join(s.dir, "p.mp4") });
    assert.equal(off.textOverlays, 0);
    const on = buildRenderPlan(buildDraft(s.dir), { out: join(s.dir, "p.mp4"), burnCaptions: true });
    assert.equal(on.textOverlays, 1);
    assert.match(on.filterComplex, /drawtext=text='Hook line'/);
  });

  // Regression: `text_color` went into `fontcolor=` raw, so a draft could close
  // the option with a `:` and append drawtext options of its own — `textfile=`
  // reads a local file straight into the burned-in captions.
  it("keeps a draft's caption colour inside the fontcolor option", () => {
    const s = setup();
    after(s.cleanup);
    const plan = (color) => {
      const draft = buildDraft(s.dir);
      draft.materials.texts[0].text_color = color;
      return buildRenderPlan(draft, { out: join(s.dir, "p.mp4"), burnCaptions: true });
    };

    assert.match(plan("#FF3300").filterComplex, /fontcolor=0xFF3300:/, "hex colours still render");
    assert.match(plan("yellow").filterComplex, /fontcolor=yellow:/, "named colours still render");

    const injected = plan("white:textfile=/etc/passwd:x=0");
    assert.ok(!injected.filterComplex.includes("textfile"), "draft colour cannot append drawtext options");
    assert.match(injected.filterComplex, /fontcolor=white:fontsize=/, "falls back to the default colour");
    assert.equal(injected.textOverlays, 1, "the caption still burns in");
  });

  it("records skipped segments when material files are missing", () => {
    const s = setup();
    after(s.cleanup);
    const draft = buildDraft(s.dir);
    rmSync(draft.materials.videos[1].path); // delete clip2
    const plan = buildRenderPlan(draft, { out: join(s.dir, "p.mp4") });
    assert.equal(plan.videoSegments, 1);
    assert.equal(plan.skipped.length, 1);
    assert.match(plan.skipped[0].reason, /file missing/);
  });

  it("composites overlay tracks, transforms, opacity, and audio fades", () => {
    const s = setup();
    after(s.cleanup);
    const draft = buildDraft(s.dir);
    const overlayPath = join(s.dir, "overlay.png");
    writeFileSync(overlayPath, "");
    draft.materials.videos.push({
      id: "mov",
      path: overlayPath,
      type: "photo",
      material_name: "overlay.png",
      duration: US,
      width: 100,
      height: 100,
    });
    draft.tracks.push({
      id: "tov",
      type: "video",
      name: "overlay",
      attribute: 0,
      segments: [
        {
          id: "seg-overlay",
          material_id: "mov",
          target_timerange: { start: US, duration: US },
          source_timerange: { start: 0, duration: US },
          speed: 1,
          volume: 1,
          visible: true,
          clip: { alpha: 0.5, rotation: 10, scale: { x: 0.5, y: 0.5 }, transform: { x: 0.25, y: -0.25 } },
          extra_material_refs: [],
          render_index: 0,
        },
      ],
    });
    draft.materials.audio_fades.push({ id: "fade-1", fade_in_duration: 250_000, fade_out_duration: 500_000 });
    draft.tracks.find((track) => track.type === "audio").segments[0].extra_material_refs.push("fade-1");
    const plan = buildRenderPlan(draft, { out: join(s.dir, "p.mp4"), allVideoTracks: true });
    assert.equal(plan.overlaySegments, 1);
    assert.match(plan.filterComplex, /overlay=x=/);
    assert.match(plan.filterComplex, /colorchannelmixer=aa=0.5/);
    assert.match(plan.filterComplex, /rotate=10\*PI\/180/);
    assert.match(plan.filterComplex, /afade=t=in/);
    assert.match(plan.filterComplex, /afade=t=out/);
  });

  it("reports ffmpeg filter capabilities", (t) => {
    if (!hasFfmpeg) return t.skip("ffmpeg not installed");
    const capabilities = probeFfmpegCapabilities();
    assert.equal(capabilities.available, true);
    assert.equal(typeof capabilities.drawtext, "boolean");
    assert.equal(typeof capabilities.overlay, "boolean");
  });

  it("throws when there is no usable video segment", () => {
    const s = setup();
    after(s.cleanup);
    const draft = buildDraft(s.dir);
    for (const v of draft.materials.videos) rmSync(v.path);
    assert.throws(() => buildRenderPlan(draft, { out: join(s.dir, "p.mp4") }), /no usable video segments/);
  });
});

describe("render — CLI", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "capcut-render-cli-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("--dry-run returns the plan and writes no file", () => {
    const s = setup();
    after(s.cleanup);
    const draftPath = join(s.dir, "draft_content.json");
    writeFileSync(draftPath, JSON.stringify(buildDraft(s.dir)));
    const out = join(s.dir, "preview.mp4");
    const r = spawnCli(["render", draftPath, "--out", out, "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.executed, false);
    assert.equal(r.json.videoSegments, 2);
    assert.ok(!existsSync(out), "dry-run must not write the output file");
  });

  it("renders a playable proxy MP4 with audio + burned captions", { skip: !hasFfmpeg }, () => {
    const s = setup();
    after(s.cleanup);
    // buildDraft writes empty placeholder files, so build the draft FIRST, then
    // overwrite those paths with real ffmpeg-generated media to decode.
    const draft = buildDraft(s.dir);
    const v1 = join(s.dir, "clip1.mp4");
    const v2 = join(s.dir, "clip2.mp4");
    const a1 = join(s.dir, "music.mp3");
    const gen = (args) => spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { encoding: "utf-8" });
    gen(["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15", "-pix_fmt", "yuv420p", v1]);
    gen(["-f", "lavfi", "-i", "testsrc2=duration=2:size=320x240:rate=15", "-pix_fmt", "yuv420p", v2]);
    gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=4", a1]);
    const draftPath = join(s.dir, "draft_content.json");
    writeFileSync(draftPath, JSON.stringify(draft));

    const out = join(s.dir, "preview.mp4");
    const r = spawnCli(["render", draftPath, "--out", out, "--burn-captions"], { timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.executed, true);
    assert.ok(existsSync(out) && statSync(out).size > 0, "expected a non-empty proxy file");

    // Probe: the proxy must carry both a video and an audio stream.
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", out], {
      encoding: "utf-8",
    });
    assert.match(probe.stdout, /video/);
    assert.match(probe.stdout, /audio/);
  });
});
