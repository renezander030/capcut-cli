import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { diagnoseDraftStore } from "../dist/store.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const TIMELINE_ID = "721A7038-E6EE-4D35-AF83-28D787C2C053";

// The issue #50 evidence capture: when (and only when) a project carries the
// nested Timelines/ structure, `diagnose` must attach the four items the issue
// is stalled on — the redacted Timelines/project.json pointer, the
// draft/template/project file tree, the app version + OS marker, and a
// root-vs-nested comparison in counts and hashes (never raw text).
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

function nestedProject(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-diag-nested-"));
  const rootName = options.rootName ?? "draft_info.json";
  const rootPath = join(dir, rootName);
  const rootDoc = options.rootDoc ?? draftDoc(options.rootText ?? "ROOT MIRROR", options.appVersion);
  writeFileSync(rootPath, JSON.stringify(rootDoc, null, 2));
  const timelinesDir = join(dir, "Timelines");
  const activeDir = join(timelinesDir, TIMELINE_ID);
  const nestedPath = join(activeDir, "draft_info.json");
  mkdirSync(activeDir, { recursive: true });
  writeFileSync(
    join(timelinesDir, "project.json"),
    JSON.stringify(options.pointer ?? { id: TIMELINE_ID, main_timeline_id: TIMELINE_ID }),
  );
  if (options.omitNested !== true) {
    const nestedDoc = options.nestedDoc ?? draftDoc(options.nestedText ?? "NESTED LIVE DOCUMENT", options.appVersion);
    writeFileSync(nestedPath, JSON.stringify(nestedDoc, null, 2));
  }
  return { dir, rootPath, nestedPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("diagnose nested-Timelines evidence (issue #50)", () => {
  it("a normal draft produces byte-identical diagnose output with no evidence section", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-diag-plain-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "draft_content.json"), JSON.stringify(draftDoc("PLAIN"), null, 2));

    const r = spawnCli(["diagnose", dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!("nested_evidence" in r.json), "no evidence section may appear on a non-nested draft");
    // Byte-identity: the CLI layer adds nothing beyond the library report.
    const expected = `${JSON.stringify({ ...diagnoseDraftStore(dir), bundle: null })}\n`;
    assert.equal(r.stdout, expected);
  });

  it("captures pointer, file tree, and version marker for a nested layout", () => {
    const f = nestedProject({
      pointer: {
        id: TIMELINE_ID,
        main_timeline_id: TIMELINE_ID,
        workspace: "/home/secretuser/CapCut/projects",
        device_id: "0123456789abcdef0123456789abcdef",
      },
    });
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const ev = r.json.nested_evidence;
    assert.ok(ev, "nested layout must attach the evidence section");
    assert.match(ev.issue, /issues\/50/);
    assert.match(ev.note, /issue #50/);
    assert.match(ev.note, /before\/after/);

    // Item 3: the exact version + OS marker the draft carries.
    assert.equal(ev.app_version, "7.7.0");
    assert.equal(ev.os, "mac");

    // Item 1: Timelines/project.json through the standard redactors (#59).
    assert.ok(ev.timelines_project_json.includes(TIMELINE_ID), "ids stay intact");
    assert.ok(!ev.timelines_project_json.includes("secretuser"), "home path must be redacted");
    assert.ok(ev.timelines_project_json.includes("/home/USER/"), "home path is normalized, not deleted");
    assert.ok(!ev.timelines_project_json.includes("0123456789abcdef"), "device_id must be blanked");
    assert.ok(ev.redaction_kinds.linux_user >= 1);
    assert.ok(ev.redaction_kinds.device_ids >= 1);

    // Item 2: the file tree with sizes and mtimes.
    const paths = ev.file_tree.map((e) => e.path);
    assert.deepEqual(paths, [`Timelines/${TIMELINE_ID}/draft_info.json`, "Timelines/project.json", "draft_info.json"]);
    for (const entry of ev.file_tree) {
      assert.ok(entry.size > 0, `${entry.path} must carry a size`);
      assert.match(entry.mtime, /^\d{4}-\d{2}-\d{2}T/, `${entry.path} must carry an mtime`);
    }
  });

  it("reports identical root and nested documents as identical, with no track deltas", () => {
    const doc = draftDoc("SAME CONTENT");
    const f = nestedProject({ rootDoc: doc, nestedDoc: doc });
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const [cmp] = r.json.nested_evidence.root_vs_nested;
    assert.equal(cmp.root_file, "draft_info.json");
    assert.equal(cmp.nested_file, `Timelines/${TIMELINE_ID}/draft_info.json`);
    assert.equal(cmp.identical, true);
    assert.equal(cmp.root_timeline_hash, cmp.nested_timeline_hash);
    assert.equal(cmp.mtime_newer, null);
    assert.deepEqual(cmp.track_deltas, []);
  });

  it("reports a diverging nested document with mtime order and per-track counts/hashes, never raw text", () => {
    const f = nestedProject({ rootText: "NEW ROOT CAPTION", nestedText: "OLD NESTED SECRET CAPTION" });
    after(f.cleanup);
    // The root mirror was "just written"; the nested document is the older state.
    const old = new Date(Date.now() - 120_000);
    utimesSync(f.nestedPath, old, old);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const [cmp] = r.json.nested_evidence.root_vs_nested;
    assert.equal(cmp.identical, false);
    assert.notEqual(cmp.root_timeline_hash, cmp.nested_timeline_hash);
    assert.equal(cmp.mtime_newer, "root");
    assert.match(cmp.verdict, /before\/after/);
    assert.match(cmp.verdict, /authoritative/);

    assert.equal(cmp.track_deltas.length, 1);
    const delta = cmp.track_deltas[0];
    assert.equal(delta.track, 0);
    assert.equal(delta.root.type, "text");
    assert.equal(delta.root.segments, 1);
    assert.equal(delta.root.texts, 1);
    assert.notEqual(delta.root.text_hash, delta.nested.text_hash, "the hash must prove the text changed");
    assert.ok(!r.stdout.includes("SECRET CAPTION"), "raw text content must never enter the report");
  });

  it("diagnose --bundle carries the evidence section", (t) => {
    const f = nestedProject();
    after(f.cleanup);
    const outDir = mkdtempSync(join(tmpdir(), "capcut-diag-bundle-"));
    t.after(() => rmSync(outDir, { recursive: true, force: true }));
    const bundlePath = join(outDir, "report.json");

    const r = spawnCli(["diagnose", f.dir, "--bundle", bundlePath]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const bundled = JSON.parse(readFileSync(bundlePath, "utf-8"));
    assert.ok(bundled.nested_evidence, "the bundle must carry the evidence");
    assert.equal(bundled.nested_evidence.root_vs_nested.length, 1);
    assert.ok(bundled.nested_evidence.timelines_project_json.includes(TIMELINE_ID));
  });

  it("attaches evidence on >= 8.7 storage too when nested documents exist, without relabeling the layout", () => {
    const f = nestedProject({ appVersion: "8.7.0", rootName: "draft_content.json" });
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.layout, "content-primary", "detection-only: the layout value stays untouched");
    assert.ok(r.json.nested_evidence, "nested documents on disk still get captured");
    assert.equal(r.json.nested_evidence.root_vs_nested[0].root_file, "draft_content.json");
  });

  it("fixture's diagnose.json inside the bundle carries the same evidence", (t) => {
    const f = nestedProject();
    after(f.cleanup);
    const outDir = mkdtempSync(join(tmpdir(), "capcut-fixture-diag-"));
    t.after(() => rmSync(outDir, { recursive: true, force: true }));

    const r = spawnCli(["fixture", f.dir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const report = JSON.parse(readFileSync(join(outDir, "diagnose.json"), "utf-8"));
    assert.ok(report.nested_evidence, "the fixture bundle's diagnose report must carry the #50 evidence");
  });
});
