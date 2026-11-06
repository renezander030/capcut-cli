import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildRenderPlan, probeFfmpegCapabilities } from "../dist/render.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// `render --burn-captions` draws each caption in its text material's own font
// file (drawtext fontfile=) when the draft names one that exists, and keeps
// ffmpeg's default face otherwise; `caption_fonts` counts both.

const US = 1_000_000;
const isWindows = process.platform === "win32"; // ':' and '\' are not file-name characters there

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-render-fonts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A font-shaped file: drawtext is never run on it in the plan tests. */
function fakeFont(dir, name = "Caption.ttf") {
  const path = join(dir, name);
  writeFileSync(path, "not a real font");
  return path;
}

/** One video clip and one caption per entry of `texts` ({ content, font_path }). */
function draftWith(dir, texts) {
  const clip = join(dir, "clip.mp4");
  if (!existsSync(clip)) writeFileSync(clip, "");
  const seg = (id, matId, start, dur) => ({
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
  });
  return {
    id: "d",
    name: "fonts",
    duration: 2 * US,
    fps: 30,
    canvas_config: { width: 720, height: 1280, ratio: "9:16" },
    tracks: [
      { id: "tv", type: "video", name: "video", attribute: 0, segments: [seg("sv", "mv", 0, 2 * US)] },
      {
        id: "tt",
        type: "text",
        name: "captions",
        attribute: 0,
        segments: texts.map((_, i) => seg(`st${i}`, `mt${i}`, i * 500_000, 400_000)),
      },
    ],
    materials: {
      videos: [{ id: "mv", path: clip, type: "video", duration: 2 * US, width: 320, height: 240 }],
      audios: [],
      texts: texts.map((text, i) => ({ id: `mt${i}`, type: "text", ...text })),
      speeds: [],
      material_animations: [],
      audio_fades: [],
      transitions: [],
    },
  };
}

/** How a path appears inside drawtext's quoted fontfile option. */
const escapedPath = (path) => path.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

const content = (text, fontPath) =>
  JSON.stringify({
    text,
    styles: [{ range: [0, text.length], size: 15, ...(fontPath ? { font: { id: "", path: fontPath } } : {}) }],
  });

