import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut version", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("detects CapCut + version + os from platform block", () => {
    const r = spawnCli(["version", fix.path]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json, "stdout should be valid JSON");
    assert.equal(r.json.app, "CapCut");
    assert.equal(r.json.app_source, "cc");
    assert.equal(typeof r.json.app_version, "string");
    assert.equal(typeof r.json.os, "string");
  });

  it("reports schema flags (mask_field, text-ranges, audio_fades)", () => {
    const r = spawnCli(["version", fix.path]);
    assert.equal(r.status, 0);
    assert.ok(r.json.schema);
    assert.ok(["mask", "common_masks", "both", "none"].includes(r.json.schema.mask_field));
    assert.equal(typeof r.json.schema.has_text_ranges, "boolean");
    assert.equal(typeof r.json.schema.has_audio_fades, "boolean");
  });

  it("emits a support assessment with status and notes array", () => {
    const r = spawnCli(["version", fix.path]);
    assert.equal(r.status, 0);
    assert.ok(["supported", "untested", "known-broken"].includes(r.json.support.status));
    assert.ok(Array.isArray(r.json.support.notes));
    assert.ok(r.json.support.notes.length > 0);
  });

  it("renders a human-readable layout with -H", () => {
    const r = spawnCli(["version", fix.path, "-H"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /App:/);
    assert.match(r.stdout, /Version:/);
    assert.match(r.stdout, /Support:/);
    assert.match(r.stdout, /Mask field:/);
    assert.match(r.stdout, /Evidence:/);
    assert.match(r.stdout, /Write guard:/);
    assert.match(r.stdout, /Schema int:/);
  });
});

// Version-boundary assessment: evidence labels aligned with
// docs/version-support.md and the write_guard preview of what saveDraft would do.
describe("capcut version — write-guard and evidence assessment", () => {
  function synthetic(extra = {}) {
    return {
      id: "version-assess",
      name: "assess",
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

  function versionOf(extra) {
    const dir = mkdtempSync(join(tmpdir(), "capcut-version-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "draft_content.json"), JSON.stringify(synthetic(extra), null, 2));
    const r = spawnCli(["version", dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    return r.json;
  }

  it("flags cc 10.8.0 as beyond the known range with write_guard refuse", () => {
    const v = versionOf({ platform: { app_source: "cc", app_version: "10.8.0", os: "mac" } });
    assert.equal(v.support.status, "untested");
    assert.equal(v.support.beyond_known_range, true);
    assert.equal(v.support.write_guard, "refuse");
    assert.match(v.support.notes.join(" "), /beyond the known range/);
    assert.match(v.support.notes.join(" "), /capcut fixture/);
  });

  it("reports lv 6.0.0 as known-broken via the structured >= 6.0 matcher", () => {
    const v = versionOf({ platform: { app_source: "lv", app_version: "6.0.0", os: "windows" } });
    assert.equal(v.support.status, "known-broken");
    assert.equal(v.support.write_guard, "refuse");
  });

  it("keeps lv 5.9.0 supported with write_guard ok", () => {
    const v = versionOf({ platform: { app_source: "lv", app_version: "5.9.0", os: "windows" } });
    assert.equal(v.support.status, "supported");
    assert.equal(v.support.evidence, "reported");
    assert.equal(v.support.write_guard, "ok");
  });

  it("no longer reads the repo's own 8.7.0 fixture shape as untested", () => {
    const v = versionOf({ platform: { app_source: "cc", app_version: "8.7.0", os: "windows" } });
    assert.equal(v.support.status, "supported");
    assert.equal(v.support.evidence, "synthetic-tested");
    assert.equal(v.support.write_guard, "ok");
  });

  it("labels cc 7.0.0 untested + expected-compatible (docs alignment, not a tested claim)", () => {
    const v = versionOf({ platform: { app_source: "cc", app_version: "7.0.0", os: "windows" } });
    assert.equal(v.support.status, "untested");
    assert.equal(v.support.evidence, "expected-compatible");
    assert.equal(v.support.write_guard, "ok");
  });

  it("reports the top-level schema integer and refuses beyond the known generation", () => {
    const v = versionOf({ platform: { app_source: "cc", app_version: "8.0.0", os: "windows" }, version: 99999999 });
    assert.equal(v.schema.schema_int, 99999999);
    assert.equal(v.support.beyond_known_range, true);
    assert.equal(v.support.write_guard, "refuse");
  });

  it("never guards a markerless draft (capcut create output)", () => {
    const v = versionOf({});
    assert.equal(v.schema.schema_int, null);
    assert.equal(v.support.beyond_known_range, false);
    assert.equal(v.support.write_guard, "ok");
  });

  it("uses the max of platform and last_modified_platform for the boundary", () => {
    const v = versionOf({
      platform: { app_source: "cc", app_version: "8.0.0", os: "windows" },
      last_modified_platform: { app_source: "cc", app_version: "10.8.0", os: "mac" },
    });
    assert.equal(v.app_version, "8.0.0", "the reported app_version stays the platform block's");
    assert.equal(v.support.beyond_known_range, true);
    assert.equal(v.support.write_guard, "refuse");
  });
});
