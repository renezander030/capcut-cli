import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseSubtitles } from "../dist/srt.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDir, tmpDraft } from "./helpers/tmp-draft.mjs";

const srt = (text) => `1\n00:00:01,000 --> 00:00:02,000\n${text}\n`;

describe("editable subtitle markup", () => {
  it("maps nested styles to final UTF-16 offsets, preserving the default raw parser", () => {
    const input = srt("A <b>😀<i>x</i>z</b>.");
    assert.equal(parseSubtitles(input)[0].text, "A <b>😀<i>x</i>z</b>.");
    const cue = parseSubtitles(input, true)[0];
    assert.equal(cue.text, "A 😀xz.");
    assert.deepEqual(cue.spans, [
      { start: 2, end: 4, bold: true },
      { start: 4, end: 5, bold: true, italic: true },
      { start: 5, end: 6, bold: true },
    ]);
  });

  it("decodes entities once and leaves ordinary comparisons and escaped tags literal", () => {
    const cue = parseSubtitles(srt("2 < 3 &amp; &lt;i&gt;x&lt;/i&gt; &#x1F600;"), true)[0];
    assert.equal(cue.text, "2 < 3 & <i>x</i> 😀");
    assert.deepEqual(cue.spans, []);
  });

  it("maps attributed font colors and reports unsupported font properties", () => {
    const cue = parseSubtitles(srt('<font color="#f00" face="Example">red</font> plain'), true)[0];
    assert.equal(cue.text, "red plain");
    assert.deepEqual(cue.spans, [{ start: 0, end: 3, font_color: "#FF0000" }]);
    assert.equal(cue.unsupportedStyles, 1);
  });

  it("combines WebVTT voice and ruby removal with editable bold and escaped literal markup", () => {
    const input = "WEBVTT\n\n00:01.000 --> 00:02.000\n<v Speaker><b>漢<ruby>字<rt>ji</rt></ruby></b> &lt;i&gt;</v>\n";
    const cue = parseSubtitles(input, true)[0];
    assert.equal(cue.text, "漢字 <i>");
    assert.deepEqual(cue.spans, [{ start: 0, end: 2, bold: true }]);
  });

  it("imports actual SRT markup as styled draft content and exports the visible text", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const source = join(fix.dir, "styled.srt");
    writeFileSync(source, srt('<b>Bold</b> <font color="red">red</font>'));
    const result = spawnCli(["import-srt", fix.path, source]);
    assert.equal(result.status, 0, result.stderr);
    const draft = JSON.parse(readFileSync(fix.path, "utf8"));
    const added = draft.materials.texts
      .map((material) => {
        try {
          return JSON.parse(material.content);
        } catch {
          return null;
        }
      })
      .find((content) => content?.text === "Bold red");
    assert.ok(added, "visible caption text must exclude recognized tags");
    assert.ok(
      added.styles.some((style) => style.bold === true),
      "bold run must remain editable",
    );
    const exported = spawnCli(["export-srt", fix.path]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(exported.stdout, /Bold red/);
    assert.ok(!exported.stdout.includes("<font"));
  });

  it("preserves italic runs through the quickstart entry point", (t) => {
    const fix = tmpDir();
    t.after(fix.cleanup);
    const source = join(fix.dir, "styled.srt");
    writeFileSync(source, srt("an <i>italic</i> cue"));
    const result = spawnCli(["quickstart", "styled", "--srt", source, "--drafts", fix.dir, "--template", "bundled"]);
    assert.equal(result.status, 0, result.stderr);
    const draft = JSON.parse(readFileSync(result.json.file_path, "utf8"));
    const content = draft.materials.texts
      .map((material) => JSON.parse(material.content))
      .find((item) => item.text === "an italic cue");
    assert.ok(content);
    assert.ok(content.styles.some((style) => style.italic && style.range[0] === 3 && style.range[1] === 9));
  });

  it("overlays keyword color while preserving inline bold and plain gaps", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const source = join(fix.dir, "styled.srt");
    writeFileSync(source, srt("<b>Bold</b> plain"));
    const result = spawnCli([
      "import-srt",
      fix.path,
      source,
      "--highlight-words",
      "Bold",
      "--keyword-color",
      "#00FF00",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const draft = JSON.parse(readFileSync(fix.path, "utf8"));
    const content = draft.materials.texts
      .flatMap((material) => {
        try {
          return [JSON.parse(material.content)];
        } catch {
          return [];
        }
      })
      .find((item) => item.text === "Bold plain");
    assert.ok(content);
    const bold = content.styles.find((style) => style.range[0] === 0 && style.range[1] === 4);
    assert.equal(bold.bold, true);
    assert.deepEqual(bold.fill.content.solid.color, [0, 1, 0]);
    assert.equal(content.styles.find((style) => style.range[0] === 4).bold, false);
  });

  it("preserves underline runs in compile caption operations", (t) => {
    const fix = tmpDir();
    t.after(fix.cleanup);
    const source = join(fix.dir, "styled.srt");
    const spec = join(fix.dir, "spec.json");
    const destination = join(fix.dir, "compiled");
    writeFileSync(source, srt("an <u>underlined</u> cue"));
    writeFileSync(
      spec,
      JSON.stringify({
        name: "Styled",
        width: 720,
        height: 1280,
        fps: 30,
        tracks: [{ type: "text", items: [{ text: "Example", start: 0, duration: 1 }] }],
        operations: [{ op: "captions", path: source }],
      }),
    );
    const result = spawnCli(["compile", spec, "--out", destination]);
    assert.equal(result.status, 0, result.stderr);
    const draft = JSON.parse(readFileSync(join(destination, "draft_content.json"), "utf8"));
    const content = draft.materials.texts
      .map((material) => JSON.parse(material.content))
      .find((item) => item.text === "an underlined cue");
    assert.ok(content);
    assert.ok(content.styles.some((style) => style.underline && style.range[0] === 3 && style.range[1] === 13));
  });
});
