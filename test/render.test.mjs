import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildRenderPlan,
  filterNamesInGraph,
  PROBED_FILTERS,
  probeFfmpegCapabilities,
  renderDraft,
} from "../dist/render.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const US = 1_000_000;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;
const isWindows = process.platform === "win32"; // fake-ffmpeg tests use /bin/sh scripts

// -filters rows in ffmpeg's own format, addressable by name so a test can
// compose a fake build with exactly the filters it wants present.
const FILTER_LINES = {
  fps: " ... fps                V->V       Force constant framerate.",
  scale: " ... scale              V->V       Scale the input video size and/or convert the image format.",
  pad: " ... pad                V->V       Pad the input video.",
  setsar: " ... setsar             V->V       Set the pixel sample aspect ratio.",
  format: " ... format             V->V       Convert the input video to one of several formats.",
  trim: " ... trim               V->V       Pick one continuous section from the input, drop the rest.",
  setpts: " ... setpts             V->V       Set PTS for the output video frame.",
  concat: " ..C concat             N->N       Concatenate audio and video streams.",
  atrim: " ... atrim              A->A       Pick one continuous section from the input, drop the rest.",
  asetpts: " ... asetpts            A->A       Set PTS for the output audio frame.",
  adelay: " ... adelay             A->A       Delay one or more audio channels.",
  anull: " ... anull              A->A       Pass the source unchanged to the output.",
  amix: " ... amix               N->A       Audio mixing.",
  atempo: " ... atempo             A->A       Adjust audio tempo.",
  volume: " ... volume             A->A       Change input volume.",
  afade: " ... afade              A->A       Fade in/out input audio.",
};
const BASE_VIDEO_FILTERS = ["fps", "scale", "pad", "setsar", "format", "trim", "setpts", "concat"];
const UNCONDITIONAL_AUDIO_FILTERS = ["atrim", "asetpts", "adelay", "anull", "amix"];

