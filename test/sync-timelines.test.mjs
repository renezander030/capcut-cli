import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { assertTargetsUnchangedOnDisk } from "../dist/draft.js";
import { editorProcesses, planTimelineSync } from "../dist/store.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// The canonical timeline: what the CLI wrote to draft_content.json (issue #35:
// a text track added after the app last mirrored the draft).
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

// The stale mirror: the pre-edit timeline (no text track) under a different
// draft GUID — the CapCut pre-open mirror case.
function staleDraft() {
  return { ...canonicalDraft(), id: "guid-mirror-stale", name: "before-cli-edit", tracks: [] };
}

// Drift fixture: draft_content.json is canonical/newer; template-2.tmp (string-
// JSON envelope) and draft_info.json (root envelope) still hold the old timeline.
// The mirrors' mtimes are set into the past to model the issue-#35 scenario the
// repair exists for: the CLI edited draft_content.json AFTER the app last wrote
// the mirrors.
function driftedFixture() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-sync-"));
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(canonicalDraft(), null, 2));
  writeFileSync(join(dir, "template-2.tmp"), JSON.stringify({ draft_content: JSON.stringify(staleDraft()) }, null, 2));
  writeFileSync(join(dir, "draft_info.json"), JSON.stringify(staleDraft(), null, 2));
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(join(dir, "template-2.tmp"), past, past);
  utimesSync(join(dir, "draft_info.json"), past, past);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Direction-hazard fixture: the drifted mirror is NEWER than draft_content.json
