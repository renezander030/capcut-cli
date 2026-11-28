import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const samples = {
  th: "สวัสดีทุกคนวันนี้เราจะเรียนรู้การสร้างคำบรรยายภาษาไทยด้วยกัน",
  lo: "ສະບາຍດີທຸກຄົນພວກເຮົາຈະຮຽນພາສາລາວດ້ວຍກັນ",
  km: "សួស្តីអ្នកទាំងអស់គ្នាយើងនឹងរៀនភាសាខ្មែរជាមួយគ្នា",
  my: "မင်္ဂလာပါအားလုံးဒီနေ့မြန်မာစာကိုအတူလေ့လာကြမယ်",
};

function fixture(t, text, styles = []) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const draft = JSON.parse(readFileSync(fix.path, "utf8"));
  draft.materials.texts = [{ id: "SEA-M", type: "text", content: JSON.stringify({ text, styles }), font_size: 15 }];
  draft.tracks = [
    {
      id: "SEA-T",
      type: "text",
      name: "SEA-T",
      attribute: 0,
      segments: [
        {
          id: "SEA-S",
          material_id: "SEA-M",
          target_timerange: { start: 0, duration: 10000000 },
          source_timerange: { start: 0, duration: 10000000 },
          speed: 1,
          volume: 1,
          visible: true,
          clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
          extra_material_refs: [],
          render_index: 0,
        },
      ],
    },
  ];
  writeFileSync(fix.path, JSON.stringify(draft));
  return {
    ...fix,
    content: () =>
      JSON.parse(
        JSON.parse(readFileSync(fix.path, "utf8")).materials.texts.find((material) => material.id === "SEA-M").content,
      ),
  };
}

function lint(fix, repair = false) {
  const result = spawnCli([
    "lint",
    fix.path,
    "--max-chars",
    "12",
    "--no-check-paths",
    "--no-probe",
    ...(repair ? ["--fix"] : []),
  ]);
  assert.ok(result.json, result.stderr);
  return result.json;
}

const lengthIssue = (report) =>
  report.issues.find((issue) => issue.code === "line-too-long" && issue.location?.segment_id === "SEA-S");

describe("lint wraps spaceless text", () => {
  for (const [script, text] of Object.entries(samples)) {
    it(`offers and performs a grapheme-safe ${script} line-length repair`, (t) => {
      const fix = fixture(t, text);
      assert.equal(lengthIssue(lint(fix)).fixable, true);
      lint(fix, true);
      const wrapped = fix.content().text;
      assert.ok(wrapped.includes("\n"));
      assert.ok(wrapped.split("\n").every((line) => line.length <= 12));
      assert.equal(wrapped.replaceAll("\n", ""), text);
      assert.equal(lengthIssue(lint(fix)), undefined);
      const edges = new Set(
        [...new Intl.Segmenter(script, { granularity: "grapheme" }).segment(text)].map(
          (part) => part.index + part.segment.length,
        ),
      );
      let offset = 0;
      for (const line of wrapped.split("\n")) {
        offset += line.length;
        assert.ok(edges.has(offset));
      }
    });
  }

  it("moves UTF-16 style boundaries with inserted newlines, including an emoji", (t) => {
    const text = `😀${samples.th}`;
    const fix = fixture(t, text, [
      { range: [0, 2], bold: false },
      { range: [2, 35], bold: true },
      { range: [35, text.length], bold: false },
    ]);
    lint(fix, true);
    const content = fix.content();
    assert.ok(content.text.includes("\n"));
    const bold = content.styles.find((style) => style.bold);
    assert.equal(content.text.slice(...bold.range).replaceAll("\n", ""), text.slice(2, 35));
    assert.ok(bold.range[1] > 35);
  });

  it("converges without shifting styles a second time", (t) => {
    const fix = fixture(t, samples.th, [{ range: [0, samples.th.length], bold: true }]);
    lint(fix, true);
    const first = fix.content();
    assert.ok(first.text.includes("\n"));
    lint(fix, true);
    assert.deepEqual(fix.content(), first);
  });

  it("retains existing CRLF breaks while repairing each long source line", (t) => {
    const text = `${samples.th}\r\n${samples.th}`;
    const fix = fixture(t, text);
    lint(fix, true);
    const wrapped = fix.content().text;
    assert.ok(wrapped.includes("\r\n"));
    assert.ok(wrapped.split(/\r?\n/).every((line) => line.length <= 12));
    assert.equal(wrapped.replace(/\r?\n/g, ""), text.replace(/\r?\n/g, ""));
  });

  it("combines dictionary breaks with existing clause spaces through the style repair path", (t) => {
    const text = `${samples.th} ${samples.th}`;
    const fix = fixture(t, text, [{ range: [0, text.length], italic: true }]);
    lint(fix, true);
    const content = fix.content();
    assert.ok(content.text.split("\n").every((line) => line.length <= 12));
    assert.equal(content.text.replace(/[\n ]/g, ""), text.replaceAll(" ", ""));
    assert.equal(content.styles[0].range[1], content.text.length);
  });

  it("keeps an unbreakable Latin identifier intact", (t) => {
    const text = "long_unbreakable_identifier_that_must_stay_intact";
    const fix = fixture(t, text);
    assert.equal(lengthIssue(lint(fix)).fixable, false);
    lint(fix, true);
    assert.equal(fix.content().text, text);
  });
});
