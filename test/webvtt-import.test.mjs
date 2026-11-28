import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseSubtitles, parseVtt } from "../dist/srt.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// WebVTT was refused with "Invalid SRT timestamp near line 1: WEBVTT" although export-srt writes it.
// One file with the spec's variants: titled header with metadata lines, NOTE/STYLE/REGION blocks, text and
// numeric cue ids, cue settings, mm:ss.ttt and 3-digit-hour timestamps, voice/class/lang/ruby tags, inline
// timestamps, entities, a multi-line cue and CRLF line ends.
const VTT = [
  "WEBVTT - Episode 1",
  "Kind: captions",
  "Language: en",
  "",
  "STYLE",
  "::cue { color: yellow }",
  "",
  "REGION",
  "id:bill width:40%",
  "",
  "NOTE a comment",
  "that spans two lines",
  "",
  "intro",
  "00:01.000 --> 00:02.500 align:start position:10%",
  "<v Roger Bingham>We are in New York City</v>",
  "",
  "2",
  "00:00:03.000 --> 00:00:05.000",
  "<c.yellow>Café</c> &amp; <lang de>Brötchen</lang>",
  "<00:00:04.000>second line <ruby>漢<rt>kan</rt></ruby>",
  "",
  "00:00:06.000 --> 00:00:07.250",
  "<b>bold</b> stays",
  "",
  "100:00:00.000 --> 100:00:01.000",
  "late",
  "",
].join("\r\n");

const expected = [
  [1_000_000, 2_500_000, "We are in New York City"],
  [3_000_000, 5_000_000, "Café & Brötchen\nsecond line 漢"],
  [6_000_000, 7_250_000, "<b>bold</b> stays"],
  [360_000_000_000, 360_001_000_000, "late"],
];

describe("WebVTT import", () => {
  it("parseVtt reads the spec's header, block, id, setting, timestamp and markup variants", () => {
    assert.deepEqual(
      parseVtt(VTT).map((c) => [c.startUs, c.endUs, c.text]),
      expected,
    );
    assert.deepEqual(
      parseVtt(VTT).map((c) => c.index),
      [1, 2, 3, 4],
    );
  });

  it("parseSubtitles picks WebVTT by its header and SRT otherwise", () => {
    assert.equal(parseSubtitles(VTT).length, 4);
    assert.deepEqual(parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\nhi\n"), [
      { index: 1, startUs: 1_000_000, endUs: 2_000_000, text: "hi" },
    ]);
  });

  it("names the WebVTT line it cannot read and an end before its start", () => {
    assert.throws(() => parseVtt("WEBVTT\n\n00:01.000 -> 00:02.000\nx\n"), /WebVTT.*line 3/);
    assert.throws(() => parseVtt("WEBVTT\n\n00:02.000 --> 00:01.000\nx\n"), /WebVTT cue 1 has end <= start/);
    assert.throws(() => parseVtt("WEBVTTX\n\n00:01.000 --> 00:02.000\nx\n"), /WEBVTT/);
  });

  it("import-srt imports a .vtt file with a byte-order mark, one text segment per cue at its time", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const path = join(fix.dir, "captions.vtt");
    writeFileSync(path, String.fromCharCode(0xfeff) + VTT);
    const segmentIds = (draft) => draft.tracks.flatMap((track) => track.segments.map((s) => s.id));
    const before = new Set(segmentIds(JSON.parse(readFileSync(fix.path, "utf-8"))));
    const r = spawnCli(["import-srt", fix.path, path]);
    assert.equal(r.status, 0, r.stderr);
    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    const texts = new Map(draft.materials.texts.map((m) => [m.id, m.content]));
    const added = draft.tracks
      .filter((track) => track.type === "text")
      .flatMap((track) => track.segments)
      .filter((s) => !before.has(s.id))
      .sort((x, y) => x.target_timerange.start - y.target_timerange.start);
    assert.deepEqual(
      added.map((s) => [
        s.target_timerange.start,
        s.target_timerange.start + s.target_timerange.duration,
        JSON.parse(texts.get(s.material_id)).text,
      ]),
      expected.map(([start, end, text]) => [start, end, text === "<b>bold</b> stays" ? "bold stays" : text]),
    );
    const bold = JSON.parse(texts.get(added[2].material_id));
    assert.ok(bold.styles.some((style) => style.bold && style.range[0] === 0 && style.range[1] === 4));
  });
});
