import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { compileDraft } from "../dist/compile.js";
import { copyAssetDeduped, planAssetCopy } from "../dist/factory.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// compileDraft records the app version it saw for the write guard's tripwire;
// keep that in a scratch state file, never the developer's own
// ~/.config/capcut-cli/app-versions.json.
const stateDir = fs.mkdtempSync(join(tmpdir(), "capcut-asset-hash-state-"));
const previousState = process.env.CAPCUT_CLI_APP_VERSIONS;
process.env.CAPCUT_CLI_APP_VERSIONS = join(stateDir, "versions.json");
after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (previousState === undefined) delete process.env.CAPCUT_CLI_APP_VERSIONS;
  else process.env.CAPCUT_CLI_APP_VERSIONS = previousState;
});

function setup(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "capcut-asset-hash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "clip.mp4");
  const assets = join(dir, "assets", "video");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(source, "AAAA");
  return { dir, source, assets, destination: join(assets, "clip.mp4") };
}

// Count actual media bytes read, so the regression is independent of disk speed
// and the OS page cache. Restore the built-ins before any other test runs.
function countReads(run) {
  const original = { openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync };
  const paths = new Map();
  const bytes = new Map();
  fs.openSync = (path, ...args) => {
    const fd = original.openSync(path, ...args);
    paths.set(fd, resolve(String(path)));
    return fd;
  };
  fs.readSync = (fd, ...args) => {
    const count = original.readSync(fd, ...args);
    const path = paths.get(fd);
    if (path) bytes.set(path, (bytes.get(path) ?? 0) + count);
    return count;
  };
  fs.closeSync = (fd) => {
    paths.delete(fd);
    return original.closeSync(fd);
  };
  syncBuiltinESMExports();
  try {
    run(bytes);
  } finally {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  }
  return bytes;
}

