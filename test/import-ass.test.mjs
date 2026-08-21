import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseAss } from "../dist/ass.js";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDir, tmpDraft } from "./helpers/tmp-draft.mjs";

const ASS_SAMPLE = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,18

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.50,Default,,0,0,0,,Hello world
Dialogue: 0,0:00:05.00,0:00:08.25,Default,,0,0,0,,{\\b1\\an8}Bold up\\NSecond line
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Comma, in text, works
`;

describe("capcut import-ass", () => {
  const fix = tmpDraft();
  let assPath;
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ass-"));
    assPath = join(dir, "sample.ass");
    writeFileSync(assPath, ASS_SAMPLE);
  });
  after(() => {
    fix.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("imports each Dialogue: as a text segment with correct timing", () => {
    const before = (spawnCli(["texts", fix.path]).json ?? []).length;
    const r = spawnCli(["import-ass", fix.path, assPath]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.format, "ass");
    assert.equal(r.json.cues, 3);
    assert.equal(r.json.first.start_us, 1_000_000);
    assert.equal(r.json.first.duration_us, 3_500_000);

    const after = (spawnCli(["texts", fix.path]).json ?? []).length;
    assert.equal(after, before + 3);
  });

  it("strips override codes and preserves comma-containing text", () => {
    const draft = loadDraft(fix.path);
    // Find the cue text in the materials.texts content blobs
    const allText = draft.materials.texts
      .map((t) => {
        try {
          return JSON.parse(t.content).text ?? "";
        } catch {
          return "";
        }
      })
      .join("\n");
    assert.match(allText, /Bold up/);
    assert.ok(!allText.includes("{\\b1"), "override codes stripped");
    assert.match(allText, /Comma, in text, works/);
  });

  it("respects --time-offset", () => {
    const fix2 = tmpDraft();
    try {
      const r = spawnCli(["import-ass", fix2.path, assPath, "--time-offset", "0.5s"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.first.start_us, 1_500_000);
    } finally {
      fix2.cleanup();
    }
  });

  it("rejects empty files with a clear error", () => {
    const empty = join(dir, "empty.ass");
    writeFileSync(empty, "");
    const r = spawnCli(["import-ass", fix.path, empty]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /0 cues|empty/i);
  });
});

const STYLED_SAMPLE = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,1,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,plain {\\b1}bold{\\b0} and {\\i1\\c&H0000FF&}red italic{\\r} end
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\fs30}big\\Nline {\\an8}stripped
`;

describe("parseAss — inline override tags become spans, not casualties", () => {
  const cues = parseAss(STYLED_SAMPLE);

  it("keeps the displayed text flat while carrying the overrides as spans", () => {
    assert.equal(cues[0].text, "plain bold and red italic end");
    assert.deepEqual(cues[0].spans, [
      { start: 6, end: 10, bold: true },
      { start: 15, end: 25, italic: true, color: "#FF0000" },
    ]);
  });

  it("drops tags that restate the style default (\\b0 after a bold range, \\r)", () => {
    // "\\b0 and " and " end" after \\r produce no span at all.
    assert.equal(cues[0].spans.length, 2);
  });

  it("measures offsets in code units of the final text, across \\N", () => {
    assert.equal(cues[1].text, "big\nline stripped");
    // \\fs persists to the end of the line; {\\an8} is stripped, not styling.
    assert.deepEqual(cues[1].spans, [{ start: 0, end: 17, size: 30 }]);
  });

  it("resolves the Dialogue's Style line into a segment-default seed", () => {
    assert.equal(cues[0].styleSeed.fontSize, 20);
    assert.equal(cues[0].styleSeed.color, "#FFFFFF");
    assert.equal(cues[0].styleSeed.alignment, 0); // ASS 1 = bottom-left
  });
});

