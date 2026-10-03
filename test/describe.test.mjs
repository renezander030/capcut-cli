import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { extractText } from "../dist/draft.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// `describe` emits a machine-readable tool spec for agent callers.
describe("describe", () => {
  it("offers a compact discovery index below 64 KiB without losing command names", () => {
    const full = spawnCli(["describe"]);
    const compact = spawnCli(["describe", "--compact"]);
    assert.equal(compact.status, 0, compact.stderr);
    assert.equal(compact.json.detail, "compact");
    assert.equal(full.json.detail, undefined);
    assert.deepEqual(
      compact.json.commands.map((command) => command.name),
      full.json.commands.map((command) => command.name),
    );
    assert.ok(Buffer.byteLength(compact.stdout) < 64 * 1024);
    assert.ok(Buffer.byteLength(compact.stdout) < Buffer.byteLength(full.stdout) / 2);
    assert.deepEqual(compact.json.global_flags, full.json.global_flags);
    for (const command of compact.json.commands) {
      assert.ok(command.summary && command.usage);
      assert.equal(typeof command.mutates, "boolean");
      assert.equal(command.options, undefined);
    }
  });

  it("filters complete contracts, deduplicates repeated selections, and supports compact filters", () => {
    const full = spawnCli(["describe"]);
    const selected = spawnCli(["describe", "--command", "compile", "--command", "relink", "--command", "compile"]);
    assert.equal(selected.status, 0, selected.stderr);
    assert.deepEqual(
      selected.json.commands,
      full.json.commands.filter((command) => ["compile", "relink"].includes(command.name)),
    );
    const compact = spawnCli(["describe", "--compact", "--command", "compile"]);
    assert.equal(compact.status, 0, compact.stderr);
    assert.deepEqual(
      compact.json.commands.map((command) => command.name),
      ["compile"],
    );
    assert.equal(compact.json.commands[0].options, undefined);
  });

  it("refuses unknown, missing, and empty command selections", () => {
    for (const args of [["--command", "not-a-command"], ["--command"], ["--command", ""], ["--command", "--compact"]]) {
      const result = spawnCli(["describe", ...args]);
      assert.notEqual(result.status, 0);
      assert.match(JSON.parse(result.stderr).error, /command/i);
    }
  });

  it("preserves discovery flags as free text on unrelated commands", () => {
    const fix = tmpDraft();
    try {
      const result = spawnCli(["add-text", fix.path, "0s", "1s", "--compact", "--command", "compile"]);
      assert.equal(result.status, 0, result.stderr);
      const draft = JSON.parse(readFileSync(fix.path, "utf8"));
      assert.ok(
        draft.materials.texts.some((material) => extractText(material.content) === "--compact --command compile"),
      );
    } finally {
      fix.cleanup();
    }
  });

  it("emits valid JSON with name, version, global_flags, and commands", () => {
    const r = spawnCli(["describe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json, "stdout should be valid JSON");
    assert.equal(r.json.name, "capcut-cli");
    assert.match(r.json.version, /^\d+\.\d+\.\d+/);
    assert.ok(Array.isArray(r.json.global_flags) && r.json.global_flags.length > 0);
    assert.ok(Array.isArray(r.json.commands) && r.json.commands.length > 0);
  });

  it("describes every command with a non-empty summary (no undescribed commands)", () => {
    const r = spawnCli(["describe"]);
    const undescribed = r.json.commands.filter((c) => !c.name || !c.summary || c.summary.length === 0);
    assert.deepEqual(undescribed, [], `commands missing a summary: ${undescribed.map((c) => c.name).join(", ")}`);
  });

  it("provides a complete machine-callable contract for every command", () => {
    const r = spawnCli(["describe"]);
    assert.equal(r.json.schema_version, 2);
    for (const command of r.json.commands) {
      assert.match(command.usage, new RegExp(`^capcut ${command.name}(?: |$)`));
      assert.ok(Array.isArray(command.positionals), `${command.name}: positionals`);
      assert.ok(Array.isArray(command.options), `${command.name}: options`);
      assert.equal(typeof command.mutates, "boolean", `${command.name}: mutates`);
      assert.ok(command.output?.type, `${command.name}: output`);
      assert.ok(command.exit_codes?.["0"], `${command.name}: exit codes`);
      for (const option of command.options) {
        assert.ok(Array.isArray(option.flags) && option.flags.length > 0, `${command.name}: option flags`);
        assert.ok(option.type, `${command.name}: option type`);
      }
    }
  });

  it("includes the new commands", () => {
    const r = spawnCli(["describe"]);
    const names = r.json.commands.map((c) => c.name);
    for (const expected of [
      "prune",
      "relink",
      "timeline",
      "projects",
      "describe",
      "restore",
      "diagnose",
      "templates",
    ]) {
      assert.ok(names.includes(expected), `expected command "${expected}" in describe output`);
    }
  });
});
