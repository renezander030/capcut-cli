import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANONICAL = join(__dirname, "draft_content.json");

// Build a project dir from the canonical fixture, then inject PII into a string
// field so the redactor has something to scrub. Returns { projDir, cleanup }.
function projectWithPii() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-fixture-"));
  const projDir = join(dir, "proj");
  mkdirSync(projDir);
  const dst = join(projDir, "draft_content.json");
  copyFileSync(CANONICAL, dst);
  const draft = JSON.parse(readFileSync(dst, "utf-8"));
  draft.name = "/home/secretuser/Movies/clip.mp4 — contact secretuser@gmail.com";
  writeFileSync(dst, JSON.stringify(draft), "utf-8");
  // a sibling media file that must NOT be bundled
  mkdirSync(join(projDir, "assets", "video"), { recursive: true });
  writeFileSync(join(projDir, "assets", "video", "clip.mp4"), "binary-media");
  return { projDir, outDir: join(dir, "out"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("capcut fixture", () => {
  it("writes a redacted, media-free bundle", (t) => {
    const { projDir, outDir, cleanup } = projectWithPii();
    t.after(cleanup);

    const r = spawnCli(["fixture", projDir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.ok(r.json.files.length >= 1, "should bundle at least one timeline file");
    assert.equal(r.json.media_excluded, true);

    const bundled = readFileSync(join(outDir, "draft_content.json"), "utf-8");
    assert.ok(!bundled.includes("secretuser"), "username must be redacted from path and email");
    assert.ok(bundled.includes("/home/USER/"), "home path should be normalized");
    assert.ok(bundled.includes("redacted@example.com"), "email should be redacted");
  });

  it("counts redactions and never copies assets/", (t) => {
    const { projDir, outDir, cleanup } = projectWithPii();
    t.after(cleanup);

    const r = spawnCli(["fixture", projDir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok((r.json.redaction_kinds.linux_user ?? 0) >= 1, "should record a linux_user redaction");
    assert.ok((r.json.redaction_kinds.email ?? 0) >= 1, "should record an email redaction");
    assert.ok(existsSync(join(outDir, "SANITIZE_REPORT.json")), "should write the sanitize report");
    assert.ok(existsSync(join(outDir, "README.md")), "should write a reporter README");
    assert.ok(!existsSync(join(outDir, "assets")), "must not copy media assets");
  });

  it("requires --out", (t) => {
    const { projDir, cleanup } = projectWithPii();
    t.after(cleanup);
    const r = spawnCli(["fixture", projDir]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--out/);
  });
});

// The #44 harvest: the mask-geometry keyframe encoding has no public ground
// truth, so `fixture` maps whatever mask + keyframe structures a real draft
// contains instead of the CLI guessing an encoding. The injected structures
// below are SYNTHETIC — they prove the detector flags unknown shapes, they do
// not claim any knowledge of the real encoding.
describe("capcut fixture — mask-keyframe harvest (#44)", () => {
  it("emits mask-keyframe-report.json; a mask-less draft yields no evidence", (t) => {
    const { projDir, outDir, cleanup } = projectWithPii();
    t.after(cleanup);

    const r = spawnCli(["fixture", projDir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const reportPath = join(outDir, "mask-keyframe-report.json");
    assert.ok(existsSync(reportPath), "should write the mask-keyframe report");
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    assert.equal(report.verdict, "no-mask-keyframe-evidence");
    assert.match(report.issue, /issues\/44/);
    const contentEvidence = report.files.find((f) => f.file === "draft_content.json");
    assert.equal(contentEvidence.parsed, true, "canonical draft should parse");
    assert.equal(report.summary.masks_found, 0, "canonical fixture has no masks");
    assert.equal(r.json.mask_keyframe_evidence.verdict, "no-mask-keyframe-evidence");
    assert.ok(
      r.json.notes.some((n) => n.includes("mask-keyframe-report.json")),
      "sanitize notes should name the harvest report",
    );
  });

  it("flags unknown property types and keyframe-shaped nodes inside mask materials", (t) => {
    const { projDir, outDir, cleanup } = projectWithPii();
    t.after(cleanup);

    // Inject a synthetic "app-authored" shape: a mask entry carrying an
    // unrecognized keyframe-looking container, and a masked segment carrying a
    // property_type the CLI does not know.
    const dst = join(projDir, "draft_content.json");
    const draft = JSON.parse(readFileSync(dst, "utf-8"));
    draft.materials.common_mask = [
      {
        id: "mask-harvest-1",
        type: "mask",
        name: "Rectangle",
        resource_type: "rectangle",
        config: { centerX: 0, centerY: 0, width: 0.5, height: 0.5, rotation: 0, feather: 0 },
        mask_keyframes: [{ time_offset: 0, values: [0.1] }],
      },
    ];
    const seg = draft.tracks.find((tr) => tr.type === "video").segments[0];
    seg.extra_material_refs = [...(seg.extra_material_refs ?? []), "mask-harvest-1"];
    seg.common_keyframes = [
      ...(seg.common_keyframes ?? []),
      { id: "kf-synth", property_type: "KFTypeSyntheticMaskCenterX", keyframe_list: [{ time_offset: 0, values: [0] }] },
    ];
    writeFileSync(dst, JSON.stringify(draft), "utf-8");

    const r = spawnCli(["fixture", projDir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const report = JSON.parse(readFileSync(join(outDir, "mask-keyframe-report.json"), "utf-8"));
    assert.equal(report.verdict, "mask-keyframe-evidence-found");
    const evidence = report.files.find((f) => f.file === "draft_content.json");
    assert.equal(evidence.masks.length, 1, "should find the injected mask entry");
    const mask = evidence.masks[0];
    assert.ok(mask.unrecognized_keys.includes("mask_keyframes"), "keys beyond the CLI's write set are surfaced");
    assert.ok(mask.keyframe_shaped_nodes.length >= 1, "keyframe-shaped node inside the mask entry is flagged");
    assert.ok(evidence.property_types.unknown.includes("KFTypeSyntheticMaskCenterX"));
    const masked = evidence.segments_with_mask_and_keyframes.find((s) => s.segment_id === seg.id);
    assert.ok(masked, "the masked segment with keyframes is reported");
    assert.ok(masked.mask_material_ids.includes("mask-harvest-1"));
    assert.ok(
      r.json.mask_keyframe_evidence.unknown_property_types_on_masked_segments.includes("KFTypeSyntheticMaskCenterX"),
    );
    assert.ok(
      r.json.notes.some((n) => n.includes("issue #44")),
      "evidence-found bundles point the reporter at #44",
    );
    const readme = readFileSync(join(outDir, "README.md"), "utf-8");
    assert.match(readme, /issue #44/);
  });

  it("stays read-only: the source draft is byte-identical after a fixture run", (t) => {
    const { projDir, outDir, cleanup } = projectWithPii();
    t.after(cleanup);

    const dst = join(projDir, "draft_content.json");
    const before = readFileSync(dst);
    const r = spawnCli(["fixture", projDir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const after = readFileSync(dst);
    assert.ok(before.equals(after), "fixture must never write to the source draft");
  });
});

// #59: `fixture` is documented as producing a shareable bundle and the README
// invites attaching it to a public issue, so the device identifiers CapCut
// stamps into every draft must not survive the redactor. The values below are
// synthetic 32-hex strings shaped like the real ones.
const DEVICE_ID = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const MAC_ADDRESS = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

// Built under a fake /home/<user>/ prefix so the report's own source_dir has
// something for the path redactor to catch — a bare tmpdir() path would not.
function projectWithDeviceIds() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-fixture-dev-"));
  const projDir = join(dir, "home", "secretuser", "proj");
  mkdirSync(projDir, { recursive: true });
  const dst = join(projDir, "draft_content.json");
  copyFileSync(CANONICAL, dst);
  const draft = JSON.parse(readFileSync(dst, "utf-8"));
  const platform = {
    app_id: 3704,
    app_version: "8.5.0",
    device_id: DEVICE_ID,
    hard_disk_id: "",
    mac_address: MAC_ADDRESS,
    os: "mac",
  };
  draft.platform = platform;
  draft.last_modified_platform = { ...platform };
  writeFileSync(dst, JSON.stringify(draft), "utf-8");
  // template-2.tmp holds its payload as string-JSON, so the same keys appear
  // with escaped quotes — the other branch of the redactor's pattern.
  writeFileSync(
    join(projDir, "template-2.tmp"),
    JSON.stringify(JSON.stringify({ platform: { device_id: DEVICE_ID, mac_address: MAC_ADDRESS } })),
    "utf-8",
  );
  return { projDir, outDir: join(dir, "out"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Walked by hand rather than with recursive readdir: Dirent.parentPath only
// exists from Node 20, and CI still builds on 18.
function allBundledText(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) allBundledText(p, out);
    else out.push({ file: p, text: readFileSync(p, "utf-8") });
  }
  return out;
}

describe("capcut fixture — device identifiers (#59)", () => {
  it("blanks device_id and mac_address in plain and escaped string-JSON alike", (t) => {
    const { projDir, outDir, cleanup } = projectWithDeviceIds();
    t.after(cleanup);

    const r = spawnCli(["fixture", projDir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    for (const name of ["draft_content.json", "template-2.tmp"]) {
      const text = readFileSync(join(outDir, name), "utf-8");
      assert.ok(!text.includes(DEVICE_ID), `${name} must not carry device_id`);
      assert.ok(!text.includes(MAC_ADDRESS), `${name} must not carry mac_address`);
    }
    // The keys survive with empty values — shape is what a fixture is for.
    const bundled = JSON.parse(readFileSync(join(outDir, "draft_content.json"), "utf-8"));
    assert.equal(bundled.platform.device_id, "");
    assert.equal(bundled.platform.mac_address, "");
    assert.equal(bundled.last_modified_platform.device_id, "");
    assert.equal(bundled.platform.app_version, "8.5.0", "app_version must be preserved");
  });

  it("leaves no identifier in ANY emitted file, report and README included", (t) => {
    const { projDir, outDir, cleanup } = projectWithDeviceIds();
    t.after(cleanup);

    const r = spawnCli(["fixture", projDir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    for (const { file, text } of allBundledText(outDir)) {
      assert.ok(!text.includes(DEVICE_ID), `${file} leaks device_id`);
      assert.ok(!text.includes(MAC_ADDRESS), `${file} leaks mac_address`);
      assert.ok(!text.includes("secretuser"), `${file} leaks the username`);
    }
  });

  it("redacts the report's own source_dir and out_dir", (t) => {
    const { projDir, outDir, cleanup } = projectWithDeviceIds();
    t.after(cleanup);

    const r = spawnCli(["fixture", projDir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!r.json.source_dir.includes("secretuser"), "source_dir must be redacted");
    assert.ok(r.json.source_dir.includes("/home/USER/"), "source_dir should keep its shape");
    assert.ok(!r.json.out_dir.includes("secretuser"), "out_dir must be redacted");
  });

  it("counts what it removed and ignores an already-empty hard_disk_id", (t) => {
    const { projDir, outDir, cleanup } = projectWithDeviceIds();
    t.after(cleanup);

    const r = spawnCli(["fixture", projDir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // draft_content.json: device_id + mac_address in both platform blocks (4),
    // template-2.tmp: one of each (2). The blank hard_disk_id contributes none.
    assert.equal(r.json.redaction_kinds.device_ids, 6, "should count exactly the non-empty identifiers");
    const content = r.json.files.find((f) => f.file === "draft_content.json");
    assert.ok(content.redactions >= 4, "per-file totals must include the identifiers");
  });
});
