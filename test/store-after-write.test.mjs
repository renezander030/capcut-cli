import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadDraft, saveDraft } from "../dist/draft.js";
import { discoverDraftStore, storeAfterWrite } from "../dist/store.js";

// saveDraft runs the app-upgrade tripwire in-process here, so point its state
// file at a throwaway dir.
const stateDir = mkdtempSync(join(tmpdir(), "capcut-after-write-state-"));
process.env.CAPCUT_CLI_APP_VERSIONS = join(stateDir, "app-versions.json");
after(() => rmSync(stateDir, { recursive: true, force: true }));

function draftAt(version, name) {
  return {
    id: "after-write",
    name,
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: version, os: "windows" },
    tracks: [],
    materials: { videos: [], audios: [], texts: [], speeds: [] },
  };
}

function project(files) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-after-write-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CANDIDATE_FIELDS = [
  "name",
  "path",
  "exists",
  "size",
  "mtime",
  "sha256",
  "raw",
  "parseable",
  "timelineHash",
  "error",
];

function assertSameStore(rolled, rediscovered, label) {
  for (const field of ["projectDir", "version", "modernStorage", "diverged", "layout"]) {
    assert.deepEqual(rolled[field], rediscovered[field], `${label}: store.${field}`);
  }
  assert.deepEqual(rolled.nestedTimelines, rediscovered.nestedTimelines, `${label}: nestedTimelines`);
  assert.equal(rolled.targets.length, rediscovered.targets.length, `${label}: target count`);
  assert.equal(rolled.candidates.length, rediscovered.candidates.length, `${label}: candidate count`);
  for (const list of ["targets", "candidates"]) {
    for (const [i, expected] of rediscovered[list].entries()) {
      const actual = rolled[list][i];
      for (const field of CANDIDATE_FIELDS) {
        assert.deepEqual(actual[field], expected[field], `${label}: ${list}[${i}].${field}`);
      }
      assert.deepEqual(actual.envelopePath, expected.envelopePath, `${label}: ${list}[${i}].envelopePath`);
      assert.deepEqual(actual.draft, expected.draft, `${label}: ${list}[${i}].draft`);
    }
  }
  assert.equal(rolled.canonical.path, rediscovered.canonical.path, `${label}: canonical.path`);
  assert.equal(rolled.canonical.raw, rediscovered.canonical.raw, `${label}: canonical.raw`);
}

// saveDraft rolls its per-path store forward from the bytes it wrote instead
// of discovering the project again. Whatever it produces has to be what a
// re-discovery would have produced.
describe("store rolled forward after a write", () => {
  function saveAndCompare(dir, label) {
    const before = discoverDraftStore(dir);
    const { draft, filePath } = loadDraft(dir);
    draft.name = "edited";
    saveDraft(filePath, draft);
    // The commit handed saveDraft exactly these bytes for exactly these paths.
    const written = new Map(before.targets.map((t) => [t.path, readFileSync(t.path, "utf-8")]));
    assertSameStore(storeAfterWrite(before, draft, written), discoverDraftStore(before.canonical.path), label);
  }

  it("matches a re-discovery on a single-file project", () => {
    const dir = project({ "draft_content.json": JSON.stringify(draftAt("8.7.0", "one"), null, 2) });
    saveAndCompare(dir, "single file");
  });

  it("matches a re-discovery across an enveloped mirror", () => {
    const draft = draftAt("8.7.0", "shared");
    const dir = project({
      "draft_content.json": JSON.stringify(draft, null, 2),
      "template-2.tmp": JSON.stringify({ draft_content: JSON.stringify(draft) }, null, 2),
    });
    saveAndCompare(dir, "enveloped mirror");
  });

  it("drops the store version once the mirror that carried it is overwritten", () => {
    const dir = project({
      "draft_content.json": JSON.stringify(draftAt("8.5.0", "content"), null, 2),
      "draft_info.json": JSON.stringify(draftAt("8.7.0", "info"), null, 2),
    });
    const before = discoverDraftStore(dir);
    assert.equal(before.version, "8.7.0", "the newer mirror must set the store version");
    assert.equal(before.modernStorage, true);

    const { draft, filePath } = loadDraft(dir);
    draft.name = "edited";
    saveDraft(filePath, draft);

    const written = new Map(before.targets.map((t) => [t.path, readFileSync(t.path, "utf-8")]));
    const rolled = storeAfterWrite(before, draft, written);
    const rediscovered = discoverDraftStore(before.canonical.path);
    assert.equal(rolled.version, "8.5.0", "every target now carries the written draft's version");
    assert.equal(rolled.modernStorage, false);
    assertSameStore(rolled, rediscovered, "version drop");
  });

  it("collapses divergence once every target holds the written timeline", () => {
    const dir = project({
      "draft_content.json": JSON.stringify(draftAt("8.7.0", "content"), null, 2),
      "draft_info.json": JSON.stringify(draftAt("8.7.0", "info"), null, 2),
    });
    const before = discoverDraftStore(dir);
    assert.equal(before.diverged, true);

    const { draft, filePath } = loadDraft(dir);
    draft.name = "edited";
    saveDraft(filePath, draft);

    const written = new Map(before.targets.map((t) => [t.path, readFileSync(t.path, "utf-8")]));
    assert.equal(storeAfterWrite(before, draft, written).diverged, false);
    assert.equal(discoverDraftStore(before.canonical.path).diverged, false);
  });

  it("leaves a candidate the write did not touch untouched", () => {
    const dir = project({
      "draft_content.json": JSON.stringify(draftAt("8.7.0", "content"), null, 2),
      "template-2.tmp": "not json at all",
    });
    const before = discoverDraftStore(dir);
    const unreadable = before.candidates.find((c) => c.name === "template-2.tmp");
    assert.equal(unreadable.parseable, false);

    const { draft, filePath } = loadDraft(dir);
    draft.name = "edited";
    saveDraft(filePath, draft);
    const written = new Map(before.targets.map((t) => [t.path, readFileSync(t.path, "utf-8")]));
    const rolled = storeAfterWrite(before, draft, written);
    const carried = rolled.candidates.find((c) => c.name === "template-2.tmp");
    assert.equal(carried.parseable, false);
    assert.equal(carried.raw, "not json at all");
    assert.equal(carried.error, unreadable.error);
  });
});

// The reason the per-path store exists at all: a library caller saving the
// same loaded draft twice must not trip its own changed-on-disk guard.
describe("repeated saves of one loaded draft", () => {
  it("commits every save without a reload", () => {
    const dir = project({
      "draft_content.json": JSON.stringify(draftAt("8.7.0", "content"), null, 2),
      "draft_info.json": JSON.stringify(draftAt("8.7.0", "content"), null, 2),
    });
    const { draft, filePath } = loadDraft(dir);
    for (const name of ["first", "second", "third"]) {
      draft.name = name;
      saveDraft(filePath, draft);
    }
    for (const file of ["draft_content.json", "draft_info.json"]) {
      assert.equal(JSON.parse(readFileSync(join(dir, file), "utf-8")).name, "third", file);
    }
    // The .bak always holds the state immediately before the last write.
    assert.equal(JSON.parse(readFileSync(join(dir, "draft_content.json.bak"), "utf-8")).name, "second");
  });
});
