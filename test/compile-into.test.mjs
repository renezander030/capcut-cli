import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { compileIntoDraft, planCompileInto } from "../dist/compile.js";
import { setForceWrite } from "../dist/draft.js";
import { projectShell, readJson, shellDraft, snapshot } from "./helpers/project-shell.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const stateDir = fs.mkdtempSync(join((await import("node:os")).tmpdir(), "capcut-into-state-"));
const previousState = process.env.CAPCUT_CLI_APP_VERSIONS;
process.env.CAPCUT_CLI_APP_VERSIONS = join(stateDir, "versions.json");
after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (previousState === undefined) delete process.env.CAPCUT_CLI_APP_VERSIONS;
  else process.env.CAPCUT_CLI_APP_VERSIONS = previousState;
});

const textSpec = () => ({
  name: "Spec name",
  tracks: [{ type: "text", items: [{ ref: "title", text: "A title", start: 0, duration: 2 }] }],
});
const options = (s) => ({ intoDir: s.dir, specDir: s.base, activeTimeline: true });
function mediaSpec(s) {
  const spec = textSpec();
  fs.writeFileSync(join(s.base, "clip.mp4"), "first video bytes");
  fs.writeFileSync(join(s.base, "music.wav"), "audio bytes");
  spec.tracks.push({ type: "video", items: [{ path: "clip.mp4", start: 0, duration: 3 }] });
  spec.tracks.push({ type: "audio", items: [{ path: "music.wav", start: 0, duration: 3 }] });
  return spec;
}

function inject(method, replacement, run) {
  const original = fs[method];
  fs[method] = (...args) => replacement(original, ...args);
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    fs[method] = original;
    syncBuiltinESMExports();
  }
}

