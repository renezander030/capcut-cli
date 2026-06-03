# Changelog

All notable changes to capcut-cli are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Global `--dry-run`** ([#15](https://github.com/renezander030/capcut-cli/issues/15)) — any draft-mutating command now honors `--dry-run`: it computes and prints the normal JSON result with `"dryRun":true` added, but leaves the draft **and** its `.bak` untouched. Gated centrally in `saveDraft`, so it covers every write command at once. `translate` / `export --batch` keep their existing dry-run behavior.
- **`restore` command** ([#16](https://github.com/renezander030/capcut-cli/issues/16)) — `capcut restore <project>` undoes the last write by copying `<draft>.bak` back over the draft. Single-step (only one backup generation is kept); exits non-zero with a clear message when no `.bak` exists. Honors `--dry-run`.

### Documentation

- **README** — added a from-source install path and a consolidated Prerequisites note (Node ≥ 18, whisper for `caption`, `ANTHROPIC_API_KEY` for `translate`); a worked-example block for the v0.4/v0.5 commands that had none (`mix-mode`, `audio-fade`, `add-filter`, `bubble-text`, `add-cover`, `add-sfx`, `chroma`, `import-ass`); and a **Troubleshooting** table covering the CapCut-must-be-closed footgun, track-order normalization ([#21](https://github.com/renezander030/capcut-cli/issues/21)), `.bak` recovery, whisper/API-key setup, and the `--fade-out` flag.

### Fixed

- **Track order scrambled on import** ([#21](https://github.com/renezander030/capcut-cli/issues/21)) — tracks were written in the order edit commands ran, but CapCut lays out the timeline from the tracks-array order, not from per-segment `render_index`, so building a draft incrementally produced a jumbled timeline. `saveDraft` now normalizes the tracks array to the canonical bottom→top layer order (`video → audio → sticker → effect → filter → text`) on every save; the sort is stable so same-type tracks keep their authored order. Also exported as `sortTracks` from the library entry point.

## [0.6.0] — 2026-05-29

Distribution and integration release. No breaking changes to existing commands; everything stays zero-dep, JSON-by-default, and pipeable.

### Added

- **`capcut doctor`** — environment preflight that inspects the machine, not a draft: Node version (hard requirement, ≥ 18), a whisper binary on `PATH` (for `caption`), `ANTHROPIC_API_KEY` (for `translate`), and the default per-OS CapCut/JianYing project directory. JSON by default, `-H` for a human checklist. Exits `1` only on a hard failure.
- **Importable Node library** — `import { loadDraft, saveDraft, findSegment, findMaterial, getTracksByType, extractText, updateTextContent, lintDraft, detectVersion, runDoctor } from "capcut-cli"`, with types. New `src/lib.ts` entry point; `package.json` `exports`/`main`/`types` map to `dist/lib.js`; `tsconfig` now emits `.d.ts`. Importing the package no longer executes the CLI.
- **Dockerfile + `.dockerignore`** — zero-dep multi-stage build; the final image is Node + `dist/` + `templates/`. Drafts mount at `/work`. Also runs `serve` over a stdin pipe.
- **GitHub Action (`action.yml`)** — composite action wrapping `capcut lint` so drafts can be gated in CI; `lint` exit code `2` (errors) fails the job. `uses: renezander030/capcut-cli@v0.6`.
- **Three new shipped templates** — `caption-pop` (bold white center subtitle), `lower-third` (handle/name attribution), `hook-question` (large top-of-frame hook). Catalogue grows 3 → 6, all validated by the roundtrip suite.
- **`serve-automation.md` example** — JSONL job/result contract and four integration paths (local pipe, n8n Execute Command, cloud builders via webhook→queue-file, Docker).

### CI / Quality

- **GitHub Actions CI** — test matrix across Node 18 / 20 / 22 plus a Biome lint job, on every push and pull request.
- **Fuzz / injection test suite** — 12 malformed `draft_content.json` inputs (non-JSON, truncated, wrong-shape, prototype-pollution attempts, deep nesting) across six read commands assert graceful failure: no hang, no leaked stack trace, single-line JSON error on stderr. Plus a prototype-pollution non-regression check.
- Test suite grew to 113 passing tests (doctor, fuzz, library, and the three new templates added their own coverage).

## [0.5.0] — 2026-05-25

Six new commands voted in from [Discussion #1](https://github.com/renezander030/capcut-cli/discussions/1), shipped as a single release. All keep the zero-dep, JSON-by-default, pipeable design.

### Added

- **`capcut mix-mode <project> <segment-id> <mode>`** — set blend mode on a video segment. Writes `mix_mode` on the video material (not the segment) since CapCut keys blend modes off `materials.videos[]`. 12 modes: `normal`, `multiply`, `screen`, `overlay`, `soft-light`, `hard-light`, `color-dodge`, `color-burn`, `darken`, `lighten`, `difference`, `exclusion`. Rejects non-video/photo segments.
- **`capcut audio-fade <project> <segment-id> [--in <sec>] [--fade-out <sec>]`** — fade-in / fade-out on an audio segment via a real `materials.audio_fades[]` entry (`{id, fade_in_duration, fade_out_duration, fade_type, type:audio_fade}`), referenced from `segment.extra_material_refs`. Re-applying replaces the existing fade instead of stacking. Rejects on non-audio segments. (Note: `--out` collides with the global output-path flag, so this command uses `--fade-out`.)
- **`capcut add-cover <project> <image-path> [--time <ms>]`** — set the draft's cover frame (thumbnail) to a local image. Writes a populated object on the draft root's `cover` field (was `null` in every template). Shape includes `path`, `type:image`, `time`, `time_ms` (both — CapCut versions disagree on the unit), and a `custom_cover_id` uuid. Validates the image path exists. `--time` defaults to 0.
- **`capcut add-filter <project> <slug> <start> <duration>`** + **`capcut enums --filters`** — colour-filter track separate from `add-effect`. Same `materials.video_effects[]` storage but `type:filter` and `category_name:Filter` so CapCut shows it in the filter rail. 10-slug starter catalogue for the CapCut namespace (`vintage`, `warm`, `cool`, `bw`, `sepia`, `vivid`, `contrast`, `faded`, `dramatic`, `soft`); JianYing namespace delegates to the 468 entries in `enums.json` via `--jianying`.
- **`capcut bubble-text <project> <text-segment-id> --bubble <slug>`** + **`capcut enums --bubbles`** — speech-bubble shape on a text segment. Writes a `materials.filters[]` entry (`type:text_shape`, matching pyJianYingDraft's `TextBubble.export_json`) plus stamps `bubble_effect_id` / `bubble_resource_id` on the text material — some CapCut versions read from the material directly, others from `filters[]`. 7-slug starter catalogue (`rectangle`, `rounded`, `cloud`, `oval`, `star`, `heart`, `burst`) plus `--effect-id` / `--resource-id` passthrough for users with custom ids.
- **`capcut import-ass <project> <ass-path-or-->`** — ASS / SSA subtitle import alongside `import-srt`. Zero-dep parser (`src/ass.ts`) reads `[Events]` / `Dialogue` lines, honours the `Format` header, strips inline overrides (`{\\b1\\an8}`) and `\\N` line breaks. Time format `H:MM:SS.cc` (centiseconds → microseconds). Shares the cue-to-segments pipeline with `import-srt` — same `--track-name`, `--style-ref`, `--time-offset`, and text-style flag surface.

### Fixed

- **`readFileSync("/dev/stdin", ...)` → `readFileSync(0, ...)`** in three call sites (`keyframe --batch`, `import-srt`, `serve` queue). Fixes `ENXIO: no such device or address` when the CLI was invoked with a piped stdin via `child_process.spawn`. The `/dev/stdin` device node fails to open in that mode on Linux; fd-0 always works.
- **`capcut init` falls back to a bundled template** at `templates/_init/` when the upstream `../CapCutAPI/template` directory isn't present. Previously broke on every machine that didn't have the Python project cloned alongside.

### Misc

- Test suite grew from 60 → 91 passing tests across 53 suites (six new test files, one per shipped command).
- Husky pre-commit gate stayed green throughout the v0.5 cycle — every feature commit includes its tests and passes before being pushed.

## [0.3.2] — 2026-05-15

### Added — README polish for discoverability

- **Workflow diagram** (Mermaid) at the top of both READMEs showing how `capcut-cli` fits into a viral-shorts pipeline (long video → cut → LLM hook → CLI edits → CapCut render → publish). GitHub renders Mermaid natively; no committed image. Mirrored in [`README.zh-CN.md`](./README.zh-CN.md) with 小红书 / 抖音 / 视频号 labels.
- **Comparison table** vs `pyJianYingDraft` (Python, JianYing-only), `CapCutAPI` (Python + HTTP server), and `cutcli` (Go, closed-source). Shows the unique positioning: only `capcut-cli` is zero-dep Node + cross-namespace (CapCut + JianYing) + has a shipped schema reference + ships built-in templates.
- **Feature checklist** — categorized list of every shipped command with ✅ / ⬜ / 🚫 status and anchor links to the relevant docs section. 10 categories: Project I/O, Add content, Edit, Decorators, Templates, Import & discovery, Source materials, Cross-platform, Output, Quality, Roadmap. Mirrors the structure that drove `pyJianYingDraft` to 3,266 stars.

No code changes; CLI surface is bit-for-bit identical to v0.3.1.

## [0.3.1] — 2026-05-15

### Added

- **`docs/draft-schema/`** — 7-file reference for the CapCut / JianYing project JSON: overview, tracks-and-segments, materials, keyframes-and-animations, effects-filters-stickers-masks-transitions, CapCut↔JianYing version differences. Practical, field-level, derived from real drafts + `pyJianYingDraft`. Closes the most-asked question for anyone writing tooling against the format: "what's the JSON shape?"
- **`node:test` fixture-backed test suite** — 36 tests across 5 test files (`inspect`, `edit`, `create`, `template`, `decorators`) covering the major CLI surface against the canonical `test/draft_content.json` fixture. ~1 second total runtime.
- **Husky pre-commit hook + Biome lint** — every commit runs `lint-staged` (Biome check/format on staged files only) followed by the full `node:test` suite. Cheap (<10s on a clean tree), catches regressions before they hit npm. Skipping with `--no-verify` should be rare.
- **`npm run test` / `test:fast` / `lint` / `lint:fix` / `format` scripts** in `package.json`.

### Changed

- Test runner: shell-based `scripts/_test.sh` (which tests skill wrappers) remains, but the canonical CLI test suite is now `test/*.test.mjs` via `node --test`. CI-friendly, parallel, cross-platform.

## [0.3.0] — 2026-05-15

Five phases of new commands ported from the upstream Python project (sun-guannan/VectCutAPI / CapCutAPI), all keeping the original zero-dep, local-only, JSON-by-default, pipeable design. No new runtime, no network beyond the Wikimedia gate, no Python at runtime.

### Added — Phase 1: decorators on existing segments

- **`capcut keyframe`** — add keyframe(s) to a segment for `position_x`, `position_y`, `rotation`, `scale_x`, `scale_y`, `uniform_scale`, `alpha`, `saturation`, `contrast`, `brightness`, `volume`. Single-shot and `--batch` (JSONL on stdin) modes. Value parsing accepts `"50%"`, `"+0.5"`, `"45deg"`. Writes to `common_keyframes` on the segment, appends to existing per-property lists, sorted by time offset.
- **`capcut transition`** — attach a transition between segments. Starter catalogue: `dissolve`, `rgb-glitch`, `radial-blur`, `horizontal-blur`, `vertical-blur-ii`, `twinkle-zoom`, `urban-glitch`, `shake-3`. `--duration <s>` override.
- **`capcut mask`** — attach a mask: `linear | mirror | circle | rectangle | heart | star`. Flags: `--center-x`, `--center-y`, `--size`, `--rotation`, `--feather`, `--invert`, `--rect-width`, `--round-corner`. `capcut mask <project> <id> --off` removes all masks.
- **`capcut bg-blur`** — background blur level 1–4 (light → maximum, mapping to `0.0625 / 0.375 / 0.75 / 1.0`). `--off` to clear.
- **`capcut text-style`** — rich text styling on an existing text segment: `--alpha`, `--vertical`, `--fixed-width/-height`, `--shadow` (+ `--shadow-alpha/-angle/-color/-distance/-smoothing`), `--border-width/-color/-alpha`, `--bg-color/-alpha/-style/-round-radius/-width/-height/-h-offset/-v-offset`.
- **`capcut text-anim`** — text intro/outro animations. Slugs: `fade-in`, `fade-out`, `typewriter`, `pop-up`, `throw-out`, `blur-text-in`, `zoom-in-text`. Per-side duration overrides.

### Added — Phase 2: new track types

- **`capcut add-sticker`** — create a sticker track + segment from a CapCut resource id, with `--x/-y/-scale/-rotation/-track-name` transforms.
- **`capcut add-effect`** — scene/character effect on its own effect track. Starter catalogue (CapCut namespace): `shake`, `vhs`, `cinematic`, `light-leak`, `film-grain`, `chromatic`, `vignette`. `--params <json-array>` of 0–100 effect parameters.
- **`capcut image-anim`** — intro/outro/combo animations on video / image segments. Slugs: `fade-in`, `flash-in`, `pulsing-zooms`, `scroll-up`, `stripe-merge`, `zoom-out`, `fade-out`, `blur-out`, `smoke`.

### Added — Phase 3: import + enum discovery

- **`capcut import-srt`** — parse an SRT file and create one text segment per cue. Accepts a file path or `-` for stdin. Flags: `--track-name`, `--time-offset <s>`, `--style-ref <segment-id>` (copy styling from an existing text segment), plus explicit text-style flags. Zero-dep parser; single `saveDraft` for the whole file (fast on hundreds of cues).
- **`capcut enums`** — list valid enum values for AI agents: `--transitions`, `--masks`, `--text-intros/-outros/-loop-anims`, `--image-intros/-outros/-combos`, `--scene-effects`, `--character-effects`, `--audio-effects`, `--fonts`. Output is JSON by default (`slug`, `member`, `name`, effect/resource ids, md5, durations) or a human-readable table with `-H`. Reads from a committed `enums.json` extracted from `pyJianYingDraft` (13 categories × 2 namespaces, ~790 KB).

### Added — Phase 4: multi-style text + JianYing namespace

- **`capcut text-ranges`** — multi-style text. Different styling per character range in a single text segment. `--styles @path.json` or inline JSON: `[{"start":0,"end":5,"font_color":"#FFD700","font_size":18,"bold":true},…]`. Sorts + validates non-overlap, emits baseline-style fillers for gaps so CapCut renders the whole text. Unlocks word-level highlight captions.
- **`--jianying` global flag** — threaded through `transition`, `mask`, `text-anim`, `image-anim`, `add-effect`, and `enums`. Selects the JianYing enum namespace (default is CapCut). Lookup falls back to `member` name, so `capcut transition <project> <id> "_3D空间" --jianying` works.

### Added — Phase 5: Wikimedia Commons input

- **`add-video` / `add-audio` accept Wikimedia URLs** — `commons.wikimedia.org`, `*.wikipedia.org`, `upload.wikimedia.org` page URLs and direct CDN URLs all resolve through the Commons imageinfo API to a canonical `File:` title.
- **License classifier + refusal gate** — `permissive` (CC*, PD, CC0, etc.), `fair-use`, `restrictive` (NC, ND, ©), `unknown`. Restrictive/unknown require `--force-license`. Fair-use downloads with a warning. Output JSON carries a `wikimedia` block with `artist`, `credit`, `description_url`, license raw + class, dimensions, mime — drop-in attribution for YouTube descriptions.
- **Single on-disk copy** — assets download directly into `<draft>/assets/<kind>/`. No temp-dir churn; `addVideo` / `addAudio` `copyFileSync` becomes a no-op.

### Added — packaging

- **Ready-made templates** ship in `templates/`: `gold-title.json`, `end-card.json`, `subscribe-cta.json`. Use directly via `capcut apply-template ./project ./node_modules/capcut-cli/templates/<name>.json <start> <duration>`.
- **`.github/FUNDING.yml`** — enables GitHub Sponsors + Gumroad links on the repo sidebar.
- **`--help` footer** — every `capcut --help` now ends with links to the full viral-shorts pipeline (Gumroad / Stripe), guides, Sponsors, and contact.

### Skill + docs

- `skills/capcut-edit/` reorganised into `references/` + `scripts/` + `assets/`. `SKILL.md` trimmed; `references/api-reference.md` covers every command and flag; `references/workflows.md` documents which `scripts/*.sh` to call (not how to reconstruct them); `references/pitfalls.md` covers the gotchas (close-project-first, `.bak`, `clip=null` on audio, etc.).
- Wrapper scripts: `fade-in.sh`, `fade-out.sh`, `anim.sh`, `ken-burns.sh`, `long-to-short.sh`, `stamp-cta.sh`. All covered by `scripts/_test.sh` (7/7 passing).

### Changed

- `npm run build` now does `tsc && cp src/enums.json dist/enums.json` so the runtime reads the dist copy via `import.meta.url`.
- `npm run extract-enums` regenerates `src/enums.json` from `pyJianYingDraft`.

### Notes

- All five phases keep capcut-cli zero-dep at runtime — no Python, no FFmpeg, no network beyond the explicit Wikimedia opt-in (which is `fetch`-based, no external deps).
- HTTP server, MCP server, ffprobe-based duration probing, FFmpeg letterboxing, and cloud rendering remain explicitly out of scope per `PLAN.md`.

## [0.2.2] — 2026-04-26

- README CTAs to Viral Story Shorts Blueprint (Gumroad).

## [0.2.1] — 2026-04-26

- npm tarball now includes `examples/` and Chinese README.

## [0.2.0] — 2026-04-26

- Long-form videos to shorts, end to end.

[0.3.2]: https://github.com/renezander030/capcut-cli/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/renezander030/capcut-cli/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/renezander030/capcut-cli/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/renezander030/capcut-cli/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/renezander030/capcut-cli/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/renezander030/capcut-cli/releases/tag/v0.2.0