describe("render --burn-captions — draft fonts (plan)", () => {
  it("passes the material's font_path to drawtext as fontfile", (t) => {
    const dir = scratch(t);
    const font = fakeFont(dir);
    const plan = buildRenderPlan(draftWith(dir, [{ content: content("Hello"), font_path: font }]), {
      out: join(dir, "p.mp4"),
      burnCaptions: true,
    });
    assert.ok(plan.filterComplex.includes(`drawtext=text='Hello':fontfile='${escapedPath(font)}':`));
    assert.deepEqual(plan.caption_fonts, { from_draft: 1, default: 0 });
  });

  it("prefers the content's style font, which CapCut renders from, over font_path", (t) => {
    const dir = scratch(t);
    const styled = fakeFont(dir, "Styled.otf");
    const material = fakeFont(dir, "Material.ttf");
    const plan = buildRenderPlan(draftWith(dir, [{ content: content("Hi", styled), font_path: material }]), {
      out: join(dir, "p.mp4"),
      burnCaptions: true,
    });
    assert.match(plan.filterComplex, /fontfile='[^']*Styled\.otf'/);
    assert.doesNotMatch(plan.filterComplex, /Material\.ttf/);
  });

  it("falls back to font_path, then to ffmpeg's default face", (t) => {
    const dir = scratch(t);
    const ttc = fakeFont(dir, "Collection.TTC");
    mkdirSync(join(dir, "folder.ttf"));
    const texts = [
      { content: content("One", join(dir, "missing.ttf")), font_path: ttc }, // missing style font -> font_path
      { content: content("Two"), font_path: join(dir, "absent.ttf") }, // file does not exist
      { content: content("Three"), font_path: fakeFont(dir, "web.woff2") }, // not a font type drawtext reads
      { content: content("Four"), font_path: join(dir, "folder.ttf") }, // a directory
      { content: content("Five"), font_path: fakeFont(dir, "it's.ttf") }, // a quote cannot be written in the graph
      { content: content("Six") }, // no font named at all
    ];
    const plan = buildRenderPlan(draftWith(dir, texts), { out: join(dir, "p.mp4"), burnCaptions: true });
    assert.deepEqual(plan.caption_fonts, { from_draft: 1, default: 5 });
    assert.equal((plan.filterComplex.match(/fontfile=/g) ?? []).length, 1);
    assert.match(plan.filterComplex, /drawtext=text='One':fontfile='[^']*Collection\.TTC':/);
    for (const text of ["Two", "Three", "Four", "Five", "Six"]) {
      assert.match(plan.filterComplex, new RegExp(`drawtext=text='${text}':fontcolor=`));
    }
  });

  it("escapes a font path so it cannot leave the fontfile option", { skip: isWindows }, (t) => {
    const dir = scratch(t);
    const odd = join(dir, "fonts, [a]; b:c\\d");
    mkdirSync(odd);
    const font = fakeFont(odd, "x:fontcolor=red.ttf");
    const plan = buildRenderPlan(draftWith(dir, [{ content: content("Hey"), font_path: font }]), {
      out: join(dir, "p.mp4"),
      burnCaptions: true,
    });
    assert.ok(plan.filterComplex.includes(`fontfile='${escapedPath(font)}':fontcolor=white`), plan.filterComplex);
    assert.ok(escapedPath(font).endsWith("x\\:fontcolor=red.ttf"), "the colon in the file name is escaped");
    assert.deepEqual(plan.caption_fonts, { from_draft: 1, default: 0 });
  });

  it("reports no caption_fonts without --burn-captions", (t) => {
    const dir = scratch(t);
    const plan = buildRenderPlan(draftWith(dir, [{ content: content("Hello"), font_path: fakeFont(dir) }]), {
      out: join(dir, "p.mp4"),
    });
    assert.equal(plan.caption_fonts, undefined);
    assert.doesNotMatch(plan.filterComplex, /fontfile/);
  });

  it("--dry-run plans carry caption_fonts", (t) => {
    const dir = scratch(t);
    const draftPath = join(dir, "draft_content.json");
    writeFileSync(
      draftPath,
      JSON.stringify(
        draftWith(dir, [{ content: content("Hello"), font_path: fakeFont(dir) }, { content: content("World") }]),
      ),
    );
    const r = spawnCli(["render", draftPath, "--out", join(dir, "p.mp4"), "--burn-captions", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.executed, false);
    assert.deepEqual(r.json.caption_fonts, { from_draft: 1, default: 1 });
  });
});

// A real render needs ffmpeg with drawtext and a font on the machine.
const SYSTEM_FONTS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
];
const systemFont = SYSTEM_FONTS.find((path) => existsSync(path));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;
const canBurn = !isWindows && hasFfmpeg && systemFont !== undefined && probeFfmpegCapabilities("ffmpeg").drawtext;

describe("render --burn-captions — draft fonts (ffmpeg)", () => {
  it("renders captions in the draft's font, even from an awkward path", { skip: !canBurn }, (t) => {
    const dir = scratch(t);
    const odd = join(dir, "fonts, [a]; b:c");
    mkdirSync(odd);
    const font = join(odd, "Caption Font.ttf");
    copyFileSync(systemFont, font);
    const draft = draftWith(dir, [{ content: content("Hello"), font_path: font }]);
    const clip = join(dir, "clip.mp4");
    const gen = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=2:size=320x240:rate=15",
        "-pix_fmt",
        "yuv420p",
        clip,
      ],
      { encoding: "utf-8" },
    );
    assert.equal(gen.status, 0, gen.stderr);
    const draftPath = join(dir, "draft_content.json");
    writeFileSync(draftPath, JSON.stringify(draft));
    const out = join(dir, "preview.mp4");
    const r = spawnCli(["render", draftPath, "--out", out, "--burn-captions"], { timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.caption_fonts, { from_draft: 1, default: 0 });
    assert.ok(existsSync(out) && statSync(out).size > 0, "expected a non-empty proxy file");
  });
});
