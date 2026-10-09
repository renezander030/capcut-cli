import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildRenderPlan,
  checkOutputDuration,
  FIDELITY_CATEGORIES,
  FIDELITY_ID_CAP,
  fidelityCensus,
  frameToleranceUs,
  probeRenderOutput,
  renderDraft,
} from "../dist/render.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const US = 1_000_000;
const isWindows = process.platform === "win32"; // fake ffmpeg/ffprobe are /bin/sh scripts

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-render-fidelity-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const seg = (id, matId, start, dur, extra = {}) => ({
  id,
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

// Two contiguous main-track clips, one audio bed, one caption: everything the
// proxy reproduces once --burn-captions is on.
function plainDraft(dir) {
  const v1 = join(dir, "clip1.mp4");
  const v2 = join(dir, "clip2.mp4");
  const a1 = join(dir, "music.mp3");
  for (const p of [v1, v2, a1]) writeFileSync(p, "");
  return {
    id: "d",
    name: "t",
    duration: 4 * US,
    fps: 30,
    canvas_config: { width: 720, height: 1280, ratio: "9:16" },
    tracks: [
      {
        id: "tv",
        type: "video",
        name: "video",
        attribute: 0,
        segments: [seg("v1", "mv1", 0, 2 * US), seg("v2", "mv2", 2 * US, 2 * US)],
      },
      { id: "ta", type: "audio", name: "audio", attribute: 0, segments: [seg("a1", "ma1", 0, 4 * US)] },
      { id: "tt", type: "text", name: "captions", attribute: 0, segments: [seg("t1", "mt1", 0, 2 * US)] },
    ],
    materials: {
      videos: [
        { id: "mv1", path: v1, type: "video", material_name: "clip1.mp4", duration: 2 * US },
        { id: "mv2", path: v2, type: "video", material_name: "clip2.mp4", duration: 2 * US },
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

// Every category the census checks, one segment each where possible.
function richDraft(dir) {
  const d = plainDraft(dir);
  const ov = join(dir, "overlay.mp4");
  writeFileSync(ov, "");
  const main = d.tracks[0].segments;
  main[0].extra_material_refs = ["tr1", "mask1", "chroma1", "anim-video"];
  main[0].common_keyframes = [{ property_type: "KFTypePositionX", keyframe_list: [{ time_offset: 0 }] }];
  // A gap before the second clip: concat would pull it to 2s.
  main[1].target_timerange = { start: 3 * US, duration: 1 * US };
  main[1].source_timerange = { start: 0, duration: 1 * US };
  // An empty keyframe list is not animation.
  main[1].common_keyframes = [{ property_type: "KFTypeScaleX", keyframe_list: [] }];
  d.tracks[2].segments[0].extra_material_refs = ["anim-text"];
  d.tracks.push(
    { id: "to", type: "video", name: "overlay", attribute: 0, segments: [seg("o1", "mov", 0, 1 * US)] },
    { id: "ts", type: "sticker", name: "sticker", attribute: 0, segments: [seg("s1", "st1", 0, 1 * US)] },
    { id: "te", type: "effect", name: "effect", attribute: 0, segments: [seg("e1", "fx1", 0, 1 * US)] },
    { id: "tf", type: "filter", name: "filter", attribute: 0, segments: [seg("f1", "flt1", 0, 1 * US)] },
  );
  d.materials.videos[1].mix_mode = "Screen";
  d.materials.videos[1].matting = { flag: 2 };
  d.materials.videos.push({ id: "mov", path: ov, type: "video", material_name: "overlay.mp4", duration: US });
  d.materials.transitions = [{ id: "tr1", name: "Dissolve" }];
  d.materials.common_mask = [{ id: "mask1", type: "mask" }];
  d.materials.chromas = [{ id: "chroma1", type: "chromas" }];
  d.materials.video_effects = [
    { id: "fx1", type: "video_effect" },
    { id: "flt1", type: "filter" },
  ];
  d.materials.material_animations = [
    { id: "anim-video", type: "sticker_animation", animations: [{ type: "in" }] },
    { id: "anim-text", type: "sticker_animation", animations: [{ type: "out" }] },
  ];
  return d;
}

describe("render fidelity census (pure)", () => {
  it("a plain draft with burned captions is faithful and targets the draft duration", () => {
    const s = setup();
    after(s.cleanup);
    const plan = buildRenderPlan(plainDraft(s.dir), { out: join(s.dir, "p.mp4"), burnCaptions: true });
    assert.equal(plan.fidelity.faithful, true);
    assert.deepEqual(plan.fidelity.dropped, {});
    assert.equal(plan.fidelity.expected_duration_us, 4 * US);
    assert.deepEqual(plan.fidelity.checked, [...FIDELITY_CATEGORIES]);
  });

  it("text that is not burned counts as dropped", () => {
    const s = setup();
    after(s.cleanup);
    const plan = buildRenderPlan(plainDraft(s.dir), { out: join(s.dir, "p.mp4"), softCaptions: true });
    assert.equal(plan.fidelity.faithful, false);
    assert.deepEqual(plan.fidelity.dropped.text.segment_ids, ["t1"]);
    assert.match(plan.fidelity.dropped.text.hint, /--burn-captions/);
  });

  it("names every category the draft carries, with the affected segment ids", () => {
    const s = setup();
    after(s.cleanup);
    const census = buildRenderPlan(richDraft(s.dir), { out: join(s.dir, "p.mp4"), burnCaptions: true }).fidelity;
    const ids = Object.fromEntries(Object.entries(census.dropped).map(([k, v]) => [k, v.segment_ids]));
    assert.deepEqual(ids, {
      main_track_gaps: ["v2"],
      overlay_tracks: ["o1"],
      stickers: ["s1"],
      transitions: ["v1"],
      effects: ["e1"],
      filters: ["f1"],
      masks: ["v1"],
      keyframes: ["v1"],
      text_animations: ["t1"],
      video_animations: ["v1"],
      mix_modes: ["v2"],
      chroma: ["v1"],
      matting: ["v2"],
    });
    assert.equal(census.faithful, false);
    for (const entry of Object.values(census.dropped)) assert.equal(entry.count, entry.segment_ids.length);
  });

  it("--all-video-tracks composites overlays, so they leave the census", () => {
    const s = setup();
    after(s.cleanup);
    const census = fidelityCensus(richDraft(s.dir), { allVideoTracks: true, burnCaptions: true });
    assert.equal(census.dropped.overlay_tracks, undefined);
  });

  it("caps the id list but keeps the full count", () => {
    const s = setup();
    after(s.cleanup);
    const d = plainDraft(s.dir);
    const n = FIDELITY_ID_CAP + 5;
    d.tracks.push({
      id: "ts",
      type: "sticker",
      name: "sticker",
      attribute: 0,
      segments: Array.from({ length: n }, (_, i) => seg(`s${i}`, "st", i * 1000, 1000)),
    });
    const census = fidelityCensus(d, { burnCaptions: true });
    assert.equal(census.dropped.stickers.count, n);
    assert.equal(census.dropped.stickers.segment_ids.length, FIDELITY_ID_CAP);
  });

  it("main-track segments whose media is missing count as missing_media", () => {
    const s = setup();
    after(s.cleanup);
    const d = plainDraft(s.dir);
    d.materials.videos[1].path = join(s.dir, "gone.mp4");
    const plan = buildRenderPlan(d, { out: join(s.dir, "p.mp4"), burnCaptions: true });
    assert.deepEqual(plan.fidelity.dropped.missing_media.segment_ids, ["v2"]);
  });

  it("falls back to the last segment end when draft.duration is unset", () => {
    const s = setup();
    after(s.cleanup);
    const d = plainDraft(s.dir);
    d.duration = 0;
    assert.equal(fidelityCensus(d, {}).expected_duration_us, 4 * US);
  });
});

describe("render output verification (pure)", () => {
  it("tolerance is one frame at the render fps; drift within it passes", () => {
    assert.equal(frameToleranceUs(30), 33_333);
    assert.equal(frameToleranceUs(25), 40_000);
    const ok = checkOutputDuration(4 * US + 33_333, 4 * US, 30);
    assert.deepEqual(ok, {
      verified: true,
      duration_us: 4 * US + 33_333,
      expected_duration_us: 4 * US,
      drift_us: 33_333,
      tolerance_us: 33_333,
      within_tolerance: true,
    });
    const short = checkOutputDuration(3 * US, 4 * US, 30);
    assert.equal(short.drift_us, -US);
    assert.equal(short.within_tolerance, false);
  });

  it("an unprobeable output reports verified:false with a reason instead of failing", () => {
    const s = setup();
    after(s.cleanup);
    const missing = probeRenderOutput(join(s.dir, "nope.mp4"), 4 * US, 30);
    assert.equal(missing.verified, false);
    assert.match(missing.reason, /not found/);
    const out = join(s.dir, "p.mp4");
    writeFileSync(out, "");
    const noProbe = probeRenderOutput(out, 4 * US, 30, join(s.dir, "no-ffprobe"));
    assert.equal(noProbe.verified, false);
    assert.match(noProbe.reason, /ffprobe is unavailable/);
  });
});

// A fake ffmpeg with every probed filter and libx264 that "renders" by
// touching its last argument (the output path).
function fakeFfmpeg(dir) {
  const path = join(dir, "fake-ffmpeg");
  const filters = [
    "fps",
    "scale",
    "pad",
    "setsar",
    "format",
    "trim",
    "setpts",
    "concat",
    "atrim",
    "asetpts",
    "adelay",
    "anull",
    "amix",
    "atempo",
    "volume",
    "afade",
    "drawtext",
    "overlay",
  ];
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$*" in',
      "  *-filters*)",
      "    cat <<'EOF'",
      ...filters.map((name) => ` ... ${name.padEnd(18)} V->V       fake.`),
      "EOF",
      "    exit 0 ;;",
      "  *-encoders*)",
      "    cat <<'EOF'",
      " V..... libx264              H.264",
      " S..... mov_text             3GPP Timed Text subtitle",
      "EOF",
      "    exit 0 ;;",
      "esac",
      'for last; do :; done; : > "$last"',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

// A fake ffprobe reporting the container duration given in FAKE_FFPROBE_DURATION (seconds).
function fakeFfprobe(dir) {
  const path = join(dir, "fake-ffprobe");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "-version" ]; then echo "ffprobe version fake"; exit 0; fi',
      'printf \'{"streams":[{"codec_type":"video","width":360,"height":640}],"format":{"duration":"%s"}}\' "$FAKE_FFPROBE_DURATION"',
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

function writeDraft(dir, draft) {
  const path = join(dir, "draft_content.json");
  writeFileSync(path, JSON.stringify(draft));
  return path;
}

describe("render --strict", () => {
  it("--dry-run reports the census; --strict refuses an unfaithful plan", () => {
    const s = setup();
    after(s.cleanup);
    const draftPath = writeDraft(s.dir, richDraft(s.dir));
    const plain = spawnCli(["render", draftPath, "--out", join(s.dir, "p.mp4"), "--dry-run"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.json.fidelity.faithful, false);
    assert.equal(plain.json.fidelity.dropped.transitions.count, 1);

    const strict = spawnCli(["render", draftPath, "--out", join(s.dir, "p.mp4"), "--dry-run", "--strict"]);
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /refused \[render-unfaithful\]/);
    assert.match(strict.stderr, /transitions 1/);
  });

  it("--strict passes a faithful plan through", () => {
    const s = setup();
    after(s.cleanup);
    const draftPath = writeDraft(s.dir, plainDraft(s.dir));
    const r = spawnCli([
      "render",
      draftPath,
      "--out",
      join(s.dir, "p.mp4"),
      "--dry-run",
      "--strict",
      "--burn-captions",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.fidelity.faithful, true);
  });

  it("refuses before ffmpeg runs, so nothing is written", { skip: isWindows }, () => {
    const s = setup();
    after(s.cleanup);
    const out = join(s.dir, "p.mp4");
    assert.throws(
      () =>
        renderDraft(richDraft(s.dir), join(s.dir, "draft_content.json"), {
          out,
          ffmpegCmd: fakeFfmpeg(s.dir),
          strict: true,
        }),
      /refused \[render-unfaithful\]/,
    );
    assert.equal(existsSync(out), false);
  });
});

describe("render output verification (fake ffmpeg + ffprobe)", { skip: isWindows }, () => {
  function run(dir, durationSeconds, extra = []) {
    const draftPath = writeDraft(dir, plainDraft(dir));
    const out = join(dir, "p.mp4");
    const r = spawnCli(
      [
        "render",
        draftPath,
        "--out",
        out,
        "--ffmpeg-cmd",
        fakeFfmpeg(dir),
        "--ffprobe-cmd",
        fakeFfprobe(dir),
        "--burn-captions",
        ...extra,
      ],
      { env: { FAKE_FFPROBE_DURATION: String(durationSeconds) } },
    );
    return { r, out };
  }

  it("reports the probed duration and drift within one frame", () => {
    const s = setup();
    after(s.cleanup);
    const { r } = run(s.dir, "4.02", ["--verify"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.verification, {
      verified: true,
      duration_us: 4_020_000,
      expected_duration_us: 4 * US,
      drift_us: 20_000,
      tolerance_us: 33_333,
      within_tolerance: true,
    });
    assert.equal(typeof r.json.output, "string", "the existing output path field is unchanged");
  });

  it("drift beyond tolerance is reported; only --verify turns it into a failure, and the file stays", () => {
    const s = setup();
    after(s.cleanup);
    const lax = run(s.dir, "3.5");
    assert.equal(lax.r.status, 0, lax.r.stderr);
    assert.equal(lax.r.json.verification.within_tolerance, false);
    assert.equal(lax.r.json.verification.drift_us, -500_000);

    const strict = run(s.dir, "3.5", ["--verify"]);
    assert.notEqual(strict.r.status, 0);
    assert.equal(strict.r.json.verification.within_tolerance, false);
    assert.match(strict.r.stderr, /drifts -500000us/);
    assert.ok(existsSync(strict.out), "the rendered file is kept");
  });

  it("missing ffprobe: verified:false normally, a clear failure with --verify", () => {
    const s = setup();
    after(s.cleanup);
    const draftPath = writeDraft(s.dir, plainDraft(s.dir));
    const args = [
      "render",
      draftPath,
      "--out",
      join(s.dir, "p.mp4"),
      "--ffmpeg-cmd",
      fakeFfmpeg(s.dir),
      "--ffprobe-cmd",
      join(s.dir, "no-such-ffprobe"),
    ];
    const lax = spawnCli(args);
    assert.equal(lax.status, 0, lax.stderr);
    assert.equal(lax.json.verification.verified, false);
    assert.match(lax.json.verification.reason, /ffprobe is unavailable/);

    const strict = spawnCli([...args, "--verify"]);
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /could not be verified: ffprobe is unavailable/);
  });
});
