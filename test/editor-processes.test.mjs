import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchEditorProcesses } from "../dist/store.js";

// #99: the editor-open guard must compare process names, not search the joined
// listing — npm's rewritten process title contains `capcut-cli`, so a substring
// test detects the CLI's own npm parent and refuses every write under npx.
describe("editorProcesses matching", () => {
  it("ignores npm's rewritten process title under npx / npm exec (#99)", () => {
    const listing = [
      "npm exec capcut-cli@0.21.0 sync-timelines /Users/me/Movies/CapCut/User Data/Projects/com.lveditor.draft/proj --nested --apply",
      "node",
      "/usr/lib/systemd/systemd",
    ].join("\n");
    assert.deepEqual(matchEditorProcesses(listing, "posix"), []);
  });

  it("still detects CapCut by its full macOS bundle path", () => {
    const listing = ["/Applications/CapCut.app/Contents/MacOS/CapCut", "node"].join("\n");
    assert.deepEqual(matchEditorProcesses(listing, "posix"), ["CapCut"]);
  });

  it("matches bare comm names case-insensitively, both editors, stable order", () => {
    assert.deepEqual(matchEditorProcesses("jianyingpro\nnode\ncapcut\n", "posix"), ["CapCut", "JianyingPro"]);
  });

  it("does not match a name that merely contains an editor's name", () => {
    const listing = ["/opt/tools/MyCapCut", "/home/me/bin/capcut-sync", "CapCut Helper (Renderer)"].join("\n");
    assert.deepEqual(matchEditorProcesses(listing, "posix"), []);
  });

  it("compares the tasklist image name, not the whole CSV row, on win32", () => {
    const clear = ['"MyCapCut.exe","1044","Console","1","12,345 K"', '"node.exe","2088","Console","1","45,678 K"'].join(
      "\r\n",
    );
    assert.deepEqual(matchEditorProcesses(clear, "win32"), []);
    const running = '"CapCut.exe","1044","Console","1","12,345 K"\r\n"node.exe","2088","Console","1","45,678 K"';
    assert.deepEqual(matchEditorProcesses(running, "win32"), ["CapCut.exe"]);
  });

  it("returns nothing for an empty or whitespace-only listing", () => {
    assert.deepEqual(matchEditorProcesses("", "posix"), []);
    assert.deepEqual(matchEditorProcesses("\n \n", "win32"), []);
  });
});
