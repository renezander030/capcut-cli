# capcut-cli — docs

Reference documentation for `capcut-cli` users and contributors. Source code lives in [`src/`](../src/); the CLI's runtime command reference lives in [`README.md`](../README.md) at the repo root; the **Chinese** README is at [`README.zh-CN.md`](../README.zh-CN.md).

## What's in here

- **[`quickstart.zh-CN.md`](./quickstart.zh-CN.md)** — 剪映快速上手 (JianYing-first quickstart, Simplified Chinese); the command reference is also translated: [`command-reference.zh-CN.md`](./command-reference.zh-CN.md)
- **[`draft-schema/`](./draft-schema/)** — annotated reference for the CapCut / JianYing project file (`draft_content.json` on Windows, `draft_info.json` on macOS). Read this before writing your own CLI / agent / pipeline against the format. Covers the top-level shape, tracks and segments, materials, keyframes and animations, effects and masks, and the CapCut↔JianYing differences.

## What's NOT in here

- **Command reference**: `capcut --help` and the [README](../README.md) cover every command, flag, and value format.
- **Recipes / workflows**: bundled inside the [`skills/capcut-edit/`](../skills/capcut-edit/) Claude Code skill — `references/workflows.md` and the `scripts/*.sh` wrappers are the authoritative recipe set.
- **Internal design notes**: [`PLAN.md`](../PLAN.md) at the repo root tracks the phase-by-phase implementation roadmap and explicitly out-of-scope items.

## Contributing

Schema corrections, additional sections, and clarifications are welcome. Open a PR — the CapCut draft format is undocumented by ByteDance and these notes are reverse-engineered from real project files plus the upstream Python work in [`pyJianYingDraft`](https://github.com/GuanYixuan/pyJianYingDraft). Field-by-field corrections from production drafts are the highest-value contribution.
