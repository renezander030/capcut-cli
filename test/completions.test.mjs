import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

describe("capcut completions bash", () => {
  it("prints bash completion script", () => {
    const r = spawnCli(["completions", "bash"]);

    assert.equal(r.status, 0);
    assert.match(r.stdout, /complete -F _capcut capcut/);
    assert.match(r.stdout, /info/);
    assert.match(r.stdout, /tracks/);
    assert.match(r.stdout, /--jianying/);
    assert.match(r.stdout, /--quiet/);
    assert.match(r.stdout, /--version/);
    assert.match(r.stdout, /-H/);
    assert.match(r.stdout, /-q/);
    assert.match(r.stdout, /-v/);
  });
});
describe("capcut completions zsh", () => {
  it("prints zsh completion script", () => {
    const r = spawnCli(["completions", "zsh"]);

    assert.equal(r.status, 0);
    assert.match(r.stdout, /#compdef capcut/);
    assert.match(r.stdout, /info/);
    assert.match(r.stdout, /tracks/);
    assert.match(r.stdout, /--jianying/);
    assert.match(r.stdout, /--quiet/);
    assert.match(r.stdout, /--version/);
    assert.match(r.stdout, /-H/);
    assert.match(r.stdout, /-q/);
    assert.match(r.stdout, /-v/);
  });
});

describe("capcut completions fish", () => {
  it("prints fish completion script", () => {
    const r = spawnCli(["completions", "fish"]);

    assert.match(r.stdout, /info/);
    assert.match(r.stdout, /tracks/);
    assert.match(r.stdout, /--jianying/);
    assert.match(r.stdout, /--quiet/);
    assert.match(r.stdout, /--version/);
    assert.match(r.stdout, /-H/);
    assert.match(r.stdout, /-q/);
    assert.match(r.stdout, /-v/);
  });
});
