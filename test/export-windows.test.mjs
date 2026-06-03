import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT_BATCH = join(__dirname, "..", "dist", "export-batch.js");

// Live Windows UI automation can't run on this (Linux) host, so we verify the
// generated PowerShell script — the part that is deterministic and testable.
describe("windows export script generation", () => {
  it("opens the draft, targets the app, and sends the export shortcut", async () => {
    const { windowsExportScript } = await import(EXPORT_BATCH);
    const script = windowsExportScript("C:\\projects\\demo", "capcut");
    assert.match(script, /Start-Process/);
    assert.ok(script.includes("C:\\projects\\demo\\draft_content.json"), "opens the project's draft file");
    assert.ok(script.includes("'CapCut'"), "targets the CapCut process");
    assert.ok(script.includes("SendKeys"), "uses SendKeys");
    assert.ok(script.includes("'^e'"), "sends Ctrl+E (export)");
  });

  it("targets JianyingPro for the jianying app", async () => {
    const { windowsExportScript } = await import(EXPORT_BATCH);
    const script = windowsExportScript("C:\\p", "jianying");
    assert.ok(script.includes("'JianyingPro'"));
  });
});
