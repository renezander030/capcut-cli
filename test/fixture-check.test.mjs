import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-fixture-check-"));
  const draft = {
    id: "guid-fixture",
    name: "fixture-draft",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "8.7.0", os: "windows" },
    tracks: [{ id: "T1", type: "text", name: "text", attribute: 0, segments: [] }],
    materials: { videos: [], audios: [], texts: [], speeds: [] },
  };
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(draft, null, 2));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("fixture --check (redaction verification)", () => {
  it("builds a bundle and passes the check when nothing private survives", () => {
    const p = project();
    after(p.cleanup);
    const out = join(p.dir, "bundle");

    const r = spawnCli(["fixture", p.dir, "--out", out, "--check"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.redaction_check.ok, true, JSON.stringify(r.json.redaction_check));
    assert.ok(r.json.redaction_check.files_scanned >= 2, "the bundle's own report and README must be scanned too");
    assert.match(r.stderr, /Redaction check passed/);
  });

  it("verify-only mode fails an existing bundle that leaks a home path, naming file and line", () => {
    const p = project();
    after(p.cleanup);
    const out = join(p.dir, "bundle");
    assert.equal(spawnCli(["fixture", p.dir, "--out", out]).status, 0);
    writeFileSync(join(out, "leak.json"), JSON.stringify({ note: "/Users/hansmustermann/secret.mov" }));

    const r = spawnCli(["fixture", out, "--check"]);
    assert.equal(r.status, 1, `a finding must fail the exit code — stderr: ${r.stderr}`);
    assert.equal(r.json.ok, false);
    const finding = r.json.findings.find((f) => f.file === "leak.json");
    assert.ok(finding, JSON.stringify(r.json.findings));
    assert.equal(finding.kind, "home-path");
    assert.equal(typeof finding.line, "number");
    assert.match(r.stderr, /LEAK home-path leak\.json/);
    assert.ok(!r.stderr.includes("hansmustermann"), "the check must never echo the leaked value itself");
  });

  it("flags real emails and unredacted device keys, allows the redactor's placeholder", () => {
    const p = project();
    after(p.cleanup);
    const out = join(p.dir, "bundle");
    assert.equal(spawnCli(["fixture", p.dir, "--out", out]).status, 0);
    writeFileSync(
      join(out, "extra.json"),
      JSON.stringify({ contact: "someone@real-mail.com", device_id: "abcdef123456", ok: "redacted@example.com" }),
    );
    writeFileSync(join(out, "clean.json"), JSON.stringify({ device_id: "redacted", mail: "redacted@example.com" }));

    const r = spawnCli(["fixture", out, "--check"]);
    assert.equal(r.status, 1);
    const kinds = r.json.findings.filter((f) => f.file === "extra.json").map((f) => f.kind);
    assert.ok(kinds.includes("email"), JSON.stringify(r.json.findings));
    assert.ok(kinds.includes("device-key"));
    assert.ok(!r.json.findings.some((f) => f.file === "clean.json"), "redacted placeholders must not be flagged");
  });

  it("allows the redactor's own USER home-path placeholder but flags a real account name", () => {
    const p = project();
    after(p.cleanup);
    const out = join(p.dir, "bundle");
    assert.equal(spawnCli(["fixture", p.dir, "--out", out]).status, 0);
    // What a correctly redacted report looks like when the project lives under
    // a home directory (and what every Windows/macOS temp dir produces).
    writeFileSync(
      join(out, "placeholder.json"),
      JSON.stringify({ a: "/home/USER/drafts/p", b: "/Users/USER/x", c: "C:\\Users\\USER\\y" }),
    );
    const clean = spawnCli(["fixture", out, "--check"]);
    assert.equal(clean.status, 0, `placeholder paths are the redactor working — stderr: ${clean.stderr}`);

    writeFileSync(join(out, "real.json"), JSON.stringify({ a: "/home/hansmustermann/drafts/p" }));
    const dirty = spawnCli(["fixture", out, "--check"]);
    assert.equal(dirty.status, 1);
    assert.ok(dirty.json.findings.some((f) => f.file === "real.json" && f.kind === "home-path"));
  });
});
