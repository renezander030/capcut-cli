import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("relink", () => {
  it("--dir repoints a missing path to a same-basename file in the folder", () => {
    const fix = tmpDraft();
    const media = mkdtempSync(join(tmpdir(), "capcut-media-"));
    after(() => {
      fix.cleanup();
      rmSync(media, { recursive: true, force: true });
    });
    writeFileSync(join(media, "clip.mp4"), "x");

    const d = JSON.parse(readFileSync(fix.path, "utf-8"));
    d.materials.videos = [{ id: "V1", path: "/nonexistent/old/clip.mp4" }];
    writeFileSync(fix.path, JSON.stringify(d, null, 2));

    const r = spawnCli(["relink", fix.path, "--dir", media]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.relinked, 1);

    const v = JSON.parse(readFileSync(fix.path, "utf-8")).materials.videos[0];
    assert.equal(v.path, join(media, "clip.mp4"), "path should point at the found file");
  });

  it("--from/--to prefix-replaces material paths", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const d = JSON.parse(readFileSync(fix.path, "utf-8"));
    d.materials.videos = [{ id: "V1", path: "/old/root/a/clip.mp4" }];
    writeFileSync(fix.path, JSON.stringify(d, null, 2));

    const r = spawnCli(["relink", fix.path, "--from", "/old/root", "--to", "/new/place"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.relinked, 1);
    const v = JSON.parse(readFileSync(fix.path, "utf-8")).materials.videos[0];
    assert.equal(v.path, "/new/place/a/clip.mp4");
  });

  it("errors when neither --dir nor --from/--to is given", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const r = spawnCli(["relink", fix.path]);
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /--dir|--from/);
  });

  it("honors --dry-run", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const d = JSON.parse(readFileSync(fix.path, "utf-8"));
    d.materials.videos = [{ id: "V1", path: "/old/x.mp4" }];
    writeFileSync(fix.path, JSON.stringify(d, null, 2));
    const before = readFileSync(fix.path, "utf-8");

    const r = spawnCli(["relink", fix.path, "--from", "/old", "--to", "/new", "--dry-run"]);
    assert.equal(r.status, 0);
    assert.equal(r.json.relinked, 1);
    assert.equal(r.json.dryRun, true);
    assert.equal(readFileSync(fix.path, "utf-8"), before, "dry-run must not change the file");
  });
});
