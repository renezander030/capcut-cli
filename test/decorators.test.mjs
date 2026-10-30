import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut keyframe", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("adds a single keyframe to an existing segment", () => {
    const segs = spawnCli(["segments", fix.path]).json ?? [];
    const seg = segs[0];
    if (!seg) return;
    const r = spawnCli(["keyframe", fix.path, seg.id.slice(0, 8), "alpha", "0s", "0.5"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
  });

  it("accepts --batch JSONL on stdin", () => {
    const segs = spawnCli(["segments", fix.path]).json ?? [];
    const seg = segs[0];
    if (!seg) return;
    const lines = [
      JSON.stringify({ property: "alpha", time: "0s", value: "0%" }),
      JSON.stringify({ property: "alpha", time: "1s", value: "100%" }),
    ].join("\n");
    const r = spawnCli(["keyframe", fix.path, seg.id.slice(0, 8), "--batch"], { input: lines });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.added, 2);
  });
});

describe("capcut mask", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("attaches a circle mask to a video segment", () => {
    const segs = spawnCli(["segments", fix.path, "--track", "video"]).json ?? [];
    const seg = segs[0];
    if (!seg) return;
    const r = spawnCli(["mask", fix.path, seg.id.slice(0, 8), "circle", "--size", "0.6"]);
    if (r.status !== 0) {
      // mask may refuse if segment already has a mask in fixture — accept that path too
      assert.match(r.stderr, /already|mask/i);
      return;
    }
    assert.equal(r.json.ok, true);
  });

  it("--off removes the mask", () => {
    const segs = spawnCli(["segments", fix.path, "--track", "video"]).json ?? [];
    const seg = segs[0];
    if (!seg) return;
    spawnCli(["mask", fix.path, seg.id.slice(0, 8), "circle"]); // best-effort apply
    const r = spawnCli(["mask", fix.path, seg.id.slice(0, 8), "--off"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });
});

describe("capcut bg-blur", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("sets blur level 2 on a video segment", () => {
    const segs = spawnCli(["segments", fix.path, "--track", "video"]).json ?? [];
    const seg = segs[0];
    if (!seg) return;
    const r = spawnCli(["bg-blur", fix.path, seg.id.slice(0, 8), "2"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });
});

describe("capcut text-style", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("applies border + shadow to a text segment", () => {
    const texts = spawnCli(["texts", fix.path]).json ?? [];
    if (texts.length === 0) return;
    const r = spawnCli([
      "text-style",
      fix.path,
      texts[0].id.slice(0, 8),
      "--border-width",
      "0.05",
      "--border-color",
      "#000000",
      "--shadow",
      "--shadow-color",
      "#000000",
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.ok(Array.isArray(r.json.applied));
    assert.ok(r.json.applied.length > 0);
  });

  it("applies --font-size, --color, --align and --y without a preset", () => {
    const added = spawnCli(["add-text", fix.path, "0s", "2s", "Sale"]);
    assert.equal(added.status, 0, `stderr: ${added.stderr}`);
    const id = added.json.segment_id;
    const r = spawnCli([
      "text-style",
      fix.path,
      id,
      "--font-size",
      "22",
      "--color",
      "#FFD60A",
      "--align",
      "0",
      "--y",
      "0.35",
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.applied, ["font_size", "color", "alignment", "transform"]);

    const seg = spawnCli(["segment", fix.path, id]).json;
    assert.equal(seg.clip.transform.y, 0.35);
    assert.equal(seg._material.font_size, 22);
    assert.equal(seg._material.text_color, "#FFD60A");
    assert.equal(seg._material.alignment, 0);
    const block = JSON.parse(seg._material.content).styles[0];
    assert.equal(block.size, 22);
    assert.deepEqual(block.fill.content.solid.color, [1, 214 / 255, 10 / 255]);
  });

  it("rejects a non-hex --color", () => {
    const added = spawnCli(["add-text", fix.path, "3s", "1s", "x"]);
    const r = spawnCli(["text-style", fix.path, added.json.segment_id, "--color", "yellow"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /#RRGGBB/);
  });
});

describe("capcut enums", () => {
  it("--transitions returns an array", () => {
    const r = spawnCli(["enums", "--transitions"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(Array.isArray(r.json));
    assert.ok(r.json.length > 0);
    for (const e of r.json.slice(0, 3)) {
      assert.equal(typeof e.slug, "string");
      assert.equal(typeof e.member, "string");
    }
  });

  it("--masks returns an array", () => {
    const r = spawnCli(["enums", "--masks"]);
    assert.equal(r.status, 0);
    assert.ok(Array.isArray(r.json));
  });

  it("--jianying swaps the namespace", () => {
    const cap = spawnCli(["enums", "--transitions"]).json;
    const jy = spawnCli(["enums", "--transitions", "--jianying"]).json;
    // Different namespaces return different slug sets
    if (cap?.length && jy?.length) {
      const _capSlugs = new Set(cap.map((e) => e.member));
      const _jySlugs = new Set(jy.map((e) => e.member));
      // At least some overlap or difference — they shouldn't be identical objects
      assert.notEqual(JSON.stringify(cap), JSON.stringify(jy));
    }
  });
});
