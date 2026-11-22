import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { renderCommandDocs } from "../scripts/generate-command-docs.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// The packaged references are what `describe` says; regenerate them with `npm run docs:commands`.
it("committed command references equal what describe generates", () => {
  const described = spawnCli(["describe"]);
  assert.equal(described.status, 0, described.stderr);
  const docs = renderCommandDocs(described.json);
  // A Windows checkout may turn LF into CRLF (core.autocrlf); the generator writes LF.
  const committed = (name) =>
    readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.equal(committed("command-reference.json"), docs.json);
  assert.equal(committed("command-reference.md"), docs.markdown);
});
