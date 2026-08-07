import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// App auto-upgrade tripwire (pyJianYingDraft#115, #178): the CLI remembers the
// last version evidence it saw per draft store in its own config area and, on
// a mutating write, warns old -> new when the app moved underneath the
// pipeline. Warn only — never a refusal (the v0.15 write guard owns those).

function baseDraft(extra = {}) {
  return {
    id: "tripwire-draft",
    name: "tripwire",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
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
    ...extra,
  };
}

function markedDraft(appVersion, extra = {}) {
  return baseDraft({ platform: { app_source: "cc", app_version: appVersion, os: "windows" }, ...extra });
}

// Project dir under a fresh root, with the tripwire state file OUTSIDE the
// project (its real home is ~/.config/capcut-cli — state never lives in a
// draft). The state path is shared across spawns via env.
function project(draft) {
  const root = mkdtempSync(join(tmpdir(), "capcut-tripwire-"));
  const projectDir = join(root, "project");
  mkdirSync(projectDir);
  const path = join(projectDir, "draft_content.json");
  writeFileSync(path, JSON.stringify(draft, null, 2));
  const statePath = join(root, "app-versions.json");
  return {
    root,
    projectDir,
    path,
    statePath,
    env: { CAPCUT_CLI_APP_VERSIONS: statePath },
    setVersion(version) {
      const current = JSON.parse(readFileSync(path, "utf-8"));
      current.platform.app_version = version;
      writeFileSync(path, JSON.stringify(current, null, 2));
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("app auto-upgrade tripwire", () => {
  it("records silently on first sighting, then warns old -> new on drift and updates the record", (t) => {
    const p = project(markedDraft("6.2.8"));
    t.after(p.cleanup);

    const first = spawnCli(["add-text", p.path, "0", "1s", "one"], { env: p.env });
    assert.equal(first.status, 0);
    assert.ok(!first.stderr.includes("drift"), `first sighting must be silent, got: ${first.stderr}`);
    assert.equal(first.json.app_version_drift, undefined, "no drift field on first sighting");
    const recorded = JSON.parse(readFileSync(p.statePath, "utf-8"));
    assert.equal(recorded.stores[p.projectDir].app_version, "6.2.8");

    // The app "auto-updated" and re-saved the draft with its new version marker.
    p.setVersion("8.7.0");
    const second = spawnCli(["add-text", p.path, "0", "1s", "two"], { env: p.env });
    assert.equal(second.status, 0, "drift warns, never refuses");
    assert.match(second.stderr, /WARNING: App version drift/);
    assert.match(second.stderr, /app version 6\.2\.8 -> 8\.7\.0/);
    assert.match(second.stderr, /Pinning app updates/);
    const drift = second.json.app_version_drift;
    assert.ok(drift, "mutating command JSON gains app_version_drift");
    assert.deepEqual(drift.changes, ["app version 6.2.8 -> 8.7.0"]);
    assert.equal(drift.from.app_version, "6.2.8");
    assert.equal(drift.to.app_version, "8.7.0");
    const updated = JSON.parse(readFileSync(p.statePath, "utf-8"));
    assert.equal(updated.stores[p.projectDir].app_version, "8.7.0", "drift updates the record");
  });

  it("stays silent when the evidence has not moved", (t) => {
    const p = project(markedDraft("6.2.8"));
    t.after(p.cleanup);

    spawnCli(["add-text", p.path, "0", "1s", "one"], { env: p.env });
    const again = spawnCli(["add-text", p.path, "0", "1s", "two"], { env: p.env });
    assert.equal(again.status, 0);
    assert.ok(!again.stderr.includes("WARNING"), `no-drift write must be silent, got: ${again.stderr}`);
    assert.equal(again.json.app_version_drift, undefined);
  });

  it("treats a corrupt state file as empty with a WARNING and rebuilds it", (t) => {
    const p = project(markedDraft("6.2.8"));
    t.after(p.cleanup);

    const seed = spawnCli(["add-text", p.path, "0", "1s", "seed"], { env: p.env });
    assert.equal(seed.status, 0);
    writeFileSync(p.statePath, "not-json{{");

    const r = spawnCli(["add-text", p.path, "0", "1s", "after-corrupt"], { env: p.env });
    assert.equal(r.status, 0, "a broken state file must never block a write");
    assert.match(r.stderr, /WARNING: app-version state did not parse/);
    assert.equal(r.json.app_version_drift, undefined, "corrupt state reads as empty — no drift claim");
    const healed = JSON.parse(readFileSync(p.statePath, "utf-8"));
    assert.equal(healed.stores[p.projectDir].app_version, "6.2.8", "next write rebuilds the state");

    const quiet = spawnCli(["add-text", p.path, "0", "1s", "healed"], { env: p.env });
    assert.ok(!quiet.stderr.includes("WARNING"), "rebuilt state is silent again");
  });

  it("never tracks a markerless CLI-created draft", (t) => {
    const p = project(baseDraft());
    t.after(p.cleanup);

    const r = spawnCli(["add-text", p.path, "0", "1s", "hi"], { env: p.env });
    assert.equal(r.status, 0);
    assert.ok(!r.stderr.includes("WARNING"), r.stderr);
    assert.ok(!existsSync(p.statePath), "no evidence, no state entry");
  });

  it("`version` surfaces the drift read-only and never updates the record", (t) => {
    const p = project(markedDraft("6.2.8"));
    t.after(p.cleanup);

    spawnCli(["add-text", p.path, "0", "1s", "seed"], { env: p.env });
    p.setVersion("8.7.0");

    const first = spawnCli(["version", p.path], { env: p.env });
    assert.equal(first.status, 0);
    assert.deepEqual(first.json.app_version_drift.changes, ["app version 6.2.8 -> 8.7.0"]);

    // Read-only: the record did not move, so the drift is still visible.
    const second = spawnCli(["version", p.path], { env: p.env });
    assert.deepEqual(second.json.app_version_drift.changes, ["app version 6.2.8 -> 8.7.0"]);
    const state = JSON.parse(readFileSync(p.statePath, "utf-8"));
    assert.equal(state.stores[p.projectDir].app_version, "6.2.8");

    const human = spawnCli(["version", p.path, "-H"], { env: p.env });
    assert.match(human.stdout, /App drift:\s+app version 6\.2\.8 -> 8\.7\.0/);
  });

  it("`version` reports app_version_drift: null when nothing is recorded", (t) => {
    const p = project(markedDraft("6.2.8"));
    t.after(p.cleanup);

    const r = spawnCli(["version", p.path], { env: p.env });
    assert.equal(r.status, 0);
    assert.equal(r.json.app_version_drift, null);
  });

  it("`doctor` re-inspects tracked stores and flags the drifted one", (t) => {
    const p = project(markedDraft("6.2.8"));
    t.after(p.cleanup);

    spawnCli(["add-text", p.path, "0", "1s", "seed"], { env: p.env });
    p.setVersion("8.7.0");

    const r = spawnCli(["doctor"], { env: p.env });
    assert.equal(r.status, 0, "app-upgrade drift is warn-only, doctor still exits 0");
    const checks = r.json.checks.filter((c) => c.name === "app-upgrade");
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, "warn");
    assert.match(checks[0].detail, /app version 6\.2\.8 -> 8\.7\.0/);
    assert.match(checks[0].fix, /Pinning app updates/);
  });

  it("`doctor` reports a corrupt state file as warn and an empty state as ok", (t) => {
    const p = project(markedDraft("6.2.8"));
    t.after(p.cleanup);

    const clean = spawnCli(["doctor"], { env: p.env });
    const okCheck = clean.json.checks.find((c) => c.name === "app-upgrade");
    assert.equal(okCheck.status, "ok");
    assert.match(okCheck.detail, /no tracked draft stores yet/);

    spawnCli(["add-text", p.path, "0", "1s", "seed"], { env: p.env });
    writeFileSync(p.statePath, "not-json{{");
    const corrupt = spawnCli(["doctor"], { env: p.env });
    const check = corrupt.json.checks.find((c) => c.name === "app-upgrade");
    assert.equal(check.status, "warn");
    assert.match(check.detail, /did not parse/);
  });

  it("leaves written drafts byte-identical with or without tripwire state (nothing lands in the draft)", (t) => {
    // Deterministic mutation (shift-all — no generated ids) on two identical
    // version-marked projects: one with a drift-primed state file, one with a
    // fresh one. The tripwire must change stderr/JSON only, never the draft
    // bytes, and must never write state into the project dir.
    const draft = markedDraft("6.2.8", {
      tracks: [
        {
          id: "t1",
          type: "video",
          segments: [
            {
              id: "s1",
              material_id: "m1",
              target_timerange: { start: 0, duration: 500_000 },
              source_timerange: { start: 0, duration: 500_000 },
              extra_material_refs: [],
            },
          ],
        },
      ],
    });
    draft.materials.videos = [{ id: "m1", path: "clip.mp4", type: "video" }];

    const plain = project(structuredClone(draft));
    const primed = project(structuredClone(draft));
    t.after(plain.cleanup);
    t.after(primed.cleanup);
    writeFileSync(
      primed.statePath,
      JSON.stringify({
        version: 1,
        stores: {
          [primed.projectDir]: {
            app_source: "cc",
            app_version: "5.0.0",
            schema_int: null,
            seen_at: "2026-01-01T00:00:00Z",
          },
        },
      }),
    );

    const a = spawnCli(["shift-all", plain.path, "100ms"], { env: plain.env });
    const b = spawnCli(["shift-all", primed.path, "100ms"], { env: primed.env });
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    assert.ok(b.json.app_version_drift, "primed run must actually take the drift path");
    assert.match(b.stderr, /app version 5\.0\.0 -> 6\.2\.8/);

    assert.equal(
      readFileSync(plain.path, "utf-8"),
      readFileSync(primed.path, "utf-8"),
      "the tripwire must never change what is written into the draft",
    );
    assert.deepEqual(
      readdirSync(plain.projectDir).sort(),
      readdirSync(primed.projectDir).sort(),
      "the project dirs must stay identical — no state file may appear in a draft",
    );
    assert.ok(!readdirSync(plain.projectDir).includes("app-versions.json"));
  });
});
