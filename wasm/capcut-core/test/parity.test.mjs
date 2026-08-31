import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { __test } from "../component.js";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageDirectory, "../..");
const fixturePath = resolve(repositoryRoot, "test/draft_content.json");
const cliPath = resolve(repositoryRoot, "dist/index.js");
const fixtureJson = readFileSync(fixturePath, "utf8");
const supportedLintCodes = new Set([
  "missing-material",
  "dangling-companion-ref",
  "cue-too-long",
  "caption-too-fast",
  "caption-outside-safe-area",
  "caption-overlap",
]);

function invokeCli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
  assert.notEqual(result.status, null, result.error?.message);
  assert.ok(result.stdout.trim(), `capcut-cli emitted no JSON: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function unwrap(result) {
  return JSON.parse(result);
}

function summarize(issues) {
  const summary = { errors: 0, warnings: 0, info: 0, total: issues.length };
  for (const issue of issues) {
    if (issue.severity === "error") summary.errors += 1;
    else if (issue.severity === "warning") summary.warnings += 1;
    else summary.info += 1;
  }
  return summary;
}

describe("semantic parity with the repository CLI", () => {
  it("matches capcut info field-for-field", () => {
    assert.deepEqual(unwrap(__test.inspect(fixtureJson)), invokeCli(["info", fixturePath]));
  });

  it("matches the declared portable subset of capcut lint", () => {
    const broken = JSON.parse(fixtureJson);
    broken.canvas_config = { ...broken.canvas_config, width: 1080, height: 1920 };
    const textTrack = broken.tracks.find((track) => track.type === "text");
    const [first, second, third] = textTrack.segments;
    const firstText = broken.materials.texts.find((material) => material.id === first.material_id);

    first.target_timerange.duration = 8_000_000;
    first.clip = { ...(first.clip ?? {}), transform: { ...(first.clip?.transform ?? {}), y: 0.9 } };
    firstText.content = JSON.stringify({ text: "X".repeat(200), styles: [] });
    second.target_timerange.start = 1_000_000;
    second.material_id = "missing-material-id";
    third.extra_material_refs = ["missing-companion-id"];

    const temporaryDirectory = mkdtempSync(join(tmpdir(), "capcut-core-wasm-lint-"));
    const brokenPath = join(temporaryDirectory, "broken.json");
    writeFileSync(brokenPath, JSON.stringify(broken));

    const cliReport = invokeCli(["lint", brokenPath, "--no-check-paths", "--no-probe"]);
    const expectedIssues = cliReport.issues.filter((issue) => supportedLintCodes.has(issue.code));
    const componentReport = unwrap(__test.lintPortable(JSON.stringify(broken)));

    assert.deepEqual(componentReport.issues, expectedIssues);
    assert.deepEqual(componentReport.summary, summarize(expectedIssues));
  });

  it("matches capcut diff field-for-field", () => {
    const after = JSON.parse(fixtureJson);
    after.materials.texts[0].content = JSON.stringify({ text: "EDITED BY PARITY TEST", styles: [] });
    after.tracks[0].segments[0].target_timerange.start += 1_000_000;
    after.tracks[0].segments[0].speed = 1.25;
    after.tracks[0].segments[0].volume = 0.5;

    const temporaryDirectory = mkdtempSync(join(tmpdir(), "capcut-core-wasm-diff-"));
    const beforePath = join(temporaryDirectory, "before.json");
    const afterPath = join(temporaryDirectory, "after.json");
    writeFileSync(beforePath, fixtureJson);
    writeFileSync(afterPath, JSON.stringify(after));

    assert.deepEqual(
      unwrap(__test.diff(fixtureJson, JSON.stringify(after))),
      invokeCli(["diff", beforePath, afterPath]),
    );
  });
});
