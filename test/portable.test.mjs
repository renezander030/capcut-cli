import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildPortable } from "../scripts/build-portable.mjs";

const runtimeRoot = process.env.CAPCUT_PORTABLE_NODE_ROOT || resolve(dirname(process.execPath), "..");
describe("Linux x64 portable distribution", {
  skip:
    process.platform !== "linux" || process.arch !== "x64" || !existsSync(join(runtimeRoot, "LICENSE"))
      ? "Requires Linux x64 and a complete official Node distribution (CAPCUT_PORTABLE_NODE_ROOT)"
      : false,
}, () => {
  let root;
  let receipt;
  let extracted;
  const nodeRoot = process.env.CAPCUT_PORTABLE_NODE_ROOT;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "portable-test-"));
    receipt = buildPortable({ outDir: join(root, "archives"), ...(nodeRoot ? { nodeRoot } : {}) });
    const result = spawnSync("tar", ["-xzf", receipt.archive, "-C", root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    extracted = join(root, `capcut-cli-v${receipt.version}-linux-x64`);
  });
  after(() => rmSync(root, { recursive: true, force: true }));
  function invoke(command, args) {
    const result = spawnSync(join(extracted, command), args, {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        NODE_OPTIONS: "",
        XDG_CONFIG_HOME: join(root, "config"),
        CAPCUT_CLI_APP_VERSIONS: join(root, "config", "versions.json"),
      },
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return result.stdout;
  }
  it("runs both CLI names without Node or npm on PATH", () => {
    for (const command of ["capcut", "capcut-cli"])
      assert.equal(invoke(command, ["--version"]).trim(), receipt.version);
  });
  it("retains packaged command metadata and templates for real draft compilation", () => {
    const description = JSON.parse(invoke("capcut", ["describe", "--command", "compile"]));
    assert.equal(description.commands[0].name, "compile");
    const spec = join(root, "example.json");
    writeFileSync(
      spec,
      JSON.stringify({
        name: "Example",
        tracks: [{ type: "text", items: [{ text: "Portable example", start: 0, duration: 2 }] }],
      }),
    );
    const draft = join(root, "draft");
    invoke("capcut", ["compile", spec, "--out", draft, "--template", "bundled"]);
    assert.match(readFileSync(join(draft, "draft_content.json"), "utf8"), /Portable example/);
  });
  it("remains relocatable when the directory contains spaces", () => {
    const moved = join(root, "relocated package");
    renameSync(extracted, moved);
    extracted = moved;
    assert.equal(invoke("capcut", ["--version"]).trim(), receipt.version);
  });
  it("includes the runtime license and a checksum matching the actual archive", () => {
    assert.ok(readFileSync(join(extracted, "runtime", "LICENSE"), "utf8").includes("Copyright"));
    assert.equal(createHash("sha256").update(readFileSync(receipt.archive)).digest("hex"), receipt.sha256);
    assert.match(readFileSync(receipt.checksum, "utf8"), new RegExp(`^${receipt.sha256}  capcut-cli-`));
    assert.equal(JSON.parse(readFileSync(join(extracted, "PORTABLE.json"), "utf8")).version, receipt.version);
  });
  it("refuses to overwrite a previous distribution", () => {
    const before = readFileSync(receipt.archive);
    assert.throws(
      () => buildPortable({ outDir: join(root, "archives"), ...(nodeRoot ? { nodeRoot } : {}) }),
      /already exists/,
    );
    assert.deepEqual(readFileSync(receipt.archive), before);
  });
  it("rejects an incomplete runtime before producing an archive", () => {
    const missing = join(root, "incomplete");
    mkdirSync(missing);
    assert.throws(() => buildPortable({ outDir: join(root, "bad"), nodeRoot: missing }), /complete official Node/);
    assert.equal(existsSync(join(root, "bad")), false);
  });
});
