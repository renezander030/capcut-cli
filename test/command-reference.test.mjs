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
  assert.equal(readFileSync(new URL("../docs/command-reference.json", import.meta.url), "utf8"), docs.json);
  assert.equal(readFileSync(new URL("../docs/command-reference.md", import.meta.url), "utf8"), docs.markdown);
});
