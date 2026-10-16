import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const contracts = spawnCli(["describe"]).json.commands;

describe("per-command help", () => {
  it("every registered command answers --help with its own usage and options", () => {
    for (const command of contracts) {
      const r = spawnCli([command.name, "--help"]);
      assert.equal(r.status, 0, `${command.name} --help exited ${r.status}: ${r.stderr}`);
      assert.ok(r.stdout.startsWith(`Usage: ${command.usage}\n`), `${command.name} --help prints its usage line`);
      for (const option of command.options) {
        assert.ok(r.stdout.includes(option.flags[0]), `${command.name} --help lists ${option.flags[0]}`);
      }
      assert.ok(r.stdout.includes(`capcut describe --command ${command.name}`));
    }
  });

  it("accepts -h, `help <command>` and global flags before the command", () => {
    const expected = spawnCli(["restore", "--help"]).stdout;
    assert.equal(spawnCli(["restore", "-h"]).stdout, expected);
    assert.equal(spawnCli(["help", "restore"]).stdout, expected);
    assert.equal(spawnCli(["-H", "restore", "--help"]).stdout, expected);
  });

  it("does not run the command", () => {
    const r = spawnCli(["doctor", "--help"]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.startsWith("Usage: capcut doctor"), "doctor --help prints help instead of running the checks");
  });

  it("falls back to the full help for `help` alone or an unknown command", () => {
    const full = spawnCli(["--help"]).stdout;
    assert.match(full, /Generated command index:/);
    assert.equal(spawnCli(["help"]).stdout, full);
    assert.equal(spawnCli(["help", "no-such-command"]).stdout, full);
  });
});