describe("asset hashing cache (#155)", () => {
  it("compiles 40 cuts per video/audio source with one hash read per unchanged file", (t) => {
    const s = setup(t);
    const content = Buffer.alloc(130 * 1024, 97);
    const sources = [s.source, join(s.dir, "music.wav")];
    for (const source of sources) fs.writeFileSync(source, content);
    const spec = {
      tracks: ["video", "audio"].map((type, index) => ({
        type,
        items: Array.from({ length: 40 }, (_, start) => ({
          path: sources[index],
          start,
          sourceStart: start,
          duration: 1,
        })),
      })),
    };
    const outDir = join(s.dir, "Built");
    let result;
    const bytes = countReads(() => {
      result = compileDraft(spec, {
        specDir: s.dir,
        outDir,
        templateDir: join(root, "templates", "_init"),
        seed: "off",
      });
    });
    const draft = JSON.parse(fs.readFileSync(result.file_path, "utf8"));
    assert.equal(result.segments, 80);
    assert.equal(draft.duration, 40_000_000);
    for (const [index, kind] of ["video", "audio"].entries()) {
      const source = sources[index];
      const destination = join(outDir, "assets", kind, index === 0 ? "clip.mp4" : "music.wav");
      assert.equal(bytes.get(source), content.length, "source must be hashed once, regardless of cut count");
      assert.equal(bytes.get(destination), content.length, "staged asset must be hashed once");
      assert.deepEqual(fs.readFileSync(destination), content);
      const track = draft.tracks.find((item) => item.type === kind);
      assert.equal(track.segments.length, 40);
      const materials = kind === "video" ? draft.materials.videos : draft.materials.audios;
      for (const [start, segment] of track.segments.entries()) {
        assert.equal(segment.target_timerange.start, start * 1_000_000);
        assert.equal(segment.source_timerange.start, start * 1_000_000);
        assert.equal(materials.find((material) => material.id === segment.material_id).path, destination);
      }
    }
  });

  it("hashes collision candidates and the source only once across repeated copies", (t) => {
    const s = setup(t);
    const content = fs.readFileSync(s.source);
    const hash = createHash("sha1").update(content).digest("hex");
    const occupied = join(s.assets, `clip.${hash.slice(0, 8)}.mp4`);
    const expected = join(s.assets, `clip.${hash.slice(0, 12)}.mp4`);
    fs.writeFileSync(s.destination, "BBBB");
    fs.writeFileSync(occupied, "CCCC");
    // A matching suffix is not proof of matching bytes. Occupied candidates
    // still need their content checked before they can be reused.
    fs.writeFileSync(expected, content);
    const bytes = countReads(() => {
      for (let index = 0; index < 40; index++) {
        assert.equal(copyAssetDeduped(s.source, s.assets, "media"), expected);
      }
    });
    for (const path of [s.source, s.destination, occupied, expected]) {
      assert.equal(bytes.get(path), content.length, `expected only one full read of ${path}`);
    }
    assert.deepEqual(fs.readdirSync(s.assets).sort(), ["clip.mp4", basename(occupied), basename(expected)].sort());
  });

  it("reuses digest reads across relative and absolute spellings of the source", (t) => {
    const s = setup(t);
    fs.copyFileSync(s.source, s.destination);
    const bytes = countReads(() => {
      for (const source of [s.source, relative(process.cwd(), s.source)]) {
        assert.equal(planAssetCopy(source, s.assets, "media").copyNeeded, false);
      }
    });
    assert.equal(bytes.get(s.source), 4);
    assert.equal(bytes.get(s.destination), 4);
  });

  for (const changed of ["source", "destination"]) {
    it(`detects same-size ${changed} edits even when mtime is restored`, async (t) => {
      const s = setup(t);
      fs.copyFileSync(s.source, s.destination);
      const path = s[changed];
      const oldTime = new Date("2020-01-01T00:00:00Z");
      fs.utimesSync(path, oldTime, oldTime);
      assert.equal(planAssetCopy(s.source, s.assets, "media").copyNeeded, false);
      // Some filesystems stamp successive writes with the same clock tick.
      // Cross a tick so this test exercises a changed ctime with a fixed mtime.
      await setTimeout(25);
      fs.writeFileSync(path, "BBBB");
      fs.utimesSync(path, oldTime, oldTime);
      const plan = planAssetCopy(s.source, s.assets, "media");
      assert.equal(plan.copyNeeded, true);
      assert.equal(plan.collision, true);
      assert.notEqual(plan.destination, s.destination);
      assert.equal(fs.existsSync(plan.destination), false, "planning must not copy assets");
    });
  }

  it("detects a replacement destination with the same size and mtime", (t) => {
    const s = setup(t);
    fs.copyFileSync(s.source, s.destination);
    const oldTime = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(s.destination, oldTime, oldTime);
    assert.equal(planAssetCopy(s.source, s.assets, "media").copyNeeded, false);
    const replacement = join(s.dir, "replacement.mp4");
    fs.writeFileSync(replacement, "BBBB");
    fs.utimesSync(replacement, oldTime, oldTime);
    fs.renameSync(replacement, s.destination);
    assert.equal(planAssetCopy(s.source, s.assets, "media").copyNeeded, true);
  });

  it("invalidates a previously different destination when it becomes identical", (t) => {
    const s = setup(t);
    fs.writeFileSync(s.destination, "BBBB");
    const oldTime = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(s.destination, oldTime, oldTime);
    assert.equal(planAssetCopy(s.source, s.assets, "media").collision, true);
    fs.writeFileSync(s.destination, "AAAA");
    assert.deepEqual(planAssetCopy(s.source, s.assets, "media"), {
      destination: s.destination,
      copyNeeded: false,
      collision: false,
    });
  });

  it("checks current file sizes and handles deleted/recreated assets", (t) => {
    const s = setup(t);
    fs.copyFileSync(s.source, s.destination);
    assert.equal(planAssetCopy(s.source, s.assets, "media").copyNeeded, false);
    fs.writeFileSync(s.source, "LONGER");
    const plan = planAssetCopy(s.source, s.assets, "media");
    assert.equal(plan.copyNeeded, true);
    assert.equal(plan.collision, true);
    fs.rmSync(s.destination);
    assert.deepEqual(planAssetCopy(s.source, s.assets, "media"), {
      destination: s.destination,
      copyNeeded: true,
      collision: false,
    });
    fs.copyFileSync(s.source, s.destination);
    assert.equal(planAssetCopy(s.source, s.assets, "media").copyNeeded, false);
    fs.rmSync(s.source);
    assert.throws(() => planAssetCopy(s.source, s.assets, "media"), /ENOENT/);
  });
});
