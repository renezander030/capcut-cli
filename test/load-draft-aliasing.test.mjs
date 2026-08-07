import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadDraft, saveDraft } from "../dist/draft.js";

const stateDir = mkdtempSync(join(tmpdir(), "capcut-alias-state-"));
process.env.CAPCUT_CLI_APP_VERSIONS = join(stateDir, "app-versions.json");
after(() => rmSync(stateDir, { recursive: true, force: true }));

function draftNamed(name) {
  return {
    id: "aliasing",
    name,
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "8.7.0", os: "windows" },
    tracks: [],
    materials: { videos: [], audios: [], texts: [], speeds: [] },
  };
}

function project(names) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-alias-"));
  for (const name of names) writeFileSync(join(dir, name), JSON.stringify(draftNamed("original"), null, 2));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const read = (p) => readFileSync(p, "utf-8");

// loadDraft hands back the parsed timeline itself rather than a copy, so the
// store it caches for saveDraft now aliases the caller's draft. Everything
// saveDraft takes from that store must stay immune to the caller's edits.
describe("a draft edited after loadDraft", () => {
  it("does not leak into the pre-write snapshot the .bak is built from", () => {
    const dir = project(["draft_content.json", "draft_info.json"]);
    const original = read(join(dir, "draft_content.json"));

    const { draft, filePath } = loadDraft(dir);
    draft.name = "edited";
    draft.duration = 9_000_000;
    saveDraft(filePath, draft);

    for (const file of ["draft_content.json", "draft_info.json"]) {
      assert.equal(JSON.parse(read(join(dir, file))).name, "edited", file);
      assert.equal(read(`${join(dir, file)}.bak`), original, `${file}.bak must hold the pre-write bytes`);
    }
  });

  it("keeps the write set correct across repeated saves of the same object", () => {
    const dir = project(["draft_content.json", "draft_info.json"]);
    const { draft, filePath } = loadDraft(dir);

    draft.name = "first";
    saveDraft(filePath, draft);
    const afterFirst = read(join(dir, "draft_content.json"));

    draft.name = "second";
    saveDraft(filePath, draft);

    assert.equal(JSON.parse(read(join(dir, "draft_content.json"))).name, "second");
    assert.equal(JSON.parse(read(join(dir, "draft_info.json"))).name, "second");
    assert.equal(
      read(`${join(dir, "draft_content.json")}.bak`),
      afterFirst,
      "the second write's .bak must hold the first write's output",
    );
  });

  it("gives each load its own draft, so one caller's edits never reach another's", () => {
    const dir = project(["draft_content.json"]);
    const first = loadDraft(dir);
    const second = loadDraft(dir);
    assert.notEqual(first.draft, second.draft, "two loads must not share one object");
    first.draft.name = "mutated";
    assert.equal(second.draft.name, "original");
    assert.equal(JSON.parse(read(join(dir, "draft_content.json"))).name, "original", "nothing written yet");
  });

  it("writes the same bytes whether or not the caller reused the loaded object", () => {
    const reused = project(["draft_content.json"]);
    const fresh = project(["draft_content.json"]);

    const a = loadDraft(reused);
    a.draft.name = "one";
    saveDraft(a.filePath, a.draft);
    a.draft.name = "two";
    saveDraft(a.filePath, a.draft);

    const b = loadDraft(fresh);
    b.draft.name = "one";
    saveDraft(b.filePath, b.draft);
    const c = loadDraft(fresh);
    c.draft.name = "two";
    saveDraft(c.filePath, c.draft);

    assert.equal(read(join(reused, "draft_content.json")), read(join(fresh, "draft_content.json")));
  });
});
