import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Media files only need to EXIST for compile (factory copies them; it never
// reads their content), so empty placeholder files are enough here.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-compile-"));
  writeFileSync(join(dir, "clip1.mp4"), "");
  writeFileSync(join(dir, "clip2.mp4"), "");
  writeFileSync(join(dir, "music.mp3"), "");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeSpec(dir, spec) {
  const p = join(dir, "spec.json");
  writeFileSync(p, JSON.stringify(spec));
  return p;
}

const VALID = {
  name: "T",
  width: 720,
  height: 1280,
  fps: 30,
  ratio: "9:16",
  tracks: [
    {
      type: "video",
      items: [
        { path: "clip1.mp4", start: 0, duration: 2 },
        { path: "clip2.mp4", start: 2, duration: 3 },
      ],
    },
    { type: "audio", items: [{ path: "music.mp3", start: 0, duration: 5, volume: 0.4 }] },
    { type: "text", items: [{ text: "Hook", start: 0, duration: 2, fontSize: 18, color: "#FFD700", y: -0.6 }] },
  ],
};

describe("compile", () => {
  it("builds a valid draft from a JSON spec (both draft files, consistent)", () => {
    const s = setup();
    after(s.cleanup);
    const spec = writeSpec(s.dir, VALID);
    const out = join(s.dir, "Built");
    const r = spawnCli(["compile", spec, "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.tracks, 3);
    assert.equal(r.json.segments, 4);
    assert.equal(r.json.duration_us, 5_000_000);

    const content = JSON.parse(readFileSync(join(out, "draft_content.json"), "utf-8"));
    const info = JSON.parse(readFileSync(join(out, "draft_info.json"), "utf-8"));
    // Canvas + fps come from the spec.
    assert.deepEqual(content.canvas_config, { width: 720, height: 1280, ratio: "9:16" });
    assert.equal(content.fps, 30);
    assert.equal(content.duration, 5_000_000);
    // Times converted seconds -> microseconds.
    const vTrack = content.tracks.find((t) => t.type === "video");
    assert.equal(vTrack.segments.length, 2);
    assert.equal(vTrack.segments[0].target_timerange.duration, 2_000_000);
    // Both files mirror the same built draft so every downstream tool agrees.
    assert.equal(JSON.stringify(content), JSON.stringify(info));
  });

  it("produces a draft that passes lint (cross-tool validity)", () => {
    const s = setup();
    after(s.cleanup);
    const spec = writeSpec(s.dir, VALID);
    const out = join(s.dir, "Built");
    assert.equal(spawnCli(["compile", spec, "--out", out]).status, 0);
    const lint = spawnCli(["lint", out, "--no-check-paths"]);
    assert.equal(lint.status, 0, `lint failed: ${lint.stdout}${lint.stderr}`);
  });

  it("supports refs, decorators, templates, captions, and --check planning", () => {
    const s = setup();
    after(s.cleanup);
    writeFileSync(join(s.dir, "captions.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHello\n");
    const rich = structuredClone(VALID);
    rich.tracks[0].items = [
      { path: "clip1.mp4", start: 0, duration: 2, ref: "hero", speed: 1.25, opacity: 0.8, scale: 1.1 },
    ];
    rich.tracks[1].items[0].ref = "music";
    rich.tracks[2].items[0].ref = "hook";
    rich.operations = [
      { op: "transition", target: "hero", slug: "dissolve", duration: 0.4 },
      { op: "keyframe", target: "hero", property: "uniform_scale", time: 0, value: 1 },
      { op: "audio-fade", target: "music", fadeIn: 0.5, fadeOut: 0.5 },
      { op: "text-style", target: "hook", style: { borderWidth: 0.08, borderColor: "#000000" } },
      { op: "text-ranges", target: "hook", ranges: [{ start: 0, end: 4, font_color: "#FFD700" }] },
      { op: "filter", slug: "vintage", start: 0, duration: 2 },
      { op: "effect", slug: "shake", start: 0, duration: 1 },
      {
        op: "template",
        path: join(__dirname, "..", "templates", "subscribe-cta.json"),
        start: 1,
        duration: 1,
        text: "Follow",
      },
      { op: "captions", path: "captions.srt" },
    ];
    const spec = writeSpec(s.dir, rich);
    const out = join(s.dir, "Rich");

    const check = spawnCli(["compile", spec, "--out", out, "--check"]);
    assert.equal(check.status, 0, check.stderr);
    assert.equal(check.json.write, false);
    assert.equal(check.json.operations, rich.operations.length);
    assert.equal(check.json.refs.length, 3);
    assert.equal(readFileSync(spec, "utf-8").length > 0, true);

    const result = spawnCli(["compile", spec, "--out", out]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.json.refs.hero);
    const draft = JSON.parse(readFileSync(join(out, "draft_content.json"), "utf-8"));
    const hero = draft.tracks
      .flatMap((track) => track.segments)
      .find((segment) => segment.id === result.json.refs.hero);
    assert.equal(hero.speed, 1.25);
    assert.equal(hero.clip.alpha, 0.8);
    assert.equal(hero.clip.scale.x, 1.1);
    assert.ok(hero.common_keyframes.length > 0);
    assert.ok(draft.materials.transitions.length > 0);
    assert.ok(draft.materials.audio_fades.length > 0);
    assert.ok(draft.tracks.some((track) => track.type === "filter"));
    assert.ok(draft.tracks.some((track) => track.type === "effect"));
    assert.ok(draft.tracks.some((track) => track.name === "captions"));
  });

  it("rejects a spec with no tracks", () => {
    const s = setup();
    after(s.cleanup);
    const spec = writeSpec(s.dir, { name: "X", tracks: [] });
    const r = spawnCli(["compile", spec, "--out", join(s.dir, "X")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /tracks must be a non-empty array/);
  });

  it("fails before writing when a media file is missing", () => {
    const s = setup();
    after(s.cleanup);
    const spec = writeSpec(s.dir, {
      name: "X",
      tracks: [{ type: "video", items: [{ path: "does-not-exist.mp4", start: 0, duration: 2 }] }],
    });
    const r = spawnCli(["compile", spec, "--out", join(s.dir, "X")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /media file not found/);
  });

  it("requires text and duration on text items", () => {
    const s = setup();
    after(s.cleanup);
    const spec = writeSpec(s.dir, {
      name: "X",
      tracks: [{ type: "text", items: [{ start: 0, duration: 2 }] }],
    });
    const r = spawnCli(["compile", spec, "--out", join(s.dir, "X")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\.text is required/);
  });

  it("rejects invalid JSON with a clear error", () => {
    const s = setup();
    after(s.cleanup);
    const p = join(s.dir, "bad.json");
    writeFileSync(p, "{not json");
    const r = spawnCli(["compile", p, "--out", join(s.dir, "X")]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not valid JSON/);
  });
});

// v0.13.0 review: validateSpec never checked the keyframe `easing` field, so
// `compile --check` exited 0 on a spec the real compile would reject — and the
// real compile only threw AFTER initDraft had seeded the draft directory,
// leaving an orphan half-built draft that CapCut lists.
describe("compile: keyframe easing pre-flight", () => {
  const specWithEasing = (easing) => ({
    name: "K",
    tracks: [{ type: "video", items: [{ path: "clip1.mp4", start: 0, duration: 2, ref: "v1" }] }],
    operations: [{ op: "keyframe", target: "v1", property: "uniform_scale", time: 1, value: 1.2, easing }],
  });

  it("--check rejects an invalid easing instead of green-lighting it", () => {
    const s = setup();
    after(s.cleanup);
    const spec = writeSpec(s.dir, specWithEasing("cubic-out"));
    const r = spawnCli(["compile", spec, "--check"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unsupported keyframe easing: cubic-out/);
  });

  it("real compile fails before initDraft writes anything (no orphan draft dir)", () => {
    const s = setup();
    after(s.cleanup);
    const spec = writeSpec(s.dir, specWithEasing("cubic-out"));
    const out = join(s.dir, "outdraft");
    const r = spawnCli(["compile", spec, "--out", out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unsupported keyframe easing: cubic-out/);
    assert.equal(existsSync(out), false, "orphan half-built draft dir left behind");
  });

  it("rejects inherited prototype names in specs too", () => {
    const s = setup();
    after(s.cleanup);
    const spec = writeSpec(s.dir, specWithEasing("hasOwnProperty"));
    const r = spawnCli(["compile", spec, "--check"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unsupported keyframe easing: hasOwnProperty/);
  });

  it("--check and compile both accept every supported easing", () => {
    const s = setup();
    after(s.cleanup);
    const spec = writeSpec(s.dir, specWithEasing("ease-out"));
    assert.equal(spawnCli(["compile", spec, "--check"]).status, 0);
    const out = join(s.dir, "Built");
    const r = spawnCli(["compile", spec, "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.ok, true);
  });
});

// The spec's `name` becomes a directory under the draft store, so an untrusted
// spec (or, with --data, an untrusted row) could name `../../elsewhere` and
// build the draft outside the store. validateSpec refuses a name shaped like a
// path, on both the single-draft and the per-row derived path.
describe("compile: draft name stays inside the draft store", () => {
  function setupStore() {
    const s = setup();
    const store = join(s.dir, "store");
    mkdirSync(store);
    return { ...s, store };
  }

  const named = (name) => ({ ...VALID, name });

  it("refuses a traversing spec.name instead of building outside the store", () => {
    const s = setupStore();
    after(s.cleanup);
    const spec = writeSpec(s.dir, named("../escaped"));
    const r = spawnCli(["compile", spec, "--drafts", s.store]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /spec\.name takes a plain folder name, not a path/);
    assert.equal(existsSync(join(s.dir, "escaped")), false, "draft was built outside the store");
  });

  it("refuses an absolute and a drive-prefixed spec.name", () => {
    const s = setupStore();
    after(s.cleanup);
    for (const name of ["/tmp/escaped", "sub/nested", "..\\escaped", "C:escaped"]) {
      const r = spawnCli(["compile", writeSpec(s.dir, named(name)), "--drafts", s.store]);
      assert.equal(r.status, 1, `accepted "${name}"`);
      assert.match(r.stderr, /spec\.name takes a plain folder name, not a path/);
    }
  });

  it("refuses an empty spec.name, which would resolve to the store root itself", () => {
    const s = setupStore();
    after(s.cleanup);
    const r = spawnCli(["compile", writeSpec(s.dir, named("")), "--drafts", s.store]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /spec\.name must be a non-empty folder name/);
  });

  it("--check catches it too, before any draft directory is seeded", () => {
    const s = setupStore();
    after(s.cleanup);
    const r = spawnCli(["compile", writeSpec(s.dir, named("../escaped")), "--check"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /spec\.name takes a plain folder name, not a path/);
  });

  it("--data: a row whose derived name traverses aborts, nothing written", () => {
    const s = setupStore();
    after(s.cleanup);
    const spec = writeSpec(s.dir, {
      name: "{{name}}",
      tracks: [{ type: "video", items: [{ path: "clip1.mp4", start: 0, duration: 2 }] }],
    });
    const rows = join(s.dir, "rows.jsonl");
    writeFileSync(rows, `${JSON.stringify({ name: "Fine" })}\n${JSON.stringify({ name: "../escaped" })}\n`);
    const r = spawnCli(["compile", spec, "--data", rows, "--drafts", s.store]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /aborted at row 2/);
    assert.match(r.stderr, /spec\.name takes a plain folder name, not a path/);
    assert.equal(existsSync(join(s.dir, "escaped")), false, "row 2 built outside the store");
    assert.equal(existsSync(join(s.store, "Fine")), false, "row 1 was built despite the abort");
  });

  it("a plain name still builds where it always did", () => {
    const s = setupStore();
    after(s.cleanup);
    const r = spawnCli(["compile", writeSpec(s.dir, named("Kept Name")), "--drafts", s.store]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.draft_path, join(s.store, "Kept Name"));
    assert.ok(existsSync(join(s.store, "Kept Name", "draft_content.json")));
  });
});

// v0.17: `compile --data` — one spec + N JSONL rows = N drafts, {{key}}
// placeholders substituted into the spec's string values per row. Row errors
// mirror `batch`'s per-line contract: fail fast with the row number (nothing
// written), or --continue-on-error to build the rows that validate + exit 1.
describe("compile --data (one spec + N JSONL rows = N drafts)", () => {
  const TEMPLATED = {
    name: "{{name}}",
    width: 720,
    height: 1280,
    fps: 30,
    ratio: "9:16",
    tracks: [
      { type: "video", items: [{ path: "{{clip}}", start: 0, duration: 2 }] },
      { type: "text", items: [{ text: "{{title}} for {{price}}", start: 0, duration: 2 }] },
    ],
  };

  function setupStore() {
    const s = setup();
    const store = join(s.dir, "store");
    mkdirSync(store);
    return { ...s, store };
  }

  function writeRows(dir, rows) {
    const p = join(dir, "rows.jsonl");
    writeFileSync(p, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return p;
  }

  const ROWS = [
    { name: "Prod A", clip: "clip1.mp4", title: "Alpha", price: 9 },
    { name: "Prod B", clip: "clip2.mp4", title: "Beta", price: 19 },
    { name: "Prod C", clip: "clip1.mp4", title: "Gamma", price: 29 },
  ];

  it("builds one draft per row: 3-row happy path with a summary array", () => {
    const s = setupStore();
    after(s.cleanup);
    const spec = writeSpec(s.dir, TEMPLATED);
    const rowsPath = writeRows(s.dir, ROWS);
    const r = spawnCli(["compile", spec, "--data", rowsPath, "--drafts", s.store]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Array.isArray(r.json), `expected summary array, got: ${r.stdout}`);
    assert.equal(r.json.length, 3);
    for (const [i, rowResult] of r.json.entries()) {
      assert.equal(rowResult.row, i + 1);
      assert.equal(rowResult.ok, true);
      assert.equal(rowResult.name, ROWS[i].name);
      assert.equal(rowResult.draft_path, join(s.store, ROWS[i].name));
      assert.ok(existsSync(join(s.store, ROWS[i].name, "draft_content.json")), `draft missing for ${ROWS[i].name}`);
    }
  });

  it("substitutes {{key}} into string values and the draft name (rows on stdin)", () => {
    const s = setupStore();
    after(s.cleanup);
    const spec = writeSpec(s.dir, TEMPLATED);
    const r = spawnCli(["compile", spec, "--data", "-", "--drafts", s.store], {
      input: `${JSON.stringify({ name: "Priced", clip: "clip1.mp4", title: "Hook", price: 42 })}\n`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json[0].ok, true);
    const raw = readFileSync(join(s.store, "Priced", "draft_content.json"), "utf-8");
    const content = JSON.parse(raw);
    // The draft's display name comes from the templated spec.name.
    assert.equal(content.name, "Priced");
    // String substitution covers nested items; the number 42 arrives as text.
    assert.match(raw, /Hook for 42/);
    assert.doesNotMatch(raw, /\{\{/);
  });

  it("mirrors batch: the first bad row aborts with its row number, nothing written", () => {
    const s = setupStore();
    after(s.cleanup);
    const spec = writeSpec(s.dir, TEMPLATED);
    const bad = [ROWS[0], { ...ROWS[1], clip: "does-not-exist.mp4" }, ROWS[2]];
    const r = spawnCli(["compile", spec, "--data", writeRows(s.dir, bad), "--drafts", s.store]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /aborted at row 2/);
    assert.match(r.stderr, /no drafts written/);
    assert.match(r.stderr, /media file not found/);
    // Every row is validated before anything is built: row 1 must NOT exist.
    assert.equal(existsSync(join(s.store, "Prod A")), false, "row 1 was built despite the abort");
  });

  it("--continue-on-error builds the rows that validate and exits 1 (batch's contract)", () => {
    const s = setupStore();
    after(s.cleanup);
    const spec = writeSpec(s.dir, TEMPLATED);
    const bad = [ROWS[0], { ...ROWS[1], clip: "does-not-exist.mp4" }, ROWS[2]];
    const r = spawnCli(["compile", spec, "--data", writeRows(s.dir, bad), "--drafts", s.store, "--continue-on-error"]);
    assert.equal(r.status, 1);
    assert.equal(r.json.length, 3);
    assert.equal(r.json[0].ok, true);
    assert.equal(r.json[1].ok, false);
    assert.match(r.json[1].error, /media file not found/);
    assert.equal(r.json[2].ok, true);
    assert.ok(existsSync(join(s.store, "Prod A", "draft_content.json")));
    assert.equal(existsSync(join(s.store, "Prod B")), false);
    assert.ok(existsSync(join(s.store, "Prod C", "draft_content.json")));
  });

  it("a placeholder with no matching row key is a row error, never kept silently", () => {
    const s = setupStore();
    after(s.cleanup);
    const spec = writeSpec(s.dir, TEMPLATED);
    const r = spawnCli([
      "compile",
      spec,
      "--data",
      writeRows(s.dir, [{ name: "X", clip: "clip1.mp4", title: "T" }]),
      "--drafts",
      s.store,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /aborted at row 1/);
    assert.match(r.stderr, /no value for placeholder \{\{price\}\}/);
  });

  it("rejects --out with --data — each row names its own draft", () => {
    const s = setupStore();
    after(s.cleanup);
    const spec = writeSpec(s.dir, TEMPLATED);
    const r = spawnCli(["compile", spec, "--data", writeRows(s.dir, ROWS), "--out", join(s.dir, "One")]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /use --drafts/);
  });

  it("without --data, compile is unchanged: {{placeholder}}-looking text is kept verbatim", () => {
    const s = setup();
    after(s.cleanup);
    const literal = structuredClone(VALID);
    literal.name = "{{title}}";
    literal.tracks[2].items[0].text = "{{title}} stays literal";
    const spec = writeSpec(s.dir, literal);
    const out = join(s.dir, "Literal");
    const r = spawnCli(["compile", spec, "--out", out]);
    assert.equal(r.status, 0, r.stderr);
    const raw = readFileSync(join(out, "draft_content.json"), "utf-8");
    const content = JSON.parse(raw);
    // No templating on the single-draft path: braces survive byte-for-byte.
    assert.equal(content.name, "{{title}}");
    assert.match(raw, /\{\{title\}\} stays literal/);
  });
});
