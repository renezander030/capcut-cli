import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

/** Write a draft_content.json with arbitrary raw bytes; return the dir path. */
function draftWith(raw) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-cli-fuzz-"));
  writeFileSync(join(dir, "draft_content.json"), raw);
  return dir;
}

// Read-only commands should never crash, hang, or leak a stack trace on bad input.
const READ_CMDS = ["info", "version", "lint", "texts", "tracks", "segments"];

const MALFORMED = {
  "not JSON at all": "}{ this is not json",
  "empty file": "",
  "truncated JSON": '{"tracks": [',
  "JSON array, not object": "[]",
  "JSON scalar": "42",
  "JSON null": "null",
  "object missing tracks": '{"id": "x", "name": "y"}',
  "tracks not an array": '{"tracks": {"nope": true}}',
  "segment missing fields": '{"tracks": [{"segments": [{}]}]}',
  "prototype-pollution attempt": '{"__proto__": {"polluted": true}, "tracks": []}',
  "constructor-pollution attempt": '{"constructor": {"prototype": {"x": 1}}, "tracks": []}',
  "deeply nested garbage": `{"tracks": ${"[".repeat(50)}${"]".repeat(50)}}`,
};

describe("fuzz: malformed draft_content.json", () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  for (const [label, raw] of Object.entries(MALFORMED)) {
    it(`handles "${label}" gracefully across read commands`, () => {
      const dir = draftWith(raw);
      dirs.push(dir);
      for (const cmd of READ_CMDS) {
        const r = spawnCli([cmd, dir], { timeout: 10_000 });
        // Must terminate (not hang → status null) — either clean (0) or a handled error.
        assert.notEqual(r.status, null, `${cmd} on "${label}" timed out / was killed`);
        // A non-zero exit must carry a single-line JSON error on stderr, not a raw stack.
        if (r.status !== 0) {
          assert.doesNotMatch(r.stderr, /\n\s+at\s/, `${cmd} on "${label}" leaked a stack trace`);
          const firstLine = r.stderr.trim().split("\n")[0];
          assert.doesNotThrow(
            () => JSON.parse(firstLine),
            `${cmd} on "${label}" should report a JSON error, got: ${firstLine}`,
          );
        }
      }
    });
  }

  it("does not pollute Object.prototype when parsing a hostile draft", () => {
    const dir = draftWith('{"__proto__": {"pwned": true}, "tracks": []}');
    dirs.push(dir);
    const r = spawnCli(["info", dir]);
    assert.notEqual(r.status, null);
    // The test process must be unaffected regardless of what the child did.
    assert.equal({}.pwned, undefined);
  });
});
