import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { maskText, replaceJsonStrings } from "../dist/fixture-anonymize.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const TIMELINE_ID = "5B3D7A10-0000-4000-8000-00000000A001";
const VIDEO = "/home/alice/Clients/Acme Corp/interview-final.MP4";
const AUDIO = "/home/alice/Music/acme theme.mp3";
const MIXED = "你好 World 2026！";
const MIXED_RANGES = [
  [0, 2],
  [3, 8],
  [9, 14],
];
const KANA = "カタカナ ひらがな 한국어 Ünïcode";
// The markup form older drafts store instead of a JSON text document.
const LEGACY = '<font id="" path="/home/alice/fonts/a.ttf"><size=8.000000>[Hi 你好 7]</size></font>';
const PRIVATE = ["alice", "Acme", "interview", "theme", "你好", "World", "カタカナ", "ひらがな", "한국어", "Ünïcode"];

function textContent(text, ranges) {
  return JSON.stringify({
    styles: ranges.map(([start, end], i) => ({
      fill: { content: { render_type: "solid", solid: { color: [1, 1, 1] } } },
      range: [start, end],
      size: 15 - i,
      bold: i === 1,
    })),
    text,
  });
}

function draft() {
  return {
    id: TIMELINE_ID,
    name: "Acme Launch Teaser",
    duration: 6000000,
    fps: 30,
    canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
    tracks: [
      {
        id: "track-video",
        type: "video",
        segments: [
          { id: "seg-v1", material_id: "mat-v1", target_timerange: { start: 0, duration: 3000000 } },
          { id: "seg-v2", material_id: "mat-v2", target_timerange: { start: 3000000, duration: 3000000 } },
        ],
      },
      {
        id: "track-audio",
        type: "audio",
        segments: [{ id: "seg-a1", material_id: "mat-a1", target_timerange: { start: 0, duration: 6000000 } }],
      },
      {
        id: "track-text",
        type: "text",
        segments: [
          { id: "seg-t1", material_id: "mat-t1", target_timerange: { start: 0, duration: 3000000 } },
          { id: "seg-t2", material_id: "mat-t2", target_timerange: { start: 3000000, duration: 3000000 } },
        ],
      },
    ],
    materials: {
      // The same file under two materials must get one neutral name.
      videos: [
        { id: "mat-v1", type: "video", path: VIDEO, material_name: "interview-final.MP4", reverse_path: "" },
        { id: "mat-v2", type: "video", path: VIDEO, material_name: "interview-final.MP4", reverse_path: "" },
      ],
      audios: [{ id: "mat-a1", type: "extract_music", path: AUDIO, name: "acme theme.mp3" }],
      texts: [
        { id: "mat-t1", type: "text", content: textContent(MIXED, MIXED_RANGES), font_path: "", name: "" },
        {
          id: "mat-t2",
          type: "subtitle",
          content: textContent(KANA, [[0, KANA.length]]),
          words: { start_time: [0, 500], end_time: [500, 1000], text: ["カタカナ", "ひらがな"] },
        },
        { id: "mat-t3", type: "text", content: LEGACY },
      ],
      speeds: [],
    },
  };
}

function project(t) {
  const root = mkdtempSync(join(tmpdir(), "capcut-fixture-anon-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "Acme Launch Teaser");
  mkdirSync(join(dir, "Timelines", TIMELINE_ID), { recursive: true });
  const doc = JSON.stringify(draft());
  writeFileSync(join(dir, "draft_content.json"), doc);
  writeFileSync(join(dir, "draft_info.json"), doc);
  // A string-JSON envelope, the shape whose escaped quotes the redactor also handles.
  writeFileSync(join(dir, "template-2.tmp"), JSON.stringify({ draft_content: doc }));
  writeFileSync(join(dir, "Timelines", TIMELINE_ID, "draft_info.json"), doc);
  writeFileSync(
    join(dir, "Timelines", "project.json"),
    JSON.stringify({ main_timeline_id: TIMELINE_ID, timelines: [{ id: TIMELINE_ID, name: "Timeline 01" }] }),
  );
  writeFileSync(
    join(dir, "draft_meta_info.json"),
    JSON.stringify({
      draft_name: "Acme Launch Teaser",
      draft_fold_path: "/home/alice/Movies/CapCut/User Data/Projects/com.lveditor.draft/Acme Launch Teaser",
      draft_root_path: "/home/alice/Movies/CapCut/User Data/Projects/com.lveditor.draft",
      draft_cover: "draft_cover.jpg",
      draft_materials: [
        {
          type: 0,
          value: [
            { file_Path: VIDEO, extra_info: "interview-final.MP4", metetype: "video" },
            { file_Path: AUDIO, extra_info: "acme theme.mp3", metetype: "music" },
          ],
        },
        { type: 1, value: [] },
      ],
    }),
  );
  return { dir, out: join(root, "bundle") };
}

function bundledFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...bundledFiles(join(dir, entry.name), rel));
    else files.push({ rel, text: readFileSync(join(dir, entry.name), "utf-8") });
  }
  return files;
}

const read = (out, rel) => JSON.parse(readFileSync(join(out, ...rel.split("/")), "utf-8"));