// A stand-in for a minimal/custom ffmpeg build (e.g. Remotion's bundled
// compositor binary, #89): reports libx264 and the named filters as present,
// omitting everything else (by default the #89 shape: scale/format/trim/concat
// only, no fps/pad/setsar/setpts and no audio filters). Skipped on Windows
// because spawnSync cannot exec a shebang script directly there (same
// constraint as detect-scenes.test.mjs).
function fakeFfmpeg(dir, filters = ["scale", "format", "trim", "concat"]) {
  const path = join(dir, "fake-ffmpeg");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$*" in',
      "  *-filters*)",
      "    cat <<'EOF'",
      ...filters.map((name) => FILTER_LINES[name]),
      "EOF",
      "    exit 0 ;;",
      "  *-encoders*)",
      "    cat <<'EOF'",
      " V..... libx264              H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10",
      "EOF",
      "    exit 0 ;;",
      "esac",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

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
    assert.equal(typeof capabilities.fps, "boolean");
  });

  // #89: a minimal/custom ffmpeg build (Remotion's bundled compositor binary
  // is the reported case) can compile in scale/format/trim/concat but omit
  // fps/pad/setsar/setpts, which the base render chain needs on every segment
  // regardless of any flag. The probe must name exactly the missing ones.
  it("flags missing base-chain filters on a minimal ffmpeg build (#89)", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const capabilities = probeFfmpegCapabilities(fakeFfmpeg(s.dir));
    assert.equal(capabilities.available, true);
    assert.equal(capabilities.scale, true);
    assert.equal(capabilities.format, true);
    assert.equal(capabilities.trim, true);
    assert.equal(capabilities.concat, true);
    assert.equal(capabilities.x264, true);
    assert.equal(capabilities.fps, false);
    assert.equal(capabilities.pad, false);
    assert.equal(capabilities.setsar, false);
    assert.equal(capabilities.setpts, false);
  });

  it("throws when there is no usable video segment", () => {
    const s = setup();
    after(s.cleanup);
    const draft = buildDraft(s.dir);
    for (const v of draft.materials.videos) rmSync(v.path);
    assert.throws(() => buildRenderPlan(draft, { out: join(s.dir, "p.mp4") }), /no usable video segments/);
  });

  // #91: the audio filters read from the SAME -filters output as the video
  // base chain — same single probe, no extra spawn.
  it("probes the audio-chain filters from the same -filters output (#91)", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const capabilities = probeFfmpegCapabilities(
      fakeFfmpeg(s.dir, [...BASE_VIDEO_FILTERS, ...UNCONDITIONAL_AUDIO_FILTERS]),
    );
    assert.equal(capabilities.available, true);
    for (const name of UNCONDITIONAL_AUDIO_FILTERS) {
      assert.equal(capabilities[name], true, `'${name}' is listed and must probe true`);
    }
    assert.equal(capabilities.atempo, false);
    assert.equal(capabilities.volume, false);
    assert.equal(capabilities.afade, false);
  });

  // #91 guard: build a plan from a draft that exercises everything the graph
  // can emit — speed change (video + audio), volume, fades, captions, an
  // overlay with rotation and alpha, multiple audio tracks — and assert every
  // filter name in the generated filter_complex is either probed or on the
  // explicit allowlist below. A filter added to the chain without a probe (or
  // a deliberate allowlist entry) fails here, so chain and probe cannot drift
  // apart again.
  it("every filter the render graph emits is probed or explicitly allowlisted (#91)", () => {
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
    const audioTrack = draft.tracks.find((track) => track.type === "audio");
    audioTrack.segments[0].speed = 1.5; // atempo
    draft.materials.audio_fades.push({ id: "fade-1", fade_in_duration: 250_000, fade_out_duration: 500_000 });
    audioTrack.segments[0].extra_material_refs.push("fade-1"); // afade; volume 0.4 is already set
    draft.tracks.push({
      id: "ta2",
      type: "audio",
      name: "audio2",
      attribute: 0,
      segments: [
        {
          id: "seg-a2",
          material_id: "ma1",
          target_timerange: { start: US, duration: US },
          source_timerange: { start: 0, duration: US },
          speed: 1,
          volume: 1,
          visible: true,
          clip: null,
          extra_material_refs: [],
          render_index: 0,
        },
      ],
    });
    const plan = buildRenderPlan(draft, { out: join(s.dir, "p.mp4"), burnCaptions: true, allVideoTracks: true });
    const used = filterNamesInGraph(plan.filterComplex);
    const probed = new Set(PROBED_FILTERS);
    // null: the identity passthrough, present in any build that runs at all.
    // rotate/colorchannelmixer: overlay-transform cosmetics on the flag-gated
    // --all-video-tracks path, the same degrade class as overlay itself.
    const allowlisted = new Set(["null", "rotate", "colorchannelmixer"]);
    for (const name of used) {
      assert.ok(
        probed.has(name) || allowlisted.has(name),
        `filter '${name}' is emitted by the render graph but neither probed nor allowlisted — ` +
          "extend PROBED_FILTERS (and the renderDraft check) or the allowlist above",
      );
    }
    // The draft must stay representative: if a chain stops emitting one of
    // these, the guard above stops covering it.
    for (const name of PROBED_FILTERS.filter((n) => n !== "anull")) {
      assert.ok(used.includes(name), `representative draft no longer exercises '${name}'`);
    }
    // anull is the single-audio-segment variant of the amix line above.
    const single = buildRenderPlan(buildDraft(s.dir), { out: join(s.dir, "p.mp4") });
    assert.ok(filterNamesInGraph(single.filterComplex).includes("anull"));
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

  // #89: previously this reached ffmpeg and surfaced its raw, position-only
  // parse error ("No option name near '30'") with no mention of `fps` at all.
  it("fails fast naming the missing filters instead of a raw ffmpeg parse error (#89)", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const draftPath = join(s.dir, "draft_content.json");
    const draft = buildDraft(s.dir);
    writeFileSync(draftPath, JSON.stringify(draft));
    let err = null;
    try {
      renderDraft(draft, draftPath, { out: join(s.dir, "p.mp4"), ffmpegCmd: fakeFfmpeg(s.dir) });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected renderDraft to throw before invoking ffmpeg");
    assert.match(err.message, /'fps'/);
    assert.match(err.message, /'pad'/);
    assert.match(err.message, /'setsar'/);
    assert.match(err.message, /'setpts'/);
    assert.doesNotMatch(err.message, /'scale'/, "a present filter must not be named as missing");
    assert.match(err.message, /minimal\/custom ffmpeg builds/);
  });

  // #91: same failure class as #89, audio side — a build with the full video
  // chain but no audio filters previously reached ffmpeg and died on its raw
  // parser error instead of naming what is missing.
  it("fails fast naming the missing audio-chain filters (#91)", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const draftPath = join(s.dir, "draft_content.json");
    const draft = buildDraft(s.dir);
    writeFileSync(draftPath, JSON.stringify(draft));
    let err = null;
    try {
      renderDraft(draft, draftPath, { out: join(s.dir, "p.mp4"), ffmpegCmd: fakeFfmpeg(s.dir, BASE_VIDEO_FILTERS) });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected renderDraft to throw before invoking ffmpeg");
    for (const name of UNCONDITIONAL_AUDIO_FILTERS) {
      assert.match(err.message, new RegExp(`'${name}'`), `must name '${name}' as missing`);
    }
    assert.doesNotMatch(err.message, /'atempo'/, "conditional filters are not part of the unconditional check");
    assert.doesNotMatch(err.message, /'fps'/, "a present filter must not be named as missing");
    assert.match(err.message, /--ffmpeg-cmd/);
  });

  // #91: atempo/volume/afade are draft-dependent. A draft that uses them must
  // fail fast (silently dropping them would change the audio); a draft that
  // does not must keep rendering on the same build. dryRun stops renderDraft
  // right after the capability checks, so no real ffmpeg is needed.
  it("fails on a missing conditional audio filter only when the plan uses it (#91)", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const draftPath = join(s.dir, "draft_content.json");
    const ffmpegCmd = fakeFfmpeg(s.dir, [...BASE_VIDEO_FILTERS, ...UNCONDITIONAL_AUDIO_FILTERS]);

    const retimed = buildDraft(s.dir);
    const audioSeg = retimed.tracks.find((track) => track.type === "audio").segments[0];
    audioSeg.speed = 1.5; // atempo; volume 0.4 is already set
    retimed.materials.audio_fades.push({ id: "fade-1", fade_in_duration: 250_000, fade_out_duration: 0 });
    audioSeg.extra_material_refs.push("fade-1");
    writeFileSync(draftPath, JSON.stringify(retimed));
    let err = null;
    try {
      renderDraft(retimed, draftPath, { out: join(s.dir, "p.mp4"), ffmpegCmd, dryRun: true });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected renderDraft to throw for the retimed draft");
    assert.match(err.message, /'atempo'/);
    assert.match(err.message, /'volume'/);
    assert.match(err.message, /'afade'/);
    assert.match(err.message, /silently change the audio/);

    const plain = buildDraft(s.dir);
    plain.tracks.find((track) => track.type === "audio").segments[0].volume = 1;
    writeFileSync(draftPath, JSON.stringify(plain));
    const result = renderDraft(plain, draftPath, { out: join(s.dir, "p.mp4"), ffmpegCmd, dryRun: true });
    assert.equal(result.ok, true, "a draft that never retimes/fades must keep rendering on the same build");
  });

  // cmdRender routes --dry-run through buildRenderPlan directly (src/index.ts,
  // cmdRender), never through renderDraft/probeFfmpegCapabilities — on purpose,
  // so the plan stays inspectable on a machine with no ffmpeg at all (the
  // existing "--dry-run returns the plan" test above runs ungated on
  // ffmpeg-less machines for the same reason). The base-chain probe added for
  // #89 must not change that: this locks it in as a regression test.
  it("--dry-run stays ffmpeg-free even with a minimal ffmpeg build (#89)", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const draftPath = join(s.dir, "draft_content.json");
    writeFileSync(draftPath, JSON.stringify(buildDraft(s.dir)));
    const r = spawnCli([
      "render",
      draftPath,
      "--out",
      join(s.dir, "p.mp4"),
      "--dry-run",
      "--ffmpeg-cmd",
      fakeFfmpeg(s.dir),
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.executed, false);
    assert.equal(r.json.videoSegments, 2);
  });
});
