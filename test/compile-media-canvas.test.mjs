import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-compile-133-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spec = join(dir, "spec.json");
  const out = join(dir, "Built");
  return { dir, spec, out };
}

function writeSpec(s, fields = {}, items) {
  writeFileSync(
    s.spec,
    JSON.stringify({
      name: "Built",
      ...fields,
      tracks: items
        ? [{ type: "video", items }]
        : [{ type: "text", items: [{ text: "TEST", start: 0, duration: 12 }] }],
    }),
  );
}

function readDraft(s) {
  return JSON.parse(readFileSync(join(s.out, "draft_content.json"), "utf-8"));
}

describe("compile canvas and source ranges (#133)", () => {
  for (const fields of [
    { ratio: "9:16" },
    { width: 1080, height: 1920 },
    { ratio: "9:16", width: 720, height: 1280 },
  ]) {
    it(`resolves the same canvas for --check and compile: ${JSON.stringify(fields)}`, (t) => {
      const s = setup(t);
      writeSpec(s, fields);
      const plan = spawnCli(["compile", s.spec, "--check"]);
      assert.equal(plan.status, 0, plan.stderr);
      const compiled = spawnCli(["compile", s.spec, "--out", s.out]);
      assert.equal(compiled.status, 0, compiled.stderr);
      const { fps, ...canvas } = plan.json.canvas;
      assert.equal(canvas.ratio, "9:16");
      assert.deepEqual(readDraft(s).canvas_config, canvas);
    });
  }

  it("rejects invalid canvas flags before creating a draft", (t) => {
    const s = setup(t);
    for (const fields of [{ width: 1080 }, { ratio: "sideways" }, { width: -1, height: 1920 }]) {
      writeSpec(s, fields);
      for (const extra of [["--check"], ["--out", s.out]]) {
        assert.equal(spawnCli(["compile", s.spec, ...extra]).status, 1);
        assert.equal(existsSync(s.out), false);
      }
    }
  });

  it("keeps nonzero in-points addressable when ffprobe cannot read the source", (t) => {
    const s = setup(t);
    writeFileSync(join(s.dir, "clip.mp4"), "unprobeable media");
    writeSpec(s, { ratio: "9:16" }, [{ path: "clip.mp4", start: 0, sourceStart: 40, duration: 6 }]);
    const r = spawnCli(["compile", s.spec, "--out", s.out]);
    assert.equal(r.status, 0, r.stderr);
    const d = readDraft(s);
    assert.equal(d.materials.videos[0].duration, 46_000_000);
    assert.deepEqual(d.tracks[0].segments[0].source_timerange, { start: 40_000_000, duration: 6_000_000 });
  });

  it("uses the full probed duration for both cuts and sidecar metadata", (t) => {
    if (spawnSync("ffprobe", ["-version"]).status !== 0) return t.skip("ffprobe not installed");
    const s = setup(t);
    // A real, small PCM source supplies an exact 89.28-second ffprobe duration.
    // Both factories must separate source duration from timeline duration.
    const samples = 89_280;
    const wav = Buffer.alloc(44 + samples, 128);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + samples, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(1000, 24);
    wav.writeUInt32LE(1000, 28);
    wav.writeUInt16LE(1, 32);
    wav.writeUInt16LE(8, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples, 40);
    writeFileSync(join(s.dir, "clip.wav"), wav);
    const items = [20, 40].map((sourceStart, i) => ({
      ref: `v${i}`,
      path: "clip.wav",
      start: i * 6,
      sourceStart,
      duration: 6,
    }));
    writeSpec(s, { ratio: "9:16" }, items);
    const spec = JSON.parse(readFileSync(s.spec, "utf-8"));
    spec.tracks.push({ type: "audio", items: [{ path: "clip.wav", start: 0, sourceStart: 20, duration: 6 }] });
    writeFileSync(s.spec, JSON.stringify(spec));
    const r = spawnCli(["compile", s.spec, "--out", s.out]);
    assert.equal(r.status, 0, r.stderr);
    const d = readDraft(s);
    for (const material of [...d.materials.videos, ...d.materials.audios]) assert.equal(material.duration, 89_280_000);
    assert.deepEqual(
      d.tracks.find((track) => track.type === "video").segments.map((seg) => seg.source_timerange),
      [
        { start: 20_000_000, duration: 6_000_000 },
        { start: 40_000_000, duration: 6_000_000 },
      ],
    );
    const meta = JSON.parse(readFileSync(join(s.out, "draft_meta_info.json"), "utf-8"));
    const registered = meta.draft_materials.flatMap((group) => group.value);
    assert.ok(registered.length > 0);
    for (const material of registered) assert.equal(material.duration, 89_280_000);
    items[0].sourceStart = 80;
    items[0].speed = 2;
    writeSpec(s, {}, items);
    const badOut = join(s.dir, "Invalid");
    for (const flags of [["--check"], ["--out", badOut]]) {
      const bad = spawnCli(["compile", s.spec, ...flags]);
      assert.equal(bad.status, 1, bad.stderr);
      assert.match(bad.stderr, /source range.*exceeds source duration/);
      assert.equal(existsSync(badOut), false);
    }
  });
});
