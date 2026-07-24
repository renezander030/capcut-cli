import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// Minimal parseable timeline. Markerless by default: no `platform`, no
// top-level `version` — exactly what `capcut create` emits.
function baseDraft(extra = {}) {
  return {
    id: "guard-draft",
    name: "guard",
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

function project(draft, extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-guard-"));
  const path = join(dir, "draft_content.json");
  writeFileSync(path, JSON.stringify(draft, null, 2));
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(join(dir, name), content);
  }
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("write-time version guard", () => {
  it("refuses a mutating write on a beyond-range draft, leaving every byte untouched", () => {
    const f = project(baseDraft({ platform: { app_source: "cc", app_version: "10.8.0", os: "mac" } }));
    after(f.cleanup);
    const before = readFileSync(f.path, "utf-8");

    const r = spawnCli(["add-text", f.dir, "0", "2s", "hello guard"]);
    assert.equal(r.status, 1, "a beyond-range write must refuse");
    assert.match(r.stderr, /newer than/);
    assert.match(r.stderr, /--force-write/);
    assert.match(r.stderr, /capcut fixture/, "the refusal must carry the fixture-collection CTA");
    assert.equal(readFileSync(f.path, "utf-8"), before, "refusal must not write");
    assert.ok(!existsSync(`${f.path}.bak`), "refusal must not create a .bak");
    assert.ok(!existsSync(join(f.dir, ".capcut-cli-history")), "refusal must not snapshot history");
  });

  it("--force-write overrides with a stderr WARNING, and restore stays ungated", () => {
    const f = project(baseDraft({ platform: { app_source: "cc", app_version: "10.8.0", os: "mac" } }));
    after(f.cleanup);
    const before = readFileSync(f.path, "utf-8");

    const r = spawnCli(["add-text", f.dir, "0", "2s", "hello guard", "--force-write"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json, "stdout must stay pure JSON");
    assert.equal(r.json.ok, true);
    assert.match(r.stderr, /WARNING/, "a forced write must never be silent");
    assert.equal(JSON.parse(readFileSync(f.path, "utf-8")).tracks.length, 1, "forced write must land");
    assert.ok(existsSync(`${f.path}.bak`));

    // `restore` is the undo path, not the hazard — it must work on a guarded draft.
    const restored = spawnCli(["restore", f.path]);
    assert.equal(restored.status, 0, `stderr: ${restored.stderr}`);
    assert.equal(readFileSync(f.path, "utf-8"), before, "restore must roll the guarded draft back");
  });

  it("--dry-run previews with a WARNING but neither blocks nor writes", () => {
    const f = project(baseDraft({ platform: { app_source: "cc", app_version: "10.8.0", os: "mac" } }));
    after(f.cleanup);
    const before = readFileSync(f.path, "utf-8");

    const r = spawnCli(["add-text", f.dir, "0", "2s", "hello guard", "--dry-run"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.dryRun, true);
    assert.match(r.stderr, /WARNING/, "dry-run must still preview the version boundary");
    assert.equal(readFileSync(f.path, "utf-8"), before, "dry-run must not write");
    assert.ok(!existsSync(`${f.path}.bak`));
  });

  it("refuses a plaintext JianYing >= 6.0 draft (encrypted era) unless --force-write", () => {
    const f = project(baseDraft({ platform: { app_source: "lv", app_version: "6.0.0", os: "windows" } }));
    after(f.cleanup);
    const before = readFileSync(f.path, "utf-8");

    const refused = spawnCli(["add-text", f.dir, "0", "2s", "hello"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /known-broken/);
    assert.match(refused.stderr, /内容已损坏/, "the refusal must name the app's corrupted-content symptom");
    assert.equal(readFileSync(f.path, "utf-8"), before);

    const forced = spawnCli(["add-text", f.dir, "0", "2s", "hello", "--force-write"]);
    assert.equal(forced.status, 0, `stderr: ${forced.stderr}`);
    assert.match(forced.stderr, /WARNING/);
  });

  it("gates on the top-level schema integer alone: newer refuses, known is silent, older warns", () => {
    const newer = project(baseDraft({ version: 400000 }));
    after(newer.cleanup);
    const refused = spawnCli(["add-text", newer.dir, "0", "2s", "x"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /schema integer 400000/);

    const known = project(baseDraft({ version: 360000 }));
    after(known.cleanup);
    const ok = spawnCli(["add-text", known.dir, "0", "2s", "x"]);
    assert.equal(ok.status, 0, `stderr: ${ok.stderr}`);
    assert.doesNotMatch(ok.stderr, /WARNING/, "the newest known generation must write silently");

    const older = project(baseDraft({ version: 250000 }));
    after(older.cleanup);
    const warned = spawnCli(["add-text", older.dir, "0", "2s", "x"]);
    assert.equal(warned.status, 0, `stderr: ${warned.stderr}`);
    assert.match(warned.stderr, /Older schema generation 250000/);
    assert.equal(JSON.parse(readFileSync(older.path, "utf-8")).tracks.length, 1, "a warn must still write");
  });

  it("warns (not refuses) on an unrecognized app source that carries version markers", () => {
    const f = project(baseDraft({ platform: { app_source: "jy", app_version: "7.5.0", os: "windows" } }));
    after(f.cleanup);

    const r = spawnCli(["add-text", f.dir, "0", "2s", "x"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /Unrecognized app source "jy"/);
    assert.equal(JSON.parse(readFileSync(f.path, "utf-8")).tracks.length, 1);
  });

  it("trips on a sibling mirror written by a newer app build (store version path)", () => {
    const mirror = baseDraft({ platform: { app_source: "cc", app_version: "10.8.0", os: "mac" } });
    const f = project(baseDraft({ platform: { app_source: "cc", app_version: "8.7.0", os: "windows" } }), {
      "draft_info.json": JSON.stringify(mirror, null, 2),
    });
    after(f.cleanup);
    const contentBefore = readFileSync(f.path, "utf-8");
    const infoBefore = readFileSync(join(f.dir, "draft_info.json"), "utf-8");

    const r = spawnCli(["add-text", f.dir, "0", "2s", "x"]);
    assert.equal(r.status, 1, "an in-range canonical must still refuse when a mirror is beyond range");
    assert.match(r.stderr, /10\.8\.0/);
    assert.equal(readFileSync(f.path, "utf-8"), contentBefore);
    assert.equal(readFileSync(join(f.dir, "draft_info.json"), "utf-8"), infoBefore);
  });

  it("backward-compat: the canonical 6.2.8 fixture writes exactly as before, with zero stderr", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const added = spawnCli(["add-text", fix.path, "0", "2s", "compat check"]);
    assert.equal(added.status, 0, `stderr: ${added.stderr}`);
    assert.equal(added.stderr, "", "an in-range write must not gain any stderr output");

    const sped = spawnCli(["speed", fix.path, "aaaaaa01", "1.5"]);
    assert.equal(sped.status, 0, `stderr: ${sped.stderr}`);
    assert.equal(sped.stderr, "");

    const migrated = spawnCli(["migrate", fix.path, "--from", "5.9", "--to", "9.6"]);
    assert.equal(migrated.status, 0, `stderr: ${migrated.stderr}`);
    assert.equal(migrated.stderr, "");
  });
});
