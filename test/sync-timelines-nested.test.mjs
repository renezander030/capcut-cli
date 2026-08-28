import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// The canonical timeline: what the CLI wrote to the root files.
function canonicalDraft() {
  return {
    id: "guid-canonical",
    name: "edited-by-cli",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "8.7.0", os: "windows" },
    tracks: [{ id: "T1", type: "text", name: "text", attribute: 0, segments: [] }],
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
}

// The stale nested timeline: the pre-edit state still sitting under
// Timelines/<id>/ after a root-file write the app then ignored.
function staleNested() {
  return { ...canonicalDraft(), id: "tl-1", name: "before-cli-edit", tracks: [] };
}

// Nested Timelines/<id>/ fixture (issue #50, CapCut Mac 9.2.8 report): the
// root files agree with each other, but the nested documents still hold the
// pre-edit timeline under the timeline id ("tl-1") — exactly the state after
// a CLI write that the app then discarded. project.json is the pointer.
function nestedFixture({ newerNested = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-sync-nested-"));
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(canonicalDraft(), null, 2));
  writeFileSync(join(dir, "draft_info.json"), JSON.stringify(canonicalDraft(), null, 2));
  mkdirSync(join(dir, "Timelines", "tl-1"), { recursive: true });
  writeFileSync(join(dir, "Timelines", "project.json"), JSON.stringify({ main_timeline_id: "tl-1" }, null, 2));
  writeFileSync(join(dir, "Timelines", "tl-1", "draft_info.json"), JSON.stringify(staleNested(), null, 2));
  writeFileSync(
    join(dir, "Timelines", "tl-1", "template-2.tmp"),
    JSON.stringify({ draft_content: JSON.stringify(staleNested()) }, null, 2),
  );
  const past = new Date(Date.now() - 3_600_000);
  if (newerNested) {
    utimesSync(join(dir, "draft_content.json"), past, past);
    utimesSync(join(dir, "draft_info.json"), past, past);
  } else {
    utimesSync(join(dir, "Timelines", "tl-1", "draft_info.json"), past, past);
    utimesSync(join(dir, "Timelines", "tl-1", "template-2.tmp"), past, past);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("sync-timelines --nested (issue #50)", () => {
  it("default run reports nested documents as available but never touches or counts them", () => {
    const f = nestedFixture();
    after(f.cleanup);
    const nestedBefore = readFileSync(join(f.dir, "Timelines", "tl-1", "draft_info.json"), "utf-8");

    const r = spawnCli(["sync-timelines", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.in_sync, true, "root targets agree; nested must not flip the verdict without --nested");
    assert.equal(r.json.nested_available, 2);
    assert.equal(r.json.nested_included, false);
    assert.ok(
      !r.json.targets.some((t) => t.file.startsWith("Timelines/")),
      "nested rows must not appear without --nested",
    );
    assert.match(r.stderr, /--nested/, "the run must point at the opt-in instead of staying silent");
    assert.equal(
      readFileSync(join(f.dir, "Timelines", "tl-1", "draft_info.json"), "utf-8"),
      nestedBefore,
      "default run must not write nested documents",
    );
  });

  it("--nested plan lists the drifted nested documents, keeping their own GUID", () => {
    const f = nestedFixture();
    after(f.cleanup);

    const r = spawnCli(["sync-timelines", f.dir, "--nested"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.applied, false);
    assert.equal(r.json.nested_included, true);
    assert.deepEqual(r.json.drifted.sort(), ["Timelines/tl-1/draft_info.json", "Timelines/tl-1/template-2.tmp"]);
    const row = r.json.targets.find((t) => t.file === "Timelines/tl-1/draft_info.json");
    assert.equal(row.state, "drifted");
    assert.equal(row.nested, true);
    assert.match(r.stderr, /keeps its own GUID tl-1/);
    assert.equal(
      JSON.parse(readFileSync(join(f.dir, "Timelines", "tl-1", "draft_info.json"), "utf-8")).name,
      "before-cli-edit",
      "plan must not write",
    );
  });

  it("--nested --apply copies the root timeline into the nested documents, preserving each GUID and the pointer", () => {
    const f = nestedFixture();
    after(f.cleanup);
    const pointerBefore = readFileSync(join(f.dir, "Timelines", "project.json"), "utf-8");
    const rootBefore = readFileSync(join(f.dir, "draft_content.json"), "utf-8");

    const r = spawnCli(["sync-timelines", f.dir, "--nested", "--apply"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.applied, true);
    assert.equal(r.json.in_sync, true, "the post-write verify must see the nested documents as reconciled");
    assert.deepEqual(r.json.reconciled.sort(), ["Timelines/tl-1/draft_info.json", "Timelines/tl-1/template-2.tmp"]);

    // Nested draft_info.json: canonical timeline, but the document keeps the
    // timeline id: the verified 9.2.8 workaround writes tl-1, not the root id.
    const nestedInfo = JSON.parse(readFileSync(join(f.dir, "Timelines", "tl-1", "draft_info.json"), "utf-8"));
    assert.equal(nestedInfo.id, "tl-1", "nested document must keep its own GUID");
    assert.equal(nestedInfo.name, "edited-by-cli");
    assert.equal(nestedInfo.tracks.length, 1);

    // Nested template-2.tmp keeps its string-JSON envelope and its GUID.
    const envelope = JSON.parse(readFileSync(join(f.dir, "Timelines", "tl-1", "template-2.tmp"), "utf-8"));
    const mirrored = JSON.parse(envelope.draft_content);
    assert.equal(mirrored.id, "tl-1");
    assert.equal(mirrored.name, "edited-by-cli");

    // The pointer and the root files are untouched.
    assert.equal(readFileSync(join(f.dir, "Timelines", "project.json"), "utf-8"), pointerBefore);
    assert.equal(readFileSync(join(f.dir, "draft_content.json"), "utf-8"), rootBefore);

    // Backups of the pre-repair nested documents exist next to them.
    assert.ok(
      readFileSync(join(f.dir, "Timelines", "tl-1", "draft_info.json.bak"), "utf-8").includes("before-cli-edit"),
    );
  });

  it("--nested --apply refuses to roll back a nested document newer than the canonical unless --force-write", () => {
    const f = nestedFixture({ newerNested: true });
    after(f.cleanup);

    const refused = spawnCli(["sync-timelines", f.dir, "--nested", "--apply"]);
    assert.notEqual(refused.status, 0, "a newer nested document may hold app edits and must refuse");
    assert.match(refused.stderr, /OLDER/);
    assert.equal(
      JSON.parse(readFileSync(join(f.dir, "Timelines", "tl-1", "draft_info.json"), "utf-8")).name,
      "before-cli-edit",
      "refusal must not write",
    );

    const forced = spawnCli(["sync-timelines", f.dir, "--nested", "--apply", "--force-write"]);
    assert.equal(forced.status, 0, `stderr: ${forced.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(f.dir, "Timelines", "tl-1", "draft_info.json"), "utf-8")).id, "tl-1");
  });

  it("--nested reports an unreadable nested template-2.tmp as unreconcilable and still repairs the readable one", () => {
    const f = nestedFixture();
    after(f.cleanup);
    writeFileSync(join(f.dir, "Timelines", "tl-1", "template-2.tmp"), "  not json");

    const r = spawnCli(["sync-timelines", f.dir, "--nested", "--apply"]);
    assert.equal(r.status, 2, `an unreconcilable target must exit 2, stderr: ${r.stderr}`);
    assert.equal(r.json.applied, true);
    assert.ok(r.json.unreconcilable.some((u) => u.file === "Timelines/tl-1/template-2.tmp"));
    assert.match(r.json.unreconcilable.find((u) => u.file.startsWith("Timelines/")).workaround, /issue #50/);
    const nestedInfo = JSON.parse(readFileSync(join(f.dir, "Timelines", "tl-1", "draft_info.json"), "utf-8"));
    assert.equal(nestedInfo.name, "edited-by-cli", "the readable nested document must still be repaired");
    assert.equal(nestedInfo.id, "tl-1");
  });
});
