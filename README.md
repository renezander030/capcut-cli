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

`raw recording` → `silence-aware cuts + styled captions` → `editable CapCut / JianYing draft`

[**▶ Watch a captioned output example (60 seconds)**](./media/two-sisters-vietnam-short.mp4)

## Install and open your first editable draft

**Prerequisites:** Node ≥ 18 (built-ins only — no native modules). Optional tools unlock specific commands: Whisper for `caption`, FFmpeg for `render`, ffprobe for automatic media metadata, and `ANTHROPIC_API_KEY` for `translate`.

```bash
npm install -g capcut-cli
```

```bash
capcut doctor
capcut quickstart my-first --video clip.mp4 --srt captions.srt
capcut info ./my-first/ -H
```

**Result:** a real local project with video and captions on editable tracks — not a flattened export. Open it in CapCut or JianYing to review, adjust, and render. The publish click stays human.

Useful? [Star capcut-cli](https://github.com/renezander030/capcut-cli) to help other editors and agent builders find it.

Build from source instead: `git clone https://github.com/renezander030/capcut-cli && cd capcut-cli && npm install && npm run build` (then `npm link` to expose `capcut`). Or run any command without installing: `npx capcut-cli <command>`.

> [!IMPORTANT]
> **Upgrade before using older versions.** Fixture bundles made with versions up to 0.17.2 may contain stable device identifiers and must be treated as unsanitised ([#59](https://github.com/renezander030/capcut-cli/issues/59)). Versions up to 0.17.0 also contain local command/filter injection paths and unsafe temporary-file or credential-output behaviour. These issues are fixed in 0.18.0 and 0.17.1 respectively. Run `npm install -g capcut-cli@latest` and see the [changelog](./CHANGELOG.md) for full details.

> **Disclaimer:** This is an independent, community-maintained project. It is **not affiliated with, sponsored by, or endorsed by** CapCut, JianYing, or ByteDance Ltd. "CapCut" and "JianYing" (剪映) are trademarks of ByteDance Ltd. All product names, logos, and brands are the property of their respective owners and are used here only for identification (nominative) purposes.

**An independent CLI for CapCut / JianYing that any LLM agent can drive — zero dependencies, no server, both namespaces in one binary.**

JSON in, JSON out: every command reads and writes the local draft store directly, with no MCP server or HTTP daemon. On newer CapCut versions it detects and synchronizes every readable timeline target instead of assuming `draft_content.json` is the only source of truth. That gives any model (Claude, DeepSeek, GLM, Kimi) a deterministic boundary for inspection, building, subtitles, captions, translation, and long-form cuts.

**Use it three ways:**

- **CLI** — `npm install -g capcut-cli`, then `capcut <command> <project>`
- **Library** — `import { loadDraft, lintDraft, saveDraft } from "capcut-cli"` (typed, zero-dep)
- **Queue runner** — `capcut serve` reads JSONL jobs from stdin, for [n8n / Make / Coze](./examples/serve-automation.md)

## Release notes

> **New in v0.21.0:** the CapCut Mac 9.2.8 nested-Timelines report ([#50](https://github.com/renezander030/capcut-cli/issues/50)) gets its repair path — `sync-timelines --nested` copies the root timeline into the `Timelines/<id>/` documents as an explicit opt-in, each document keeping its own GUID (the workaround verified in the thread), and `fixture --check` mechanically verifies a bundle leaks no home path, email or device id before you attach it. Every write refusal now names its gate (`refused [editor-open]` / `[version-boundary]` / `[draft-changed-on-disk]`), so a pasted stderr line is unambiguous. Plus `catalogue <query>` — name → resource_id across every bundled and harvested table, `lint --pip` for the PIP + local-mask workflow ([#78](https://github.com/renezander030/capcut-cli/issues/78)), `import-srt --clone-style` (keep the draft's caption look without hunting a segment id), `relink --stage` (the repaired draft leaves portable), an observe-only `media-unregistered` note (pyCapCut#13), and Chinese docs for version support and encryption. No command was removed and no existing flag changed meaning. Full details in the [changelog](./CHANGELOG.md).

> **New in v0.20.0:** subtitles now carry their styling across the draft boundary in both directions — `export-ass` writes `[V4+ Styles]`, per-range override tags and `--karaoke` word timing, and `import-ass` keeps inline bold/italic/colour/size spans instead of flattening them to plain text, pinned by a round-trip test. The raw-recording pipeline closes: `detect-silence` finds dead air (with a `--pad` so no word gets clipped mid-syllable) and `tts` voices a script through any local TTS tool (piper, `say`, espeak-ng) straight onto an audio track. `render` finishes 0.19.0's fail-fast work — the audio filter chain is probed like the video chain ([#91](https://github.com/renezander030/capcut-cli/issues/91)) — and `--encoder` unlocks hardware encoders. Plus `harvest-enums --sync`/`--add` for the whole library, and `diagnose` now captures sanitized evidence for the open store-layout questions ([#50](https://github.com/renezander030/capcut-cli/issues/50)). No command was removed and no existing flag changed meaning. Full details in the [changelog](./CHANGELOG.md).

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
