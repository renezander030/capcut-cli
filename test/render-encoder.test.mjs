import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildRenderPlan, parseFfmpegEncoders, renderDraft } from "../dist/render.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const US = 1_000_000;
const isWindows = process.platform === "win32"; // fake-ffmpeg tests use /bin/sh scripts

// Captured from `ffmpeg -hide_banner -encoders`: the header + legend reuse the
// six-character capability column shape of the real rows, which is exactly
// what a naive parser trips over — kept verbatim so the parser is exercised
// against it.
const ENCODERS_OUTPUT = [
  "Encoders:",
  " V..... = Video",
  " A..... = Audio",
  " S..... = Subtitle",
  " .F.... = Frame-level multithreading",
  " ..S... = Slice-level multithreading",
  " ...X.. = Codec is experimental",
  " ....B. = Supports draw_horiz_band",
  " .....D = Supports direct rendering method 1",
  " ------",
  " V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)",
  " V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
  " V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)",
  " V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)",
  " V..... h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)",
  " A....D aac                  AAC (Advanced Audio Coding)",
  " S..... srt                  SubRip subtitle (codec subrip)",
].join("\n");

// A fake build whose -filters output satisfies every unconditional chain check
// (so renderDraft gets as far as the encoder validation) but whose -encoders
// list carries software encoders only — the machine without the hardware one.
function fakeFfmpeg(dir) {
  const path = join(dir, "fake-ffmpeg");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$*" in',
      "  *-filters*)",
      "    cat <<'EOF'",
      " ... fps                V->V       Force constant framerate.",
      " ... scale              V->V       Scale the input video size and/or convert the image format.",
      " ... pad                V->V       Pad the input video.",
      " ... setsar             V->V       Set the pixel sample aspect ratio.",
      " ... format             V->V       Convert the input video to one of several formats.",
      " ... trim               V->V       Pick one continuous section from the input, drop the rest.",
      " ... setpts             V->V       Set PTS for the output video frame.",
      " ..C concat             N->N       Concatenate audio and video streams.",
      " ... atrim              A->A       Pick one continuous section from the input, drop the rest.",
      " ... asetpts            A->A       Set PTS for the output audio frame.",
      " ... adelay             A->A       Delay one or more audio channels.",
      " ... anull              A->A       Pass the source unchanged to the output.",
      " ... amix               N->A       Audio mixing.",
      "EOF",
      "    exit 0 ;;",
      "  *-encoders*)",
      "    cat <<'EOF'",
      "Encoders:",
      " V..... = Video",
      " ------",
      " V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
      " A....D aac                  AAC (Advanced Audio Coding)",
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

// One video segment is all the encoder path needs.
function buildDraft(dir) {
  const clip = join(dir, "clip1.mp4");
  writeFileSync(clip, "");
  return {
    id: "d",
    name: "t",
    duration: 2 * US,
    fps: 30,
    canvas_config: { width: 720, height: 1280, ratio: "9:16" },
    tracks: [
      {
        id: "tv",
        type: "video",
        name: "video",
        attribute: 0,
        segments: [
          {
            id: "seg-1",
            material_id: "mv1",
            target_timerange: { start: 0, duration: 2 * US },
            source_timerange: { start: 0, duration: 2 * US },
            speed: 1,
            volume: 1,
            visible: true,
            clip: null,
            extra_material_refs: [],
            render_index: 0,
          },
        ],
      },
    ],
    materials: {
      videos: [
        { id: "mv1", path: clip, type: "video", material_name: "clip1.mp4", duration: 2 * US, width: 320, height: 240 },
      ],
      audios: [],
      texts: [],
      speeds: [],
      material_animations: [],
      audio_fades: [],
      transitions: [],
    },
  };
}

function setup(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("parseFfmpegEncoders (pure)", () => {
  it("extracts every encoder row, hardware ones included", () => {
    const names = parseFfmpegEncoders(ENCODERS_OUTPUT);
    for (const name of ["a64multi", "libx264", "h264_nvenc", "h264_qsv", "h264_videotoolbox", "aac", "srt"]) {
      assert.ok(names.has(name), `expected '${name}' in ${[...names].join(", ")}`);
    }
    assert.equal(names.size, 7);
  });

  it("does not mistake the header, legend, or separator for encoders", () => {
    const names = parseFfmpegEncoders(ENCODERS_OUTPUT);
    for (const junk of ["=", "Encoders:", "Video", "Audio", "------", "Frame-level"]) {
      assert.ok(!names.has(junk), `'${junk}' must not parse as an encoder`);
    }
  });

  it("handles CRLF output and empty input", () => {
    assert.ok(parseFfmpegEncoders(ENCODERS_OUTPUT.replaceAll("\n", "\r\n")).has("h264_nvenc"));
    assert.equal(parseFfmpegEncoders("").size, 0);
  });
});

describe("render --encoder — plan", () => {
  it("substitutes the -c:v value and changes nothing else", () => {
    const s = setup("capcut-render-encoder-plan-");
    after(s.cleanup);
    const out = join(s.dir, "p.mp4");
    const byDefault = buildRenderPlan(buildDraft(s.dir), { out });
    const slot = byDefault.args.indexOf("-c:v") + 1;
    assert.equal(byDefault.args[slot], "libx264", "no flag keeps today's encoder");

    const chosen = buildRenderPlan(buildDraft(s.dir), { out, encoder: "h264_videotoolbox" });
    assert.equal(chosen.args[slot], "h264_videotoolbox");
    const normalized = [...chosen.args];
    normalized[slot] = "libx264";
    assert.deepEqual(normalized, byDefault.args, "--encoder must only change the -c:v value");
  });

  it("--dry-run carries the chosen -c:v, ffmpeg-free", () => {
    const s = setup("capcut-render-encoder-dry-");
    after(s.cleanup);
    const draftPath = join(s.dir, "draft_content.json");
    writeFileSync(draftPath, JSON.stringify(buildDraft(s.dir)));
    const r = spawnCli(["render", draftPath, "--out", join(s.dir, "p.mp4"), "--dry-run", "--encoder", "h264_nvenc"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.executed, false);
    assert.equal(r.json.args[r.json.args.indexOf("-c:v") + 1], "h264_nvenc");
  });
});

describe("render --encoder — validation against the build", () => {
  it("fails fast naming the missing encoder and how to list the available ones", { skip: isWindows }, () => {
    const s = setup("capcut-render-encoder-miss-");
    after(s.cleanup);
    const draft = buildDraft(s.dir);
    const draftPath = join(s.dir, "draft_content.json");
    writeFileSync(draftPath, JSON.stringify(draft));
    let err = null;
    try {
      renderDraft(draft, draftPath, {
        out: join(s.dir, "p.mp4"),
        ffmpegCmd: fakeFfmpeg(s.dir),
        encoder: "h264_nvenc",
        dryRun: true,
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected renderDraft to throw before invoking ffmpeg");
    assert.match(err.message, /'h264_nvenc'/);
    assert.match(err.message, /-hide_banner -encoders/);
  });

  it("accepts an encoder the build lists", { skip: isWindows }, () => {
    const s = setup("capcut-render-encoder-hit-");
    after(s.cleanup);
    const draft = buildDraft(s.dir);
    const draftPath = join(s.dir, "draft_content.json");
    writeFileSync(draftPath, JSON.stringify(draft));
    const result = renderDraft(draft, draftPath, {
      out: join(s.dir, "p.mp4"),
      ffmpegCmd: fakeFfmpeg(s.dir),
      encoder: "libx264",
      dryRun: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.args[result.args.indexOf("-c:v") + 1], "libx264");
  });
});
