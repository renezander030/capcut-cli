import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

export interface ExportBatchOptions {
  draftsDir: string; // directory containing project subdirectories
  outDir?: string; // where CapCut should drop renders; default: ~/Movies/CapCut/Exports
  dryRun?: boolean;
  app?: "capcut" | "jianying";
}

export interface ExportBatchResult {
  ok: boolean;
  platform: NodeJS.Platform;
  drafts: string[];
  results: Array<{ draft: string; status: "queued" | "skipped" | "error"; message?: string }>;
  warning: string;
}

/**
 * Best-effort UI-automated batch export. EXPERIMENTAL.
 *
 * CapCut/JianYing have no headless render CLI. This wraps OS-level automation:
 *   - macOS: AppleScript (`osascript`) opens each draft and triggers Export
 *   - Windows: PowerShell + SendKeys (Ctrl+E export; needs CapCut window focus)
 *   - Linux: not supported — CapCut/JianYing don't run natively
 *
 * Reliability is bounded by the host UI not changing. We surface this clearly
 * with `warning` in the result and `--dry-run` for safe exploration.
 */
export function exportBatch(opts: ExportBatchOptions): ExportBatchResult {
  const os = platform();
  const drafts = listDraftDirs(opts.draftsDir);
  const result: ExportBatchResult = {
    ok: drafts.length > 0,
    platform: os,
    drafts,
    results: [],
    warning:
      "EXPERIMENTAL: UI automation breaks when CapCut/JianYing changes its window layout. Use --dry-run first. " +
      "Bounded by host UI stability — see docs/version-support.md for the trade-off.",
  };
  if (drafts.length === 0) {
    result.ok = false;
    result.warning = `No draft directories found in ${opts.draftsDir} (expected subdirs containing draft_content.json or draft_info.json)`;
    return result;
  }
  // --dry-run skips UI automation entirely, so it works on any OS.
  if (opts.dryRun) {
    for (const draft of drafts) result.results.push({ draft, status: "skipped", message: "dry-run" });
    return result;
  }
  if (os !== "darwin" && os !== "win32") {
    result.ok = false;
    result.warning = `CapCut/JianYing do not run natively on ${os}. Run this command on macOS or Windows where the app is installed.`;
    return result;
  }

  for (const draft of drafts) {
    try {
      const r =
        os === "darwin" ? runMacOSExport(draft, opts.app ?? "capcut") : runWindowsExport(draft, opts.app ?? "capcut");
      result.results.push({ draft, status: r.ok ? "queued" : "error", message: r.message });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.results.push({ draft, status: "error", message: msg });
    }
  }
  return result;
}

function listDraftDirs(parent: string): string[] {
  if (!existsSync(parent)) return [];
  const entries = readdirSync(parent);
  return entries
    .map((e) => join(parent, e))
    .filter((p) => {
      try {
        if (!statSync(p).isDirectory()) return false;
        return existsSync(join(p, "draft_content.json")) || existsSync(join(p, "draft_info.json"));
      } catch {
        return false;
      }
    });
}

function runMacOSExport(draftDir: string, app: "capcut" | "jianying"): { ok: boolean; message: string } {
  const appName = app === "capcut" ? "CapCut" : "JianYingPro";
  // Minimal AppleScript: open the project file, give the app a moment, trigger Export from the menu.
  // The Export menu path varies between versions; this is a sketch — production use needs hardening.
  const script = `
    tell application "${appName}"
      activate
      delay 1
      open POSIX file "${draftDir}/draft_content.json"
      delay 5
    end tell
    tell application "System Events"
      tell process "${appName}"
        click menu item "Export" of menu "File" of menu bar 1
      end tell
    end tell
  `;
  const r = spawnSync("osascript", ["-e", script], { encoding: "utf-8", timeout: 30_000 });
  if (r.status !== 0) {
    return { ok: false, message: `osascript failed (status ${r.status}): ${r.stderr || r.stdout || "unknown"}` };
  }
  return { ok: true, message: "Export triggered via AppleScript; check your CapCut export queue" };
}

// Build the PowerShell automation for one draft. Pure (no I/O) so it can be
// unit-tested off-Windows: opens the project file, waits for the app window,
// then sends CapCut's export shortcut (Ctrl+E) via SendKeys.
export function windowsExportScript(draftDir: string, app: "capcut" | "jianying"): string {
  const exe = app === "capcut" ? "CapCut" : "JianyingPro";
  const draftFile = `${draftDir}\\draft_content.json`;
  return [
    "Add-Type -AssemblyName System.Windows.Forms;",
    `Start-Process -FilePath '${draftFile}';`,
    "Start-Sleep -Seconds 6;",
    `$p = Get-Process '${exe}' -ErrorAction SilentlyContinue | Select-Object -First 1;`,
    "if ($p) { [System.Windows.Forms.SendKeys]::SendWait('^e'); } else { exit 3 }",
  ].join("\n");
}

function runWindowsExport(draftDir: string, app: "capcut" | "jianying"): { ok: boolean; message: string } {
  // Same reliability caveat as the macOS path: bounded by the host UI not moving.
  const script = windowsExportScript(draftDir, app);
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf-8", timeout: 30_000 });
  if (r.status !== 0) {
    return {
      ok: false,
      message: `powershell failed (status ${r.status}): ${r.stderr || r.stdout || "is CapCut installed and the window unobstructed?"}`,
    };
  }
  return { ok: true, message: "Export triggered via PowerShell SendKeys (Ctrl+E); check your CapCut export queue" };
}
