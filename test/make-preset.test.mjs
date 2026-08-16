import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDir, tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut make-preset + add-text --preset roundtrip", () => {
  const src = tmpDraft();
  const out = tmpDir();
  after(() => {
    src.cleanup();
    out.cleanup();
  });

  it("styling extracted from a segment recreates itself in a fresh draft", () => {
    // 1. Style a text segment through CLI flags only.
    const added = spawnCli([
      "add-text",
      src.path,
      "1s",
      "3s",
      "styled caption",
      "--font-size",
      "24",
      "--color",
      "#FF3300",
      "--align",
      "2",
      "--x",
      "0.1",
      "--y",
      "-0.55",
    ]);
    assert.equal(added.status, 0, `stderr: ${added.stderr}`);
    const segId = added.json.segment_id;
    const styled = spawnCli([
      "text-style",
      src.path,
      segId,
      "--alpha",
      "0.9",
      "--shadow",
      "--shadow-color",
      "#00FF00",
      "--shadow-distance",
      "8",
      "--border-width",
      "20",
      "--border-color",
      "#0000FF",
      "--bg-color",
      "#112233",
      "--bg-alpha",
      "0.8",
    ]);
    assert.equal(styled.status, 0, `stderr: ${styled.stderr}`);
    const bubbled = spawnCli(["bubble-text", src.path, segId, "--bubble", "cloud"]);
    assert.equal(bubbled.status, 0, `stderr: ${bubbled.stderr}`);

    // 2. Extract the preset.
    const presetPath = join(out.dir, "style.json");
    const made = spawnCli(["make-preset", src.path, segId, "--out", presetPath]);
    assert.equal(made.status, 0, `stderr: ${made.stderr}`);
    assert.equal(made.json.ok, true);
    assert.ok(existsSync(presetPath));
    const preset = JSON.parse(readFileSync(presetPath, "utf-8"));
    assert.equal(preset.capcutCliPreset, 1);
    assert.equal(preset.style.font_size, 24);
    assert.equal(preset.style.text_color, "#FF3300");
    assert.equal(preset.style.shadow_color, "#00FF00");
    assert.deepEqual(preset.transform, { x: 0.1, y: -0.55 });
    assert.equal(preset.bubble.effect_id, "7137269184932778510");

    // 3. Apply into a fresh draft, then re-extract: a true roundtrip.
    const dst = tmpDraft();
    try {
      const applied = spawnCli(["add-text", dst.path, "0s", "2s", "new text", "--preset", presetPath]);
      assert.equal(applied.status, 0, `stderr: ${applied.stderr}`);
      assert.equal(applied.json.ok, true);

      const roundtripPath = join(out.dir, "roundtrip.json");
      const remade = spawnCli(["make-preset", dst.path, applied.json.segment_id, "--out", roundtripPath]);
      assert.equal(remade.status, 0, `stderr: ${remade.stderr}`);
      assert.deepEqual(JSON.parse(readFileSync(roundtripPath, "utf-8")), preset);

      // The styling landed on the draft itself, not just the preset file.
      const draft = loadDraft(dst.path);
      const mat = draft.materials.texts.find((t) => t.id === applied.json.material_id);
      assert.equal(mat.text_color, "#FF3300");
      assert.equal(mat.font_size, 24);
      assert.equal(mat.shadow_color, "#00FF00");
      assert.equal(mat.border_width, 20);
      assert.equal(mat.background_color, "#112233");
      assert.equal(mat.bubble_effect_id, "7137269184932778510");
      const content = JSON.parse(mat.content);
      assert.equal(content.text, "new text");
      assert.equal(content.styles[0].size, 24);
    } finally {
      dst.cleanup();
    }
  });
});