describe("fixture --anonymize", () => {
  it("renames media, folders and the project consistently across every mirror", (t) => {
    const p = project(t);
    const r = spawnCli(["fixture", p.dir, "--out", p.out, "--anonymize"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.redaction_check.ok, true);
    assert.equal(r.json.anonymized, true);

    const video = "/home/USER/folder-001/folder-002/media-001.MP4";
    const audio = "/home/USER/Music/media-002.mp3";
    const timelines = [
      read(p.out, "draft_content.json"),
      read(p.out, "draft_info.json"),
      JSON.parse(read(p.out, "template-2.tmp").draft_content),
      read(p.out, `Timelines/${TIMELINE_ID}/draft_info.json`),
    ];
    for (const doc of timelines) {
      assert.equal(doc.name, "project");
      assert.deepEqual(
        doc.materials.videos.map((m) => [m.path, m.material_name, m.reverse_path]),
        [
          [video, "media-001.MP4", ""],
          [video, "media-001.MP4", ""],
        ],
      );
      assert.deepEqual(
        doc.materials.audios.map((m) => [m.path, m.name]),
        [[audio, "media-002.mp3"]],
      );
      // Everything that is not a name or a text is left as it was.
      assert.deepEqual(doc.tracks, draft().tracks);
    }

    const meta = read(p.out, "draft_meta_info.json");
    assert.equal(meta.draft_name, "project");
    assert.equal(meta.draft_fold_path, "/home/USER/Movies/CapCut/User Data/Projects/com.lveditor.draft/project");
    assert.equal(meta.draft_root_path, "/home/USER/Movies/CapCut/User Data/Projects/com.lveditor.draft");
    assert.equal(meta.draft_cover, "draft_cover.jpg");
    assert.deepEqual(
      meta.draft_materials[0].value.map((v) => [v.file_Path, v.extra_info]),
      [
        [video, "media-001.MP4"],
        [audio, "media-002.mp3"],
      ],
    );

    const report = read(p.out, "SANITIZE_REPORT.json");
    assert.equal(report.anonymized, true);
    assert.equal(report.anonymization.media_files, 2);
    assert.equal(report.anonymization.folders, 2);
    assert.match(report.source_dir, /[\\/]project$/);
    assert.match(readFileSync(join(p.out, "README.md"), "utf-8"), /--anonymize/);

    for (const { rel, text } of bundledFiles(p.out)) {
      for (const original of PRIVATE) assert.ok(!text.includes(original), `${rel} still carries ${original}`);
    }
    assert.ok(!r.stdout.includes("Acme") && !r.stderr.includes("Acme"));
  });

  it("replaces texts with same-length placeholders and keeps style ranges", (t) => {
    const p = project(t);
    const r = spawnCli(["fixture", p.dir, "--out", p.out, "--anonymize"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    const original = draft().materials.texts;
    for (const rel of ["draft_content.json", "draft_info.json", `Timelines/${TIMELINE_ID}/draft_info.json`]) {
      const texts = read(p.out, rel).materials.texts;
      const first = JSON.parse(texts[0].content);
      assert.equal(first.text, "字字 Xxxxx 0000！");
      assert.equal(first.text.length, MIXED.length);
      assert.deepEqual(
        first.styles.map((s) => s.range),
        MIXED_RANGES,
      );
      assert.deepEqual(
        MIXED_RANGES.map(([start, end]) => first.text.slice(start, end)),
        ["字字", "Xxxxx", "0000！"],
      );
      // Only `text` changed inside the content string; the styles keep their bytes.
      assert.equal(texts[0].content.replace(first.text, MIXED), original[0].content);

      const second = JSON.parse(texts[1].content);
      assert.equal(second.text, "字字字字 字字字字 字字字 Xxxxxxx");
      assert.deepEqual(second.styles[0].range, [0, KANA.length]);
      assert.deepEqual(texts[1].words.text, ["字字字字", "字字字字"]);
      assert.deepEqual(texts[1].words.start_time, [0, 500]);

      assert.equal(
        texts[2].content,
        '<font id="" path="/home/USER/fonts/a.ttf"><size=8.000000>[Xx 字字 0]</size></font>',
      );
    }

    const report = read(p.out, "SANITIZE_REPORT.json");
    // Three contents plus two karaoke words, in each of the four timeline copies.
    assert.equal(report.anonymization.text_fields, 20);
    // The four timeline names and the sidecar's display name.
    assert.equal(report.anonymization.project_names, 5);
    assert.ok(!JSON.stringify(report).includes("你好"));
  });

  it("leaves names and texts alone without the flag", (t) => {
    const p = project(t);
    const r = spawnCli(["fixture", p.dir, "--out", p.out]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.anonymized, false);
    assert.equal(r.json.anonymization, undefined);
    const doc = read(p.out, "draft_content.json");
    assert.equal(JSON.parse(doc.materials.texts[0].content).text, MIXED);
    assert.equal(doc.materials.videos[0].path, "/home/USER/Clients/Acme Corp/interview-final.MP4");
  });

  it("masks each script with a placeholder of the same UTF-16 length", () => {
    const input = "Ａｂ１𠮷 Σж-ي é́ (42%)";
    const { text, replaced } = maskText(input);
    assert.equal(text, "Ｘｘ０\u{20000} Ωя-ب x́ (00%)");
    assert.equal(text.length, input.length);
    assert.equal(replaced, 10);
  });

  it("rewrites only the addressed strings and keeps every other byte", () => {
    const raw = '{ "a" : [1.50, "keep", {"b":"x\\u00e9"}],\n "c": 12345678901234567890 }';
    const out = replaceJsonStrings(raw, new Map([[JSON.stringify(["a", 2, "b"]), "y"]]));
    assert.equal(out, '{ "a" : [1.50, "keep", {"b":"y"}],\n "c": 12345678901234567890 }');
  });
});
