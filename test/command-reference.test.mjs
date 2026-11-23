import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { renderCommandDocs } from "../scripts/generate-command-docs.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// A Windows checkout may turn LF into CRLF (core.autocrlf); the generator writes LF.
const committed = (name) => readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

// The packaged references are what `describe` says; regenerate them with `npm run docs:commands`.
it("committed command references equal what describe generates", () => {
  const described = spawnCli(["describe"]);
  assert.equal(described.status, 0, described.stderr);
  const docs = renderCommandDocs(described.json, { zhCN: committed("command-reference.zh-CN.md") });
  assert.equal(committed("command-reference.json"), docs.json);
  assert.equal(committed("command-reference.md"), docs.markdown);
  // The Chinese page keeps its translated summaries; its commands, order, usage and mutates columns follow describe.
  assert.equal(committed("command-reference.zh-CN.md"), docs.zhCN);
});

it("the Chinese reference takes its rows from describe and keeps each translated summary", () => {
  const schema = {
    commands: [
      { name: "info", usage: "capcut info <project>", mutates: false, summary: "Overview." },
      { name: "dub", usage: "capcut dub <project> <a.srt|.vtt>", mutates: true, summary: "Dub a track." },
    ],
  };
  const page = [
    "# 命令参考",
    "",
    "| 命令 | 用法 | 修改草稿 | 说明 |",
    "|---|---|:---:|---|",
    "| `info` | `capcut info <old>` | 否 | 项目概览。 |",
    "| `gone` | `capcut gone` | 是 | 已删除。 |",
    "",
    "尾注",
    "",
  ].join("\n");
  assert.equal(
    renderCommandDocs(schema, { zhCN: page }).zhCN,
    [
      "# 命令参考",
      "",
      "| 命令 | 用法 | 修改草稿 | 说明 |",
      "|---|---|:---:|---|",
      "| `info` | `capcut info <project>` | 否 | 项目概览。 |",
      "| `dub` | `capcut dub <project> <a.srt\\|.vtt>` | 是 | Dub a track. |",
      "",
      "尾注",
      "",
    ].join("\n"),
  );
});
