import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { findDraft } from "../dist/draft.js";
import { diagnoseDraftStore, discoverDraftStore } from "../dist/store.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const TIMELINE_ID = "721A7038-E6EE-4D35-AF83-28D787C2C053";

// The issue #50 shape: a CapCut 7.x project whose root draft_info.json is a
// regenerated mirror while Timelines/<main_timeline_id>/draft_info.json is
// reported to be the live document. The guard under test is DETECTION ONLY:
// reads and writes must keep targeting the root file exactly as in v0.16.1,
// with a stderr WARNING instead of silence.
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
  const dir = mkdtempSync(join(tmpdir(), "capcut-timelines-layout-"));
  const rootName = options.rootName ?? "draft_info.json";
  const rootPath = join(dir, rootName);
  writeFileSync(rootPath, JSON.stringify(draftDoc(options.rootText ?? "ROOT MIRROR", options.appVersion), null, 2));
  const timelinesDir = join(dir, "Timelines");
  const activeDir = join(timelinesDir, TIMELINE_ID);
  const nestedPath = join(activeDir, "draft_info.json");
  if (options.omitTimelines !== true) {
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(
      join(timelinesDir, "project.json"),
      JSON.stringify({ id: TIMELINE_ID, main_timeline_id: TIMELINE_ID }),
    );
    if (options.omitNested !== true) {
      writeFileSync(
        nestedPath,
        JSON.stringify(draftDoc(options.nestedText ?? "NESTED LIVE DOCUMENT", options.appVersion), null, 2),
      );
    }
  }
  return { dir, rootPath, nestedPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("CapCut 7.x nested Timelines/ layout (issue #50, detection-only guard)", () => {
  it("reports timelines-nested without moving canonical or targets off the root file", () => {
    const f = nestedProject();
    after(f.cleanup);

    const store = discoverDraftStore(f.dir);
    assert.equal(store.layout, "timelines-nested");
    assert.equal(
      store.canonical.path,
      f.rootPath,
      "canonical must stay the root file — no flip without field evidence",
    );
    assert.deepEqual(
      store.targets.map((candidate) => candidate.name),
      ["draft_info.json"],
      "the nested document must never join the write set",
    );
    assert.deepEqual(store.nestedTimelines, ["Timelines/project.json", `Timelines/${TIMELINE_ID}/draft_info.json`]);
    assert.equal(findDraft(f.dir), f.rootPath);
  });

  it("detects Timelines/project.json alone, and root draft_content.json stays canonical when present", () => {
    const pointerOnly = nestedProject({ omitNested: true });
    after(pointerOnly.cleanup);
    const s1 = discoverDraftStore(pointerOnly.dir);
    assert.equal(s1.layout, "timelines-nested");
    assert.deepEqual(s1.nestedTimelines, ["Timelines/project.json"]);

    const withContent = nestedProject();
    after(withContent.cleanup);
    writeFileSync(join(withContent.dir, "draft_content.json"), JSON.stringify(draftDoc("ROOT CONTENT"), null, 2));
    const s2 = discoverDraftStore(withContent.dir);
    assert.equal(s2.layout, "timelines-nested");
    assert.equal(s2.canonical.name, "draft_content.json");
  });

  it("diagnose names the layout, the discard risk, and the fixture CTA", () => {
    const f = nestedProject();
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.layout, "timelines-nested");
    assert.equal(r.json.canonical, "draft_info.json");
    assert.deepEqual(r.json.nested_timelines, ["Timelines/project.json", `Timelines/${TIMELINE_ID}/draft_info.json`]);
    assert.ok(
      r.json.next_actions.some((a) => /Timelines\//.test(a) && /discard/.test(a) && /capcut fixture/.test(a)),
      `next_actions must name the layout, the risk, and the fixture CTA; got: ${JSON.stringify(r.json.next_actions)}`,
    );
    assert.ok(
      r.json.next_actions.some((a) => /draft_info-primary/.test(a)),
      "the draft_info-primary canonical note must survive the new layout value",
    );
  });

  it("version names the layout alongside the write-guard notes", () => {
    const f = nestedProject();
    after(f.cleanup);

    const r = spawnCli(["version", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.json.support.notes.some((n) => /Timelines\//.test(n) && /discard/.test(n) && /capcut fixture/.test(n)),
      `support.notes must name the layout; got: ${JSON.stringify(r.json.support.notes)}`,
    );
  });

  it("mutating commands warn loudly but write the root file byte-identically to a Timelines-free project", () => {
    const nested = nestedProject();
    const plain = nestedProject({ omitTimelines: true });
    after(nested.cleanup);
    after(plain.cleanup);
    const nestedBefore = readFileSync(nested.nestedPath, "utf-8");

    const rNested = spawnCli(["set-text", nested.dir, "seg-1", "changed"]);
    const rPlain = spawnCli(["set-text", plain.dir, "seg-1", "changed"]);
    assert.equal(rNested.status, 0, `stderr: ${rNested.stderr}`);
    assert.equal(rPlain.status, 0, `stderr: ${rPlain.stderr}`);

    assert.match(rNested.stderr, /WARNING: Nested Timelines\/ layout detected/, "the write must not stay silent");
    assert.match(rNested.stderr, /discarded/, "the warning must state the root-mirror discard risk");
    assert.ok(!/Timelines/.test(rPlain.stderr), "a Timelines-free project must not warn");

    assert.equal(
      readFileSync(nested.rootPath, "utf-8"),
      readFileSync(plain.rootPath, "utf-8"),
      "the written root file must be byte-identical with and without the nested layout",
    );
    assert.equal(
      readFileSync(`${nested.rootPath}.bak`, "utf-8"),
      readFileSync(`${plain.rootPath}.bak`, "utf-8"),
      "the .bak must be byte-identical too",
    );
    assert.equal(readFileSync(nested.nestedPath, "utf-8"), nestedBefore, "the nested document must never be written");
    assert.ok(!existsSync(`${nested.nestedPath}.bak`), "no .bak may appear next to the nested document");
  });

  it("editing the nested document explicitly stays explicit and leaves the root mirror alone", () => {
    const f = nestedProject();
    after(f.cleanup);
    const rootBefore = readFileSync(f.rootPath, "utf-8");

    const r = spawnCli(["set-text", f.nestedPath, "seg-1", "nested edit"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(readFileSync(f.nestedPath, "utf-8"), /nested edit/);
    assert.equal(readFileSync(f.rootPath, "utf-8"), rootBefore, "an explicit nested edit must not touch the root file");
  });

  it("CapCut >= 8.7 stores keep their layout value and write silently", () => {
    const f = nestedProject({ appVersion: "8.7.0", rootName: "draft_content.json" });
    after(f.cleanup);

    const store = discoverDraftStore(f.dir);
    assert.equal(store.modernStorage, true);
    assert.equal(store.layout, "content-primary", "the 7.x claim must not relabel >= 8.7 storage");
    assert.deepEqual(store.nestedTimelines, ["Timelines/project.json", `Timelines/${TIMELINE_ID}/draft_info.json`]);

    // Writes stay silent: CapCut creates Timelines/ routinely on modern builds
    // (issue #60), so a per-write warning would fire for the majority on a
    // hazard nobody has evidenced. `diagnose` is where the note belongs.
    const r = spawnCli(["set-text", f.dir, "seg-1", "modern edit"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!/Timelines/.test(r.stderr), "no nested-layout warning on >= 8.7 writes");
    const report = diagnoseDraftStore(f.dir);
    assert.ok(
      !report.next_actions.some((a) => /may discard those edits/.test(a)),
      "diagnose must not carry the 7.x discard claim on >= 8.7 storage",
    );
  });

  it("sync-timelines --apply warns on the nested layout and still repairs from the root canonical", () => {
    const f = nestedProject({ rootText: "STALE INFO MIRROR" });
    after(f.cleanup);
    writeFileSync(join(f.dir, "draft_content.json"), JSON.stringify(draftDoc("ROOT CANONICAL"), null, 2));

    // --force-write isolates the test from a real CapCut process elsewhere on
    // the host and from the root mirror's newer mtime; the temp dir itself is
    // unmanaged.
    const r = spawnCli(["sync-timelines", f.dir, "--apply", "--force-write"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.layout, "timelines-nested");
    assert.deepEqual(r.json.reconciled, ["draft_info.json"]);
    assert.match(r.stderr, /WARNING: Nested Timelines\/ layout detected/);
    assert.match(readFileSync(f.rootPath, "utf-8"), /ROOT CANONICAL/, "repair still runs root-to-root");
    assert.match(readFileSync(f.nestedPath, "utf-8"), /NESTED LIVE DOCUMENT/, "the nested document is never a target");
  });

  it("fixture captures the redacted nested layout so the #50 artifact can finally be supplied", (t) => {
    const f = nestedProject();
    after(f.cleanup);
    // Plant redactable values in the nested document and the pointer.
    const nested = draftDoc("NESTED LIVE DOCUMENT");
    nested.materials.videos.push({ id: "vid-1", type: "video", path: "/home/secretuser/clips/a.mp4" });
    writeFileSync(f.nestedPath, JSON.stringify(nested, null, 2));
    const outDir = mkdtempSync(join(tmpdir(), "capcut-timelines-bundle-"));
    t.after(() => rmSync(outDir, { recursive: true, force: true }));

    const r = spawnCli(["fixture", f.dir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    const names = r.json.files.map((file) => file.file);
    assert.ok(names.includes("Timelines/project.json"), `bundle must carry the pointer; got: ${names}`);
    assert.ok(names.includes(`Timelines/${TIMELINE_ID}/draft_info.json`), "bundle must carry the nested document");
    const bundledNested = readFileSync(join(outDir, "Timelines", TIMELINE_ID, "draft_info.json"), "utf-8");
    assert.ok(!bundledNested.includes("secretuser"), "nested document must be redacted");
    assert.ok(bundledNested.includes("/home/USER/"), "home path should be normalized");
    assert.ok(
      r.json.notes.some((n) => /#50/.test(n)),
      "the sanitize report must point the reporter at issue #50",
    );
  });
});

// #68: the guidance above fired on layout alone, so an 8.5.0 user was shown 7.x
// text their own evidence contradicts — on that build the nested document was
// byte-identical to the root file after an open/close round trip. The 7.x
// caution itself is NOT softened: #50 covers 7.x and the 8.5.0 reporter did not
// test it. What changes is that the message now depends on detected version.
describe("nested Timelines/ guidance is version-gated (issue #68)", () => {
  it("tells an 8.5.0 project the mirror is regenerated from the root file", () => {
    const f = nestedProject({ appVersion: "8.5.0" });
    after(f.cleanup);

    const action = diagnoseDraftStore(f.dir).next_actions.find((a) => /Timelines\//.test(a));
    assert.ok(action, "the layout must still produce a next_action");
    assert.match(action, /issue #68/);
    assert.match(action, /regenerate the nested document from the project-root file/);
    assert.doesNotMatch(action, /may discard those edits/, "the 7.x risk must not be asserted for 8.5.0");
  });

  it("keeps the cautious #50 wording for 7.x", () => {
    const f = nestedProject({ appVersion: "7.9.0" });
    after(f.cleanup);

    const action = diagnoseDraftStore(f.dir).next_actions.find((a) => /Timelines\//.test(a));
    assert.ok(action, "the layout must still produce a next_action");
    assert.match(action, /issue #50/);
    assert.match(action, /may discard those edits/);
  });

  it("keeps the cautious wording when no version marker is present", () => {
    const f = nestedProject();
    after(f.cleanup);

    const action = diagnoseDraftStore(f.dir).next_actions.find((a) => /Timelines\//.test(a));
    assert.ok(action, "the layout must still produce a next_action");
    assert.match(action, /issue #50/, "an unknown version stays cautious");
  });

  it("gates the write-time stderr warning the same way", () => {
    const f = nestedProject({ appVersion: "8.5.0" });
    after(f.cleanup);
    writeFileSync(join(f.dir, "draft_content.json"), JSON.stringify(draftDoc("ROOT CANONICAL", "8.5.0"), null, 2));

    const r = spawnCli(["sync-timelines", f.dir, "--apply", "--force-write"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /WARNING: Nested Timelines\/ layout detected on CapCut 8\.5\.0/);
    assert.match(r.stderr, /issue #68/);
    assert.doesNotMatch(r.stderr, /may\s+be discarded the next time/, "8.5.0 must not get the 7.x risk claim");
  });
});

// A >= 8.7 store keeps its content-/info-primary layout value by design, so both
// the layout-gated action and the layout-gated `version` note fell away — while
// `diagnose` still attached the redacted nested evidence and `fixture` still
// bundled it, both keyed off nested_timelines.length rather than the layout.
// The report was carrying Timelines/ evidence with no line of text saying why.
describe("nested Timelines/ on >= 8.7 storage is named, not asserted", () => {
  it("diagnose names the layout claim-free, with the fixture CTA", () => {
    const f = nestedProject({ appVersion: "9.2.8" });
    after(f.cleanup);

    const store = discoverDraftStore(f.dir);
    assert.equal(store.layout, "info-primary", "the layout value stays as it was");
    assert.equal(store.modernStorage, true);

    const action = diagnoseDraftStore(f.dir).next_actions.find((a) => /Timelines\//.test(a));
    assert.ok(action, ">= 8.7 nested stores must no longer be silent");
    assert.match(action, />= 8\.7 storage/);
    assert.match(action, /capcut fixture/);
    assert.match(action, /issue #50/);
    // Claim-free in both directions: neither report transfers across 8.7.
    assert.doesNotMatch(action, /may discard those edits/, "the 7.x risk must not be asserted");
    assert.doesNotMatch(action, /should survive the next open/, "the 8.5.0 survival claim must not be asserted");
  });

  it("version carries the same note alongside the write-guard notes", () => {
    const f = nestedProject({ appVersion: "9.2.8" });
    after(f.cleanup);

    const r = spawnCli(["version", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const note = r.json.support.notes.find((n) => /Timelines\//.test(n));
    assert.ok(note, `support.notes must name the layout; got: ${JSON.stringify(r.json.support.notes)}`);
    assert.match(note, />= 8\.7 storage/);
  });

  it("the JSON report's nested evidence and the prose note now agree", () => {
    const f = nestedProject({ appVersion: "9.2.8" });
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.nested_timelines, ["Timelines/project.json", `Timelines/${TIMELINE_ID}/draft_info.json`]);
    assert.ok(r.json.nested_evidence, "evidence was already attached on >= 8.7 — that is the half that worked");
    assert.ok(
      r.json.next_actions.some((a) => /Timelines\//.test(a)),
      "and now a next_action explains why the evidence is there",
    );
  });

  it("a >= 8.7 store with no Timelines/ directory stays completely silent", () => {
    const f = nestedProject({ appVersion: "9.2.8", omitTimelines: true });
    after(f.cleanup);

    const report = diagnoseDraftStore(f.dir);
    assert.deepEqual(report.nested_timelines, []);
    assert.ok(!report.next_actions.some((a) => /Timelines\//.test(a)), "no note without the structure");

    const r = spawnCli(["version", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!r.json.support.notes.some((n) => /Timelines\//.test(n)));
  });

  it("never emits both the layout action and the >= 8.7 note", () => {
    for (const appVersion of ["7.9.0", "8.5.0", "8.7.0", "9.2.8"]) {
      const f = nestedProject({ appVersion });
      after(f.cleanup);
      const hits = diagnoseDraftStore(f.dir).next_actions.filter((a) => /Timelines\//.test(a));
      assert.equal(hits.length, 1, `${appVersion} must produce exactly one nested note, got ${hits.length}`);
    }
  });
});
