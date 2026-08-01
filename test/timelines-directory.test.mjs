import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { extractText, findDraft, loadDraft, saveDraft, updateTextContent } from "../dist/draft.js";
import { diagnoseDraftStore, discoverDraftStore, planTimelineSync } from "../dist/store.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const TIMELINE_ID = "721A7038-E6EE-4D35-AF83-28D787C2C053";

function draftDoc(text, appVersion = "7.7.0") {
  return {
    id: "draft-id",
    name: "capcut-7-project",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: appVersion, os: "mac" },
    tracks: [
      {
        id: "track-1",
        type: "text",
        name: "text",
        attribute: 0,
        segments: [
          {
            id: "seg-1",
            material_id: "mat-1",
            target_timerange: { start: 0, duration: 1_000_000 },
            source_timerange: { start: 0, duration: 1_000_000 },
            speed: 1,
            volume: 1,
            visible: true,
            clip: null,
            extra_material_refs: [],
            render_index: 0,
          },
        ],
      },
    ],
    materials: {
      videos: [],
      audios: [],
      texts: [
        {
          id: "mat-1",
          type: "text",
          content: JSON.stringify({ text, styles: [] }),
          font_size: 15,
          text_color: "#ffffff",
          alignment: 1,
        },
      ],
      speeds: [],
      material_animations: [],
      audio_fades: [],
      transitions: [],
    },
  };
}

function draftText(path) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  return extractText(draft.materials.texts[0].content);
}

