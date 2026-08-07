import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { findMaterial } from "../dist/draft.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// findMaterial keeps a per-array id index so a per-segment lookup is not a
// per-segment rescan. These pin the cases where the index has to notice that
// the array it indexed is no longer the array it is being asked about.
describe("findMaterial id index", () => {
  const mat = (id) => ({ id, type: "text", content: id });

  it("returns the same material on repeated lookups", () => {
    const arr = [mat("a"), mat("b"), mat("c")];
    assert.equal(findMaterial(arr, "b"), arr[1]);
    assert.equal(findMaterial(arr, "b"), arr[1]);
    assert.equal(findMaterial(arr, "c"), arr[2]);
    assert.equal(findMaterial(arr, "missing"), undefined);
  });

  it("finds a material pushed onto an already-indexed array", () => {
    const arr = [mat("a")];
    assert.equal(findMaterial(arr, "b"), undefined);
    const added = mat("b");
    arr.push(added);
    assert.equal(findMaterial(arr, "b"), added, "a material added mid-command must be findable");
    assert.equal(findMaterial(arr, "a"), arr[0]);
  });

  it("stops finding a material removed from an already-indexed array", () => {
    const arr = [mat("a"), mat("b")];
    assert.ok(findMaterial(arr, "b"));
    arr.pop();
    assert.equal(findMaterial(arr, "b"), undefined, "a removed material must stop resolving");
    assert.equal(findMaterial(arr, "a"), arr[0]);
  });

  it("does not carry an index across a replaced array", () => {
    const arr = [mat("a"), mat("b")];
    assert.ok(findMaterial(arr, "b"));
    const swept = arr.filter((m) => m.id !== "b");
    assert.equal(findMaterial(swept, "b"), undefined, "the prune sweep replaces the array outright");
    assert.equal(findMaterial(swept, "a"), swept[0]);
  });

  it("sees a material mutated in place, with no invalidation needed", () => {
    const arr = [mat("a"), mat("b")];
    const hit = findMaterial(arr, "a");
    arr[0].content = "rewritten by --fix";
    assert.equal(findMaterial(arr, "a").content, "rewritten by --fix");
    assert.equal(findMaterial(arr, "a"), hit, "the index holds the array's own objects");
  });

  it("resolves a repeated id to the first entry, as the scan did", () => {
    const arr = [mat("dupe"), mat("dupe")];
    arr[1].content = "second";
    assert.equal(findMaterial(arr, "dupe"), arr[0]);
    assert.equal(findMaterial(arr, "dupe"), arr[0]);
  });
});

// The end-to-end version of the invalidation cases above: one process, one
// loaded draft, a material added and then resolved by a later operation.
describe("batch resolves a material added earlier in the same run", () => {
  it("adds a caption and edits it in one invocation", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const before = JSON.parse(readFileSync(fix.path, "utf-8"));
    const beforeTexts = before.materials.texts.length;

    const added = spawnCli(["add-text", fix.path, "0", "2", "seed caption"]);
    assert.equal(added.status, 0, added.stderr);
    const segmentId = added.json.segment_id ?? added.json.id;
    assert.ok(segmentId, JSON.stringify(added.json));

    const result = spawnCli(["batch", fix.path], {
      input: [
        JSON.stringify({ cmd: "set-text", id: segmentId, text: "first rewrite" }),
        JSON.stringify({ cmd: "set-text", id: segmentId, text: "second rewrite" }),
        JSON.stringify({ cmd: "shift", id: segmentId, offset: "+1s" }),
      ].join("\n"),
    });
    assert.equal(result.status, 0, result.stderr);

    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    assert.equal(draft.materials.texts.length, beforeTexts + 1);
    const seg = draft.tracks.flatMap((t) => t.segments).find((s) => s.id === segmentId);
    const material = draft.materials.texts.find((m) => m.id === seg.material_id);
    assert.match(material.content, /second rewrite/);
    assert.equal(seg.target_timerange.start, 1_000_000);
  });
});
