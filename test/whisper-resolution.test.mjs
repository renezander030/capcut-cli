import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectEngine, whisperCommand } from "../dist/caption.js";
import { resolveWhisperCommand, WHISPER_COMMANDS } from "../dist/whisper.js";

/**
 * `doctor` has always probed openai-whisper (`whisper`), whisper.cpp
 * (`whisper-cli`) and `faster-whisper`; `caption` only ever spawned `whisper`
 * and defaulted its dialect to openai. On a host that installs whisper.cpp —
 * a `whisper-cli` binary and no `whisper` — doctor reported the check as ok
 * and the first `caption` run died with ENOENT, hinting at the wrong dialect.
 *
 * The resolver is exercised through an injected PATH probe so the assertions
 * do not depend on what the test host happens to have installed.
 */
describe("whisper command resolution", () => {
  it("prefers the dialects in WHISPER_COMMANDS order", () => {
    const r = resolveWhisperCommand((cmd) => `/${cmd}`);
    assert.equal(r, `/${WHISPER_COMMANDS[0]}`);
  });

  it("finds a whisper.cpp install that ships only whisper-cli", () => {
    const r = resolveWhisperCommand((cmd) => (cmd === "whisper-cli" ? "/usr/local/bin/whisper-cli" : null));
    assert.equal(r, "/usr/local/bin/whisper-cli");
  });

  it("falls back to faster-whisper", () => {
    const r = resolveWhisperCommand((cmd) => (cmd === "faster-whisper" ? "/opt/fw/faster-whisper" : null));
    assert.equal(r, "/opt/fw/faster-whisper");
  });

  it("returns null when nothing is installed", () => {
    assert.equal(
      resolveWhisperCommand(() => null),
      null,
    );
  });
});

describe("caption dialect detection follows the resolved binary", () => {
  it("an explicit --whisper-cmd still wins", () => {
    assert.equal(detectEngine({ whisperCmd: "/opt/openai/whisper" }), "openai");
  });

  it("a whisper.cpp path selects the whisper-cpp invocation", () => {
    assert.equal(detectEngine({ whisperCmd: "/usr/local/bin/whisper-cli" }), "whisper-cpp");
  });

  it("an explicit --whisper-engine still wins", () => {
    assert.equal(detectEngine({ whisperCmd: "/usr/local/bin/whisper-cli", whisperEngine: "openai" }), "openai");
  });

  it("whisperCommand() returns the caller's command unchanged", () => {
    assert.equal(whisperCommand({ whisperCmd: "/custom/whisper" }), "/custom/whisper");
  });

  it("whisperCommand() always resolves to something runnable", () => {
    // Host-dependent which binary is found, but never an empty string.
    assert.ok(whisperCommand({}).length > 0);
  });
});
