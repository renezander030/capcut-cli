import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { pickRestoreSource, readRecoveryHistory } from "../dist/history-integrity.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function editedDraft(t) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const seg = JSON.parse(readFileSync(fix.path, "utf-8")).tracks.find((tr) => tr.type === "text").segments[0].id;
  assert.equal(spawnCli(["set-text", fix.path, seg, "edited"]).status, 0);
  return fix;
}
const pick = (fix, opts = {}) => pickRestoreSource(readRecoveryHistory(fix.path), fix.path, "proj", opts);

describe("pickRestoreSource — which recovery file restore copies back", () => {
  it("defaults to the .bak and reports it intact", (t) => {
    const fix = editedDraft(t);
    assert.deepEqual(pick(fix), { path: `${fix.path}.bak`, integrity: "intact" });
  });

  it("picks history step N and echoes the step", (t) => {
    const fix = editedDraft(t);
    const picked = pick(fix, { step: 1 });
    assert.equal(picked.step, 1);
    assert.equal(picked.integrity, "intact");
    assert.match(picked.path, /\.capcut-cli-history/);
  });

  it("refuses a .bak the app rewrote, pointing at the intact step 1; --force-write takes it as it is", (t) => {
    const fix = editedDraft(t);
    writeFileSync(`${fix.path}.bak`, readFileSync(fix.path, "utf-8"));
    assert.throws(() => pick(fix), /^Error: refused \[backup-changed\]: .* capcut restore proj --step 1\./);
    assert.deepEqual(pick(fix, { forceWrite: true }), { path: `${fix.path}.bak`, integrity: "changed" });
  });

  it("refuses a step that is not a positive integer or not in the history", (t) => {
    const fix = editedDraft(t);
    assert.throws(() => pick(fix, { step: 0 }), { message: "--step must be a positive integer (1 = most recent)." });
    assert.throws(() => pick(fix, { step: 3 }), {
      message: "No snapshot at --step 3. Available: 1..1. Try: capcut restore proj --list",
    });
  });

  it("refuses when there is nothing to restore", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    assert.throws(() => pick(fix), {
      message: `No backup found at ${fix.path}.bak. Nothing to restore (a .bak is written on the first edit).`,
    });
  });
});