function timelineProject(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-timelines-"));
  const timelinesDir = join(dir, "Timelines");
  const activeDir = join(timelinesDir, TIMELINE_ID);
  const rootPath = join(dir, "draft_info.json");
  const nestedName = options.nestedName ?? "draft_info.json";
  const nestedPath = join(activeDir, nestedName);
  mkdirSync(activeDir, { recursive: true });
  writeFileSync(
    rootPath,
    JSON.stringify(draftDoc(options.rootText ?? "STALE ROOT MIRROR", options.appVersion), null, 2),
  );
  const projectJson = options.projectJson ?? { id: TIMELINE_ID, main_timeline_id: TIMELINE_ID, timelines: [] };
  writeFileSync(join(timelinesDir, "project.json"), options.projectRaw ?? JSON.stringify(projectJson));
  if (!options.omitNested) {
    writeFileSync(
      nestedPath,
      JSON.stringify(draftDoc(options.nestedText ?? "REAL TIMELINE SOURCE", options.appVersion), null, 2),
    );
  }
  return {
    dir,
    rootPath,
    nestedPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("CapCut 7.x Timelines directory", () => {
  it("selects the active nested timeline and labels it distinctly from the root mirror", () => {
    const f = timelineProject();
    after(f.cleanup);

    const store = discoverDraftStore(f.dir);
    assert.equal(store.layout, "timelines-primary");
    assert.equal(store.canonical.path, f.nestedPath);
    assert.equal(store.canonical.name, `Timelines/${TIMELINE_ID}/draft_info.json`);
    assert.equal(store.activeTimeline?.path, f.nestedPath);
    assert.deepEqual(
      store.targets.map((candidate) => candidate.name),
      ["draft_info.json", `Timelines/${TIMELINE_ID}/draft_info.json`],
    );
    assert.equal(findDraft(f.dir), f.nestedPath);
    assert.equal(draftText(loadDraft(f.dir).filePath), "REAL TIMELINE SOURCE");

    const report = diagnoseDraftStore(f.dir);
    assert.equal(report.layout, "timelines-primary");
    assert.equal(report.canonical, `Timelines/${TIMELINE_ID}/draft_info.json`);
    assert.ok(report.next_actions.some((action) => /Timelines\/project\.json/.test(action)));
  });

  it("uses project.json id when main_timeline_id is absent", () => {
    const f = timelineProject({ projectJson: { id: TIMELINE_ID } });
    after(f.cleanup);
    assert.equal(findDraft(f.dir), f.nestedPath);
  });

  it("falls back to nested draft_content.json when the active draft_info.json is absent", () => {
    const f = timelineProject({ nestedName: "draft_content.json" });
    after(f.cleanup);
    const store = discoverDraftStore(f.dir);
    assert.equal(store.canonical.path, f.nestedPath);
    assert.equal(store.canonical.name, `Timelines/${TIMELINE_ID}/draft_content.json`);
  });

  it("preserves the established template-2.tmp priority for CapCut 8.7+", () => {
    const f = timelineProject({ appVersion: "8.7.0" });
    after(f.cleanup);
    writeFileSync(
      join(f.dir, "template-2.tmp"),
      JSON.stringify({ draft_content: JSON.stringify(draftDoc("MODERN CANONICAL", "8.7.0")) }, null, 2),
    );

    const store = discoverDraftStore(f.dir);
    assert.equal(store.modernStorage, true);
    assert.equal(store.canonical.name, "template-2.tmp");
    assert.equal(store.activeTimeline, null);
    assert.equal(extractText(store.canonical.draft.materials.texts[0].content), "MODERN CANONICAL");

    const { draft, filePath } = loadDraft(f.dir);
    draft.materials.texts[0].content = updateTextContent(draft.materials.texts[0].content, "MODERN EDIT");
    saveDraft(filePath, draft);
    assert.equal(draftText(f.rootPath), "MODERN EDIT");
    assert.equal(draftText(f.nestedPath), "REAL TIMELINE SOURCE");
    assert.ok(!existsSync(`${f.nestedPath}.bak`), "unverified modern nested files must remain untouched");
  });

  it("falls back safely for legacy, unreadable-index, missing-target, and escaping-id projects", () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "capcut-timelines-legacy-"));
    after(() => rmSync(legacyDir, { recursive: true, force: true }));
    const legacyPath = join(legacyDir, "draft_info.json");
    writeFileSync(legacyPath, JSON.stringify(draftDoc("LEGACY"), null, 2));
    assert.equal(findDraft(legacyDir), legacyPath);

    const unreadable = timelineProject({ projectRaw: "{ not json" });
    after(unreadable.cleanup);
    assert.equal(findDraft(unreadable.dir), unreadable.rootPath);

    const missing = timelineProject({ omitNested: true });
    after(missing.cleanup);
    assert.equal(findDraft(missing.dir), missing.rootPath);

    const escaping = timelineProject({ projectJson: { main_timeline_id: "../../outside" }, omitNested: true });
    after(escaping.cleanup);
    assert.equal(findDraft(escaping.dir), escaping.rootPath);
  });

  it("honors explicit root and nested file paths", () => {
    const f = timelineProject();
    after(f.cleanup);

    assert.equal(findDraft(f.rootPath), f.rootPath);
    assert.equal(findDraft(f.nestedPath), f.nestedPath);
    assert.equal(discoverDraftStore(f.rootPath).canonical.path, f.rootPath);
    const nestedStore = discoverDraftStore(f.nestedPath);
    assert.equal(nestedStore.projectDir, f.dir);
    assert.equal(nestedStore.canonical.path, f.nestedPath);
    assert.ok(nestedStore.targets.some((candidate) => candidate.path === f.rootPath));

    const { draft, filePath } = loadDraft(f.rootPath);
    draft.materials.texts[0].content = updateTextContent(draft.materials.texts[0].content, "EXPLICIT ROOT EDIT");
    saveDraft(filePath, draft);
    assert.equal(draftText(f.rootPath), "EXPLICIT ROOT EDIT");
    assert.equal(draftText(f.nestedPath), "REAL TIMELINE SOURCE");
    assert.ok(!existsSync(`${f.nestedPath}.bak`), "an explicit root edit must not overwrite the active timeline");
  });

  it("keeps the active timeline writable when an explicit root file is unreadable", () => {
    const f = timelineProject();
    after(f.cleanup);
    writeFileSync(f.rootPath, "{ not json");

    const store = discoverDraftStore(f.rootPath);
    assert.equal(store.canonical.path, f.nestedPath);
    assert.ok(store.targets.some((candidate) => candidate.path === f.nestedPath));

    const { draft, filePath } = loadDraft(f.rootPath);
    draft.materials.texts[0].content = updateTextContent(draft.materials.texts[0].content, "NESTED FALLBACK EDIT");
    saveDraft(filePath, draft);
    assert.equal(draftText(f.nestedPath), "NESTED FALLBACK EDIT");
    assert.equal(readFileSync(f.rootPath, "utf-8"), "{ not json");
  });

  it("keeps an explicitly selected archived timeline isolated from the active project", () => {
    const f = timelineProject();
    after(f.cleanup);
    const archivedDir = join(f.dir, "Timelines", "ARCHIVED-TIMELINE");
    const archivedPath = join(archivedDir, "draft_info.json");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(archivedPath, JSON.stringify(draftDoc("ARCHIVED SOURCE"), null, 2));

    const { draft, filePath } = loadDraft(archivedPath);
    draft.materials.texts[0].content = updateTextContent(draft.materials.texts[0].content, "ARCHIVED EDIT");
    saveDraft(filePath, draft);

    assert.equal(draftText(archivedPath), "ARCHIVED EDIT");
    assert.equal(draftText(f.nestedPath), "REAL TIMELINE SOURCE");
    assert.equal(draftText(f.rootPath), "STALE ROOT MIRROR");
  });

  it("rejects a root mirror as an explicit sync source when a nested timeline is authoritative", () => {
    const f = timelineProject();
    after(f.cleanup);
    const rootContent = join(f.dir, "draft_content.json");
    writeFileSync(rootContent, JSON.stringify(draftDoc("ANOTHER ROOT MIRROR"), null, 2));

    assert.throws(() => planTimelineSync(rootContent), /cannot target draft_content\.json directly/);
    assert.equal(draftText(f.nestedPath), "REAL TIMELINE SOURCE");
    assert.equal(draftText(rootContent), "ANOTHER ROOT MIRROR");
  });

  it("rejects an active-directory symlink that escapes the project", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-timelines-symlink-"));
    const external = mkdtempSync(join(tmpdir(), "capcut-timelines-external-"));
    after(() => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    });
    const timelinesDir = join(dir, "Timelines");
    const rootPath = join(dir, "draft_info.json");
    const externalPath = join(external, "draft_info.json");
    mkdirSync(timelinesDir, { recursive: true });
    writeFileSync(rootPath, JSON.stringify(draftDoc("SAFE ROOT"), null, 2));
    writeFileSync(externalPath, JSON.stringify(draftDoc("EXTERNAL FILE"), null, 2));
    symlinkSync(external, join(timelinesDir, "ESCAPE"), "dir");
    writeFileSync(join(timelinesDir, "project.json"), JSON.stringify({ id: "ESCAPE", main_timeline_id: "ESCAPE" }));

    assert.equal(findDraft(dir), rootPath);
    const { draft, filePath } = loadDraft(dir);
    draft.materials.texts[0].content = updateTextContent(draft.materials.texts[0].content, "SAFE EDIT");
    saveDraft(filePath, draft);
    assert.equal(draftText(rootPath), "SAFE EDIT");
    assert.equal(draftText(externalPath), "EXTERNAL FILE");
    assert.ok(!existsSync(`${externalPath}.bak`));
  });

  it("writes the active timeline and root mirror transactionally, including repeated saves", () => {
    const f = timelineProject();
    after(f.cleanup);

    const { draft, filePath } = loadDraft(f.dir);
    draft.materials.texts[0].content = updateTextContent(draft.materials.texts[0].content, "FIRST EDIT");
    saveDraft(filePath, draft);

    assert.equal(draftText(f.nestedPath), "FIRST EDIT");
    assert.equal(draftText(f.rootPath), "FIRST EDIT");
    assert.equal(draftText(`${f.nestedPath}.bak`), "REAL TIMELINE SOURCE");
    assert.equal(draftText(`${f.rootPath}.bak`), "STALE ROOT MIRROR");

    draft.materials.texts[0].content = updateTextContent(draft.materials.texts[0].content, "SECOND EDIT");
    saveDraft(filePath, draft);
    assert.equal(draftText(f.nestedPath), "SECOND EDIT");
    assert.equal(draftText(f.rootPath), "SECOND EDIT");
    assert.equal(draftText(`${f.nestedPath}.bak`), "FIRST EDIT");
    assert.equal(draftText(`${f.rootPath}.bak`), "FIRST EDIT");
  });

  it("sync-timelines always repairs root mirrors from the selected nested source", () => {
    const f = timelineProject();
    after(f.cleanup);
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(f.rootPath, future, future);

    const { plan } = planTimelineSync(f.dir);
    assert.equal(plan.layout, "timelines-primary");
    assert.equal(plan.canonical, `Timelines/${TIMELINE_ID}/draft_info.json`);
    assert.deepEqual(plan.drifted, ["draft_info.json"]);
    assert.equal(plan.canonical_stale, false, "a newer derived mirror must not reverse structural authority");
    assert.deepEqual(plan.newer_mirrors, []);

    // `--force-write` isolates this direction test from a real/fake CapCut
    // process elsewhere on the host; the fixture itself is an unmanaged temp dir.
    const r = spawnCli(["sync-timelines", f.dir, "--apply", "--force-write"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.canonical, `Timelines/${TIMELINE_ID}/draft_info.json`);
    assert.deepEqual(r.json.reconciled, ["draft_info.json"]);
    assert.match(r.stderr, new RegExp(`Reconciled from Timelines/${TIMELINE_ID}/draft_info\\.json`));
    assert.equal(draftText(f.rootPath), "REAL TIMELINE SOURCE");
    assert.equal(draftText(f.nestedPath), "REAL TIMELINE SOURCE");
    assert.equal(draftText(`${f.rootPath}.bak`), "STALE ROOT MIRROR");
    assert.ok(!existsSync(`${f.nestedPath}.bak`), "the canonical nested source must remain read-only");
  });
});
