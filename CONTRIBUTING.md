# Contributing to capcut-cli

Thanks for considering a contribution. This is a small, zero-dependency project — keep changes in that spirit and they'll land fast.

## Principles

- **Zero runtime dependencies.** The CLI uses Node ≥ 18 built-ins only (`fetch`, `fs`, etc.). A PR that adds a runtime dep to `package.json` will be declined unless there's no built-in path.
- **JSON in, JSON out.** Every command reads/writes `draft_content.json` directly. Default output is JSON; `-H`/`--human` is the table view; `-q`/`--quiet` is exit-code-only.
- **No server, no daemon, no state.** Each invocation is independent. HTTP/MCP servers are explicitly out of scope (see `PLAN.md`).

## Development

```bash
git clone https://github.com/renezander030/capcut-cli
cd capcut-cli
npm install
npm run build        # tsc → dist/ (+ copies enums.json)
npm test             # build + full node:test suite
npm run dev -- info ./some-project   # run from source via tsx
```

- `npm run lint` / `npm run lint:fix` — Biome (pinned version; no autofix debt).
- `npm run test:fast` — runs the suite **without** rebuilding; only use it when `dist/` is already current.

## Claiming an issue

Comment on the issue before you start, and wait to be assigned. Maintainers will not
pick up an issue that someone has asked for without answering here first, and issues
labelled `good first issue` are held for first-time contributors. If nobody replies
within three days, treat it as free and go ahead.

## Pull requests

1. **Branch** off `master` (`feat/…`, `fix/…`, `docs/…`).
2. **Add a test** under `test/` — one `.test.mjs` per feature, driven through `spawnCli` against a `tmpDraft()` fixture (see `test/restore.test.mjs` for the pattern). New commands and bug fixes both need coverage.
3. **Update docs** — README for user-facing changes, `CHANGELOG.md` under a `## [Unreleased]` heading (Keep a Changelog format).
4. The **pre-commit hook** runs `npm test` (build + full suite) and Biome on staged files. Keep it green; `--no-verify` only for genuine emergencies.
5. Keep commits focused and the PR description concrete. Reference the issue it closes (`Closes #NN`).

## Filing issues

Bugs: include the command, the relevant slice of `draft_content.json`, the CapCut/JianYing version (`capcut version <project>`), and what you expected vs. saw. Feature requests: describe the workflow it unblocks. A scoped issue with acceptance criteria is the fastest path to a merge.

## Give your agent the map (optional)

If you run a coding agent (Claude Code, pi, …) over your checkout while working on
the source, [`pi-codegraph`](https://github.com/renezander030/pi-codegraph) hands it
derived knowledge of *this codebase as it is now* — the call graph, the command
pattern, and the blast radius of a change — so it stops re-reading the whole repo
every session.

```bash
pi-codegraph trust --repo . --label capcut-cli
pi-codegraph index --repo .
pi-codegraph arch -H                     # the command pattern + the busiest helpers
pi-codegraph trace saveDraft --inbound   # the commands that persist a draft, as a template
pi-codegraph impact                      # before touching a core helper, what your change breaks
```

Entirely optional and external — nothing in the project depends on it.

## License

By contributing you agree your work is licensed under the project's [MIT License](./LICENSE).
