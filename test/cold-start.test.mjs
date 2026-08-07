import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SOURCE = readFileSync(join(__dirname, "..", "dist", "index.js"), "utf-8");

// Every invocation pays for the CLI's static import graph, so the command
// modules load lazily at their dispatch sites. These tests pin that down: the
// allow-list keeps a stray `import` from quietly putting the cost back, and the
// dispatch checks prove nothing broke on the way to being lazy.
const HOT_PATH_MODULES = [
  // Arg parsing, --help, describe and the shell completions.
  "command-specs",
  // loadDraft/saveDraft and its own transitive core — every draft command needs it.
  "app-versions",
  "bom",
  "draft",
  "store",
  "version",
  // Time formatting for the common read commands (info/tracks/segments/texts).
  "time",
];

// Commands that run in an early branch of main() that ends in process.exit().
// A dropped `await` there exits before the lazy module resolves, so the command
// silently prints nothing — these keep that failure visible.
const EARLY_EXIT_COMMANDS = [
  ["enums", ["enums", "--transitions"]],
  ["doctor", ["doctor"]],
  ["templates", ["templates"]],
  ["config", ["config"]],
  ["describe", ["describe"]],
];

const uniq = (values) => values.filter((value, index, all) => all.indexOf(value) === index);
const staticImports = (source) => uniq([...source.matchAll(/from "\.\/([a-z-]+)\.js"/g)].map((m) => m[1]));
const dynamicImports = (source) => uniq([...source.matchAll(/import\("\.\/([a-z-]+)\.js"\)/g)].map((m) => m[1]));

describe("cold start", () => {
  it("statically imports only the hot-path modules", () => {
    const unexpected = staticImports(CLI_SOURCE).filter((m) => !HOT_PATH_MODULES.includes(m));
    assert.deepEqual(
      unexpected,
      [],
      `these modules load on every invocation; import them lazily at the dispatch site instead: ${unexpected.join(", ")}`,
    );
  });

  it("loads the rarely-used command modules lazily", () => {
    const lazy = dynamicImports(CLI_SOURCE);
    // A representative slice: the heaviest module (caption pulls the whisper
    // path), the two the mutating commands share, plus one per command family.
    for (const expected of [
      "caption",
      "compile",
      "decorators",
      "doctor",
      "factory",
      "lint",
      "preset",
      "quickstart",
      "render",
      "serve",
      "srt",
    ]) {
      assert.ok(lazy.includes(expected), `expected ./${expected}.js to be imported lazily`);
    }
  });

  it("keeps a dispatch site for every command it describes", () => {
    const names = spawnCli(["describe"]).json.commands.map((c) => c.name);
    assert.ok(names.length > 50, `expected the full command surface, got ${names.length}`);
    // Each command is reached either from the switch or from an early branch of
    // main(). A renamed or dropped case would otherwise only surface as
    // "Unknown command" for a project the test suite never builds.
    const cases = new Set([...CLI_SOURCE.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
    const branches = new Set([...CLI_SOURCE.matchAll(/cmd === "([a-z-]+)"/g)].map((m) => m[1]));
    const undispatched = names.filter((name) => !cases.has(name) && !branches.has(name));
    assert.deepEqual(undispatched, [], `commands with no dispatch site: ${undispatched.join(", ")}`);
  });

  it("still produces output for the commands that exit early", () => {
    for (const [name, args] of EARLY_EXIT_COMMANDS) {
      const { stdout, stderr } = spawnCli(args);
      assert.ok(stdout.length > 0, `${name}: printed nothing — a lazy import was not awaited (stderr: ${stderr})`);
    }
  });

  it("lists every command in the shell completions", () => {
    const names = spawnCli(["describe"]).json.commands.map((c) => c.name);
    for (const shell of ["bash", "zsh", "fish"]) {
      const { stdout, status } = spawnCli(["completions", shell]);
      assert.equal(status, 0, `completions ${shell} should exit 0`);
      for (const name of names) {
        assert.ok(stdout.includes(name), `completions ${shell}: missing command "${name}"`);
      }
    }
  });
});
