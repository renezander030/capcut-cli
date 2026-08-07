import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXPORT_BATCH = pathToFileURL(join(__dirname, "..", "dist", "export-batch.js")).href;

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

  // Read the `Start-Process -FilePath '…'` literal back the way PowerShell's
  // tokenizer does: any single-quote character ends the string unless it is
  // doubled, in which case it decodes to one literal quote.
  function readFilePathLiteral(script) {
    const open = script.indexOf("-FilePath '") + "-FilePath '".length;
    let value = "";
    let i = open;
    while (i < script.length) {
      const c = script[i];
      if (/['\u2018\u2019\u201a\u201b]/.test(c)) {
        if (/['\u2018\u2019\u201a\u201b]/.test(script[i + 1])) {
          value += script[i + 1];
          i += 2;
          continue;
        }
        return { value, rest: script.slice(i + 1) };
      }
      value += c;
      i += 1;
    }
    return { value, rest: null };
  }

  // Regression: the draft directory was interpolated raw into this single-quoted
  // literal, so a folder name carrying a quote closed the string early and the
  // remainder ran as PowerShell.
  it("keeps an injected quote inside the draft path literal", async () => {
    const { windowsExportScript } = await import(EXPORT_BATCH);
    const dir = "C:\\drafts\\demo'; Start-Process calc.exe; #";
    const script = windowsExportScript(dir, "capcut");

    const { value, rest } = readFilePathLiteral(script);
    assert.equal(value, `${dir}\\draft_content.json`, "the whole folder name stays one string literal");
    assert.ok(rest !== null, "literal must be closed");
    assert.equal(rest.split("\n")[0], ";", "nothing runs after the literal but the statement terminator");
    assert.ok(!/^\s*Start-Process calc\.exe/m.test(rest), "payload never becomes its own command");
  });

  it("round-trips a legitimate apostrophe in a folder name", async () => {
    const { windowsExportScript } = await import(EXPORT_BATCH);
    const dir = "C:\\Users\\Rene's Drafts\\demo";
    const { value } = readFilePathLiteral(windowsExportScript(dir, "capcut"));
    assert.equal(value, `${dir}\\draft_content.json`);
  });
});
