import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// Canvas at creation: the bundled template is 1920x1080 16:9; --ratio picks a
// CapCut-native preset size, --width/--height set an exact canvas.

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-init-canvas-"));
  return { dir, drafts: join(dir, "drafts"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function canvasOf(draftPath) {
  const file = join(draftPath, "draft_content.json");
  return JSON.parse(readFileSync(file, "utf-8")).canvas_config;
}

describe("init / quickstart canvas flags", () => {
  it("keeps the template canvas when no flag is given (canvas: null in the output)", (t) => {
    const s = scratch();
    t.after(s.cleanup);
    const r = spawnCli(["init", "plain", "--drafts", s.drafts]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.canvas, null);
    assert.deepEqual(canvasOf(r.json.draft_path), { width: 1920, height: 1080, ratio: "16:9" });
  });

  it("--ratio 9:16 creates a 1080x1920 portrait canvas", (t) => {
    const s = scratch();
    t.after(s.cleanup);
    const r = spawnCli(["init", "portrait", "--drafts", s.drafts, "--ratio", "9:16"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.canvas, { width: 1080, height: 1920, ratio: "9:16" });
    assert.deepEqual(canvasOf(r.json.draft_path), { width: 1080, height: 1920, ratio: "9:16" });
    assert.match(r.stderr, /Canvas: 1080x1920 \(9:16\)/);
  });

  it("--width/--height set an exact canvas and label it from the matching preset", (t) => {
    const s = scratch();
    t.after(s.cleanup);
    const square = spawnCli(["init", "square", "--drafts", s.drafts, "--width", "1200", "--height", "1200"]);
    assert.equal(square.status, 0, `stderr: ${square.stderr}`);
    assert.deepEqual(square.json.canvas, { width: 1200, height: 1200, ratio: "1:1" });

    const custom = spawnCli(["init", "custom", "--drafts", s.drafts, "--width", "1000", "--height", "700"]);
    assert.equal(custom.status, 0, `stderr: ${custom.stderr}`);
    assert.deepEqual(custom.json.canvas, { width: 1000, height: 700, ratio: "original" });
  });

  it("explicit size wins over the preset's size but keeps its label", (t) => {
    const s = scratch();
    t.after(s.cleanup);
    const r = spawnCli(["init", "hd", "--drafts", s.drafts, "--ratio", "9:16", "--width", "720", "--height", "1280"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.canvas, { width: 720, height: 1280, ratio: "9:16" });
  });

  it("refuses a half-specified canvas and an unknown preset", (t) => {
    const s = scratch();
    t.after(s.cleanup);
    const half = spawnCli(["init", "half", "--drafts", s.drafts, "--width", "1080"]);
    assert.notEqual(half.status, 0);
    assert.match(half.stderr, /--width and --height must be given together/);
    const bad = spawnCli(["init", "bad", "--drafts", s.drafts, "--ratio", "5:4"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /Unknown --ratio 5:4/);
    const fraction = spawnCli(["init", "frac", "--drafts", s.drafts, "--width", "100.5", "--height", "200"]);
    assert.notEqual(fraction.status, 0);
    assert.match(fraction.stderr, /positive integer pixel count/);
  });

  it("quickstart passes the canvas through and reports it in the create step", (t) => {
    const s = scratch();
    t.after(s.cleanup);
    const video = join(s.dir, "clip.mp4");
    writeFileSync(video, "not-a-real-video");
    const r = spawnCli(["quickstart", "short", "--video", video, "--drafts", s.drafts, "--ratio", "9:16"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.canvas, { width: 1080, height: 1920, ratio: "9:16" });
    assert.deepEqual(canvasOf(r.json.draft_path), { width: 1080, height: 1920, ratio: "9:16" });
    const create = r.json.steps.find((step) => step.step === "create");
    assert.match(create.detail, /Canvas 1080x1920 \(9:16\)/);
  });

  it("describe advertises --ratio with the preset values on init and quickstart", () => {
    const r = spawnCli(["describe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    for (const name of ["init", "quickstart"]) {
      const spec = r.json.commands.find((c) => c.name === name);
      const ratio = spec.options.find((o) => o.flags.includes("--ratio"));
      assert.ok(ratio, `${name} must declare --ratio`);
      assert.deepEqual(ratio.values, ["16:9", "9:16", "1:1", "4:3", "3:4"]);
      assert.ok(spec.options.some((o) => o.flags.includes("--width")));
      assert.ok(spec.options.some((o) => o.flags.includes("--height")));
    }
  });
});
