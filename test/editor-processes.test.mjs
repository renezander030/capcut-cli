import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchEditorProcesses, matchEditorRows, ownProcessChain, parseProcessRows } from "../dist/store.js";

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

// #168: under Volta the `capcut` command is a shim executable named `capcut`
// that starts node, so the CLI's own parent matched the editor by name.
describe("editorProcesses leaves out the CLI's own process chain", () => {
  const shim = [
    "    1     0 /sbin/launchd",
    "  400     1 -zsh",
    "  500   400 /Users/me/.volta/bin/capcut",
    "  501   500 node",
  ];

  it("ignores a Volta shim named capcut that is the CLI's parent (#168)", () => {
    const rows = parseProcessRows(shim.join("\n"), "posix");
    assert.deepEqual(matchEditorRows(rows, "posix", ownProcessChain(rows, 501, 500)), []);
  });

  it("still detects an editor running beside the shim chain", () => {
    const listing = [...shim, "  700     1 /Applications/CapCut.app/Contents/MacOS/CapCut"].join("\n");
    const rows = parseProcessRows(listing, "posix");
    assert.deepEqual(matchEditorRows(rows, "posix", ownProcessChain(rows, 501, 500)), ["CapCut"]);
  });

  it("walks the whole parent chain, not only the direct parent", () => {
    const listing = [
      "  400     1 -zsh",
      "  450   400 capcut",
      "  460   450 npm exec capcut-cli",
      "  501   460 node",
    ].join("\n");
    const rows = parseProcessRows(listing, "posix");
    assert.deepEqual(
      [...ownProcessChain(rows, 501, 460)].sort((a, b) => a - b),
      [400, 450, 460, 501],
    );
    assert.deepEqual(matchEditorRows(rows, "posix", ownProcessChain(rows, 501, 460)), []);
  });

  it("keeps a command name with spaces whole", () => {
    const rows = parseProcessRows("  812   1 CapCut Helper (Renderer)", "posix");
    assert.deepEqual(rows, [{ pid: 812, ppid: 1, line: "CapCut Helper (Renderer)" }]);
  });

  it("leaves out the direct parent on win32, where tasklist has no parent ids", () => {
    const listing = [
      '"capcut.exe","900","Console","1","4,096 K"',
      '"node.exe","901","Console","1","45,678 K"',
      '"CapCut.exe","1044","Console","1","12,345 K"',
    ].join("\r\n");
    const rows = parseProcessRows(listing, "win32");
    assert.deepEqual(matchEditorRows(rows.slice(0, 2), "win32", ownProcessChain(rows, 901, 900)), []);
    assert.deepEqual(matchEditorRows(rows, "win32", ownProcessChain(rows, 901, 900)), ["CapCut.exe"]);
  });
});
