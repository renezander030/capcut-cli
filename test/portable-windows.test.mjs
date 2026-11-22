import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { inflateRawSync } from "node:zlib";
import { buildPortable } from "../scripts/build-portable.mjs";

// The win-x64 archive's layout, launchers and checksum, built on any host from a Windows Node layout. Running it needs
// Windows: release.yml builds and runs it natively on a Windows runner (test/portable.test.mjs) before publishing.

/** Every file of a zip: name -> contents, read from its central directory (stored or deflate). */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "zip end record");
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50);
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30);
    const comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : data);
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

// On Windows itself the archive is built from the real runtime and run by test/portable.test.mjs instead.
describe("Windows portable archive (win-x64)", {
  skip: process.platform === "win32" && "covered natively by test/portable.test.mjs",
}, () => {
  let root;
  let receipt;
  let files;
  let windowsNode;
  const nodeVersion = "22.12.0";
  before(() => {
    root = mkdtempSync(join(tmpdir(), "portable-win-test-"));
    // the official node-v*-win-x64 layout: node.exe and LICENSE side by side
    windowsNode = join(root, "node-win-x64");
    mkdirSync(windowsNode);
    writeFileSync(join(windowsNode, "node.exe"), Buffer.concat([Buffer.from("MZ"), Buffer.alloc(1024, 7)]));
    writeFileSync(
      join(windowsNode, "LICENSE"),
      "Node.js is licensed for use as follows: Copyright Node.js contributors.",
    );
    receipt = buildPortable({ outDir: join(root, "out"), nodeRoot: windowsNode, target: "win-x64", nodeVersion });
    files = readZip(readFileSync(receipt.archive));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("is a zip named for win-x64 with a sha256 file that matches it", () => {
    const name = `capcut-cli-v${receipt.version}-win-x64`;
    assert.equal(receipt.archive, join(root, "out", `${name}.zip`));
    assert.equal(receipt.checksum, `${receipt.archive}.sha256`);
    assert.equal(createHash("sha256").update(readFileSync(receipt.archive)).digest("hex"), receipt.sha256);
    assert.equal(readFileSync(receipt.checksum, "utf8"), `${receipt.sha256}  ${name}.zip\n`);
  });

  it("holds the Node runtime with its license, the packed CLI and both cmd launchers under one folder", () => {
    const name = `capcut-cli-v${receipt.version}-win-x64`;
    const expected = [
      "capcut.cmd",
      "capcut-cli.cmd",
      "PORTABLE.json",
      "runtime/node.exe",
      "runtime/LICENSE",
      "app/package.json",
      "app/dist/index.js",
    ];
    for (const path of expected) assert.ok(files.has(`${name}/${path}`), path);
    assert.ok([...files.keys()].every((path) => path.startsWith(`${name}/`)));
    assert.deepEqual(files.get(`${name}/runtime/node.exe`), readFileSync(join(windowsNode, "node.exe")));
    assert.match(files.get(`${name}/runtime/LICENSE`).toString("utf8"), /Copyright/);
    assert.deepEqual(JSON.parse(files.get(`${name}/PORTABLE.json`).toString("utf8")), {
      version: receipt.version,
      target: "win-x64",
      node: nodeVersion,
    });
    assert.equal(receipt.target, "win-x64");
  });

  it("launches the bundled node.exe from the launcher's own folder, with CRLF line ends", () => {
    const name = `capcut-cli-v${receipt.version}-win-x64`;
    for (const command of ["capcut.cmd", "capcut-cli.cmd"]) {
      const text = files.get(`${name}/${command}`).toString("utf8");
      assert.equal(
        text,
        '@echo off\r\nsetlocal\r\n"%~dp0runtime\\node.exe" "%~dp0app\\dist\\index.js" %*\r\nexit /b %ERRORLEVEL%\r\n',
      );
    }
    assert.ok(!files.has(`${name}/capcut`), "no sh launcher in the Windows archive");
  });

  it("is byte-for-byte the same when built again", () => {
    const again = buildPortable({ outDir: join(root, "again"), nodeRoot: windowsNode, target: "win-x64", nodeVersion });
    assert.equal(again.sha256, receipt.sha256);
  });

  it("opens with a standard zip reader", {
    skip: spawnSync("python3", ["--version"]).status !== 0 && "python3 absent",
  }, () => {
    const listed = spawnSync(
      "python3",
      [
        "-c",
        "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(len(z.namelist()))",
        receipt.archive,
      ],
      { encoding: "utf8" },
    );
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(Number(listed.stdout.trim()), files.size);
  });

  it("refuses a runtime that is not a Windows executable, and a missing Node version", () => {
    const fake = join(root, "not-windows");
    mkdirSync(fake);
    writeFileSync(join(fake, "node.exe"), "#!/bin/sh\n");
    writeFileSync(join(fake, "LICENSE"), "x");
    assert.throws(
      () => buildPortable({ outDir: join(root, "bad1"), nodeRoot: fake, target: "win-x64", nodeVersion }),
      /not a Windows executable/,
    );
    assert.throws(
      () => buildPortable({ outDir: join(root, "bad2"), nodeRoot: windowsNode, target: "win-x64" }),
      /Build the win-x64 archive on win-x64/,
    );
    assert.equal(existsSync(join(root, "bad1")), false);
  });

  it("builds other targets only on their own platform", () => {
    const other = process.platform === "darwin" ? "linux-x64" : "darwin-arm64";
    assert.throws(
      () => buildPortable({ outDir: join(root, "bad3"), target: other }),
      new RegExp(`Build the ${other} archive on ${other}`),
    );
  });
});
