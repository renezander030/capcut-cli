import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  assStyleFromMaterial,
  assTime,
  defaultAssStyle,
  formatAssColor,
  formatAssInlineColor,
  parseAss,
  parseAssColor,
  renderAss,
} from "../dist/ass.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDir } from "./helpers/tmp-draft.mjs";

function initDraft(dir, name) {
  const r = spawnCli(["init", name, "--drafts", dir]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return join(dir, name);
}

function addText(project, start, duration, text) {
  const r = spawnCli(["add-text", project, start, duration, text]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return r.json.segment_id;
}

function addHighlightedText(project, start, duration, text, from, to) {
  const id = addText(project, start, duration, text);
  const styles = JSON.stringify([{ start: from, end: to, font_color: "#FFD700", bold: true }]);
  const r = spawnCli(["text-ranges", project, id, "--styles", styles]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return id;
}

describe("ASS colour encoding — &H is blue-green-red, alpha 00 = opaque", () => {
  it("writes #RRGGBB as &HAABBGGRR in the Style-line form", () => {
    assert.equal(formatAssColor("#FFD700", 1), "&H0000D7FF");
    assert.equal(formatAssColor("#FF0000", 1), "&H000000FF");
    assert.equal(formatAssColor("#0000FF", 0), "&HFFFF0000");
    assert.equal(formatAssColor("#FFFFFF", 1), "&H00FFFFFF");
  });

  it("writes #RRGGBB as &HBBGGRR& in the inline override form", () => {
    assert.equal(formatAssInlineColor("#FFD700"), "&H00D7FF&");
    assert.equal(formatAssInlineColor("#FF0000"), "&H0000FF&");
  });

  it("parses both forms back to #RRGGBB", () => {
    assert.deepEqual(parseAssColor("&H00D7FF&"), { color: "#FFD700" });
    assert.deepEqual(parseAssColor("&H0000D7FF"), { color: "#FFD700", alpha: 1 });
    assert.deepEqual(parseAssColor("&HFF0000FF"), { color: "#FF0000", alpha: 0 });
    // The low byte is red: &HFF& is pure red, not blue.
    assert.deepEqual(parseAssColor("&hff&"), { color: "#FF0000" });
    assert.equal(parseAssColor("not-a-colour"), null);
  });

  it("round-trips through both directions", () => {
    assert.equal(parseAssColor(formatAssInlineColor("#123456")).color, "#123456");
    assert.equal(parseAssColor(formatAssColor("#123456", 1)).color, "#123456");
  });
});

describe("assTime — H:MM:SS.cc with centisecond rollover carry", () => {
  it("rounds to centiseconds and carries into seconds", () => {
    assert.equal(assTime(0), "0:00:00.00");
    assert.equal(assTime(1_999_999), "0:00:02.00");
    assert.equal(assTime(1_234_567), "0:00:01.23");
  });

  it("carries across minute and hour boundaries", () => {
    assert.equal(assTime(3_599_999_600), "1:00:00.00");
    assert.equal(assTime(59_999_700), "0:01:00.00");
  });
});

describe("renderAss — pure writer, no draft required", () => {
  const style = { ...defaultAssStyle("Default") };

  it("emits Script Info with PlayRes, a V4+ Styles line, and Dialogue events", () => {
    const doc = {
      title: "My cut",
      playResX: 1080,
      playResY: 1920,
      styles: [style],
      events: [{ startUs: 1_000_000, endUs: 4_500_000, text: "Hello world", style: "Default" }],
    };
    const out = renderAss(doc);
    assert.match(out, /^\[Script Info\]\nTitle: My cut\n/);
    assert.match(out, /PlayResX: 1080\nPlayResY: 1920\n/);
    assert.match(out, /\[V4\+ Styles\]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour,/);
    assert.ok(
      out.includes(
        "Style: Default,Arial,15,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1",
      ),
    );
    assert.ok(out.includes("Dialogue: 0,0:00:01.00,0:00:04.50,Default,,0,0,0,,Hello world"));
  });

  it("renders spans as inline overrides and resets to the style afterwards", () => {
    const doc = {
      playResX: 1920,
      playResY: 1080,
      styles: [style],
      events: [
        {
          startUs: 0,
          endUs: 1_000_000,
          text: "hello brave world",
          style: "Default",
          spans: [{ start: 6, end: 11, bold: true, color: "#FFD700" }],
        },
      ],
    };
    assert.ok(renderAss(doc).includes(",,hello {\\b1\\c&H00D7FF&}brave{\\b0\\c&HFFFFFF&} world"));
  });

  it("emits \\fs and \\i for size/italic spans", () => {
    const doc = {
      playResX: 1920,
      playResY: 1080,
      styles: [style],
      events: [
        {
          startUs: 0,
          endUs: 1_000_000,
          text: "ab cd",
          style: "Default",
          spans: [{ start: 3, end: 5, italic: true, size: 18.5 }],
        },
      ],
    };
    assert.ok(renderAss(doc).includes(",,ab {\\i1\\fs18.5}cd"));
  });

  it("escapes newlines as \\N and literal braces as \\{ \\}", () => {
    const doc = {
      playResX: 1920,
      playResY: 1080,
      styles: [style],
      events: [{ startUs: 0, endUs: 1_000_000, text: "a{b}\nc", style: "Default" }],
    };
    assert.ok(renderAss(doc).includes(",,a\\{b\\}\\Nc"));
  });

  it("renders words as {\\k} centisecond timing, preserving onsets across gaps", () => {
    const doc = {
      playResX: 1920,
      playResY: 1080,
      styles: [style],
      events: [
        {
          startUs: 1_000_000,
          endUs: 2_500_000,
          text: "one two three",
          style: "Default",
          words: [
            { word: "one", startUs: 1_000_000, endUs: 1_400_000 },
            { word: "two", startUs: 1_400_000, endUs: 1_700_000 },
            // 100ms gap before "three": its \k stretches so the onset holds.
            { word: "three", startUs: 1_800_000, endUs: 2_500_000 },
          ],
        },
      ],
    };
    assert.ok(renderAss(doc).includes(",,{\\k40}one {\\k40}two {\\k70}three"));
  });

  it("falls back to a Default style when the document has none", () => {
    const out = renderAss({ playResX: 1920, playResY: 1080, styles: [], events: [] });
    assert.match(out, /Style: Default,Arial,15,/);
    assert.match(out, /\[Events\]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n$/);
  });
});

describe("assStyleFromMaterial — base style + differing spans from content JSON", () => {
  it("picks the widest-covering block as base even when the highlight is styles[0]", () => {
    // A karaoke word-segment highlighting word 0 stores the highlight FIRST.
    const content = JSON.stringify({
      text: "one two three",
      styles: [
        { range: [0, 3], size: 15, bold: true, fill: { content: { solid: { alpha: 1, color: [1, 215 / 255, 0] } } } },
        { range: [3, 13], size: 15, bold: false, fill: { content: { solid: { alpha: 1, color: [1, 1, 1] } } } },
      ],
    });
    const { style, spans } = assStyleFromMaterial({ content, alignment: 1 });
    assert.equal(style.color, "#FFFFFF");
    assert.equal(style.bold, false);
    assert.equal(style.alignment, 2);
    assert.deepEqual(spans, [{ start: 0, end: 3, bold: true, color: "#FFD700" }]);
  });

  it("maps draft alignment 0/1/2 to ASS bottom-row 1/2/3", () => {
    const content = JSON.stringify({ text: "x", styles: [] });
    assert.equal(assStyleFromMaterial({ content, alignment: 0 }).style.alignment, 1);
    assert.equal(assStyleFromMaterial({ content, alignment: 2 }).style.alignment, 3);
  });
});

describe("export-ass — styled draft to ASS via the CLI", () => {
  const t = tmpDir();
  after(() => t.cleanup());

  it("emits PlayRes from the canvas and per-range overrides in the Dialogue", () => {
    const project = initDraft(t.dir, "styled");
    addHighlightedText(project, "1s", "3s", "hello brave world", 6, 11);
    const r = spawnCli(["export-ass", project]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /PlayResX: 1920\nPlayResY: 1080\n/);
    assert.match(r.stdout, /Style: Default,Arial,15,&H00FFFFFF,/);
    assert.ok(
      r.stdout.includes(
        "Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,hello {\\b1\\c&H00D7FF&}brave{\\b0\\c&HFFFFFF&} world",
      ),
    );
    // The exported document is valid ASS to our own parser: same cue timing,
    // overrides stripped back out of the visible text.
    const cues = parseAss(r.stdout);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].startUs, 1_000_000);
    assert.equal(cues[0].endUs, 4_000_000);
    assert.equal(cues[0].text, "hello brave world");
  });

  it("escapes multiline text as \\N", () => {
    const project = initDraft(t.dir, "multiline");
    addText(project, "0s", "1s", "First line\nSecond line");
    const r = spawnCli(["export-ass", project]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(",,First line\\NSecond line"));
  });

  it("--out writes the file and prints a JSON summary instead", () => {
    const project = initDraft(t.dir, "outfile");
    addText(project, "0s", "1s", "hello");
    const outPath = join(t.dir, "subs.ass");
    const r = spawnCli(["export-ass", project, "--out", outPath]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.events, 1);
    assert.match(readFileSync(outPath, "utf-8"), /\[Script Info\][\s\S]*Dialogue: 0,0:00:00\.00,0:00:01\.00,/);
  });

  it("emits a valid document with no Dialogue lines for an empty draft", () => {
    const project = initDraft(t.dir, "empty");
    const r = spawnCli(["export-ass", project]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /\[V4\+ Styles\]/);
    assert.doesNotMatch(r.stdout, /^Dialogue:/m);
  });
});

describe("export-ass --karaoke — stored word timings become {\\k} tags", () => {
  const t = tmpDir();
  after(() => t.cleanup());

  it("collapses caption --karaoke word segments into one timed Dialogue", () => {
    // Rebuild what `caption --karaoke` writes (src/caption.ts): one
    // full-phrase segment per word, word-timed, that word's range highlighted.
    const project = initDraft(t.dir, "karaoke");
    const words = [
      ["1s", "0.4s", 0, 3],
      ["1.4s", "0.4s", 4, 7],
      ["1.8s", "0.7s", 8, 13],
    ];
    for (const [start, duration, from, to] of words) {
      addHighlightedText(project, start, duration, "one two three", from, to);
    }
    const r = spawnCli(["export-ass", project, "--karaoke"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\k40}one {\\k40}two {\\k70}three"),
    );
    // Highlight paint: gold PrimaryColour, white (base) SecondaryColour.
    assert.match(r.stdout, /Style: Default,Arial,15,&H0000D7FF,&H00FFFFFF,/);
  });

  it("interpolates {\\k} for plain cues the way export-srt word granularity does", () => {
    const project = initDraft(t.dir, "plain");
    addText(project, "1s", "3s", "hello brave world");
    const r = spawnCli(["export-ass", project, "--karaoke"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // 5+5+5 chars over 3s: equal thirds of 100cs each.
    assert.ok(r.stdout.includes(",,{\\k100}hello {\\k100}brave {\\k100}world"));
  });
});
