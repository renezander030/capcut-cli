import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// Caption limits by script. The Latin defaults (42 characters per line, 20
// per second) let a 32-character Chinese line through although a CJK line is
// full at 16 and unreadable past about 9 characters per second; the streaming
// style guides differ per script (zh 16/9, ja 13/4, ko 16/12). An explicit
// --max-chars / --max-cps applies to every script.

function textMat(id, text) {
  return {
    id,
    type: "text",
    content: JSON.stringify({ text, styles: [] }),
    font_size: 15,
    text_color: "#FFFFFF",
    alignment: 1,
  };
}

function textSeg(id, materialId, startUs, durationUs) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start: startUs, duration: durationUs },
    source_timerange: { start: 0, duration: durationUs },
    speed: 1,
    volume: 1,
    visible: true,
    clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
    extra_material_refs: [],
    render_index: 0,
  };
}

/** A fixture copy with one caption of the given text and duration on its own text track. */
function draftWithCaption(t, text, durationUs) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
  draft.materials.texts = [...(draft.materials.texts ?? []), textMat("CJK-M", text)];
  draft.tracks.push({
    id: "CJK-T",
    type: "text",
    name: "CJK-T",
    attribute: 0,
    segments: [textSeg("CJK-S", "CJK-M", 10_000_000, durationUs)],
  });
  writeFileSync(fix.path, JSON.stringify(draft));
  return fix;
}

function lengthAndSpeed(issues) {
  return issues.filter((i) => i.code === "line-too-long" || i.code === "caption-too-fast");
}

const ZH_32 = "今天我们来聊一聊剪映草稿的自动化处理方法以及常见的坑，一起看看吧"; // 32 characters
const JA_28 = "きょうはじまるあたらしいものがたりをいっしょにみましょう"; // 28 kana
const KO_30 = "오늘은 새로운 이야기를 함께 시작해 보겠습니다 기대돼요"; // 30 code units

describe("capcut lint — caption limits follow the caption's script", () => {
  it("holds a Chinese caption to 16 characters per line and 9 per second", (t) => {
    const fix = draftWithCaption(t, ZH_32, 2_000_000);
    const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
    const found = lengthAndSpeed(r.json.issues);
    const line = found.find((i) => i.code === "line-too-long");
    const speed = found.find((i) => i.code === "caption-too-fast");
    assert.ok(line, `expected line-too-long; got: ${JSON.stringify(r.json.issues)}`);
    assert.match(line.message, /32-char line \(>16, zh default\)/);
    assert.equal(line.fixable, true, "a CJK line re-wraps between characters");
    assert.ok(speed, `expected caption-too-fast; got: ${JSON.stringify(r.json.issues)}`);
    assert.match(speed.message, /chars\/s \(>9, zh default\)/);
  });

  it("holds a Japanese caption to 13 characters per line and 4 per second", (t) => {
    const fix = draftWithCaption(t, JA_28, 3_000_000);
    const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
    const found = lengthAndSpeed(r.json.issues);
    assert.match(found.find((i) => i.code === "line-too-long")?.message ?? "", /\(>13, ja default\)/);
    assert.match(found.find((i) => i.code === "caption-too-fast")?.message ?? "", /\(>4, ja default\)/);
  });

  it("holds a Korean caption to 16 characters per line and 12 per second", (t) => {
    const fix = draftWithCaption(t, KO_30, 1_500_000);
    const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
    const found = lengthAndSpeed(r.json.issues);
    assert.match(found.find((i) => i.code === "line-too-long")?.message ?? "", /\(>16, ko default\)/);
    assert.match(found.find((i) => i.code === "caption-too-fast")?.message ?? "", /\(>12, ko default\)/);
  });

  it("leaves Latin captions, and mostly-Latin ones with a CJK word, on the Latin limits", (t) => {
    const latin = draftWithCaption(t, "This is a thirty char line ok!", 2_000_000);
    assert.deepEqual(lengthAndSpeed(spawnCli(["lint", latin.path, "--no-check-paths"]).json.issues), []);
    const mixed = draftWithCaption(t, "Rene 说 hello world today again", 2_000_000);
    assert.deepEqual(lengthAndSpeed(spawnCli(["lint", mixed.path, "--no-check-paths"]).json.issues), []);
  });

  it("applies an explicit --max-chars / --max-cps to every script", (t) => {
    const fix = draftWithCaption(t, ZH_32, 2_000_000);
    const both = spawnCli(["lint", fix.path, "--no-check-paths", "--max-chars", "42", "--max-cps", "20"]);
    assert.deepEqual(lengthAndSpeed(both.json.issues), []);
    // One explicit rule leaves the other on its script default.
    const lineOnly = spawnCli(["lint", fix.path, "--no-check-paths", "--max-chars", "42"]);
    assert.deepEqual(
      lengthAndSpeed(lineOnly.json.issues).map((i) => i.code),
      ["caption-too-fast"],
    );
  });

  it("--fix re-wraps the Chinese line to 16 characters", (t) => {
    const fix = draftWithCaption(t, ZH_32, 6_000_000);
    const r = spawnCli(["lint", fix.path, "--no-check-paths", "--fix"]);
    assert.ok(
      r.json.fixed.some((f) => f.code === "line-too-long"),
      `fixed: ${JSON.stringify(r.json.fixed)}`,
    );
    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    const text = JSON.parse(draft.materials.texts.find((m) => m.id === "CJK-M").content).text;
    assert.equal(text.replace(/\n/g, ""), ZH_32, "characters untouched");
    assert.ok(
      text.split("\n").every((l) => l.length <= 16),
      `lines: ${JSON.stringify(text.split("\n"))}`,
    );
    const again = spawnCli(["lint", fix.path, "--no-check-paths"]);
    assert.equal(again.json.issues.filter((i) => i.code === "line-too-long").length, 0);
  });
});
