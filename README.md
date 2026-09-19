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

**Create and edit real CapCut / JianYing projects from the terminal — or any LLM agent.**

Open the result in CapCut with every track still editable. capcut-cli works directly on the local draft store: JSON in, JSON out, with no upload, API, MCP server, or HTTP daemon.

**Also from the maintainer:** [500 Years Frozen in Time: The Inca Children Mystery](https://www.youtube.com/watch?v=cl8SP3PjspQ), a 14:49 documentary from [Bronze Age Banter](https://www.youtube.com/@BronzeAgeBanter).

`raw recording` → `silence-aware cuts + styled captions` → `editable CapCut / JianYing draft`

**▶ Captioned output example (60 seconds)**

https://github.com/user-attachments/assets/4e6ee99c-0745-4cfb-8e9b-ad873fb1259b

## Install and open your first editable draft

**Prerequisites:** Node ≥ 18 (built-ins only — no native modules). Optional tools unlock specific commands: Whisper for `caption`, FFmpeg for `render`, ffprobe for automatic media metadata, and `ANTHROPIC_API_KEY` for `translate`.

```bash
npm install -g capcut-cli
```

From Python: `pip install capcut` wraps the same binary — `capcut.run("quickstart", "my-short", video="clip.mp4", ratio="9:16")` — see [python/README.md](https://github.com/renezander030/capcut-cli/blob/master/python/README.md).

```bash
capcut doctor
capcut quickstart my-first --video clip.mp4 --srt captions.srt
capcut info ./my-first/ -H
```

**Result:** a real local project with video and captions on editable tracks — not a flattened export. Open it in CapCut or JianYing to review, adjust, and render. The publish click stays human.

Useful? [Star capcut-cli](https://github.com/renezander030/capcut-cli) to help other editors and agent builders find it.

For more practical tools for AI agents, from video automation to checks before they ship, [follow René on GitHub](https://github.com/renezander030).

Build from source instead: `git clone https://github.com/renezander030/capcut-cli && cd capcut-cli && npm install && npm run build` (then `npm link` to expose `capcut`). Or run any command without installing: `npx capcut-cli <command>`.

> [!IMPORTANT]
> **Upgrade before using older versions.** Fixture bundles made with versions up to 0.17.2 may contain stable device identifiers and must be treated as unsanitised ([#59](https://github.com/renezander030/capcut-cli/issues/59)). Versions up to 0.17.0 also contain local command/filter injection paths and unsafe temporary-file or credential-output behaviour. These issues are fixed in 0.18.0 and 0.17.1 respectively. Run `npm install -g capcut-cli@latest` and see the [changelog](./CHANGELOG.md) for full details.

> **Disclaimer:** This is an independent, community-maintained project. It is **not affiliated with, sponsored by, or endorsed by** CapCut, JianYing, or ByteDance Ltd. "CapCut" and "JianYing" (剪映) are trademarks of ByteDance Ltd. All product names, logos, and brands are the property of their respective owners and are used here only for identification (nominative) purposes.

**An independent CLI for CapCut / JianYing that any LLM agent can drive — zero dependencies, no server, both namespaces in one binary.**

JSON in, JSON out: every command reads and writes the local draft store directly, with no MCP server or HTTP daemon. On newer CapCut versions it detects and synchronizes every readable timeline target instead of assuming `draft_content.json` is the only source of truth. That gives any model (Claude, DeepSeek, GLM, Kimi) a deterministic boundary for inspection, building, subtitles, captions, translation, and long-form cuts.

**Use it four ways:**

- **CLI** — `npm install -g capcut-cli`, then `capcut <command> <project>`
- **Library** — `import { loadDraft, lintDraft, saveDraft } from "capcut-cli"` (typed, zero-dep)
- **Queue runner** — `capcut serve` reads JSONL jobs from stdin, for [n8n / Make / Coze](./examples/serve-automation.md)
- **Agent sandbox (experimental)** — build [`capcut-core.wasm`](https://github.com/renezander030/capcut-cli/tree/master/wasm/capcut-core) for three read-only MCP tools with zero filesystem, network, environment, clock, random, stdio, or process imports

### Give your agent the skill

One command installs the `capcut-edit` skill into Claude Code, Codex, Cursor, OpenCode and the other agents the [`skills`](https://skills.sh) installer supports:

```bash
npx skills add renezander030/capcut-cli
```

Claude Code can also load it as a plugin:

```
/plugin marketplace add renezander030/capcut-cli
/plugin install capcut-cli@capcut-cli
```

The skill teaches the agent every command, the progressive-disclosure habit (inspect first, never dump a whole draft), where the draft store lives on macOS and Windows, and the deterministic scripts for fades, Ken Burns and long-to-short cuts. It triggers on English and Chinese requests alike (剪映, 字幕, 草稿).

### Capability-free Wasm tools for agents

**Using an AI assistant with capcut-cli? Give it a safer “look, don’t touch” mode.**

The optional Wasm tool lets an AI:

- describe what is inside a CapCut project;
- show what changed between two versions; and
- spot common timeline and caption problems.

It can examine only the project information you hand to it. It cannot browse your files, go online, read passwords or API keys, open other apps, or change the project.

**Use it when** you want an AI to review a draft with the least possible access. **Skip it when** you are using capcut-cli yourself or want the AI to edit or render—the normal CLI still does those jobs. This feature is experimental, optional, and changes nothing unless you set it up. [**Technical details and setup →**](https://github.com/renezander030/capcut-cli/tree/master/wasm/capcut-core#readme)

The experimental [`wasm/capcut-core`](https://github.com/renezander030/capcut-cli/tree/master/wasm/capcut-core) source package moves the deterministic, JSON-in/JSON-out boundary into a WebAssembly Component:

- `inspect` matches `capcut info` for valid drafts.
- `diff` matches `capcut diff` for structural changes.
- `lint-portable` runs an explicit, parity-tested subset of `capcut lint` that needs no host files or media probing.

The host reads a draft and passes its JSON as tool input. The component itself has no ambient capabilities, and CI proves the built world has zero imports before exercising all three functions through [Wassette](https://github.com/microsoft/wassette) over MCP. From a source checkout, build it with `npm --prefix wasm/capcut-core ci && npm run wasm:verify`; setup and security details are in the [component README](https://github.com/renezander030/capcut-cli/tree/master/wasm/capcut-core#readme).

## Release notes

> **New in v0.25.0:** `caption` follows the transcript's script. Whisper's "words" for Chinese and Japanese are single characters or short tokens, so the Latin defaults (four words per cue, joined with spaces) produced fragments with spaces between the characters; cues are now joined without spaces and bounded by characters alone, at the width `lint` holds captions to (zh 16, ja 13, ko 16), and the result reports `caption_script`. An explicit `--max-words` / `--max-chars` still wins. Full details in the [changelog](./CHANGELOG.md).

> **New in v0.24.0:** captions in Chinese, Japanese and Korean are held to their own limits — `lint` flags a 32-character Chinese line and a 15 chars/s cue that the Latin defaults (42, 20) let through, and `--fix` re-wraps between characters (zh 16/9, ja 13/4, ko 16/12; an explicit `--max-chars` / `--max-cps` still applies everywhere). On a JianYing 6.0+ drafts folder, where every app-written project is encrypted, `init` / `quickstart` / `compile` now say that none could seed the new draft (`template.store`, a WARNING) and `lint` reports `template-unverified-store` instead of nothing. Plus a one-command agent install: `npx skills add renezander030/capcut-cli`. Full details in the [changelog](./CHANGELOG.md).

## Built with capcut-cli

- [OpenChatCut](https://github.com/0xsline/OpenChatCut) — exports an agent-edited timeline, local media, audio, and captions into a real CapCut / JianYing draft for review and rendering.

Built something with capcut-cli? [Open a showcase issue](https://github.com/renezander030/capcut-cli/issues/new?template=showcase.yml) with a public link, one sentence about what it does, and an optional screenshot or demo.

Project descriptions are approved by their maintainers. Inclusion does not imply endorsement or affiliation.


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
| **Effects** | `sfx` · `chroma` (chroma key) · `matting` (smart background removal) |
| **Long-form → short** | `cut` · `detect-scenes` (ffmpeg scene-cut detection) · `detect-silence` · `detect-retakes` (repeated takes) |
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
- [skillgate](https://github.com/renezander030/skillgate) — sibling project: deterministic finish-line gates (Node, MIT), for when your agent reports "done" before the tests pass

## Trademarks

CapCut™ and JianYing™ (剪映) are trademarks of ByteDance Ltd. This project is unofficial and is not affiliated with or endorsed by ByteDance; the marks are used nominatively to describe interoperability.

## License

MIT
