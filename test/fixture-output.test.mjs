import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sanitizeDraftBundle } from "../dist/fixture.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "fixture-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "project");
  mkdirSync(source);
  const draft = join(source, "draft_content.json");
  const original = JSON.stringify({
    id: "example-project",
    name: "/home/example/clip.mp4",
    tracks: [],
    materials: { videos: [], texts: [], audios: [] },
  });
  writeFileSync(draft, original);
  return { root, source, draft, original, out: join(root, "bundle") };
}

describe("fixture output isolation", () => {
  for (const inputFile of [false, true]) {
    it(`refuses the source directory when input is a ${inputFile ? "file" : "directory"}`, (t) => {
      const f = setup(t);
      assert.throws(() => sanitizeDraftBundle(inputFile ? f.draft : f.source, f.source), /new or empty/);
      assert.equal(readFileSync(f.draft, "utf8"), f.original);
      assert.deepEqual(readdirSync(f.source), ["draft_content.json"]);
    });
  }

  it("returns a CLI error without changing the source", (t) => {
    const f = setup(t);
    const result = spawnCli(["fixture", f.source, "--out", f.source]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /new or empty/);
    assert.equal(readFileSync(f.draft, "utf8"), f.original);
  });

  it("refuses occupied output without keeping unrelated media in a successful bundle", (t) => {
    const f = setup(t);
    mkdirSync(f.out);
    writeFileSync(join(f.out, "recording.mp4"), "synthetic-media");
    assert.throws(() => sanitizeDraftBundle(f.source, f.out), /new or empty/);
    assert.deepEqual(readdirSync(f.out), ["recording.mp4"]);
    assert.equal(readFileSync(join(f.out, "recording.mp4"), "utf8"), "synthetic-media");
  });

  it("refuses an existing output-file link without overwriting its target", {
    skip: process.platform === "win32",
  }, (t) => {
    const f = setup(t);
    mkdirSync(f.out);
    const outside = join(f.root, "unrelated.json");
    writeFileSync(outside, "keep");
    symlinkSync(outside, join(f.out, "draft_content.json"));
    assert.throws(() => sanitizeDraftBundle(f.source, f.out), /new or empty/);
    assert.equal(readFileSync(outside, "utf8"), "keep");
  });

  it("refuses directory and dangling output links", { skip: process.platform === "win32" }, (t) => {
    const f = setup(t);
    const empty = join(f.root, "empty");
    mkdirSync(empty);
    symlinkSync(empty, f.out, "dir");
    assert.throws(() => sanitizeDraftBundle(f.source, f.out), /new or empty/);
    assert.deepEqual(readdirSync(empty), []);
    rmSync(f.out);
    symlinkSync(join(f.root, "absent"), f.out, "dir");
    assert.throws(() => sanitizeDraftBundle(f.source, f.out), /new or empty/);
    assert.equal(existsSync(join(f.root, "absent")), false);
  });

  it("refuses output inside the source before creating missing parents", (t) => {
    const f = setup(t);
    assert.throws(() => sanitizeDraftBundle(f.source, join(f.source, "new", "bundle")), /outside the source/);
    assert.deepEqual(readdirSync(f.source), ["draft_content.json"]);
  });

  it("detects a source alias in an output ancestor", { skip: process.platform === "win32" }, (t) => {
    const f = setup(t);
    const alias = join(f.root, "alias");
    symlinkSync(f.source, alias, "dir");
    assert.throws(() => sanitizeDraftBundle(f.source, join(alias, "new", "bundle")), /outside the source/);
    assert.deepEqual(readdirSync(f.source), ["draft_content.json"]);
  });

  for (const existing of [false, true]) {
    it(`publishes a complete bundle to ${existing ? "empty" : "new nested"} output`, (t) => {
      const f = setup(t);
      const output = existing ? f.out : join(f.out, "parent", "export");
      if (existing) mkdirSync(output);
      const report = sanitizeDraftBundle(f.source, output);
      assert.equal(report.ok, true);
      assert.equal(report.media_excluded, true);
      assert.equal(report.files.length, 1);
      const saved = readFileSync(join(output, "SANITIZE_REPORT.json"), "utf8");
      assert.ok(!saved.includes(".capcut-fixture-"));
      assert.ok(existsSync(join(output, "README.md")));
      assert.equal(readFileSync(f.draft, "utf8"), f.original);
      assert.ok(!readdirSync(f.root).some((name) => name.startsWith(".capcut-fixture-")));
    });
  }

  for (const existing of [false, true]) {
    it(`keeps ${existing ? "empty output empty" : "new output absent"} after an input read failure`, (t) => {
      const f = setup(t);
      // This late timeline read fails after the first timeline has been staged.
      mkdirSync(join(f.source, "draft_meta_info.json"));
      if (existing) mkdirSync(f.out);
      assert.throws(() => sanitizeDraftBundle(f.source, f.out));
      if (existing) assert.deepEqual(readdirSync(f.out), []);
      else assert.equal(existsSync(f.out), false);
      assert.equal(readFileSync(f.draft, "utf8"), f.original);
      assert.ok(!readdirSync(f.root).some((name) => name.startsWith(".capcut-fixture-")));
    });
  }
});
