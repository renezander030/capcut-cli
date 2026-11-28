import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { captionScript, wordSeparator } from "../dist/script.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const samples = [
  ["th", "สวัสดีทุกคนวันนี้เราจะเรียนรู้การสร้างคำบรรยายภาษาไทยด้วยกัน"],
  ["lo", "ສະບາຍດີທຸກຄົນພວກເຮົາຈະຮຽນພາສາລາວດ້ວຍກັນ"],
  ["km", "សួស្តីអ្នកទាំងអស់គ្នាយើងនឹងរៀនភាសាខ្មែរជាមួយគ្នា"],
  ["my", "မင်္ဂလာပါအားလုံးဒီနေ့မြန်မာစာကိုအတူလေ့လာကြမယ်"],
];

function caption(t, words, maxChars = 12) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const source = join(fix.dir, "words.json");
  writeFileSync(source, JSON.stringify(words));
  const result = spawnCli([
    "caption",
    fix.path,
    "--words",
    source,
    "--max-chars",
    String(maxChars),
    "--track-name",
    "sea-test",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const draft = JSON.parse(readFileSync(fix.path, "utf8"));
  const track = draft.tracks.find((item) => item.type === "text" && item.name === "sea-test");
  assert.ok(track);
  const cues = track.segments.map((segment) => ({
    text: JSON.parse(draft.materials.texts.find((material) => material.id === segment.material_id).content).text,
    start: segment.target_timerange.start,
    end: segment.target_timerange.start + segment.target_timerange.duration,
  }));
  return { result: result.json, cues };
}

describe("spaceless caption grouping", () => {
  for (const [script, text] of samples) {
    it(`detects ${script} and does not insert spaces between source tokens`, () => {
      assert.equal(captionScript(text), script);
      assert.equal(wordSeparator(script), "");
    });

    it(`splits one long ${script} aligner token without breaking graphemes and labels estimated timings`, (t) => {
      const { result, cues } = caption(t, [{ word: text, start: 1, end: 9 }]);
      assert.equal(result.caption_script, script);
      assert.ok(cues.length > 1);
      assert.ok(cues.every((cue) => cue.text.length <= 12));
      assert.equal(cues.map((cue) => cue.text).join(""), text);
      assert.equal(cues[0].start, 1000000);
      assert.equal(cues.at(-1).end, 9000000);
      const edges = new Set(
        [...new Intl.Segmenter(script, { granularity: "grapheme" }).segment(text)].map(
          (part) => part.index + part.segment.length,
        ),
      );
      let offset = 0;
      cues.forEach((cue, index) => {
        offset += cue.text.length;
        assert.ok(edges.has(offset), "cue must end on an original grapheme boundary");
        assert.ok(cue.end > cue.start);
        if (index) assert.equal(cue.start, cues[index - 1].end);
      });
      assert.equal(result.timing_interpolation.split_tokens, 1);
      assert.ok(result.timing_interpolation.generated_chunks > 1);
      assert.equal(result.timing_interpolation.unresolved_tokens, 0);
    });
  }

  it("keeps a mostly Latin caption under the existing Latin defaults", () => {
    assert.equal(captionScript("A short Latin caption with ไทย"), "latin");
    assert.equal(wordSeparator("latin"), " ");
  });

  it("joins short Thai source tokens without adding spaces or inventing internal timing", (t) => {
    const { result, cues } = caption(
      t,
      [
        { word: "สวัสดี", start: 0, end: 1 },
        { word: "ทุกคน", start: 1, end: 2 },
      ],
      42,
    );
    assert.equal(result.caption_script, "th");
    assert.equal(cues[0].text, "สวัสดีทุกคน");
    assert.equal(result.timing_interpolation, undefined);
    assert.equal(cues[0].start, 0);
    assert.equal(cues[0].end, 2000000);
  });

  it("reports a grapheme that cannot fit a one-unit cap instead of splitting its combining mark", (t) => {
    const { result, cues } = caption(t, [{ word: "ก้", start: 0, end: 1 }], 1);
    assert.equal(cues[0].text, "ก้");
    assert.equal(result.timing_interpolation.unresolved_tokens, 1);
    assert.equal(result.timing_interpolation.split_tokens, 0);
  });
});
