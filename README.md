<p align="center">
  <img src="https://raw.githubusercontent.com/renezander030/capcut-cli/master/media/og-card.png" alt="capcut-cli — the CapCut/JianYing CLI any LLM agent can drive: zero dependencies, no server, both namespaces" width="640">
</p>

# capcut-cli

[![CI](https://github.com/renezander030/capcut-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/renezander030/capcut-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/capcut-cli.svg)](https://www.npmjs.com/package/capcut-cli)
[![npm downloads](https://img.shields.io/npm/dm/capcut-cli.svg)](https://www.npmjs.com/package/capcut-cli)
[![node](https://img.shields.io/node/v/capcut-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/capcut-cli.svg)](./LICENSE)

English | [中文](./README.zh-CN.md)

> **Security — update to 0.17.1 or newer.** Versions up to and including 0.17.0 build the automation script behind `export --batch` by pasting the draft folder's name into it, so a folder named with the right characters can run commands of its own on macOS and Windows. Fixed in 0.17.1, together with an ffmpeg filter option injection reachable from a draft's caption colour (`render --burn-captions`), a `compile` spec whose `name` could write outside the draft store, predictable temp files on every draft write, and `serve` echoing credential values into its own output. Both injection paths need a draft folder or draft file you did not author, so the exposure is local rather than remote. `npm install -g capcut-cli@latest`. Details in the [changelog](./CHANGELOG.md).

> **Disclaimer:** This is an independent, community-maintained project. It is **not affiliated with, sponsored by, or endorsed by** CapCut, JianYing, or ByteDance Ltd. "CapCut" and "JianYing" (剪映) are trademarks of ByteDance Ltd. All product names, logos, and brands are the property of their respective owners and are used here only for identification (nominative) purposes.

**An independent CLI for CapCut / JianYing that any LLM agent can drive — zero dependencies, no server, both namespaces in one binary.**

JSON in, JSON out: every command reads and writes the local draft store directly, with no MCP server or HTTP daemon. On newer CapCut versions it detects and synchronizes every readable timeline target instead of assuming `draft_content.json` is the only source of truth. That gives any model (Claude, DeepSeek, GLM, Kimi) a deterministic boundary for inspection, building, subtitles, captions, translation, and long-form cuts.

**Use it three ways:**

- **CLI** — `npm install -g capcut-cli`, then `capcut <command> <project>`
- **Library** — `import { loadDraft, lintDraft, saveDraft } from "capcut-cli"` (typed, zero-dep)
- **Queue runner** — `capcut serve` reads JSONL jobs from stdin, for [n8n / Make / Coze](./examples/serve-automation.md)

> **New in v0.17.1:** seven security fixes, led by the two `export --batch` command-injection paths above, plus a performance pass that makes `lint --fix` and `lint` roughly 4x faster on large projects and starts every invocation 22-27% sooner by loading command modules only when they are used, and a subtraction pass that drops dead code, folds ten duplicated blocks into shared helpers, and ships 28 fewer files. No command or flag changed, and written drafts stay byte-identical to v0.17.0. Full details in the [changelog](./CHANGELOG.md).

> **New in v0.17.0:** OpenTimelineIO import as a new draft or appended tracks (`import-timeline`, the inverse of `export-timeline`), one spec plus N JSONL rows building N registered drafts (`compile --data`), transactional draft rename (`rename`), main-track-gap and outside-the-draft media checks in `lint` with `--fix` close-up and stage-in, an app auto-upgrade tripwire that warns old -> new on the first write after an update, detection of and write warnings for the CapCut 7.x nested `Timelines/` layout, mask-keyframe evidence harvesting in every `fixture` bundle (#44), and a Simplified-Chinese command reference plus JianYing-first quickstart. Full details in the [changelog](./CHANGELOG.md).

## Install

**Prerequisites:** Node ≥ 18 (built-ins only — no native modules). Optional tools unlock specific commands: Whisper for `caption`, FFmpeg for `render`, ffprobe for automatic media metadata, and `ANTHROPIC_API_KEY` for `translate`.

```bash
npm install -g capcut-cli      # or: npx capcut-cli <command>
```

Build from source instead: `git clone https://github.com/renezander030/capcut-cli && cd capcut-cli && npm install && npm run build` (then `npm link` to expose `capcut`).

## Quickstart

```bash
capcut doctor                                  # verify Node, FFmpeg, whisper, draft dirs
capcut quickstart my-first --video clip.mp4    # create + add input + lint, prints the "open in CapCut" step
capcut info ./my-first/                         # inspect the draft (add -H for a table)
```

Then open the project in CapCut to review and render. Every short-video platform forbids automated upload, so the publish click stays human.

## Commands

JSON by default (pipe to `jq`); add `-H` for a human-readable table. Pass `--jianying` to use the JianYing enum namespace. Run `capcut <command> --help` for full flags.

| Group | Commands |
|-------|----------|
| **Inspect** | `info` · `tracks` · `materials` · `version` · `lint` |
| **Browse / drill in** | `segments` · `texts` · `segment` · `material` |
| **Create** | `init` · `quickstart` · `compile` (build a draft from a JSON spec) |
| **Preview** | `render` (low-res ffmpeg proxy — not CapCut's final render) |
| **Add** | `add-video` · `add-audio` · `add-text` (Wikimedia URLs supported, license-checked) |
| **Edit / animate** | trim · speed · volume · transitions · masks · text/image animations · easing curves |
| **Templates** | apply and extract reusable layouts · `make-preset` (portable text-style presets) |
| **Subtitles & i18n** | `caption` · `import-srt` · `export-srt` (line/word SRT + VTT) · `translate` (multi-language draft clone) |
| **Effects** | `sfx` · `chroma` (chroma key) |
| **Long-form → short** | `cut` · `detect-scenes` (ffmpeg scene-cut detection) |
| **Automation** | `serve` (stateless JSONL runner) · `migrate` · `doctor` · `sync-timelines` (8.7 mirror repair) |

**Full reference** for every command, option, and exit code: **[docs/command-reference.md](./docs/command-reference.md)** (简体中文: [docs/command-reference.zh-CN.md](./docs/command-reference.zh-CN.md)).

## Sponsor

capcut-cli is MIT and free forever. Sponsoring funds faster releases and same-week support for new CapCut / JianYing versions — and unlocks power-user extras:

- **$5/mo · Supporter** — sponsors-only release notes plus your name in `BACKERS.md`. Keep the project moving.
- **$25/mo · Pro** — invite to the private `capcut-cli-pro` repo: premium template and caption-style packs, the full Claude viral-shorts pipeline, ready-to-run `compile` specs, and early-access builds. Plus priority issue triage.
- **$100/mo · Team** — everything in Pro for up to 5 teammates, written commercial-use confirmation, your logo in this README, and priority fast-tracking of the features your team needs.

[**Become a sponsor →**](https://github.com/sponsors/renezander030)

> Using capcut-cli at work? The Team tier pays for itself the first afternoon it saves your engineers.

## How it works

CapCut/JianYing store each project as local JSON. capcut-cli loads that store, validates against a version-aware schema, applies your edit, and writes it back atomically (with a `.bak`). No project files are uploaded anywhere; nothing runs as a service. See [docs/version-support.md](./docs/version-support.md) for the CapCut/JianYing versions and schema flags it understands.

## Docs & examples

- [docs/command-reference.md](./docs/command-reference.md) — every command and flag ([简体中文](./docs/command-reference.zh-CN.md))
- [docs/quickstart.zh-CN.md](./docs/quickstart.zh-CN.md) — 剪映快速上手 (JianYing-first quickstart, Simplified Chinese)
- [examples/](./examples/) — end-to-end recipes (VO alignment, serve automation, batch subtitle correction)
- [docs/version-support.md](./docs/version-support.md) · [docs/jianying-encryption.md](./docs/jianying-encryption.md)
- [CHANGELOG.md](./CHANGELOG.md) · [Releases](https://github.com/renezander030/capcut-cli/releases) — what's new
- [draftcat](https://github.com/renezander030/draftcat) — sibling project: governed AI pipelines (Go, MIT), same single-binary, no-API design

## Trademarks

CapCut™ and JianYing™ (剪映) are trademarks of ByteDance Ltd. This project is unofficial and is not affiliated with or endorsed by ByteDance; the marks are used nominatively to describe interoperability.

## License

MIT
