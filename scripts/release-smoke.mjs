import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [tarballArg, sourceArg = "."] = process.argv.slice(2);
if (!tarballArg) throw new Error("Usage: npm run smoke:package -- <tarball.tgz> [source-root]");
const tarball = resolve(tarballArg);
const sourceRoot = resolve(sourceArg);
const expectedVersion = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).version;
const root = mkdtempSync(join(tmpdir(), "capcut-package-smoke-"));
const load = (path) => JSON.parse(readFileSync(path, "utf8"));
try {
  const npmArgs = ["install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", "--offline", tarball];
  const installed = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...npmArgs], { encoding: "utf8" })
    : spawnSync("npm", npmArgs, { encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  const packageRoot = join(root, "node_modules", "capcut-cli");
  const binary = join(packageRoot, "dist", "index.js");
  const invoke = (args, status = 0) => {
    const r = spawnSync(process.execPath, [binary, ...args], { encoding: "utf8" });
    assert.equal(r.status, status, `${args[0]}: ${r.stderr}\n${r.stdout}`);
    return { ...r, json: args[0] === "--version" || !r.stdout.trim() ? undefined : JSON.parse(r.stdout) };
  };
  assert.equal(invoke(["--version"]).stdout.trim(), expectedVersion);
  assert.equal(load(join(packageRoot, "package.json")).version, expectedVersion);
  const lib = await import(pathToFileURL(join(packageRoot, "dist", "lib.js")));
  assert.equal(typeof lib.loadDraft, "function");
  assert.ok(existsSync(join(packageRoot, "docs", "command-reference.json")));
  const contract = load(join(packageRoot, "docs", "command-reference.json"));
  const compact = invoke(["describe", "--compact"]);
  assert.equal(compact.json.detail, "compact");
  assert.ok(Buffer.byteLength(compact.stdout) < 64 * 1024);
  assert.deepEqual(compact.json.commands.map((command) => command.name), contract.commands.map((command) => command.name));
  const selected = invoke(["describe", "--command", "compile"]);
  assert.deepEqual(selected.json.commands, contract.commands.filter((command) => command.name === "compile"));

  const beat = (60 / 136) * 4;
  const beatsSpec = join(root, "beats.json");
  writeFileSync(
    beatsSpec,
    JSON.stringify({
      name: "Beats",
      tracks: [
        {
          type: "text",
          items: Array.from({ length: 8 }, (_, i) => ({
            start: i * beat,
            duration: beat,
            text: "beat",
            ref: `beat-${i}`,
          })),
        },
      ],
    }),
  );
  const beatsOut = join(root, "beats");
  invoke(["compile", beatsSpec, "--out", beatsOut, "--template", "bundled"]);
  const beatSegments = load(join(beatsOut, "draft_content.json")).tracks[0].segments;
  for (let i = 1; i < beatSegments.length; i++)
    assert.equal(
      beatSegments[i - 1].target_timerange.start + beatSegments[i - 1].target_timerange.duration,
      beatSegments[i].target_timerange.start,
    );
  const invalidSpec = load(beatsSpec);
  invalidSpec.operations = [{ op: "keyframe", target: "beat-0", property: "not-real", time: 0, value: 1 }];
  writeFileSync(beatsSpec, JSON.stringify(invalidSpec));
  invoke(["compile", beatsSpec, "--check"], 1);
  invoke(["compile", beatsSpec, "--out", join(root, "bad-operation")], 1);
  assert.equal(existsSync(join(root, "bad-operation")), false);

  const wav = Buffer.alloc(44 + 89_280, 128);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + 89_280, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(1000, 24);
  wav.writeUInt32LE(1000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(89_280, 40);
  writeFileSync(join(root, "clip.wav"), wav);
  const specPath = join(root, "spec.json");
  const items = [20, 40].map((sourceStart, i) => ({ path: "clip.wav", sourceStart, start: i * 6, duration: 6 }));
  writeFileSync(specPath, JSON.stringify({ name: "Smoke", ratio: "9:16", tracks: [{ type: "video", items }] }));
  assert.equal(invoke(["compile", specPath, "--check"]).json.canvas.ratio, "9:16");
  const out = join(root, "compiled");
  invoke(["compile", specPath, "--out", out]);
  const draft = load(join(out, "draft_content.json"));
  assert.deepEqual(draft.canvas_config, { width: 1080, height: 1920, ratio: "9:16" });
  for (const material of draft.materials.videos) assert.equal(material.duration, 89_280_000);
  assert.deepEqual(
    draft.tracks[0].segments.map((s) => s.source_timerange),
    [
      { start: 20_000_000, duration: 6_000_000 },
      { start: 40_000_000, duration: 6_000_000 },
    ],
  );
  for (const material of load(join(out, "draft_meta_info.json")).draft_materials.flatMap((group) => group.value)) {
    assert.equal(material.duration, 89_280_000);
  }
  items[0].sourceStart = 80;
  items[0].speed = 2;
  writeFileSync(specPath, JSON.stringify({ name: "Invalid", tracks: [{ type: "video", items }] }));
  const invalidOut = join(root, "invalid");
  invoke(["compile", specPath, "--out", invalidOut], 1);
  assert.equal(existsSync(invalidOut), false);

  const replacementDir = join(root, "new-media");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(replacementDir);
  const newClip = join(replacementDir, "clip.wav");
  const newBytes = Buffer.from(wav);
  newBytes[1000] = 12;
  writeFileSync(newClip, newBytes);
  const segmentId = draft.tracks[0].segments[0].id;
  const replace = invoke(["replace-media", out, segmentId, newClip]).json;
  assert.deepEqual(readFileSync(replace.new_path), newBytes);
  assert.notEqual(replace.new_path, draft.materials.videos[0].path);
  const replacedDraft = load(join(out, "draft_content.json"));
  const replacedMaterial = replacedDraft.materials.videos.find((m) => m.id === replace.material_id);
  const imported = load(join(out, "draft_meta_info.json"))
    .draft_materials.flatMap((g) => g.value)
    .find((e) => e.file_Path === replace.new_path);
  assert.equal(replacedMaterial.local_material_id, imported.id);

  const jobs = [
    { id: "same", cmd: "info", project: out },
    { id: "same", cmd: "info", project: out },
    { id: "same", cmd: "tracks", project: out },
  ];
  const queue = join(root, "jobs.jsonl");
  writeFileSync(queue, jobs.map((job) => JSON.stringify(job)).join("\n"));
  const queueResult = spawnSync(process.execPath, [binary, "serve", "--queue", queue, "--workers", "3"], {
    encoding: "utf8",
  });
  assert.equal(queueResult.status, 0, queueResult.stderr);
  const results = queueResult.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(results.filter((r) => r.deduplicated).length, 1);
  assert.match(results.find((r) => !r.ok).stderr, /different command payload/);

  const privatePath = "C:\\Users\\Smoke Account\\AppData\\Local\\CapCut";
  const metaPath = join(out, "draft_meta_info.json");
  const meta = load(metaPath);
  meta.draft_root_path = privatePath;
  writeFileSync(metaPath, JSON.stringify(meta));
  draft.embedded = JSON.stringify({ path: privatePath });
  writeFileSync(join(out, "draft_content.json"), JSON.stringify(draft));
  const bundle = join(root, "bundle");
  assert.equal(invoke(["fixture", out, "--out", bundle]).json.redaction_check.ok, true);
  for (const name of ["draft_content.json", "draft_meta_info.json", "SANITIZE_REPORT.json"]) {
    assert.doesNotMatch(readFileSync(join(bundle, name), "utf8"), /Smoke Account/);
  }
  assert.equal(
    JSON.parse(load(join(bundle, "draft_content.json")).embedded).path,
    "C:\\Users\\USER\\AppData\\Local\\CapCut",
  );
  invoke(["fixture", bundle, "--check"]);
  writeFileSync(join(bundle, "leak.json"), JSON.stringify({ path: privatePath }));
  const leak = invoke(["fixture", bundle, "--check"], 1);
  assert.equal(leak.json.ok, false);
  assert.doesNotMatch(leak.stderr, /Smoke Account/);

  const project = join(root, "active");
  cpSync(join(sourceRoot, "test", "fixtures", "capcut-8.7-windows-active"), project, { recursive: true });
  const pointerPath = join(project, "Timelines", "project.json");
  const pointerBefore = readFileSync(pointerPath, "utf8");
  const pointer = JSON.parse(pointerBefore);
  const activePath = join(project, "Timelines", pointer.main_timeline_id || pointer.id, "draft_content.json");
  const activeBefore = load(activePath);
  const segment = activeBefore.tracks.find((track) => track.type === "text").segments[0];
  const documentPaths = [activePath, join(project, "draft_content.json"), join(project, "template-2.tmp")];
  const ids = documentPaths.map((path) => load(path).id);
  invoke(["set-text", project, segment.id, "PACKAGE RELEASE SMOKE"]);
  for (const [i, path] of documentPaths.entries()) {
    const document = load(path);
    assert.equal(document.id, ids[i]);
    assert.match(JSON.stringify(document), /PACKAGE RELEASE SMOKE/);
  }
  assert.equal(readFileSync(pointerPath, "utf8"), pointerBefore);
  invoke(["texts", project]);
  invoke(["restore", project]);
  assert.deepEqual(load(activePath), activeBefore);
  console.log(
    "PASS: fresh tarball install, CLI/library/version, compile/canvas/source duration/preflight, fractional timing, operation preflight, same-name replacement/media registration, queue payload dedup, escaped-path redaction/leak rejection, active-timeline writes/IDs/pointer/restore.",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
