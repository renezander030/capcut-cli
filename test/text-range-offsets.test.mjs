import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { rangesLookDoubled, repairDoubledRanges, storedTextLength, toStoredOffset } from "../dist/text-offsets.js";
import { loadDraft } from "./helpers/load-fixture.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// The reporter's string from #85: 17 UTF-16 code units, "Claude" at [11,17).
// Through 0.19.0 the emphasised span was written at [22,34] — past the end of
// the text it was meant to style, so CapCut painted nothing.
const THAI = "อย่าไปซื้อ Claude";

function contentOf(path, materialId) {
  const draft = loadDraft(path);
  const mat = draft.materials.texts.find((m) => m.id === materialId);
  assert.ok(mat, `text material ${materialId} missing`);
  return JSON.parse(mat.content);
}

function addRanged(path, text, ranges) {
  const added = spawnCli(["add-text", path, "0s", "1s", text]);
  assert.equal(added.status, 0, `stderr: ${added.stderr}`);
  const r = spawnCli(["text-ranges", path, added.json.segment_id, "--styles", JSON.stringify(ranges)]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return { ...added.json, result: r.json };
}

describe("styles[].range is written in UTF-16 code units (#85)", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("puts a multi-range highlight on the characters the caller named", () => {
    const seg = addRanged(fix.path, THAI, [{ start: 11, end: 17, font_color: "#F4C70F", bold: true }]);
    assert.equal(seg.result.text_length, 17);

    const c = contentOf(fix.path, seg.material_id);
    assert.equal(c.text.length, 17);
    assert.deepEqual(
      c.styles.map((s) => s.range),
      [
        [0, 11],
        [11, 17],
      ],
    );
    const bold = c.styles.find((s) => s.bold);
    assert.equal(c.text.slice(bold.range[0], bold.range[1]), "Claude", "the range must select the emphasised word");
  });

  it("counts an astral character as the two code units CapCut counts", () => {
    // 🎬 is a surrogate pair: "a🎬b" is 3 characters but 4 code units, and the
    // clapperboard occupies [1,3). The old writer's "one code unit = 2 bytes"
    // comment was a BMP assumption; code units need no such caveat.
    const seg = addRanged(fix.path, "a🎬b", [{ start: 1, end: 3, font_color: "#FF0000" }]);
    assert.equal(seg.result.text_length, 4);

    const c = contentOf(fix.path, seg.material_id);
    const hit = c.styles.find((s) => s.range[0] === 1);
    assert.deepEqual(hit.range, [1, 3]);
    assert.equal(c.text.slice(hit.range[0], hit.range[1]), "🎬");
  });

  it("spans a plain add-text with one block ending at the text length", () => {
    const added = spawnCli(["add-text", fix.path, "0s", "1s", "hello world"]);
    assert.equal(added.status, 0, `stderr: ${added.stderr}`);
    const c = contentOf(fix.path, added.json.material_id);
    assert.deepEqual(c.styles[0].range, [0, 11], "a full-span block ends at n, not 2n");
  });
});

describe("lint repairs the doubled ranges older versions wrote", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  /** Rewrite one material's ranges the way 0.19.0 would have written them. */
  function doubleRanges(materialId) {
    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    const mat = draft.materials.texts.find((m) => m.id === materialId);
    const content = JSON.parse(mat.content);
    content.styles = content.styles.map((s) => ({ ...s, range: [s.range[0] * 2, s.range[1] * 2] }));
    mat.content = JSON.stringify(content);
    writeFileSync(fix.path, JSON.stringify(draft));
  }

  // lint exits 0 clean / 1 with warnings / 2 with errors — all three are a
  // completed run, only a crash is not.
  const lint = (...extra) => {
    const r = spawnCli(["lint", fix.path, "--no-check-paths", ...extra]);
    assert.ok(r.status <= 2, `lint exited ${r.status}: ${r.stderr}`);
    return r.json;
  };
  const doubledIssues = (issues, segmentId) =>
    issues.filter((i) => i.code === "text-range-doubled" && i.location?.segment_id === segmentId);

  it("says nothing about a draft whose ranges are already code units", () => {
    const seg = addRanged(fix.path, THAI, [{ start: 11, end: 17, bold: true }]);
    assert.equal(doubledIssues(lint().issues, seg.segment_id).length, 0);
  });

  it("flags the doubled form as fixable and halves it, once", () => {
    const seg = addRanged(fix.path, "hello brave world", [{ start: 6, end: 11, font_color: "#FFD700" }]);
    doubleRanges(seg.material_id);

    const found = doubledIssues(lint().issues, seg.segment_id);
    assert.equal(found.length, 1, "the doubled material must be reported");
    assert.equal(found[0].fixable, true);
    assert.equal(found[0].location.material_id, seg.material_id);

    const fixed = lint("--fix");
    assert.equal(
      fixed.fixed.filter((i) => i.code === "text-range-doubled").length,
      1,
      `--fix must repair it; got: ${JSON.stringify(fixed.fixed)}`,
    );

    const c = contentOf(fix.path, seg.material_id);
    assert.deepEqual(
      c.styles.map((s) => s.range),
      [
        [0, 6],
        [6, 11],
        [11, 17],
      ],
    );
    assert.equal(c.text.slice(6, 11), "brave", "the repaired range lands back on its word");

    // Converges: a second pass has nothing left to find, so the repair can
    // never run twice over the same material and halve it into nonsense.
    assert.equal(doubledIssues(lint().issues, seg.segment_id).length, 0);
  });
});

describe("text-offsets", () => {
  it("maps code-unit indices straight through, clamped to the text", () => {
    assert.equal(toStoredOffset("hello", 3), 3);
    assert.equal(toStoredOffset("hello", 99), 5);
    assert.equal(toStoredOffset("hello", -1), 0);
    assert.equal(storedTextLength("你好 世界"), 5);
    assert.equal(storedTextLength("a🎬b"), 4);
  });

  it("recognises the doubled form only when it cannot be anything else", () => {
    // max(end) === 2n: out of bounds as code units, and exactly where the old
    // writer's trailing block landed.
    assert.equal(rangesLookDoubled("hello", [[0, 10]]), true);
    assert.equal(
      rangesLookDoubled("hello world", [
        [0, 12],
        [12, 22],
      ]),
      true,
    );

    // Already code units — an app-authored draft, or one we repaired.
    assert.equal(rangesLookDoubled("hello", [[0, 5]]), false);
    assert.equal(
      rangesLookDoubled("hello world", [
        [0, 6],
        [6, 11],
      ]),
      false,
    );

    // Shapes the doubling writer could not have produced.
    assert.equal(rangesLookDoubled("hello", [[0, 9]]), false, "an odd offset");
    assert.equal(rangesLookDoubled("hello", [[0, 8]]), false, "a trailing block short of the text");
    assert.equal(rangesLookDoubled("", [[0, 0]]), false, "empty text");
    assert.equal(rangesLookDoubled("hello", []), false, "no ranges");
  });

  it("halves only what it recognises", () => {
    assert.deepEqual(
      repairDoubledRanges("hello world", [
        [0, 12],
        [12, 22],
      ]),
      [
        [0, 6],
        [6, 11],
      ],
    );
    assert.equal(
      repairDoubledRanges("hello world", [
        [0, 6],
        [6, 11],
      ]),
      null,
      "already code units — null tells the caller there is nothing to write",
    );
  });
});