// (the CapCut >= 8.7 app wrote it on save after the canonical file went stale).
function staleCanonicalFixture() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-sync-"));
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(canonicalDraft(), null, 2));
  writeFileSync(join(dir, "draft_info.json"), JSON.stringify(staleDraft(), null, 2));
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(join(dir, "draft_content.json"), past, past);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("sync-timelines", () => {
  it("plan (default) reports the drifted mirrors without writing", () => {
    const f = driftedFixture();
    after(f.cleanup);
    const tmpBefore = readFileSync(join(f.dir, "template-2.tmp"), "utf-8");
    const infoBefore = readFileSync(join(f.dir, "draft_info.json"), "utf-8");

    const r = spawnCli(["sync-timelines", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.applied, false);
    assert.equal(r.json.in_sync, false);
    assert.equal(r.json.canonical, "draft_content.json");
    assert.deepEqual(r.json.drifted.sort(), ["draft_info.json", "template-2.tmp"]);
    const info = r.json.targets.find((t) => t.file === "draft_info.json");
    assert.equal(info.state, "drifted");
    assert.equal(info.guid_drifted, true, "the pre-open mirror's stale GUID must be flagged");
    for (const target of r.json.targets) {
      assert.equal(typeof target.mtime, "string", `${target.file} must report its mtime`);
    }
    assert.equal(r.json.canonical_stale, false, "mirrors older than draft_content.json are the normal direction");
    assert.match(r.stderr, /--apply/);
    assert.match(r.stderr, /mtime/, "the human plan must surface mtimes");
    assert.equal(readFileSync(join(f.dir, "template-2.tmp"), "utf-8"), tmpBefore, "plan must not write");
    assert.equal(readFileSync(join(f.dir, "draft_info.json"), "utf-8"), infoBefore, "plan must not write");
  });

  it("--apply reconciles the drifted mirrors from draft_content.json, preserving envelopes", () => {
    const f = driftedFixture();
    after(f.cleanup);

    const r = spawnCli(["sync-timelines", f.dir, "--apply"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.applied, true);
    assert.equal(r.json.in_sync, true);
    assert.deepEqual(r.json.reconciled.sort(), ["draft_info.json", "template-2.tmp"]);

    // template-2.tmp keeps its string-JSON envelope; the timeline inside is the canonical one.
    const envelope = JSON.parse(readFileSync(join(f.dir, "template-2.tmp"), "utf-8"));
    const mirrored = JSON.parse(envelope.draft_content);
    assert.equal(mirrored.name, "edited-by-cli");
    assert.equal(mirrored.tracks.length, 1);

    // draft_info.json: timeline AND GUID reconciled (CapCut pre-open mirror case).
    const info = JSON.parse(readFileSync(join(f.dir, "draft_info.json"), "utf-8"));
    assert.equal(info.id, "guid-canonical", "stale mirror GUID must be reconciled to the canonical draft id");
    assert.equal(info.name, "edited-by-cli");

    // draft_content.json itself still carries the canonical edit.
    assert.equal(JSON.parse(readFileSync(join(f.dir, "draft_content.json"), "utf-8")).name, "edited-by-cli");

    // Backups of the pre-repair mirrors exist.
    assert.ok(readFileSync(join(f.dir, "template-2.tmp.bak"), "utf-8").includes("before-cli-edit"));
    assert.ok(readFileSync(join(f.dir, "draft_info.json.bak"), "utf-8").includes("before-cli-edit"));
  });

  it("no-ops with exit 0 and a clear message when all targets agree", () => {
    const f = driftedFixture();
    after(f.cleanup);
    assert.equal(spawnCli(["sync-timelines", f.dir, "--apply"]).status, 0);

    const r = spawnCli(["sync-timelines", f.dir, "--apply"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.applied, false);
    assert.equal(r.json.in_sync, true);
    assert.match(r.json.message, /already agree/);
    assert.match(r.stderr, /already agree/);
  });

  it("--apply --dry-run previews without writing and does not claim reconciliation", () => {
    const f = driftedFixture();
    after(f.cleanup);
    const infoBefore = readFileSync(join(f.dir, "draft_info.json"), "utf-8");

    const r = spawnCli(["sync-timelines", f.dir, "--apply", "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dryRun, true);
    assert.equal(r.json.applied, false);
    assert.deepEqual(r.json.reconciled, [], "dry-run must not claim reconciliation");
    assert.deepEqual(r.json.backups, []);
    assert.deepEqual(r.json.would_reconcile.sort(), ["draft_info.json", "template-2.tmp"]);
    assert.equal(r.json.in_sync, false);
    assert.doesNotMatch(r.stderr, /Reconciled/, "dry-run stderr must not assert a repair happened");
    assert.match(r.stderr, /plan only/i);
    assert.equal(readFileSync(join(f.dir, "draft_info.json"), "utf-8"), infoBefore, "dry-run must not write");
    assert.ok(!existsSync(join(f.dir, "draft_info.json.bak")), "dry-run must not create backups");
  });

  it("reports an unreadable template-2.tmp as unreconcilable instead of pretending success", () => {
    const f = driftedFixture();
    after(f.cleanup);
    // Modern storage where the mirror is binary/encrypted — the CLI cannot re-embed it.
    writeFileSync(join(f.dir, "template-2.tmp"), "\x00\x01not-json\x02");

    const plan = spawnCli(["sync-timelines", f.dir]);
    assert.equal(plan.status, 0, `stderr: ${plan.stderr}`);
    assert.equal(plan.json.unreconcilable.length, 1);
    assert.equal(plan.json.unreconcilable[0].file, "template-2.tmp");
    assert.match(plan.json.unreconcilable[0].workaround, /fixture.*#35/s);
    assert.match(plan.stderr, /WARNING template-2\.tmp/);

    const r = spawnCli(["sync-timelines", f.dir, "--apply"]);
    assert.equal(r.status, 2, "an unreconcilable mirror must exit 2, not pretend success");
    assert.equal(r.json.ok, false, "the file CapCut trusts may still hold the stale timeline");
    assert.equal(r.json.in_sync, false, "in_sync must not be asserted when a mirror could not be reconciled");
    assert.equal(r.json.applied, true);
    assert.deepEqual(r.json.reconciled, ["draft_info.json"], "only the readable mirror is repaired");
    assert.equal(r.json.unreconcilable[0].file, "template-2.tmp");
    assert.match(r.stderr, /WARNING template-2\.tmp/);
    assert.equal(
      readFileSync(join(f.dir, "template-2.tmp"), "utf-8"),
      "\x00\x01not-json\x02",
      "binary mirror left untouched",
    );

    // Idempotent verdict: a re-run on the unchanged state reports the same
    // ok/in_sync/exit outcome as the apply that left it there.
    const again = spawnCli(["sync-timelines", f.dir]);
    assert.equal(again.status, 2, "the unreconcilable state must keep reporting exit 2");
    assert.equal(again.json.in_sync, false);
    assert.equal(again.json.ok, false, "an unreconcilable mirror must not be reported as fully ok");
    assert.match(again.json.message, /cannot be reconciled/);
  });

  it("plan warns when draft_content.json is older than a drifted mirror", () => {
    const f = staleCanonicalFixture();
    after(f.cleanup);

    const r = spawnCli(["sync-timelines", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.canonical_stale, true);
    assert.deepEqual(r.json.newer_mirrors, ["draft_info.json"]);
    for (const target of r.json.targets) {
      assert.equal(typeof target.mtime, "string", `${target.file} must report its mtime`);
    }
    assert.match(r.stderr, /WARNING: draft_content\.json .* is OLDER/);
    assert.match(r.stderr, /--force-write/);
  });

  it("--apply refuses to roll back a mirror newer than draft_content.json unless --force-write", () => {
    const f = staleCanonicalFixture();
    after(f.cleanup);
    const infoBefore = readFileSync(join(f.dir, "draft_info.json"), "utf-8");

    const refused = spawnCli(["sync-timelines", f.dir, "--apply"]);
    assert.equal(refused.status, 1, "the older-canonical direction must refuse without --force-write");
    assert.match(refused.stderr, /OLDER/);
    assert.match(refused.stderr, /--force-write/);
    assert.equal(readFileSync(join(f.dir, "draft_info.json"), "utf-8"), infoBefore, "refusal must not write");
    assert.ok(!existsSync(join(f.dir, "draft_info.json.bak")), "refusal must not create backups");

    const forced = spawnCli(["sync-timelines", f.dir, "--apply", "--force-write"]);
    assert.equal(forced.status, 0, `stderr: ${forced.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(f.dir, "draft_info.json"), "utf-8")).id, "guid-canonical");
  });

  it("diagnose recommends the plan form with a back-up caution, never a blind --apply", () => {
    const f = driftedFixture();
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const advice = r.json.next_actions.join(" ");
    assert.match(advice, /back up/i, "divergence advice must retain a back-up caution");
    assert.match(advice, /`capcut sync-timelines <project>`/, "divergence advice must recommend the plan form");
    assert.ok(
      !advice.includes("sync-timelines <project> --apply"),
      "diagnose must not recommend a destructive one-liner",
    );
  });

  it("rejects an explicitly named custom draft file, symmetrically for plan and --apply", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-sync-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "draft_content.json"), JSON.stringify(canonicalDraft(), null, 2));
    writeFileSync(join(dir, "A.json"), JSON.stringify(staleDraft(), null, 2));
    writeFileSync(join(dir, "draft_info.json"), JSON.stringify(staleDraft(), null, 2));
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "A.json"), past, past);
    utimesSync(join(dir, "draft_info.json"), past, past);

    const plan = spawnCli(["sync-timelines", join(dir, "A.json")]);
    assert.equal(plan.status, 1);
    assert.match(plan.stderr, /cannot target A\.json/);
    assert.match(plan.stderr, /project directory/);

    const apply = spawnCli(["sync-timelines", join(dir, "A.json"), "--apply"]);
    assert.equal(apply.status, 1, "apply must reject the same inputs the plan rejects");
    assert.match(apply.stderr, /cannot target A\.json/);
    assert.equal(JSON.parse(readFileSync(join(dir, "A.json"), "utf-8")).id, "guid-mirror-stale");
    assert.equal(JSON.parse(readFileSync(join(dir, "draft_info.json"), "utf-8")).id, "guid-mirror-stale");
    assert.ok(!existsSync(join(dir, "A.json.bak")), "rejection must not write anything");
    assert.ok(!existsSync(join(dir, "draft_info.json.bak")), "rejection must not write anything");

    // The canonical file itself is an accepted alias for the directory form.
    const accepted = spawnCli(["sync-timelines", join(dir, "draft_content.json")]);
    assert.equal(accepted.status, 0, `stderr: ${accepted.stderr}`);
    assert.deepEqual(accepted.json.drifted, ["draft_info.json"]);
  });

  it("--apply writes exactly the drifted mirrors: canonical and in-sync targets stay untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-sync-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    // Canonical draft with tracks deliberately NOT in the CLI's TRACK_RANK
    // order ([text, video]); the repair must copy it verbatim, not re-sort it.
    const draft = canonicalDraft();
    draft.tracks = [
      { id: "T1", type: "text", name: "text", attribute: 0, segments: [] },
      { id: "V1", type: "video", name: "video", attribute: 0, segments: [] },
    ];
    writeFileSync(join(dir, "draft_content.json"), JSON.stringify(draft, null, 2));
    // In-sync mirror: the same timeline inside its envelope.
    writeFileSync(join(dir, "template-2.tmp"), JSON.stringify({ draft_content: JSON.stringify(draft) }, null, 2));
    // Drifted mirror, older than the canonical file.
    writeFileSync(join(dir, "draft_info.json"), JSON.stringify(staleDraft(), null, 2));
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "draft_info.json"), past, past);
    // Pre-existing restore points the repair must not destroy.
    writeFileSync(join(dir, "draft_content.json.bak"), "canonical-restore-point");
    writeFileSync(join(dir, "template-2.tmp.bak"), "insync-restore-point");
    const canonicalBefore = readFileSync(join(dir, "draft_content.json"), "utf-8");
    const templateBefore = readFileSync(join(dir, "template-2.tmp"), "utf-8");

    const r = spawnCli(["sync-timelines", dir, "--apply"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.reconciled, ["draft_info.json"]);
    assert.deepEqual(r.json.backups, ["draft_info.json.bak"], "backups must list only files actually written");
    // draft_content.json is a read-only source: byte-identical, no track re-sort.
    assert.equal(readFileSync(join(dir, "draft_content.json"), "utf-8"), canonicalBefore, "canonical rewritten");
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, "draft_content.json"), "utf-8")).tracks.map((t) => t.type),
      ["text", "video"],
      "the canonical track order must survive --apply",
    );
    // In-sync mirror untouched; the drifted mirror received the canonical timeline as-is.
    assert.equal(readFileSync(join(dir, "template-2.tmp"), "utf-8"), templateBefore, "in-sync mirror rewritten");
    const info = JSON.parse(readFileSync(join(dir, "draft_info.json"), "utf-8"));
    assert.equal(info.id, "guid-canonical");
    assert.deepEqual(
      info.tracks.map((t) => t.type),
      ["text", "video"],
    );
    // Pre-existing restore points survive; only the written mirror got a new .bak.
    assert.equal(readFileSync(join(dir, "draft_content.json.bak"), "utf-8"), "canonical-restore-point");
    assert.equal(readFileSync(join(dir, "template-2.tmp.bak"), "utf-8"), "insync-restore-point");
    assert.ok(readFileSync(join(dir, "draft_info.json.bak"), "utf-8").includes("before-cli-edit"));
  });

  it("apply's concurrency guard rejects files changed between the plan read and the write", () => {
    const f = driftedFixture();
    after(f.cleanup);
    const { canonicalCandidate, driftedCandidates } = planTimelineSync(f.dir);
    const contentPath = join(f.dir, "draft_content.json");
    writeFileSync(contentPath, `${readFileSync(contentPath, "utf-8")}\n`);
    assert.throws(() => assertTargetsUnchangedOnDisk([canonicalCandidate, ...driftedCandidates]), /changed on disk/);
  });

  it("errors when draft_content.json is missing (no canonical source)", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-sync-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "draft_info.json"), JSON.stringify(staleDraft(), null, 2));

    const r = spawnCli(["sync-timelines", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /draft_content\.json/);
  });

  it("names the draft_info-primary layout (newer Mac builds) when only draft_info.json is readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-sync-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "draft_info.json"), JSON.stringify(staleDraft(), null, 2));

    const r = spawnCli(["sync-timelines", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /timeline lives in draft_info\.json/);
    assert.match(r.stderr, /Mac/);
    assert.match(r.stderr, /capcut diagnose/);
    assert.match(r.stderr, /capcut fixture/, "the error must carry the fixture-collection CTA");
  });

  it("--apply refuses a beyond-range project without --force-write (version write guard)", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-sync-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const platform = { app_source: "cc", app_version: "10.8.0", os: "mac" };
    writeFileSync(join(dir, "draft_content.json"), JSON.stringify({ ...canonicalDraft(), platform }, null, 2));
    writeFileSync(join(dir, "draft_info.json"), JSON.stringify({ ...staleDraft(), platform }, null, 2));
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "draft_info.json"), past, past);
    const infoBefore = readFileSync(join(dir, "draft_info.json"), "utf-8");

    const plan = spawnCli(["sync-timelines", dir]);
    assert.equal(plan.status, 0, `plan must stay read-only and allowed; stderr: ${plan.stderr}`);

    const refused = spawnCli(["sync-timelines", dir, "--apply"]);
    assert.equal(refused.status, 1, "the version boundary must refuse before any mirror write");
    assert.match(refused.stderr, /newer than/);
    assert.match(refused.stderr, /--force-write/);
    assert.equal(readFileSync(join(dir, "draft_info.json"), "utf-8"), infoBefore, "refusal must not write");
    assert.ok(!existsSync(join(dir, "draft_info.json.bak")), "refusal must not create backups");

    const forced = spawnCli(["sync-timelines", dir, "--apply", "--force-write"]);
    assert.equal(forced.status, 0, `stderr: ${forced.stderr}`);
    assert.match(forced.stderr, /WARNING/, "a forced apply must never be silent");
    assert.equal(JSON.parse(readFileSync(join(dir, "draft_info.json"), "utf-8")).id, "guid-canonical");
  });

  it("refuses --apply while the editor is running unless --force-write", {
    skip: process.platform === "win32",
  }, async () => {
    const f = driftedFixture();
    // Fake a running editor: a copy of `sleep` named CapCut shows up in `ps -axo comm=`.
    const fakeDir = mkdtempSync(join(tmpdir(), "fake-editor-"));
    const fakeBin = join(fakeDir, "CapCut");
    copyFileSync("/bin/sleep", fakeBin);
    chmodSync(fakeBin, 0o755);
    const child = spawn(fakeBin, ["60"], { stdio: "ignore" });
    after(() => {
      child.kill("SIGKILL");
      f.cleanup();
      rmSync(fakeDir, { recursive: true, force: true });
    });

    // Wait until the process table shows the fake editor.
    const deadline = Date.now() + 5_000;
    while (editorProcesses().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(editorProcesses().length > 0, "fake CapCut process should be detectable");

    const refused = spawnCli(["sync-timelines", f.dir, "--apply"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /is running/);
    assert.ok(existsSync(join(f.dir, "draft_info.json")));
    assert.equal(
      JSON.parse(readFileSync(join(f.dir, "draft_info.json"), "utf-8")).id,
      "guid-mirror-stale",
      "refusal must not write",
    );

    const forced = spawnCli(["sync-timelines", f.dir, "--apply", "--force-write"]);
    assert.equal(forced.status, 0, `stderr: ${forced.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(f.dir, "draft_info.json"), "utf-8")).id, "guid-canonical");
  });
});
