import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message}`);
  return result.stdout;
}

/** Package the npm payload and a self-contained Node runtime; never downloads or publishes. */
export function buildPortable({ outDir, nodeRoot = resolve(dirname(process.execPath), ".."), root = sourceRoot }) {
  const target = `${process.platform}-${process.arch}`;
  if (!["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(target)) throw new Error("Portable archives support Linux and macOS x64/arm64 only");
  const tar = process.platform === "darwin" ? "gtar" : "tar";
  if (!run(tar, ["--version"]).includes("GNU tar")) throw new Error("Building portable archives requires GNU tar (gnu-tar on macOS)");
  const node = join(nodeRoot, "bin", "node");
  const license = join(nodeRoot, "LICENSE");
  if (!existsSync(node) || !existsSync(license)) throw new Error("Use a complete official Node distribution with bin/node and LICENSE");
  const runtime = JSON.parse(run(node, ["-p", "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})"]));
  if (runtime.platform !== process.platform || runtime.arch !== process.arch || Number(runtime.version.split(".")[0]) < 18) throw new Error(`The runtime must be Node18 or newer for ${target}`);
  if (process.platform === "darwin") {
    const libraries = run("otool", ["-L", node]).trim().split("\n").slice(1).map((line) => line.trim().split(" (", 1)[0]);
    if (!libraries.length || libraries.some((library) => !library.startsWith("/usr/lib/") && !library.startsWith("/System/Library/"))) {
      throw new Error("The runtime links non-system libraries; use the self-contained official Node distribution");
    }
  } else {
    const linked = run("ldd", [node]);
    if (/libnode\b/i.test(linked)) throw new Error("The runtime depends on libnode; use the self-contained official Node distribution");
  }
  if (!existsSync(join(root, "dist", "index.js"))) throw new Error("Build the CLI before creating a portable archive");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("A normal package version is required");
  const name = `capcut-cli-v${version}-${target}`;
  const output = resolve(outDir);
  mkdirSync(output, { recursive: true });
  const archive = join(output, `${name}.tar.gz`);
  const checksum = `${archive}.sha256`;
  if (existsSync(archive) || existsSync(checksum)) throw new Error("Portable output already exists; choose an empty output directory");
  const scratch = mkdtempSync(join(tmpdir(), "capcut-portable-"));
  try {
    const payload = join(scratch, name);
    const app = join(payload, "app");
    mkdirSync(app, { recursive: true });
    mkdirSync(join(payload, "runtime"));
    const npmArgs = ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch];
    const packed = process.env.npm_execpath
      ? run(process.execPath, [process.env.npm_execpath, ...npmArgs], { cwd: root })
      : run("npm", npmArgs, { cwd: root });
    const filename = JSON.parse(packed)[0].filename;
    if (filename !== `capcut-cli-${version}.tgz`) throw new Error("Unexpected npm package identity");
    run(tar, ["-xzf", join(scratch, filename), "-C", app, "--strip-components=1"]);
    if (JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version !== version) throw new Error("Packed version differs from the source");
    copyFileSync(node, join(payload, "runtime", "node"));
    chmodSync(join(payload, "runtime", "node"), 0o755);
    copyFileSync(license, join(payload, "runtime", "LICENSE"));
    const launcher = [
      "#!/bin/sh",
      'script=$0',
      'case "$script" in */*) ;; *) script=$(command -v "$script") || exit 1 ;; esac',
      'while [ -L "$script" ]; do',
      '  base=$(CDPATH= cd -P -- "${script%/*}" && pwd) || exit 1',
      '  target=$(/usr/bin/readlink "$script") || exit 1',
      '  case "$target" in /*) script=$target ;; *) script=$base/$target ;; esac',
      'done',
      'base=$(CDPATH= cd -P -- "${script%/*}" && pwd) || exit 1',
      'exec "$base/runtime/node" "$base/app/dist/index.js" "$@"',
      "",
    ].join("\n");
    for (const command of ["capcut", "capcut-cli"]) {
      writeFileSync(join(payload, command), launcher, { mode: 0o755 });
    }
    writeFileSync(join(payload, "PORTABLE.json"), `${JSON.stringify({ version, target, node: runtime.version }, null, 2)}\n`);
    const staged = join(scratch, "portable.tar.gz");
    run(tar, ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", staged, "-C", scratch, name]);
    const sha256 = createHash("sha256").update(readFileSync(staged)).digest("hex");
    const sum = join(scratch, "portable.sha256");
    writeFileSync(sum, `${sha256}  ${name}.tar.gz\n`);
    copyFileSync(staged, archive, constants.COPYFILE_EXCL);
    copyFileSync(sum, checksum, constants.COPYFILE_EXCL);
    return { archive, checksum, sha256, version, runtime: runtime.version, target };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < values.length; i += 2) {
    if (!["--out", "--node-root"].includes(values[i]) || !values[i + 1]) throw new Error("Usage: build-portable.mjs --out DIR [--node-root DIR]");
    options[values[i] === "--out" ? "outDir" : "nodeRoot"] = resolve(values[i + 1]);
  }
  if (!options.outDir) throw new Error("An --out directory is required");
  console.log(JSON.stringify(buildPortable(options)));
}
