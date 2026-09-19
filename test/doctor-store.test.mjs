import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// A scratch drafts ROOT nested under its own temp dir: store-level files
// (root_meta_info.json) must never land at tmpdir() itself, where every other
// test's scratch draft would suddenly look like it lives in a CapCut store.
function tmpStore() {
  const base = mkdtempSync(join(tmpdir(), "capcut-doctor-store-"));
  const store = join(base, "com.lveditor.draft");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "root_meta_info.json"), JSON.stringify({ all_draft_store: [] }));
  return { base, store, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// Not JSON, does not start with `{`: what JianYing 6.0+ writes.
const ENCRYPTED_PAYLOAD = Buffer.concat([Buffer.from([0x8f, 0x2a, 0x11]), Buffer.alloc(253, 0xa7)]);

function addEncryptedProject(store, name) {
  const project = join(store, name);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "draft_content.json"), ENCRYPTED_PAYLOAD);
  writeFileSync(join(project, "draft_info.json"), ENCRYPTED_PAYLOAD);
}

const storeChecks = (r) => r.json.checks.filter((c) => c.name === "draft-store");

describe("capcut doctor --drafts: draft-store check", () => {
  it("names an encrypted JianYing store up front and says what still works", () => {
    const t = tmpStore();
    try {
      addEncryptedProject(t.store, "app-made-1");
      addEncryptedProject(t.store, "app-made-2");
      const init = spawnCli(["init", "cli-made", "--drafts", t.store, "--template", "bundled"]);
      assert.equal(init.status, 0, `init stderr: ${init.stderr}`);

      const r = spawnCli(["doctor", "--drafts", t.store]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const dir = r.json.checks.find((c) => c.name === "draft-dir");
      assert.equal(dir.status, "ok");
      assert.match(dir.detail, /^drafts: found/);

      const checks = storeChecks(r);
      assert.equal(checks.length, 1, "one draft-store check for the one inspected folder");
      const [store] = checks;
      assert.equal(store.status, "warn");
      assert.match(store.detail, /2 of 3 project\(s\) are encrypted/);
      assert.match(store.detail, /1 readable, 0 markerless, 2 encrypted, 0 unreadable/);
      assert.match(store.fix, /init.*quickstart.*compile/);
      assert.match(store.fix, /docs\/jianying-encryption\.md/);
      assert.match(store.fix, /capcut decrypt <project>/);
    } finally {
      t.cleanup();
    }
  });

  it("reports an all-encrypted store as such", () => {
    const t = tmpStore();
    try {
      addEncryptedProject(t.store, "only-app-made");
      const [store] = storeChecks(spawnCli(["doctor", "--drafts", t.store]));
      assert.equal(store.status, "warn");
      assert.match(store.detail, /all 1 project\(s\) are encrypted/);
    } finally {
      t.cleanup();
    }
  });

  it("is ok on a plaintext store and on an empty one", () => {
    const t = tmpStore();
    try {
      let [store] = storeChecks(spawnCli(["doctor", "--drafts", t.store]));
      assert.equal(store.status, "ok");
      assert.match(store.detail, /no projects yet/);

      spawnCli(["init", "plain", "--drafts", t.store, "--template", "bundled"]);
      [store] = storeChecks(spawnCli(["doctor", "--drafts", t.store]));
      assert.equal(store.status, "ok");
      assert.match(store.detail, /1 project\(s\) — 1 readable, 0 markerless, 0 encrypted, 0 unreadable/);
      assert.equal(store.fix, undefined);
    } finally {
      t.cleanup();
    }
  });

  it("warns on a missing folder and skips the store scan", () => {
    const t = tmpStore();
    try {
      const r = spawnCli(["doctor", "--drafts", join(t.base, "nope")]);
      assert.equal(r.status, 0, "a missing drafts folder is a warning, not a hard failure");
      const dir = r.json.checks.find((c) => c.name === "draft-dir");
      assert.equal(dir.status, "warn");
      assert.match(dir.fix, /root_meta_info\.json/);
      assert.equal(storeChecks(r).length, 0);
    } finally {
      t.cleanup();
    }
  });

  it("renders the store check in the -H layout", () => {
    const t = tmpStore();
    try {
      addEncryptedProject(t.store, "app-made");
      const r = spawnCli(["doctor", "--drafts", t.store, "-H"]);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /\[!\] draft-store\s+drafts: all 1 project\(s\) are encrypted/);
      assert.match(r.stdout, /→ Existing encrypted projects cannot be edited here/);
    } finally {
      t.cleanup();
    }
  });
});
