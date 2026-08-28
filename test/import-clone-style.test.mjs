import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const SRT = "1\n00:00:03,000 --> 00:00:04,000\nHello clone\n";

function minimalDraft() {
  return {
    id: "guid-clone",
    name: "clone-draft",
    duration: 2_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "8.7.0", os: "windows" },
    tracks: [],
    materials: { videos: [], audios: [], texts: [], speeds: [] },
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-clone-style-"));
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(minimalDraft(), null, 2));
  return { dir, path: join(dir, "draft_content.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function textMaterials(path) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  return draft.materials.texts.map((m) => ({ id: m.id, content: JSON.parse(m.content) }));
}

describe("import-srt --clone-style (id-free style preservation)", () => {
  it("copies the newest existing caption's styling onto every imported cue", () => {
    const f = fixture();
    after(f.cleanup);

    const styled = spawnCli(["add-text", f.path, "0", "1s", "Styled seed", "--font-size", "77"]);
    assert.equal(styled.status, 0, `stderr: ${styled.stderr}`);

    const r = spawnCli(["import-srt", f.path, "-", "--clone-style"], { input: SRT });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    const mats = textMaterials(f.path);
    const seed = mats.find((m) => JSON.stringify(m.content).includes("Styled seed"));
    const imported = mats.find((m) => JSON.stringify(m.content).includes("Hello clone"));
    assert.ok(seed && imported, "both the seed and the imported caption must exist");
    assert.equal(
      imported.content.styles?.[0]?.size,
      seed.content.styles?.[0]?.size,
      "the imported cue must carry the seed caption's font size",
    );
    assert.equal(imported.content.styles?.[0]?.size, 77);
  });

  it("an explicit --style-ref wins over --clone-style", () => {
    const f = fixture();
    after(f.cleanup);
    spawnCli(["add-text", f.path, "0", "1s", "Old style", "--font-size", "30"]);
    const newer = spawnCli(["add-text", f.path, "1s", "1s", "New style", "--font-size", "90"]);
    assert.equal(newer.status, 0, `stderr: ${newer.stderr}`);
    const oldSegId = JSON.parse(readFileSync(f.path, "utf-8")).tracks.flatMap((t) => t.segments)[0].id;

    const r = spawnCli(["import-srt", f.path, "-", "--clone-style", "--style-ref", oldSegId], { input: SRT });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const imported = textMaterials(f.path).find((m) => JSON.stringify(m.content).includes("Hello clone"));
    assert.equal(imported.content.styles?.[0]?.size, 30, "--style-ref must win");
  });

  it("fails fast with guidance when the draft has no text segment to clone from", () => {
    const f = fixture();
    after(f.cleanup);
    const r = spawnCli(["import-srt", f.path, "-", "--clone-style"], { input: SRT });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /existing text segment/);
  });
});
