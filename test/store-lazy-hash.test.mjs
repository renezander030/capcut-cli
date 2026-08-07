import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { discoverDraftStore } from "../dist/store.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function draftNamed(name) {
  return {
    id: "lazy-hash",
    name,
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "8.7.0", os: "windows" },
    tracks: [],
    materials: { videos: [], audios: [], texts: [], speeds: [] },
  };
}

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-lazy-hash-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// timelineHash is computed on first read rather than at discovery. It must
// still be the same value discovery used to produce eagerly: sha256 over
// JSON.stringify of the timeline the candidate exposes.
describe("timeline hash", () => {
  it("is the sha256 of the candidate's own timeline", () => {
    const dir = project({ "draft_content.json": JSON.stringify(draftNamed("one")) });
    const [candidate] = discoverDraftStore(dir).targets;
    assert.equal(candidate.timelineHash, sha256(JSON.stringify(candidate.draft)));
  });

  it("is stable across repeated reads", () => {
    const dir = project({ "draft_content.json": JSON.stringify(draftNamed("one")) });
    const [candidate] = discoverDraftStore(dir).targets;
    assert.equal(candidate.timelineHash, candidate.timelineHash);
  });

  it("hashes the timeline, not the file: same draft, different envelope and indentation", () => {
    const draft = draftNamed("shared");
    const dir = project({
      "draft_content.json": JSON.stringify(draft),
      "template-2.tmp": JSON.stringify({ draft_content: JSON.stringify(draft) }, null, 2),
    });
    const store = discoverDraftStore(dir);
    const content = store.targets.find((c) => c.name === "draft_content.json");
    const template = store.targets.find((c) => c.name === "template-2.tmp");
    assert.equal(content.timelineHash, template.timelineHash);
    assert.notEqual(content.sha256, template.sha256, "the raw bytes differ; only the timeline agrees");
    assert.equal(store.diverged, false);
  });

  it("still reports divergence when the mirrors hold different timelines", () => {
    const dir = project({
      "draft_content.json": JSON.stringify(draftNamed("content")),
      "template-2.tmp": JSON.stringify({ draft_content: JSON.stringify(draftNamed("template")) }),
    });
    const store = discoverDraftStore(dir);
    assert.equal(store.diverged, true);
    assert.equal(store.diverged, true, "the flag must not change on a second read");
  });
});