describe("import-ass — inline overrides land as per-range styles", () => {
  const fix = tmpDraft();
  let assPath;
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ass-styled-"));
    assPath = join(dir, "styled.ass");
    writeFileSync(assPath, STYLED_SAMPLE);
    const r = spawnCli(["import-ass", fix.path, assPath]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });
  after(() => {
    fix.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  function contentFor(text) {
    const draft = loadDraft(fix.path);
    for (const t of draft.materials.texts) {
      try {
        const c = JSON.parse(t.content);
        if (c.text === text) return { material: t, content: c };
      } catch {
        /* not a JSON content blob */
      }
    }
    assert.fail(`no text material with text ${JSON.stringify(text)}`);
  }

  it("writes the tagged ranges into the material's styles[]", () => {
    const { content } = contentFor("plain bold and red italic end");
    const blocks = content.styles.map((s) => ({
      range: s.range,
      bold: s.bold,
      italic: s.italic,
      color: s.fill.content.solid.color,
    }));
    // Gap blocks inherit the seeded default; tagged ranges carry their overrides.
    assert.deepEqual(
      blocks.map((b) => b.range),
      [
        [0, 6],
        [6, 10],
        [10, 15],
        [15, 25],
        [25, 29],
      ],
    );
    assert.equal(blocks[1].bold, true);
    assert.equal(blocks[3].italic, true);
    assert.deepEqual(blocks[3].color, [1, 0, 0]);
    assert.equal(blocks[0].bold, false);
    assert.deepEqual(blocks[0].color, [1, 1, 1]);
  });

  it("seeds font size and size spans from the Style line and \\fs", () => {
    const { material, content } = contentFor("big\nline stripped");
    assert.equal(material.font_size, 20); // Style: Fontsize 20
    assert.equal(content.styles[0].size, 30); // {\fs30} span
    assert.deepEqual(content.styles[0].range, [0, 17]);
  });

  it("lets explicit flags beat the Style-line seed", () => {
    const fix2 = tmpDraft();
    try {
      const r = spawnCli(["import-ass", fix2.path, assPath, "--font-size", "12"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const draft = loadDraft(fix2.path);
      const sizes = draft.materials.texts.map((t) => t.font_size);
      assert.ok(sizes.includes(12));
      assert.ok(!sizes.includes(20));
    } finally {
      fix2.cleanup();
    }
  });
});

describe("export-ass -> import-ass round trip reproduces ranges and styles", () => {
  const t = tmpDir();
  after(() => t.cleanup());

  function addStyled(project, start, duration, text, styles) {
    const add = spawnCli(["add-text", project, start, duration, text]);
    assert.equal(add.status, 0, `stderr: ${add.stderr}`);
    if (styles) {
      const r = spawnCli(["text-ranges", project, add.json.segment_id, "--styles", JSON.stringify(styles)]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    }
  }

  it("re-imports its own styled export byte-identically (styles and timing)", () => {
    const init = spawnCli(["init", "src", "--drafts", t.dir]);
    assert.equal(init.status, 0, `stderr: ${init.stderr}`);
    const src = join(t.dir, "src");
    addStyled(src, "1s", "3s", "hello brave world", [{ start: 6, end: 11, font_color: "#FFD700", bold: true }]);
    addStyled(src, "5s", "2s", "sized italic here", [{ start: 0, end: 5, font_size: 20, italic: true }]);
    addStyled(src, "8s", "1s", "First line\nSecond line");

    const assPath = join(t.dir, "roundtrip.ass");
    const exp = spawnCli(["export-ass", src, "--out", assPath]);
    assert.equal(exp.status, 0, `stderr: ${exp.stderr}`);

    const init2 = spawnCli(["init", "dst", "--drafts", t.dir]);
    assert.equal(init2.status, 0, `stderr: ${init2.stderr}`);
    const dst = join(t.dir, "dst");
    const imp = spawnCli(["import-ass", dst, assPath]);
    assert.equal(imp.status, 0, `stderr: ${imp.stderr}`);
    assert.equal(imp.json.cues, 3);

    const parse = (project) => {
      const draft = loadDraft(join(project, "draft_content.json"));
      const track = draft.tracks.find((tr) => tr.type === "text");
      return track.segments
        .map((seg) => {
          const mat = draft.materials.texts.find((m) => m.id === seg.material_id);
          return { timerange: seg.target_timerange, content: JSON.parse(mat.content) };
        })
        .sort((a, b) => a.timerange.start - b.timerange.start);
    };
    const before = parse(src);
    const after = parse(dst);
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
      assert.deepEqual(after[i].timerange, before[i].timerange, `segment ${i} timing`);
      assert.equal(after[i].content.text, before[i].content.text, `segment ${i} text`);
      assert.deepEqual(after[i].content.styles, before[i].content.styles, `segment ${i} styles`);
    }
  });
});
