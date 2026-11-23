import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message}`);
  return result.stdout;
}

export const PORTABLE_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win-x64"];

/** The archive's target name: Node's platform and arch, with Windows named win as in Node's own downloads. */
export function portableTarget(platform = process.platform, arch = process.arch) {
  return `${platform === "win32" ? "win" : platform}-${arch}`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A deterministic zip of a directory (sorted names, fixed 1980-01-01 time, deflate); no tool needed on any host. */
export function writeZip(sourceDir, archivePath, prefix) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(sourceDir);
  const locals = [];
  const central = [];
  let offset = 0;
  for (const full of files) {
    const name = Buffer.from(`${prefix}/${relative(sourceDir, full).split(sep).join("/")}`, "utf8");
    const data = readFileSync(full);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push(header, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(archivePath, Buffer.concat([...locals, directory, end]));
}

// cmd.exe launchers: %~dp0 is the launcher's own folder, so the directory can move and may contain spaces
const CMD_LAUNCHER = ["@echo off", "setlocal", '"%~dp0runtime\\node.exe" "%~dp0app\\dist\\index.js" %*', "exit /b %ERRORLEVEL%", ""].join("\r\n");

// POSIX launchers resolve symlink chains to their own folder, so a link on PATH runs the bundled runtime
const SH_LAUNCHER = [
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

/** What differs per target once the runtime is checked: its file name, the launchers and the archive format. */
function portableLayout(windows, tar) {
  if (windows) {
    return {
      runtimeName: "node.exe",
      extension: "zip",
      writeLaunchers: (payload) => {
        for (const command of ["capcut", "capcut-cli"]) writeFileSync(join(payload, `${command}.cmd`), CMD_LAUNCHER);
      },
      writeArchive: (scratch, name, staged) => writeZip(join(scratch, name), staged, name),
    };
  }
  return {
    runtimeName: "node",
    extension: "tar.gz",
    writeLaunchers: (payload) => {
      chmodSync(join(payload, "runtime", "node"), 0o755);
      for (const command of ["capcut", "capcut-cli"]) writeFileSync(join(payload, command), SH_LAUNCHER, { mode: 0o755 });
    },
    writeArchive: (scratch, name, staged) =>
      run(tar, ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", staged, "-C", scratch, name]),
  };
}

/**
 * Package the npm payload and a self-contained Node runtime; never downloads or publishes.
 * The Windows archive (win-x64) is built natively on Windows; `target: "win-x64"` with `nodeVersion` also builds it
 * on another host from an official win-x64 Node distribution, for tests of its layout (it cannot be run there).
 */
export function buildPortable({ outDir, nodeRoot, root = sourceRoot, target = portableTarget(), nodeVersion }) {
  const windows = target.startsWith("win-");
  const host = portableTarget();
  if (!PORTABLE_TARGETS.includes(target)) throw new Error("Portable archives support Linux and macOS x64/arm64 and Windows x64 only");
  if (target !== host && !(windows && nodeVersion)) throw new Error(`Build the ${target} archive on ${target}`);
  nodeRoot = nodeRoot || (process.platform === "win32" ? dirname(process.execPath) : resolve(dirname(process.execPath), ".."));
  // Windows' own tar (bsdtar); Git's GNU tar earlier on a runner's PATH reads "C:\\..." as a remote host
  const tar = process.platform === "darwin" ? "gtar" : process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  if (!windows && !run(tar, ["--version"]).includes("GNU tar")) throw new Error("Building portable archives requires GNU tar (gnu-tar on macOS)");
  const node = windows ? join(nodeRoot, "node.exe") : join(nodeRoot, "bin", "node");
  const license = join(nodeRoot, "LICENSE");
  if (!existsSync(node) || !existsSync(license)) {
    throw new Error(windows ? "Use a complete official Node distribution with node.exe and LICENSE" : "Use a complete official Node distribution with bin/node and LICENSE");
  }
  let runtime;
  if (target === host) {
    runtime = JSON.parse(run(node, ["-p", "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})"]));
    if (portableTarget(runtime.platform, runtime.arch) !== target || Number(runtime.version.split(".")[0]) < 18) throw new Error(`The runtime must be Node18 or newer for ${target}`);
  } else {
    if (readFileSync(node).subarray(0, 2).toString("latin1") !== "MZ") throw new Error("node.exe is not a Windows executable");
    if (!/^\d+\.\d+\.\d+$/.test(nodeVersion) || Number(nodeVersion.split(".")[0]) < 18) throw new Error("--node-version must name Node 18 or newer");
    runtime = { version: nodeVersion, platform: "win32", arch: "x64" };
  }
  if (process.platform === "darwin") {
    const libraries = run("otool", ["-L", node]).trim().split("\n").slice(1).map((line) => line.trim().split(" (", 1)[0]);
    if (!libraries.length || libraries.some((library) => !library.startsWith("/usr/lib/") && !library.startsWith("/System/Library/"))) {
      throw new Error("The runtime links non-system libraries; use the self-contained official Node distribution");
    }
  } else if (process.platform === "linux" && !windows) {
    const linked = run("ldd", [node]);
    if (/libnode\b/i.test(linked)) throw new Error("The runtime depends on libnode; use the self-contained official Node distribution");
  }
  if (!existsSync(join(root, "dist", "index.js"))) throw new Error("Build the CLI before creating a portable archive");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("A normal package version is required");
  const name = `capcut-cli-v${version}-${target}`;
  const output = resolve(outDir);
  mkdirSync(output, { recursive: true });
  const layout = portableLayout(windows, tar);
  const archive = join(output, `${name}.${layout.extension}`);
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
      : run("npm", npmArgs, { cwd: root, shell: process.platform === "win32" });
    const filename = JSON.parse(packed)[0].filename;
    if (filename !== `capcut-cli-${version}.tgz`) throw new Error("Unexpected npm package identity");
    run(tar, ["-xzf", join(scratch, filename), "-C", app, "--strip-components=1"]);
    if (JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version !== version) throw new Error("Packed version differs from the source");
    copyFileSync(node, join(payload, "runtime", layout.runtimeName));
    copyFileSync(license, join(payload, "runtime", "LICENSE"));
    layout.writeLaunchers(payload);
    writeFileSync(join(payload, "PORTABLE.json"), `${JSON.stringify({ version, target, node: runtime.version }, null, 2)}\n`);
    const staged = join(scratch, `portable.${layout.extension}`);
    layout.writeArchive(scratch, name, staged);
    const sha256 = createHash("sha256").update(readFileSync(staged)).digest("hex");
    const sum = join(scratch, "portable.sha256");
    writeFileSync(sum, `${sha256}  ${name}.${layout.extension}\n`);
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
    const key = { "--out": "outDir", "--node-root": "nodeRoot", "--target": "target", "--node-version": "nodeVersion" }[values[i]];
    if (!key || !values[i + 1]) throw new Error("Usage: build-portable.mjs --out DIR [--node-root DIR] [--target win-x64 --node-version X.Y.Z]");
    options[key] = ["outDir", "nodeRoot"].includes(key) ? resolve(values[i + 1]) : values[i + 1];
  }
  if (!options.outDir) throw new Error("An --out directory is required");
  console.log(JSON.stringify(buildPortable(options)));
}
