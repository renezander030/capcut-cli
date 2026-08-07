import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT_BATCH = pathToFileURL(join(__dirname, "..", "dist", "export-batch.js")).href;

// Live macOS UI automation can't run on this (Linux) host, so we verify the
// generated `osascript` argument list — the part that is deterministic and testable.
describe("macos export script generation", () => {
  it("opens the draft, targets the app, and triggers the export menu item", async () => {
    const { macosExportArgs } = await import(EXPORT_BATCH);
    const args = macosExportArgs("/Users/rene/Movies/demo", "capcut");
    assert.equal(args[0], "-e");
    const [, script, pathArg] = args;
    assert.match(script, /tell application "CapCut"/);
    assert.match(script, /click menu item "Export" of menu "File"/);
    assert.equal(pathArg, "/Users/rene/Movies/demo/draft_content.json", "passes the project's draft file");
  });

  it("targets JianYingPro for the jianying app", async () => {
    const { macosExportArgs } = await import(EXPORT_BATCH);
    const [, script] = macosExportArgs("/p", "jianying");
    assert.match(script, /tell application "JianYingPro"/);
  });

  // Regression: the draft directory used to be interpolated into a double-quoted
  // AppleScript literal (`open POSIX file "${draftDir}/…"`), so a folder name
  // carrying a quote could close the literal and run `do shell script`.
  it("passes the draft path as an argument, never into the script source", async () => {
    const { macosExportArgs } = await import(EXPORT_BATCH);
    const payload = 'demo" & (do shell script "touch /tmp/capcut-pwned") & "';
    const dir = `/Users/rene/Movies/${payload}`;
    const [flag, script, pathArg] = macosExportArgs(dir, "capcut");

    assert.equal(flag, "-e");
    assert.ok(!script.includes(payload), "folder name must not reach the AppleScript source");
    assert.ok(!script.includes("do shell script"), "no shell escape hatch in the compiled script");
    assert.match(script, /on run argv/, "reads the path from argv instead");
    assert.equal(pathArg, `${dir}/draft_content.json`, "path stays inert data in its own argument");
  });
});