describe("--preset precedence and validation", () => {
  const fix = tmpDraft();
  const out = tmpDir();
  const presetPath = join(out.dir, "preset.json");
  writeFileSync(
    presetPath,
    JSON.stringify({
      capcutCliPreset: 1,
      style: {
        font_size: 24,
        text_color: "#FF3300",
        has_border: true,
        border_width: 20,
        border_color: "#0000FF",
        border_alpha: 1,
      },
      transform: { x: 0.1, y: -0.55 },
    }),
  );
  after(() => {
    fix.cleanup();
    out.cleanup();
  });

  it("add-text: explicit flags beat preset values", () => {
    const r = spawnCli([
      "add-text",
      fix.path,
      "0s",
      "2s",
      "flag wins",
      "--preset",
      presetPath,
      "--color",
      "#00CCFF",
      "--y",
      "0.3",
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const draft = loadDraft(fix.path);
    const mat = draft.materials.texts.find((t) => t.id === r.json.material_id);
    assert.equal(mat.text_color, "#00CCFF", "flag overrides preset color");
    assert.equal(mat.font_size, 24, "unflagged fields still come from the preset");
    assert.equal(mat.border_width, 20);
    const seg = draft.tracks.flatMap((t) => t.segments).find((s) => s.id === r.json.segment_id);
    assert.deepEqual(seg.clip.transform, { x: 0.1, y: 0.3 }, "flagged y wins, preset x kept");
  });

  it("text-style: explicit flags beat preset values", () => {
    const added = spawnCli(["add-text", fix.path, "3s", "2s", "restyle me"]);
    assert.equal(added.status, 0, `stderr: ${added.stderr}`);
    const r = spawnCli(["text-style", fix.path, added.json.segment_id, "--preset", presetPath, "--border-width", "5"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const draft = loadDraft(fix.path);
    const mat = draft.materials.texts.find((t) => t.id === added.json.material_id);
    assert.equal(mat.border_width, 5, "flag overrides preset border width");
    assert.equal(mat.border_color, "#0000FF", "unflagged fields still come from the preset");
    assert.equal(mat.text_color, "#FF3300");
  });

  it("text-style accepts --preset with no styling flags", () => {
    const added = spawnCli(["add-text", fix.path, "6s", "2s", "preset only"]);
    assert.equal(added.status, 0, `stderr: ${added.stderr}`);
    const r = spawnCli(["text-style", fix.path, added.json.segment_id, "--preset", presetPath]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json.applied.includes("style"));
  });

  it("rejects a missing preset file", () => {
    const r = spawnCli(["add-text", fix.path, "0s", "2s", "x", "--preset", join(out.dir, "nope.json")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not found/i);
  });

  it("rejects a preset that is not valid JSON", () => {
    const bad = join(out.dir, "bad.json");
    writeFileSync(bad, "{");
    const r = spawnCli(["add-text", fix.path, "0s", "2s", "x", "--preset", bad]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not valid JSON/i);
  });

  it("rejects JSON without the capcutCliPreset marker", () => {
    const bad = join(out.dir, "marker.json");
    writeFileSync(bad, JSON.stringify({ style: { font_size: 24 } }));
    const r = spawnCli(["text-style", fix.path, "deadbeef", "--preset", bad]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /capcutCliPreset/);
  });

  it("rejects an unsupported preset version", () => {
    const bad = join(out.dir, "v2.json");
    writeFileSync(bad, JSON.stringify({ capcutCliPreset: 2, style: {} }));
    const r = spawnCli(["add-text", fix.path, "0s", "2s", "x", "--preset", bad]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /version/i);
  });

  it("caption refuses --style-ref together with --preset", () => {
    const r = spawnCli([
      "caption",
      fix.path,
      "--audio",
      "missing.wav",
      "--style-ref",
      "deadbeef",
      "--preset",
      presetPath,
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /mutually exclusive/i);
  });
});

describe("capcut make-preset errors", () => {
  const fix = tmpDraft();
  const out = tmpDir();
  after(() => {
    fix.cleanup();
    out.cleanup();
  });

  it("requires --out", () => {
    const texts = spawnCli(["texts", fix.path]).json ?? [];
    if (texts.length === 0) return;
    const r = spawnCli(["make-preset", fix.path, texts[0].id.slice(0, 8)]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--out/);
  });

  it("rejects a non-text segment", () => {
    const videoSegs = spawnCli(["segments", fix.path, "--track", "video"]).json ?? [];
    if (videoSegs.length === 0) return;
    const r = spawnCli(["make-preset", fix.path, videoSegs[0].id.slice(0, 8), "--out", join(out.dir, "p.json")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /text segments/i);
  });

  it("rejects an unknown segment", () => {
    const r = spawnCli(["make-preset", fix.path, "ffffffff", "--out", join(out.dir, "p.json")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not found/i);
  });
});

// --- Regression: code-review findings v0.13.0 ---

// Pull the rendered content style blocks (CapCut renders from these, not the
// material fields) for a segment's text material.
function contentStyles(draftPath, materialId) {
  const draft = loadDraft(draftPath);
  const mat = draft.materials.texts.find((t) => t.id === materialId);
  return JSON.parse(mat.content).styles;
}

function solidColor(block) {
  return block.fill.content.solid.color;
}

// Finding 1: preset text_ranges must not defeat explicit --color/--font-size.
describe("--preset: explicit flags override preset text_ranges (karaoke)", () => {
  const src = tmpDraft();
  const out = tmpDir();
  const presetPath = join(out.dir, "karaoke.json");
  after(() => {
    src.cleanup();
    out.cleanup();
  });

  it("builds a karaoke preset carrying per-range colours/sizes", () => {
    const added = spawnCli(["add-text", src.path, "0s", "3s", "hello world hi"]);
    assert.equal(added.status, 0, `stderr: ${added.stderr}`);
    const styles = JSON.stringify([{ start: 6, end: 11, font_color: "#FFD700", font_size: 24, bold: true }]);
    const ranged = spawnCli(["text-ranges", src.path, added.json.segment_id, "--styles", styles]);
    assert.equal(ranged.status, 0, `stderr: ${ranged.stderr}`);
    const made = spawnCli(["make-preset", src.path, added.json.segment_id, "--out", presetPath]);
    assert.equal(made.status, 0, `stderr: ${made.stderr}`);
    const preset = JSON.parse(readFileSync(presetPath, "utf-8"));
    assert.ok(Array.isArray(preset.text_ranges) && preset.text_ranges.length > 1, "preset captured ranges");
  });

  it("flag colour/size win over EVERY captured range block", () => {
    const dst = tmpDraft();
    try {
      const r = spawnCli([
        "add-text",
        dst.path,
        "0s",
        "3s",
        "brand new caption",
        "--preset",
        presetPath,
        "--color",
        "#00FF00",
        "--font-size",
        "30",
      ]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const draft = loadDraft(dst.path);
      const mat = draft.materials.texts.find((t) => t.id === r.json.material_id);
      assert.equal(mat.text_color, "#00FF00");
      assert.equal(mat.font_size, 30);
      // No range block may keep the preset's gold/24 look.
      for (const block of contentStyles(dst.path, r.json.material_id)) {
        assert.equal(block.size, 30, "flag size overrides preset range size");
        assert.deepEqual(solidColor(block), [0, 1, 0], "flag colour overrides preset range colour");
      }
    } finally {
      dst.cleanup();
    }
  });

  it("without flags, the preset's per-range styling is preserved", () => {
    const dst = tmpDraft();
    try {
      const r = spawnCli(["add-text", dst.path, "0s", "3s", "brand new caption", "--preset", presetPath]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const gold = contentStyles(dst.path, r.json.material_id).find((b) => b.bold === true);
      assert.ok(gold, "gold highlight block survived");
      assert.equal(gold.size, 24, "preset range size kept when no flag given");
    } finally {
      dst.cleanup();
    }
  });
});

// Finding 2: schema validation of preset sub-objects.
describe("--preset: schema validation rejects malformed sub-objects", () => {
  const fix = tmpDraft();
  const out = tmpDir();
  after(() => {
    fix.cleanup();
    out.cleanup();
  });

  function applyBadPreset(preset) {
    const p = join(out.dir, `bad-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(preset));
    return spawnCli(["add-text", fix.path, "0s", "2s", "abc", "--preset", p]);
  }

  it("rejects a transform that is an array, not { x, y }", () => {
    const r = applyBadPreset({ capcutCliPreset: 1, style: {}, transform: [0.1, 0.2] });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /transform/i);
  });

  it("rejects a transform with non-numeric x/y", () => {
    const r = applyBadPreset({ capcutCliPreset: 1, style: {}, transform: { x: "0.5", y: 0.1 } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /transform/i);
  });

  it("rejects a string in a numeric style field", () => {
    const r = applyBadPreset({ capcutCliPreset: 1, style: { font_size: "huge" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /font_size/i);
  });

  it("rejects text_ranges that is not an array", () => {
    const r = applyBadPreset({ capcutCliPreset: 1, style: {}, text_ranges: "nope" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /text_ranges/i);
  });

  it("rejects a text range with end <= start", () => {
    const r = applyBadPreset({ capcutCliPreset: 1, style: {}, text_ranges: [{ start: 5, end: 2 }] });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /text_ranges/i);
  });

  it("rejects a bubble missing resource_id", () => {
    const r = applyBadPreset({ capcutCliPreset: 1, style: {}, bubble: { effect_id: "x" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /bubble/i);
  });

  it("a well-formed transform + text_ranges preset still applies", () => {
    const good = join(out.dir, "good.json");
    writeFileSync(
      good,
      JSON.stringify({
        capcutCliPreset: 1,
        style: { font_size: 24 },
        transform: { x: 0.1, y: 0.2 },
        text_ranges: [{ start: 0, end: 3, font_color: "#00FF00" }],
      }),
    );
    const r = spawnCli(["add-text", fix.path, "0s", "2s", "abcdef", "--preset", good]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const seg = loadDraft(fix.path)
      .tracks.flatMap((t) => t.segments)
      .find((s) => s.id === r.json.segment_id);
    assert.deepEqual(seg.clip.transform, { x: 0.1, y: 0.2 });
  });
});

// Finding 3: rangeless preset onto an already-multi-range segment.
describe("--preset: rangeless preset onto a multi-range segment", () => {
  const fix = tmpDraft();
  const out = tmpDir();
  after(() => {
    fix.cleanup();
    out.cleanup();
  });

  function multiRangeSegment(text) {
    const added = spawnCli(["add-text", fix.path, "0s", "3s", text]);
    assert.equal(added.status, 0, `stderr: ${added.stderr}`);
    const styles = JSON.stringify([{ start: 6, end: 11, font_color: "#FFD700", font_size: 24, bold: true }]);
    const ranged = spawnCli(["text-ranges", fix.path, added.json.segment_id, "--styles", styles]);
    assert.equal(ranged.status, 0, `stderr: ${ranged.stderr}`);
    assert.ok(contentStyles(fix.path, added.json.material_id).length > 1, "segment is multi-range");
    return added.json;
  }

  it("a rangeless preset collapses the segment to one uniform style", () => {
    const seg = multiRangeSegment("hello world hi");
    const p = join(out.dir, "plain.json");
    writeFileSync(p, JSON.stringify({ capcutCliPreset: 1, style: { font_size: 40, text_color: "#0000FF" } }));
    const r = spawnCli(["text-style", fix.path, seg.segment_id, "--preset", p]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const styles = contentStyles(fix.path, seg.material_id);
    assert.equal(styles.length, 1, "all range blocks collapsed to one");
    assert.equal(styles[0].size, 40);
    assert.deepEqual(solidColor(styles[0]), [0, 0, 1]);
    assert.deepEqual(styles[0].range, [0, "hello world hi".length], "the single block spans the whole text");
  });

  it("a preset WITH ranges keeps multiple blocks (no collapse)", () => {
    const seg = multiRangeSegment("hello world hi");
    const p = join(out.dir, "ranged.json");
    writeFileSync(
      p,
      JSON.stringify({
        capcutCliPreset: 1,
        style: { font_size: 18 },
        text_ranges: [{ start: 0, end: 5, font_color: "#FF0000" }],
      }),
    );
    const r = spawnCli(["text-style", fix.path, seg.segment_id, "--preset", p]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(contentStyles(fix.path, seg.material_id).length > 1, "ranged preset preserves range blocks");
  });
});

// Finding 4: make-preset must honour --dry-run.
describe("make-preset --dry-run", () => {
  const fix = tmpDraft();
  const out = tmpDir();
  let segId;
  after(() => {
    fix.cleanup();
    out.cleanup();
  });

  it("sets up a text segment to extract", () => {
    const added = spawnCli(["add-text", fix.path, "0s", "3s", "preview me", "--font-size", "22"]);
    assert.equal(added.status, 0, `stderr: ${added.stderr}`);
    segId = added.json.segment_id;
  });

  it("does not write the preset file under --dry-run", () => {
    const p = join(out.dir, "dry.json");
    const r = spawnCli(["make-preset", fix.path, segId, "--out", p, "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dryRun, true);
    assert.equal(r.json.written, false, "output reports the file was not written");
    assert.equal(existsSync(p), false, "no file created on disk");
  });

  it("does not clobber an existing preset under --dry-run", () => {
    const p = join(out.dir, "existing.json");
    const sentinel = '{"sentinel":true}';
    writeFileSync(p, sentinel);
    const r = spawnCli(["make-preset", fix.path, segId, "--out", p, "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(readFileSync(p, "utf-8"), sentinel, "existing file left untouched");
  });

  it("writes the preset file for a real (non-dry) run", () => {
    const p = join(out.dir, "real.json");
    const r = spawnCli(["make-preset", fix.path, segId, "--out", p]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.written, true);
    assert.ok(existsSync(p), "file written on disk");
    assert.equal(JSON.parse(readFileSync(p, "utf-8")).capcutCliPreset, 1);
  });
});
