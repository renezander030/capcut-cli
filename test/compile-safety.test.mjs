import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compileDraft, planCompile } from "../dist/compile.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const templateDir = join(root, "templates", "_init");

function setup(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "capcut-compile-safety-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { specDir: dir, templateDir, outDir: join(dir, "Built"), seed: "off" };
  const spec = { tracks: [{ type: "text", items: [{ ref: "title", text: "Hook", start: 0, duration: 2 }] }] };
  return { dir, opts, spec };
}

function rejected(t, operations, pattern) {
  const s = setup(t);
  s.spec.operations = operations;
  const index = join(s.dir, "root_meta_info.json");
  const original = '{"all_draft_store":[{"draft_id":"unrelated","draft_fold_path":"elsewhere"}],"custom":true}';
  fs.writeFileSync(index, original);
  assert.throws(() => planCompile(s.spec, s.dir), pattern);
  assert.throws(() => compileDraft(s.spec, s.opts), pattern);
  assert.equal(fs.existsSync(s.opts.outDir), false);
  assert.equal(fs.readFileSync(index, "utf-8"), original);
  assert.equal(fs.existsSync(`${index}.bak`), false);
}

describe("compile operation preflight", () => {
  for (const [operation, pattern] of [
    [{ op: "transition", target: "title", slug: "does-not-exist" }, /Unknown transition/],
    [{ op: "filter", slug: "does-not-exist", start: 0, duration: 1 }, /Unknown filter/],
    [{ op: "effect", slug: "does-not-exist", start: 0, duration: 1 }, /Unknown effect/],
    [{ op: "effect", slug: "shake", start: 0, duration: 1, params: {} }, /params.*array/],
    [{ op: "filter", slug: "vintage", start: -1, duration: 1 }, /start.*finite number/],
    [{ op: "filter", slug: "vintage", start: 0, duration: 0 }, /at least one microsecond/],
    [
      { op: "keyframe", target: "title", property: "does-not-exist", time: 0, value: 1 },
      /Unsupported keyframe property/,
    ],
    [{ op: "keyframe", target: "title", property: "alpha", time: -1, value: 1 }, /time.*finite number/],
    [{ op: "keyframe", target: "title", property: "alpha", time: 0, value: "bad" }, /value.*finite number/],
    [{ op: "audio-fade", target: "title", fadeIn: 1 }, /only applies to audio/],
    [{ op: "audio-fade", target: "title" }, /requires at least one/],
    [{ op: "audio-fade", target: "title", fadeIn: -1 }, /fadeIn.*finite number/],
    [{ op: "text-style", target: "title", style: { alpha: "bad" } }, /style.alpha.*finite number/],
    [{ op: "text-style", target: "title", style: { shadow: "true" } }, /style.shadow.*boolean/],
    [{ op: "text-style", target: "title", style: { borderColor: "red" } }, /borderColor.*RRGGBB/],
    [{ op: "text-ranges", target: "title", ranges: [] }, /at least one range/],
    [{ op: "text-ranges", target: "title", ranges: [null] }, /ranges\[0\].*object/],
    [{ op: "text-ranges", target: "title", ranges: [{ start: 0, end: 10 }] }, /out of bounds/],
    [
      {
        op: "text-ranges",
        target: "title",
        ranges: [
          { start: 0, end: 3 },
          { start: 2, end: 4 },
        ],
      },
      /overlapping ranges/,
    ],
    [
      { op: "text-ranges", target: "title", ranges: [{ start: 0, end: 1, font_size: "big" }] },
      /font_size.*finite number/,
    ],
  ]) {
    it(`rejects ${JSON.stringify(operation)} before creating output`, (t) => rejected(t, [operation], pattern));
  }

  it("checks state-dependent operation conflicts, even after valid operations", (t) => {
    rejected(
      t,
      [
        { op: "text-style", target: "title", style: { alpha: 0.5 } },
        { op: "transition", target: "title", slug: "dissolve" },
        { op: "transition", target: "title", slug: "dissolve" },
      ],
      /operations\[2\].*already has a transition/,
    );
  });

  it("rejects text operations and caption style refs targeting a video", (t) => {
    const s = setup(t);
    fs.writeFileSync(join(s.dir, "clip.mp4"), "unprobeable");
    fs.writeFileSync(join(s.dir, "captions.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHello\n");
    s.spec.tracks.push({ type: "video", items: [{ ref: "hero", path: "clip.mp4", start: 0, duration: 2 }] });
    for (const operation of [
      { op: "text-style", target: "hero", style: { alpha: 0.5 } },
      { op: "text-ranges", target: "hero", ranges: [{ start: 0, end: 1 }] },
      { op: "captions", path: "captions.srt", styleRef: "hero" },
    ]) {
      s.spec.operations = [operation];
      assert.throws(() => planCompile(s.spec, s.dir), /Text material not found|not a text segment/);
      assert.equal(fs.existsSync(s.opts.outDir), false);
    }
  });

  it("parses templates and captions during --check", (t) => {
    const s = setup(t);
    const specPath = join(s.dir, "spec.json");
    const input = join(s.dir, "operation.json");
    for (const content of ["{bad", JSON.stringify({ type: "text", segment: {}, material: {}, extra_materials: [] })]) {
      fs.writeFileSync(input, content);
      s.spec.operations = [{ op: "template", path: input, start: 0, duration: 1 }];
      fs.writeFileSync(specPath, JSON.stringify(s.spec));
      const result = spawnCli(["compile", specPath, "--check"]);
      assert.equal(result.status, 1);
      assert.equal(fs.existsSync(s.opts.outDir), false);
    }
    for (const content of ["not srt", "1\n00:00:02,000 --> 00:00:01,000\nWrong order\n", ""]) {
      fs.writeFileSync(input, content);
      s.spec.operations = [{ op: "captions", path: input }];
      fs.writeFileSync(specPath, JSON.stringify(s.spec));
      const result = spawnCli(["compile", specPath, "--check"]);
      assert.equal(result.status, 1);
    }
  });

  it("allows later operations to reference a previously applied template", (t) => {
    const s = setup(t);
    s.spec.operations = [
      {
        op: "template",
        ref: "cta",
        path: join(root, "templates", "subscribe-cta.json"),
        text: "Follow",
        start: 1,
        duration: 1,
      },
      { op: "text-style", target: "cta", style: { alpha: 0.5 } },
      { op: "text-ranges", target: "cta", ranges: [{ start: 0, end: 6, bold: true }] },
    ];
    assert.equal(planCompile(s.spec, s.dir).ok, true);
    const result = compileDraft(s.spec, s.opts);
    assert.ok(result.refs.cta);
    const draft = JSON.parse(fs.readFileSync(result.file_path, "utf-8"));
    const segment = draft.tracks.flatMap((track) => track.segments).find((item) => item.id === result.refs.cta);
    assert.equal(draft.materials.texts.find((material) => material.id === segment.material_id).text_alpha, 0.5);
  });

  it("rejects duplicate template refs", (t) => {
    rejected(
      t,
      [{ op: "template", ref: "title", path: join(root, "templates", "subscribe-cta.json"), start: 0, duration: 1 }],
      /duplicate ref/,
    );
  });

  it("rejects non-finite library values and sub-microsecond text durations", (t) => {
    const s = setup(t);
    for (const change of [{ start: Infinity }, { duration: NaN }, { duration: 0.00000001 }, { color: "blue" }]) {
      const invalid = structuredClone(s.spec);
      Object.assign(invalid.tracks[0].items[0], change);
      assert.throws(() => planCompile(invalid, s.dir));
      assert.throws(() => compileDraft(invalid, s.opts));
      assert.equal(fs.existsSync(s.opts.outDir), false);
    }
  });
});

describe("compile failure cleanup", () => {
  it("removes a partially initialized directory without changing the store index", (t) => {
    const s = setup(t);
    const index = join(s.dir, "root_meta_info.json");
    const before = '{"all_draft_store":[],"custom":"keep"}';
    fs.writeFileSync(index, before);
    const original = fs.cpSync;
    fs.cpSync = () => {
      throw new Error("injected template copy failure");
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => compileDraft(s.spec, s.opts), /template copy failure/);
    } finally {
      fs.cpSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(fs.existsSync(s.opts.outDir), false);
    assert.equal(fs.readFileSync(index, "utf-8"), before);
    assert.equal(fs.existsSync(`${index}.bak`), false);
  });

  it("removes failed output while preserving unrelated store edits made during the build", (t) => {
    const s = setup(t);
    const index = join(s.dir, "root_meta_info.json");
    fs.writeFileSync(index, '{"all_draft_store":[],"custom":"before"}');
    const media = join(s.dir, "clip.mp4");
    fs.writeFileSync(media, "unprobeable media");
    s.spec.tracks.push({ type: "video", items: [{ path: media, start: 0, duration: 2 }] });
    const changed = '{"all_draft_store":[{"draft_id":"concurrent","draft_fold_path":"elsewhere"}],"custom":"after"}';
    const original = fs.copyFileSync;
    fs.copyFileSync = (source, ...args) => {
      if (source === media) {
        fs.writeFileSync(index, changed);
        throw new Error("injected media copy failure");
      }
      return original(source, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => compileDraft(s.spec, s.opts), /media copy failure/);
    } finally {
      fs.copyFileSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(fs.existsSync(s.opts.outDir), false);
    assert.equal(fs.readFileSync(index, "utf-8"), changed);
    assert.equal(fs.existsSync(`${index}.bak`), false);
  });

  it("refuses preexisting output and preserves its contents", (t) => {
    const s = setup(t);
    fs.mkdirSync(s.opts.outDir);
    const sentinel = join(s.opts.outDir, "keep.txt");
    fs.writeFileSync(sentinel, "keep me");
    assert.throws(() => compileDraft(s.spec, s.opts), /already exists/);
    assert.equal(fs.readFileSync(sentinel, "utf-8"), "keep me");
  });

  it("preserves another writer's replacement directory at the output path", (t) => {
    const s = setup(t);
    const media = join(s.dir, "clip.mp4");
    fs.writeFileSync(media, "unprobeable media");
    s.spec.tracks.push({ type: "video", items: [{ path: media, start: 0, duration: 2 }] });
    const original = fs.copyFileSync;
    fs.copyFileSync = (source, ...args) => {
      if (source === media) {
        fs.renameSync(s.opts.outDir, join(s.dir, "Moved"));
        fs.mkdirSync(s.opts.outDir);
        fs.writeFileSync(join(s.opts.outDir, "keep.txt"), "another writer");
        throw new Error("output directory replaced");
      }
      return original(source, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => compileDraft(s.spec, s.opts), /output directory replaced/);
    } finally {
      fs.copyFileSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(fs.readFileSync(join(s.opts.outDir, "keep.txt"), "utf-8"), "another writer");
    assert.equal(fs.existsSync(join(s.dir, "root_meta_info.json")), false);
  });

  it("registers completed duration and preserves existing index entries", (t) => {
    const s = setup(t);
    s.spec.name = "Display title";
    const media = join(s.dir, "clip.mp4");
    fs.writeFileSync(media, "unprobeable media");
    s.spec.tracks.push({ type: "video", items: [{ path: media, start: 0, duration: 2 }] });
    const index = join(s.dir, "root_meta_info.json");
    fs.writeFileSync(
      index,
      '{"all_draft_store":[{"draft_id":"existing","draft_fold_path":"elsewhere"}],"custom":true}',
    );
    const result = compileDraft(s.spec, s.opts);
    const parsed = JSON.parse(fs.readFileSync(index, "utf-8"));
    assert.equal(parsed.custom, true);
    assert.equal(parsed.all_draft_store[0].draft_id, "existing");
    assert.equal(parsed.all_draft_store[1].tm_duration, result.duration_us);
    assert.equal(parsed.all_draft_store[1].draft_fold_path, s.opts.outDir);
    const sidecar = JSON.parse(fs.readFileSync(join(s.opts.outDir, "draft_meta_info.json"), "utf-8"));
    assert.equal(sidecar.tm_duration, result.duration_us);
    assert.equal(sidecar.draft_name, "Display title");
    const imported = sidecar.draft_materials.flatMap((group) => group.value);
    assert.equal(imported.length, 1);
    const draft = JSON.parse(fs.readFileSync(result.file_path, "utf-8"));
    assert.equal(imported[0].id, draft.materials.videos[0].local_material_id);
  });

  it("retains the actionable omitted-duration error when the source cannot be probed", (t) => {
    const s = setup(t);
    fs.writeFileSync(join(s.dir, "clip.mp4"), "unprobeable media");
    s.spec.tracks.push({ type: "video", items: [{ path: "clip.mp4", start: 0 }] });
    assert.throws(() => planCompile(s.spec, s.dir), /Pass duration explicitly or install ffprobe/);
    assert.equal(fs.existsSync(s.opts.outDir), false);
  });
});