describe("compile into an app-created empty project (#52)", () => {
  it("keeps each document's identity, markers, unknown settings and store registration", (t) => {
    const s = projectShell(t);
    const spec = mediaSpec(s);
    const root = readJson(s.root);
    root.name = "Root project name";
    root.platform.app_version = "7.6.0";
    root.root_only = { preserve: true };
    root.canvas_config.app_setting = "root-specific";
    root.materials.root_only = [{ opaque: true }];
    fs.writeFileSync(s.root, JSON.stringify(root));
    const index = fs.readFileSync(s.index, "utf-8");
    const pointer = fs.readFileSync(s.pointer, "utf-8");
    const archive = fs.readFileSync(s.archive, "utf-8");
    const meta = readJson(s.meta);
    const result = compileIntoDraft(spec, options(s));
    assert.equal(result.into, true);
    assert.equal(result.file_path, s.active);
    assert.equal(result.name, "App-created shell");
    assert.equal(result.duration_us, 3_000_000);
    const active = readJson(s.active);
    const writtenRoot = readJson(s.root);
    assert.equal(active.id, "active-id");
    assert.equal(writtenRoot.id, root.id);
    assert.equal(writtenRoot.name, root.name);
    assert.deepEqual(writtenRoot.platform, root.platform);
    assert.deepEqual(writtenRoot.root_only, root.root_only);
    assert.equal(writtenRoot.canvas_config.app_setting, "root-specific");
    assert.deepEqual(writtenRoot.materials.root_only, root.materials.root_only);
    assert.deepEqual(active.canvas_config, shellDraft().canvas_config);
    assert.equal(active.fps, 24);
    assert.deepEqual(active.opaque_setting, shellDraft().opaque_setting);
    assert.equal(fs.readFileSync(s.index, "utf-8"), index);
    assert.equal(fs.readFileSync(s.pointer, "utf-8"), pointer);
    assert.equal(fs.readFileSync(s.archive, "utf-8"), archive);
    const sidecar = readJson(s.meta);
    assert.equal(sidecar.draft_id, meta.draft_id);
    assert.equal(sidecar.draft_name, meta.draft_name);
    assert.deepEqual(sidecar.opaque, meta.opaque);
    assert.deepEqual(
      sidecar.draft_materials.find((group) => group.type === 1),
      meta.draft_materials[0],
    );
    for (const material of [...active.materials.videos, ...active.materials.audios]) {
      assert.ok(material.path.startsWith(join(s.dir, "assets")));
      assert.ok(fs.existsSync(material.path));
      assert.ok(
        sidecar.draft_materials
          .flatMap((group) => group.value)
          .some((entry) => entry.id === material.local_material_id && entry.file_Path === material.path),
      );
    }
    assert.equal(fs.readFileSync(`${s.active}.bak`, "utf-8"), JSON.stringify(shellDraft("active-id"), null, 2));
    assert.equal(fs.readFileSync(`${s.meta}.bak`, "utf-8"), JSON.stringify(meta));
    assert.equal(fs.existsSync(join(s.dir, "Timelines", "active-id", "assets")), false);
  });

  it("supports a flat shell, preserving settings unless the spec explicitly changes them", (t) => {
    const s = projectShell(t, { nested: false });
    const spec = { ...textSpec(), width: 1920, height: 1080, fps: 30 };
    const result = compileIntoDraft(spec, { ...options(s), activeTimeline: false });
    assert.equal(result.file_path, s.root);
    assert.equal(readJson(s.root).canvas_config.width, 1920);
    assert.equal(readJson(s.root).canvas_config.app_setting, true);
    assert.equal(readJson(s.root).fps, 30);
  });

  for (const preview of ["--check", "--plan", "--dry-run"]) {
    it(`validates the target and leaves all files unchanged with ${preview}`, (t) => {
      const s = projectShell(t);
      const specPath = join(s.base, "spec.json");
      fs.writeFileSync(specPath, JSON.stringify(mediaSpec(s)));
      const before = snapshot(s.base);
      const result = spawnCli(["compile", specPath, "--into", s.dir, "--active-timeline", preview]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.json.into, true);
      assert.equal(result.json.write, false);
      assert.equal(result.json.canvas.fps, 24);
      assert.equal(result.json.name, "App-created shell");
      assert.deepEqual(snapshot(s.base), before);
    });
  }

  for (const target of ["root", "active"]) {
    it(`refuses existing edits in the ${target}, including a forced write`, (t) => {
      const s = projectShell(t);
      const doc = readJson(s[target]);
      doc.tracks = [{ id: "existing", type: "text", segments: [{ material_id: "keep" }] }];
      fs.writeFileSync(s[target], JSON.stringify(doc));
      const before = snapshot(s.dir);
      setForceWrite(true);
      try {
        assert.throws(() => compileIntoDraft(textSpec(), options(s)), /must be empty/);
      } finally {
        setForceWrite(false);
      }
      assert.deepEqual(snapshot(s.dir), before);
    });
  }

  it("checks destination emptiness for previews too", (t) => {
    const s = projectShell(t);
    fs.writeFileSync(s.root, JSON.stringify({ ...readJson(s.root), duration: 1_000_000 }));
    assert.throws(() => planCompileInto(textSpec(), options(s)), /must be empty/);
  });

  it("requires active selection for nested layouts and keeps the version boundary", (t) => {
    const s = projectShell(t, { version: "99.0.0" });
    assert.throws(
      () => compileIntoDraft(textSpec(), { ...options(s), activeTimeline: false }),
      /require --active-timeline/,
    );
    const before = snapshot(s.dir);
    assert.throws(() => compileIntoDraft(mediaSpec(s), options(s)), /version-boundary/);
    assert.deepEqual(snapshot(s.dir), before);
  });

  it("rejects invalid operations and unreadable sidecars before creating assets", (t) => {
    const s = projectShell(t);
    const spec = mediaSpec(s);
    spec.operations = [{ op: "transition", target: "title", slug: "missing-transition" }];
    const before = snapshot(s.dir);
    assert.throws(() => compileIntoDraft(spec, options(s)), /transition/);
    assert.deepEqual(snapshot(s.dir), before);
    delete spec.operations;
    fs.writeFileSync(s.meta, "bad sidecar");
    assert.throws(() => compileIntoDraft(spec, options(s)), /readable app-created/);
    assert.equal(fs.existsSync(join(s.dir, "assets")), false);
  });

  it("preserves colliding existing media and stages distinct same-named sources correctly", (t) => {
    const s = projectShell(t);
    const spec = mediaSpec(s);
    const assets = join(s.dir, "assets", "video");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(join(assets, "clip.mp4"), "existing media");
    fs.mkdirSync(join(s.base, "other"));
    fs.writeFileSync(join(s.base, "other", "clip.mp4"), "second video bytes");
    spec.tracks[1].items.push({ path: "other/clip.mp4", start: 3, duration: 1 });
    compileIntoDraft(spec, options(s));
    assert.equal(fs.readFileSync(join(assets, "clip.mp4"), "utf-8"), "existing media");
    const videos = readJson(s.active).materials.videos;
    assert.equal(new Set(videos.map((material) => material.path)).size, 2);
    assert.deepEqual(
      videos.map((material) => fs.readFileSync(material.path, "utf-8")),
      ["first video bytes", "second video bytes"],
    );
  });

  it("removes partial copies and newly created asset directories on an I/O failure", (t) => {
    const s = projectShell(t);
    const spec = mediaSpec(s);
    const before = snapshot(s.dir);
    inject(
      "writeSync",
      (original, fd, ...args) => {
        if (Buffer.isBuffer(args[0])) {
          original(fd, ...args);
          throw new Error("injected copy failure");
        }
        return original(fd, ...args);
      },
      () => assert.throws(() => compileIntoDraft(spec, options(s)), /copy failure/),
    );
    assert.deepEqual(snapshot(s.dir), before);
  });

  it("rolls back timeline and sidecar targets after a partial commit", (t) => {
    const s = projectShell(t);
    const spec = mediaSpec(s);
    const before = [s.root, s.active, s.meta, s.index, s.pointer, s.archive].map((path) =>
      fs.readFileSync(path, "utf-8"),
    );
    inject(
      "renameSync",
      (original, source, destination) => {
        if (destination === s.meta) throw new Error("injected sidecar commit failure");
        return original(source, destination);
      },
      () => assert.throws(() => compileIntoDraft(spec, options(s)), /sidecar commit failure/),
    );
    for (const [index, path] of [s.root, s.active, s.meta, s.index, s.pointer, s.archive].entries())
      assert.equal(fs.readFileSync(path, "utf-8"), before[index]);
    assert.equal(fs.existsSync(join(s.dir, "assets")), false);
  });

  it("preserves another writer's sidecar and index changes and cleans staged assets", (t) => {
    const s = projectShell(t);
    const spec = mediaSpec(s);
    const beforeTimeline = fs.readFileSync(s.active, "utf-8");
    let changed = false;
    inject(
      "writeSync",
      (original, fd, ...args) => {
        if (!changed && Buffer.isBuffer(args[0])) {
          changed = true;
          fs.writeFileSync(s.meta, '{"another_writer":true}');
          fs.writeFileSync(s.index, "another writer's index");
        }
        return original(fd, ...args);
      },
      () => assert.throws(() => compileIntoDraft(spec, options(s)), /sidecar changed/),
    );
    assert.equal(fs.readFileSync(s.meta, "utf-8"), '{"another_writer":true}');
    assert.equal(fs.readFileSync(s.index, "utf-8"), "another writer's index");
    assert.equal(fs.readFileSync(s.active, "utf-8"), beforeTimeline);
    assert.equal(fs.existsSync(join(s.dir, "assets")), false);
  });

  it("refuses a pointer changed while assets are staged, even with force-write", (t) => {
    const s = projectShell(t);
    const spec = mediaSpec(s);
    const before = fs.readFileSync(s.active, "utf-8");
    inject(
      "writeSync",
      (original, fd, ...args) => {
        if (Buffer.isBuffer(args[0])) fs.writeFileSync(s.pointer, '{"main_timeline_id":"archive-id"}');
        return original(fd, ...args);
      },
      () => {
        setForceWrite(true);
        try {
          assert.throws(() => compileIntoDraft(spec, options(s)), /active-timeline-changed/);
        } finally {
          setForceWrite(false);
        }
      },
    );
    assert.equal(fs.readFileSync(s.active, "utf-8"), before);
    assert.equal(fs.existsSync(join(s.dir, "assets")), false);
  });

  it("preserves edits made to an empty mirror during staging, even with force-write", (t) => {
    const s = projectShell(t);
    const spec = mediaSpec(s);
    const edited = JSON.stringify({ ...readJson(s.root), duration: 1_000_000 });
    inject(
      "writeSync",
      (original, fd, ...args) => {
        if (Buffer.isBuffer(args[0])) fs.writeFileSync(s.root, edited);
        return original(fd, ...args);
      },
      () => {
        setForceWrite(true);
        try {
          assert.throws(() => compileIntoDraft(spec, options(s)), /draft-changed-on-disk/);
        } finally {
          setForceWrite(false);
        }
      },
    );
    assert.equal(fs.readFileSync(s.root, "utf-8"), edited);
    assert.equal(readJson(s.active).tracks.length, 0);
    assert.equal(fs.existsSync(join(s.dir, "assets")), false);
  });

  it("reuses existing registered media without rewriting its sidecar", (t) => {
    const s = projectShell(t);
    const spec = mediaSpec(s);
    spec.tracks = [spec.tracks[1]];
    const asset = join(s.dir, "assets", "video", "clip.mp4");
    fs.mkdirSync(join(s.dir, "assets", "video"), { recursive: true });
    fs.copyFileSync(join(s.base, "clip.mp4"), asset);
    const meta = readJson(s.meta);
    meta.draft_materials.push({ type: 0, value: [{ id: "existing-import-id", file_Path: asset, opaque: true }] });
    fs.writeFileSync(s.meta, JSON.stringify(meta));
    const before = fs.readFileSync(s.meta, "utf-8");
    compileIntoDraft(spec, options(s));
    assert.equal(readJson(s.active).materials.videos[0].local_material_id, "existing-import-id");
    assert.equal(fs.readFileSync(s.meta, "utf-8"), before);
    assert.equal(fs.existsSync(`${s.meta}.bak`), false);
  });

  it("refuses an asset-directory symlink and preserves the external directory", (t) => {
    const s = projectShell(t);
    const spec = mediaSpec(s);
    const outside = join(s.base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, "keep.txt"), "outside bytes");
    fs.symlinkSync(outside, join(s.dir, "assets"), "junction");
    const before = snapshot(s.dir);
    assert.throws(() => compileIntoDraft(spec, options(s)), /symlink traversal/);
    assert.deepEqual(snapshot(s.dir), before);
    assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
  });

  it("commits registration once when the metadata sidecar also contains a timeline", (t) => {
    const s = projectShell(t, { nested: false });
    const spec = mediaSpec(s);
    const meta = { ...readJson(s.meta), timeline: JSON.stringify(shellDraft()) };
    fs.writeFileSync(s.meta, JSON.stringify(meta));
    compileIntoDraft(spec, { ...options(s), activeTimeline: false });
    const sidecar = readJson(s.meta);
    const embedded = JSON.parse(sidecar.timeline);
    assert.equal(embedded.duration, 3_000_000);
    assert.equal(sidecar.opaque.keep, 1);
    assert.ok(
      sidecar.draft_materials
        .flatMap((group) => group.value)
        .some((entry) => entry.id === embedded.materials.videos[0].local_material_id),
    );
    assert.equal(fs.readFileSync(`${s.meta}.bak`, "utf-8"), JSON.stringify(meta));
  });

  for (const flag of ["--out", "--drafts", "--template", "--data"]) {
    it(`rejects ${flag} with --into before any writes`, (t) => {
      const s = projectShell(t);
      const specPath = join(s.base, "spec.json");
      fs.writeFileSync(specPath, JSON.stringify(textSpec()));
      const before = snapshot(s.base);
      const result = spawnCli(["compile", specPath, "--into", s.dir, flag, "value"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /incompatible/);
      assert.deepEqual(snapshot(s.base), before);
    });
  }
});
