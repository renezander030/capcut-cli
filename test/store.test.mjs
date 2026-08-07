import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDraft, saveDraft } from "../dist/draft.js";
import { diagnoseDraftStore, discoverDraftStore } from "../dist/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WINDOWS_87 = join(__dirname, "fixtures", "capcut-8.7-windows");

// saveDraft runs the app-upgrade tripwire in-process here (no spawn-cli
// isolation), so point its state file at a throwaway dir.
const stateDir = mkdtempSync(join(tmpdir(), "capcut-store-state-"));
process.env.CAPCUT_CLI_APP_VERSIONS = join(stateDir, "app-versions.json");
after(() => rmSync(stateDir, { recursive: true, force: true }));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-store-"));
  const draft = {
    id: "draft-87",
    name: "content-old",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "8.7.0", os: "windows" },
    tracks: [],
    materials: {
      videos: [],
      audios: [],
      texts: [],
      speeds: [],
      material_animations: [],
      audio_fades: [],
      transitions: [],
    },
  };
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(draft, null, 2));
  const templateDraft = { ...draft, name: "template-canonical" };
  writeFileSync(join(dir, "template-2.tmp"), JSON.stringify({ draft_content: JSON.stringify(templateDraft) }, null, 2));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("CapCut 8.7 draft store", () => {
  it("selects the committed Windows 8.7 synthetic fixture", () => {
    const store = discoverDraftStore(WINDOWS_87);
    assert.equal(store.canonical.name, "template-2.tmp");
    assert.equal(store.canonical.draft.name, "template-canonical");
    assert.equal(store.modernStorage, true);
    assert.equal(store.diverged, true);
  });

  it("selects template-2.tmp and synchronizes every readable timeline target", () => {
    const f = fixture();
    after(f.cleanup);
    const store = discoverDraftStore(f.dir);
    assert.equal(store.canonical.name, "template-2.tmp");
    assert.equal(store.diverged, true);

    const { draft, filePath } = loadDraft(f.dir);
    assert.equal(draft.name, "template-canonical");
    draft.name = "synchronized";
    saveDraft(filePath, draft);

    const content = JSON.parse(readFileSync(join(f.dir, "draft_content.json"), "utf-8"));
    const envelope = JSON.parse(readFileSync(join(f.dir, "template-2.tmp"), "utf-8"));
    assert.equal(content.name, "synchronized");
    assert.equal(JSON.parse(envelope.draft_content).name, "synchronized");
    assert.equal(discoverDraftStore(f.dir).diverged, false);
    assert.ok(readFileSync(join(f.dir, "draft_content.json.bak"), "utf-8").includes("content-old"));
    assert.ok(readFileSync(join(f.dir, "template-2.tmp.bak"), "utf-8").includes("template-canonical"));
  });

  it("refuses to overwrite a sibling changed after load", () => {
    const f = fixture();
    after(f.cleanup);
    const { draft, filePath } = loadDraft(f.dir);
    const contentPath = join(f.dir, "draft_content.json");
    writeFileSync(contentPath, `${readFileSync(contentPath, "utf-8")}\n`);
    draft.name = "should-not-write";
    assert.throws(() => saveDraft(filePath, draft), /changed on disk/);
    assert.equal(
      JSON.parse(JSON.parse(readFileSync(join(f.dir, "template-2.tmp"), "utf-8")).draft_content).name,
      "template-canonical",
    );
  });

  it("creates a redacted diagnostic report", () => {
    const f = fixture();
    after(f.cleanup);
    const report = diagnoseDraftStore(f.dir);
    assert.equal(report.canonical, "template-2.tmp");
    assert.equal(report.modern_storage, true);
    assert.equal(report.project_dir, "<project>");
    assert.ok(report.candidates.every((candidate) => !JSON.stringify(candidate).includes(f.dir)));
  });

  it("diagnose surfaces the version write guard as a field and a next_action", () => {
    const f = fixture();
    after(f.cleanup);
    const inRange = diagnoseDraftStore(f.dir);
    assert.equal(inRange.write_guard, "ok");
    assert.ok(!inRange.next_actions.join(" ").includes("Version boundary"));

    const dir = mkdtempSync(join(tmpdir(), "capcut-store-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const beyond = {
      id: "draft-108",
      name: "beyond-range",
      duration: 1_000_000,
      fps: 30,
      canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
      platform: { app_source: "cc", app_version: "10.8.0", os: "mac" },
      tracks: [],
      materials: {
        videos: [],
        audios: [],
        texts: [],
        speeds: [],
        material_animations: [],
        audio_fades: [],
        transitions: [],
      },
    };
    writeFileSync(join(dir, "draft_content.json"), JSON.stringify(beyond, null, 2));
    const report = diagnoseDraftStore(dir);
    assert.equal(report.write_guard, "refuse");
    const advice = report.next_actions.join(" ");
    assert.match(advice, /refuse without --force-write/);
    assert.match(advice, /capcut fixture/, "the next_action must carry the fixture-collection CTA");
  });
});
