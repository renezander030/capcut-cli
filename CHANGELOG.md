# Changelog

All notable changes to capcut-cli are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.15.0] — 2026-07-24

Four features in one release — the next slice of the opportunity backlog, bundled. Two of them deliberately change existing behaviour: mutating commands now refuse to write drafts beyond the collected version evidence (override with `--force-write`), and `--intensity` on `add-filter`/`add-effect` is now applied instead of silently ignored. With none of the new flags in play, every written draft stays byte-identical to v0.14.0 (the `version` and `diagnose` reports gain additive fields and honest evidence labels — see Fixed).

### Added

- Write-time version guard — every mutating save (`saveDraft`, and `sync-timelines --apply`, which writes outside it) now assesses the draft's version markers before writing and refuses when the draft is beyond collected evidence or known-broken: JianYing ≥ 6.0 (the encrypted era), CapCut beyond the 9.x evidence ceiling, and top-level schema integers newer than the known 360000 generation. The refusal is actionable and ends with the fixture-collection CTA; `--force-write` overrides with a stderr WARNING (the global flag's description now names version-boundary checks alongside editor-running and changed-on-disk). The effective version is the max of `platform`, `last_modified_platform`, and the newest readable sibling timeline, so a newer-app mirror trips the guard too; markerless CLI-created drafts never trigger. **Behaviour change:** these drafts previously saved without complaint. Companion surfaces: `capcut version` reports `schema_int` / `evidence` / `beyond_known_range` / `write_guard`, `diagnose` gains a version-boundary `next_action` plus a `write_guard` field, and `sync-timelines` names the draft_info-primary Mac layout when `draft_content.json` is absent.
- `remove <project> <segment-id> [--keep-track] [--keep-materials]` — delete a segment in place. The segment leaves its track; a track the removal empties is dropped (`--keep-track` keeps it with `segments: []`); the materials only that segment referenced — its source material plus every `extra_material_refs` companion (speed, canvas, sound_channel_mapping, vocal_separation, ...) — are garbage-collected with the same sweep `prune` uses, so pre-existing orphans go in the same pass and a material another segment still references is never deleted; `--keep-materials` skips the sweep (run `prune` later). The draft duration is recomputed as the max segment end across ALL tracks — removing every segment leaves `tracks: []` and duration 0 — and the removal is mirrored into readable sibling timeline files (`draft_info.json`). Unknown or missing segment id: exit 1, no write, no `.bak`. Mutating, atomic save with `.bak` + history snapshot, honors `--dry-run`; `restore` undoes a remove byte-for-byte. `--keep-track`/`--keep-materials` are release-scoped, so the tokens stay verbatim free text on every other command.
- `add-filter` / `add-effect` grow a raw-store escape hatch and range ergonomics — usage is now `<slug-or-name> (<start> <duration> | --full)`:
  - `--resource-id <id>` applies a raw catalogue/store resource id, skipping slug lookup entirely — the positional becomes the display name; `--effect-id <id>` sets a distinct effect id when the store entry carries one (defaults to `--resource-id`, rejected without it). Unknown-slug errors keep their helpful hint.
  - `--intensity <0..1>` writes the strength as the material `value` (default 1). **Behaviour change:** previously the flag was silently ignored and the material was always written at full strength; out-of-range or non-numeric values now exit 1.
  - `--full` spans the whole timeline (start 0, duration = draft duration) without the `<start> <duration>` positionals, wins when both are given, and exits 1 on a draft without a usable duration.
  - `--bind <segment-id>` (`add-effect` only, **experimental**) attaches the effect to one segment instead of the whole frame — `apply_target_type` 0 plus `bind_segment_id`; short id prefixes resolve, and an unknown id exits 1 leaving the draft untouched.
  - On the plain slug path the output stays byte-compatible (`value` 1, `source_platform` 0); the new flags are release-scoped like their v0.13/v0.14 siblings.
- `lint` unknown-slug coverage now spans every effect-shaped material array the CLI writes — previously only `materials.video_effects` was checked: transitions, masks (`resource_id` only — mask materials carry no `effect_id`), audio effects (`sfx`), and `materials.filters` (colour filters plus the text-shape bubbles that share the array), with the bubble catalogue added to the known-id table; CLI-written decorations never self-flag. New `unknown-font-id` info check on text materials (pyJianYingDraft#192): a font resource id CapCut doesn't know is silently replaced with the default font, so ids from `font_id` / `font_resource_id` / embedded content styles are checked against the bundled font table, and a resolvable on-disk font path silences the check because CapCut loads the file regardless of id. Info-severity and report-only by design — a repair would guess the author's font — and `--fix` leaves both codes untouched.

### Fixed

- The JianYing "6.0.0+" version-registry match was dead code — a literal prefix comparison that could never fire — so encrypted-era JianYing drafts were reported as merely unknown. A structured ≥ 6.0 matcher replaces it and reports the era as known-broken. Registry claims are aligned with the evidence labels in [docs/version-support.md](./docs/version-support.md): 6.2.8 fixture-tested, 8.7.0 synthetic-tested, 6.5–9.0 expected-compatible instead of a blanket tested claim.

## [0.14.0] — 2026-07-17

Five features in one release — the next slice of the opportunity backlog, bundled. Two build on prior art from the [capcut-cli-david](https://github.com/Davidb-2107/capcut-cli-david) fork (thanks @Davidb-2107). The sixth backlog item, keyframeable mask geometry (#44), is deliberately **not** in this release: no public ground truth exists for the on-disk encoding, and a guessed encoding would silently no-op in the app — it ships once a real app-authored mask-keyframe draft is captured.

### Added

- `duplicate <project> <segment-id> [--track <track-name>] [--new-track]` — duplicate a segment at the SAME timeline position and duration onto a track that renders above the source: the PIP local-retouch flow from #44 (copy the clip above itself, then `mask` the copy) without hand-editing JSON. By default — and with the explicit `--new-track` — the copy goes onto a fresh track of the same type inserted directly after the source track in the tracks array: `sortTracks` is stable within a type and a later same-type track renders above, so the copy sits exactly on top of its source (a second copy gets a unique `<name>-copy-2` track name). `--track <track-name>` places the copy onto that existing same-type track instead, and exits 1 with a clear error when the target range is occupied there, when the track is missing, or when its type does not match the source segment's; `--track` and `--new-track` together are rejected. ID hygiene: the new segment gets a fresh id; the source material entry — media included — is cloned with a fresh id (the media FILE on disk stays shared), so material-level edits on the copy (`crop`, `mix-mode`, `replace-media`) never leak to the source segment underneath it; every per-segment companion referenced via `extra_material_refs` (speed, placeholder_info, sound_channel_mapping, vocal_separation, canvas, material_color, masks, animations, ...) is cloned the same way — the app treats those as per-segment instances, so two segments never share one. Embedded keyframe list/entry ids are re-minted on the copy. The timeline duration is unchanged. Prints `{ new_segment_id, track_name, cloned_materials }` plus the copy's `material_id`, `track_id`, and `new_track`; mutating, atomic save with `.bak` + history snapshot, honors `--dry-run`.
- `register <project-dir> [--apply] [--drafts <dir>]` — the meta-repair sidecar for EXISTING drafts. `init` registers only the drafts it creates, so an existing folder missing its `draft_meta_info.json` sidecar or its entry in the store's `root_meta_info.json` is invisible to the CapCut app with no repair path (`doctor` checks the environment, `diagnose` is read-only). `register` derives id/name/duration from `draft_content.json` — a read-only source that is **never** written — and reports per target (`needs_repair`, per-target `state`/`action`/`detail`/`stale_fields`). Accepts the project directory or its `draft_content.json` path (any other filename exits 1). Plan-only by default (always exit 0); `--apply` recreates a missing/corrupt sidecar and inserts/updates the index entry — new entries clone the shape of an existing entry so they match the installed CapCut version, updates repair only the stale identifying fields (`draft_id`, `draft_fold_path`, `draft_json_file`, `draft_root_path`, `tm_duration`) in place and preserve everything else, including a non-empty `draft_name` (CapCut's display name is user data). Writes are atomic (temp+fsync+rename) with a `.bak` per file that already existed; `applied` / `backups` list exactly the files written. Idempotent: a re-run writes nothing and reports `applied: []`, exit 0. The store root is the draft's parent directory and must be *known* — a `root_meta_info.json` beside the draft folder, a managed `com.lveditor.draft` path (init's default location), or an explicit `--drafts <dir>` (which, like `init`, creates the index on a fresh store); a draft outside any known store root is reported explicitly and nothing is written. An unreadable `root_meta_info.json` is never rewritten (it lists every draft) and is reported blocked instead. `--apply` refuses while the editor is running and when a target changed on disk since the plan read, unless `--force-write`; `--apply --dry-run` previews (`would_apply`, `applied: []`). Exits 2 on `--apply` when a target stays blocked (unknown store root, unreadable index). `diagnose` now recommends the `register` plan form when it sees `draft_meta_info.json` missing.
- `crop <project> <segment-id> [--ratio <r> | --rect <x,y,w,h> | --reset]` — read and set the crop on a video/photo segment's source material: the 8-corner normalized struct CapCut stores on `materials.videos[]`, which the factory wrote full-frame at creation and no command could read or edit before. With no flags the command is read-only: it prints the material's crop struct as JSON plus the stored source `width`/`height` (`crop` is `null` when the material carries none) and writes nothing. `--ratio <free|1:1|16:9|9:16|4:3|3:4>` computes the centered maximal crop of that aspect against the source dimensions stored in the draft — when the dims are missing or zero it exits 1 with an error that points at `--rect` (`free` restores the full frame without needing dims). `--rect <x,y,w,h>` sets an explicit normalized rect, all values 0..1 fractions of the source frame, validated as `x,y >= 0`, `w,h > 0`, `x+w <= 1`, `y+h <= 1` (a float-ulp tolerance keeps sums like `0.3 + 0.7` valid, and the written corners are clamped to 1); `--rect` overrides `--ratio` when both are given. `--reset` restores the full frame. The corner mapping matches the factory default exactly — y grows downward: `upper_left = (x, y)`, `upper_right = (x+w, y)`, `lower_left = (x, y+h)`, `lower_right = (x+w, y+h)`. When the material carries a `crop_ratio` field it is stamped `"free"` — CapCut's preset enum values are not published, so the app recomputes from the corner points; stated in `--help`. Mutating command: registered in the mutating set, writes atomically with a `.bak` snapshot like its siblings, honors `--dry-run`, and prints the resulting crop JSON on write. The new `--ratio`/`--rect`/`--reset` flags are release-scoped to `crop`, so free-text positionals of other commands containing those substrings survive verbatim.
- `caption` / `import-srt` — per-word keyword emphasis and per-cue colour cycling as ergonomic flags, replacing hand-written `--styles` JSON for the viral-caption workflow (prior art: capcut-cli-david `--keyword-size` v1.15 and `import-captions --color-cycle`):
  - `--highlight-words <w1,w2,...|@file>` — case-insensitive **whole-word** matches per cue get an emphasis text range; `@file` reads one word/phrase per line (phrases match across spaces). Word boundaries are Unicode-aware, so `für` matches in `Grüße für alle` but never inside `fürs`, and `cap` never matches inside `capcut`. Overlapping matches (e.g. `New York` + `York`) keep the earlier one.
  - `--keyword-color <#RRGGBB>` — emphasis colour; defaults to `#FFD700`, the same gold `caption --karaoke` paints the active word with (now the shared `KARAOKE_HIGHLIGHT_COLOR` constant). Requires `--highlight-words`.
  - `--keyword-size <multiplier>` — emphasis size as a multiplier on the **cue's base font size** (style-ref/preset/`--font-size` aware), default 1.2 when `--highlight-words` is present. Validated: must be > 0 and <= 10. Requires `--highlight-words`.
  - `--color-cycle <#hex1,#hex2,...>` — rotates the BASE text colour per cue in list order, wrapping around; an independent axis from keyword emphasis. Precedence: explicit `--color` still sets the base colour for all cues unless `--color-cycle` is given (then the cycle wins per cue).
  - **Precedence contract (documented in `--help`):** keyword emphasis ranges sit on top of base/karaoke styling and override the matched words' colour/size; with `--karaoke`, karaoke ranges are built first and keyword matches override those words while inheriting their bold — the v0.13 "explicit flags beat preset ranges" spirit.
  - **One offset scheme.** Emphasis ranges are computed in the exact code-unit → UTF-16LE-byte scheme `text-ranges`/`setTextRanges` and the karaoke writer already use — correct for multibyte text (umlauts, CJK); no second offset scheme was introduced.
  - The four flags are release-scoped like the v0.13 parser additions: on commands that don't declare them (everything except `caption` and `import-srt`) the tokens fall through to free-text positionals verbatim.
  - JSON output gains `keyword_matches` / `color_cycle` **only when the flags are used**; with no flags, behaviour and output are byte-identical to v0.13.

### Fixed

- Every user-supplied text/JSON read now tolerates a leading UTF-8 BOM (`U+FEFF`), the byte prefix Windows PowerShell's `Set-Content` (and some editors) writes — previously the draft failed to load with a JSON parse error, `.capcutrc` was silently ignored, and the SRT/ASS/JSONL parsers misread the first token. Covered paths: `draft_content.json` / `draft_meta_info.json` / `root_meta_info.json` and every other draft store candidate, `--preset` files, `@file` arguments (e.g. `text-ranges --styles @ranges.json`, `--highlight-words @words.txt`), stdin (`import-srt -`, `import-ass -`, `batch`, `keyframe --batch` JSONL), subtitle files (`import-srt`, `import-ass`, `quickstart --srt`, `compile` captions ops), `compile` specs, template files, and `.capcutrc`. The CLI never writes a BOM: saving a BOM'd draft drops it (atomic write, `.bak` and history snapshots preserve the loaded content), the concurrent-change guard no longer reports a BOM-only difference as "changed on disk", and `fixture` bundles are emitted BOM-free. Output for BOM-free files is byte-identical to before. Prior art: capcut-cli-david `eb2f0e0` (thanks @Davidb-2107).

## [0.13.2] — 2026-07-08

### Documentation

- Wider README hero / `media/og-card.png` banner (1280x640, 2:1) replacing the 0.13.1 card. Docs-only release; no code changes.

## [0.13.1] — 2026-07-08

### Documentation

- Refreshed the README hero / `media/og-card.png` social card (EN + zh reference the same asset). Docs-only release; no code changes since 0.13.0.

## [0.13.0] — 2026-07-08

Six features in one release — the top of the opportunity backlog, bundled. Two build on prior art from the [capcut-cli-david](https://github.com/Davidb-2107/capcut-cli-david) fork (thanks @Davidb-2107); see #36.

### Added

- `sync-timelines <project-dir> [--apply] [--force-write]` — reconcile a CapCut >= 8.7 draft whose `template-2.tmp` / `draft_info.json` timeline mirror has drifted from `draft_content.json`, so CLI edits are honored by the app instead of silently ignored. `draft_content.json` is always canonical and is treated read-only. Accepts only a project directory or its `draft_content.json` (any other filename exits 1). Plan-only by default: the per-target drift report includes each mirror's mtime plus `newer_mirrors` / `canonical_stale`, and warns when `draft_content.json` is older than a drifted mirror (you would overwrite newer edits). `--apply` refuses that direction unless you add `--force-write` (exit 1), then rewrites **only** the drifted mirrors — the canonical file is never re-sorted or backed up, and in-sync mirrors are left untouched; `reconciled` / `backups` list exactly the files written. No-ops with exit 0 when all targets already agree. An unreadable (binary/encrypted) mirror is reported unreconcilable (`ok:false`, `in_sync:false`, exit 2) and stays idempotent on re-run instead of pretending success. `--apply --dry-run` reports the plan only (`would_reconcile`, `reconciled: []`). `diagnose` now recommends the plan form (with a back-up caution) instead of deferring to issue #35. Closes #39.
- `lint <project> --fix` — auto-repair mechanically-fixable draft defects, now four codes: `cue-too-long` (trims over-long captions to the configured cap), `caption-overlap` (shortens overlapping pairs so each ends where the next begins), `line-too-long` (greedy word wrap that swaps spaces for newlines 1:1, keeping styled-range byte offsets valid; never splits words — instances the wrap cannot actually fix, i.e. space-less/CJK text and over-cap single words, are stamped `fixable:false`), and `caption-gap-too-small` (pulls the earlier caption's end back to restore the minimum gap; never moves starts, never creates a new overlap). The gap repair honors a hard floor — exported `MIN_CAPTION_DURATION_US = 100_000` (100ms) — so a shrink that would land a caption below the floor is skipped and stamped `fixable:false` for that instance instead of collapsing it. Writes atomically with a `.bak` snapshot; combine with `--dry-run` to preview. `missing-material` and `missing-file` stay report-only deliberately: the only mechanical repairs would delete user timeline content or act on host-dependent paths. Closes #40.
- `lint` — new report-only rule `unknown-effect-slug` (**info** severity, exit 0): flags effect/filter/animation resource ids in the draft that are not in the bundled enum table, surfacing them before CapCut silently drops them (the silent-failure mode reported across ecosystem tools, e.g. GuanYixuan/pyCapCut#12). Info rather than warning because store-downloaded effects on app-authored drafts are legitimate; only CLI-written stale slugs are at risk.
- `export-srt <project> [--granularity line|word] [--format srt|vtt]` — word-level caption export. Captions created by `caption --karaoke` carry real per-word timing and export it exactly; plain captions interpolate word timing proportionally by word length (stated in `--help`). SRT + word emits one cue per word; VTT + word emits one cue per phrase with inline `<hh:mm:ss.mmm>` karaoke timestamps for burn-in pipelines. Defaults (`line`, `srt`) reproduce the previous output byte-identically.
- `keyframe ... --easing <linear|ease-in|ease-out|ease-in-out>` — CapCut-native easing curves, also accepted per-line (`easing` key) in `keyframe --batch` JSONL and in the `compile` spec's keyframe op. The app does not store named curve types: the UI writes `FreeCurveInOut` bezier control handles on both keyframes of the eased segment, and the emitted encodings are locked against a UI-oracle capture (prior art: capcut-cli-david). The `ken-burns` skill default changed linear → ease-out to match what the CapCut UI itself produces.
- `detect-scenes <video> [--threshold <0..1>] [--min-gap <s>] [--limit <n>] [--json]` — deterministic ffmpeg scene-cut detection (no AI, zero new dependencies) to seed the long-form → shorts flow: prints detected cut points (seconds, `hh:mm:ss.mmm` timecode, scene score) plus a ready-to-use contiguous segment list in seconds and draft-native microseconds. Follows the `probe`/`render` external-binary pattern, including a clear actionable error when ffmpeg is missing.
- `make-preset <project> <text-segment-id> --out <preset.json>` — extract a hand-tuned text style (font, colors, style flags, alignment/transform, bubble, karaoke/multi-style ranges) from an existing draft into a versioned, portable preset file; apply it with the new `--preset <file>` flag on `add-text`, `text-style`, and `caption`. Addresses the recurring ecosystem ask for programmatic font/style reuse (GuanYixuan/pyJianYingDraft#192, Hommy-master/capcut-mate#57). Contract:
  - **Explicit flags beat the preset — including its ranges.** `--color` / `--font-size` override every captured `text_ranges` block over the covered span, not just the base style, so a karaoke/highlight preset re-renders in the flag color/size; applying the same preset without those flags preserves the per-range styling.
  - **Presets are schema-validated on load.** `transform` must be an object with finite numeric `x`/`y`, `bubble` must carry non-empty `effect_id`/`resource_id`, `text_ranges` must be an array of objects with integer `start`/`end` where `end > start` and correctly typed style fields. A malformed preset is rejected with a clear error and is never written into the draft.
  - **Rangeless preset onto a multi-range segment collapses the ranges.** Applying a preset that carries no `text_ranges` onto a segment that still holds multiple range blocks (leftover karaoke/highlight) collapses them to the single uniform preset style spanning the whole text — consistent with the "applies the full preset" contract. A preset that itself carries ranges applies them unchanged. Documented in `--help`.
  - **`make-preset --dry-run` writes nothing** — the `--out` file is neither created nor overwritten, and the JSON output reports `dryRun:true` with `written:false` (a normal run reports `written:true`).
- Parser: the value-consuming flags introduced in this release (`--threshold`, `--min-gap`, `--limit`, `--json`, `--granularity`, `--format`, `--easing`, `--preset`, `--apply`) are scoped to the commands that declare them instead of being consumed globally, so free-text positionals that contain a flag-like substring survive verbatim (e.g. `add-text ... New Year --limit 5 drinks` stores the literal text). Flags that earlier releases already parsed globally are unchanged.

### Documentation

- `docs/version-support.md` — the CapCut 8.7 row now names `sync-timelines` as the repair path for drifted mirrors.
- `docs/draft-schema/03-keyframes-and-animations.md` — documents the `FreeCurveInOut` bezier-handle easing encoding.

## [0.12.0] — 2026-06-27

### Added

- `quickstart <name> [--video <f>] [--audio <f>] [--srt <f>]` — the one-command path from a single file to an editable draft. Creates the draft, adds the input (durations from ffprobe when available, a 5s placeholder otherwise), lints it with the same checks as `lint`, inspects the storage layout like `diagnose`, and prints the exact open-in-CapCut step. Exit 0 when created and lint-clean, 2 when created with lint errors. Reduces first-run friction for a CLI that now has 50+ commands.
- `fixture <project> --out <dir>` — build a shareable, redacted compatibility bundle. Copies only the timeline JSON (never `assets/` media), redacts user home paths and email addresses, and writes a reporter README plus a diagnose report. Automates the "attach a sanitized project folder" step in the version-support flow so reporters can safely contribute the real CapCut 8.7 (issue #35) fixtures the storage adapter still needs.
- `replace-media <project> <segment-id> <new-file> [--retime]` — swap a segment's source clip in place (placeholder/proxy > final render) while preserving its timeline position, timing, effects, and keyframes. Copies the file into `assets/` and refreshes intrinsic duration/dimensions via ffprobe. Distinct from `relink`, which only repairs broken paths by basename. Warns when the new clip is shorter than the segment uses; `--retime` fits the segment to the new clip. Honors `--dry-run` (no write, no copy). This is the assemble-with-placeholders-then-swap-in-finals workflow that fits the CLI's local, deterministic, agent-drivable positioning.

### Documentation

- `docs/jianying-encryption.md` — decision record for JianYing 6.0+ draft encryption: detect, do not decrypt, with the rationale (legal posture, algorithm in flux) and the tripwires that would reopen the decision. `capcut decrypt` now links to it.
- `docs/version-support.md` — the reporting flow and the CapCut 8.7 row now reference `capcut fixture` for one-command sanitized bundles.

## [0.11.3] — 2026-06-20

### Documentation

- Synchronized the English and Chinese READMEs with the shipped v0.11 surface: version-aware storage, v0.11.2 Windows fixes, six templates, 13 enum categories, 205 tests, the full cross-platform CI matrix, and the current GitHub Action reference.

## [0.11.2] — 2026-06-20

### Fixed

- Windows now resolves the bundled template and spawned `serve` CLI through proper filesystem paths instead of URL pathnames, fixing `init`, `compile`, and queued jobs on drive-letter paths.
- ESM test imports use `file:` URLs on Windows, and a single-file `restore` preserves the backup's exact bytes.
- The full Node 20 suite now passes on Windows, macOS, and Linux in GitHub Actions.

## [0.11.1] — 2026-06-20

### Fixed

- GitHub Actions on Windows now uses Node's built-in test discovery instead of relying on POSIX shell expansion of `test/*.test.mjs`.

## [0.11.0] — 2026-06-20

A reliability and automation release spanning the full draft lifecycle. It closes the highest-value gaps found in the v0.10.1 repository audit while preserving the zero-runtime-dependency core.

### Added

- **CapCut 8.7+ draft store** — version-aware discovery of `draft_content.json`, `draft_info.json`, `draft_meta_info.json`, and `template-2.tmp`, including nested/string JSON envelopes. Every readable timeline target is synchronized on write.
- **`diagnose`** — redacted storage report with canonical-file selection, hashes, timeline divergence, editor-process detection, and `--bundle <report.json>` output for compatibility reports.
- **Command contract v2** — `describe` now exposes usage, typed positionals/options, defaults/enums, mutability, prerequisites, output form, and exit codes for every command. Help, completions, generated docs, and the typed `runCommand()` library API consume the registry.
- **`compile` v2** — stable item refs, source timing, speed/volume/opacity/transforms, transitions, filters, effects, keyframes, audio fades, templates, SRT captions, text styles/ranges, plus `--check` / `--plan` validation without writes.
- **Caption adapters + karaoke** — explicit OpenAI Whisper, whisper.cpp, and faster-whisper dialects; word-timestamp parsing/grouping; `--karaoke`, `--max-words`, `--max-chars`, and `--max-gap-ms` generate time-varying highlighted caption segments.
- **Full media probing** — ffprobe duration, FPS, display rotation, dimensions, codecs, audio presence/channels, and a path+mtime cache. `add-video`, `add-audio`, and `compile` can infer omitted durations.
- **Higher-fidelity proxy rendering** — optional `--all-video-tracks` composition with transforms/opacity, audio fades, draft caption colour/size/position, explicit skipped-feature reports, and FFmpeg capability detection/fallbacks.
- **Reliable `serve` runner** — bounded async workers, per-project serialization, stable job-ID deduplication, retry/backoff, configurable timeout/output limits, and safe capture for outputs larger than 64 KiB.
- **Cross-platform CI smoke matrix** — Node 20 tests on Ubuntu, macOS, and Windows in addition to the existing Node 18/20/22 Linux matrix.

### Changed

- **Conflict-safe atomic persistence** — writes are prepared and fsynced before same-directory rename, every synchronized target receives a backup/history snapshot, changed-on-disk drafts are refused, and managed drafts are protected while CapCut/JianYing is running. `--force-write` is the explicit override.
- **Transactional `batch`** — all operations validate against cloned state and commit once. Any failure writes nothing by default; `--continue-on-error` intentionally commits only successful operations and exits non-zero.
- **`doctor`** — now reports ffprobe and detailed FFmpeg filter/encoder capabilities alongside Whisper and project-directory checks.
- **Lint gate** — warnings now fail `npm run lint`; the existing lint debt was removed.

### Fixed

- Large JianYing enum and `serve` results no longer truncate at the macOS 64 KiB synchronous pipe boundary.
- Proxy-render tests no longer assume every installed FFmpeg build includes `drawtext`; caption burn falls back cleanly when it is absent.
- Stale roadmap, version-support, Chinese README, skill reference, test-count, and release metadata claims were synchronized with the shipped surface.

## [0.10.0] — 2026-06-08

Two commands that close the two biggest gaps in a headless CapCut workflow: seeing the result, and authoring a whole draft in one shot. No breaking changes; still zero npm-dep and JSON-by-default. Both shell out to `ffmpeg` only when actually rendering, the same opt-in external-binary pattern `caption` uses for whisper.

### Added

- **`render`** — a low-res **ffmpeg proxy preview** of a draft, so you can watch an edit without opening CapCut. Flattens the main video track (per-segment source trim + speed), scales to a proxy size (`--scale`, default 0.5), mixes every audio-track segment, and optionally burns the text segments in with `--burn-captions`. It is explicitly a preview, **not** CapCut's final render (no multi-track video compositing, no effects/transitions). The ffmpeg command is built by a pure, deterministic `buildRenderPlan` that is unit-tested without invoking ffmpeg; `--dry-run` prints that plan instead of executing (and needs no ffmpeg). Read-only — never mutates the draft.
- **`compile`** — builds a whole draft from a declarative **JSON spec** (the inverse of `describe`): instead of chaining dozens of mutating `add-*` commands, an agent emits one spec and `compile` constructs the draft atomically via the same proven factory functions the imperative commands use. Times are in seconds (converted to CapCut's microseconds); media paths resolve relative to the spec file. The full spec is validated — and every media file checked to exist — **before** anything is written, so a bad spec fails clean. Writes both `draft_content.json` and `draft_info.json` so every downstream command reads the same data.

## [0.9.0] — 2026-06-03

Ten new commands/capabilities across inspection, maintenance, composition, and agent-integration. No breaking changes; still zero-dep, JSON-by-default, pipeable.

### Added

- **`describe`** — emits the full command surface as JSON (name, version, global flags, every command + summary) so LLM/agent callers get a tool spec instead of scraping `--help`. A test enforces that every command has a summary, so nothing ships undescribed.
- **`prune`** — removes materials no segment references. The referenced set is the union of every segment's `material_id` **and** `extra_material_refs[]`, so masks/effects/animations/fades referenced indirectly are never wrongly deleted. Pairs with `--dry-run`.
- **`relink`** — repairs broken media paths. `--dir <folder>` repoints each missing material to a same-basename file in the folder; `--from <p> --to <q>` prefix-replaces paths. Reports relinked / still-missing / present counts. Pairs with `--dry-run`.
- **`timeline`** — shows the track/segment layout. JSON default returns lanes with computed columns; `-H` renders ASCII bars (`--cols N`, default 60). Makes layout/track-order issues diagnosable without opening CapCut.
- **`projects`** — lists CapCut/JianYing draft folders on disk (scans the per-OS default dirs or `--drafts <dir>`), with an optional name-substring filter and `--names` to read each draft's title. No more pasting 40-char UUID paths.
- **Multi-step undo** — every write now also keeps a rolling snapshot history under `<draftdir>/.capcut-cli-history/` (capped at 20). `restore --step N` rolls back N writes (step 1 == the `.bak`); `restore --list` shows the history. Plain `restore` is unchanged.
- **`diff`** — compare two drafts: segments added/removed/changed (start/duration/material/speed/volume), and materials added/removed/**changed** (a text edit mutates the material in place, so this is where `set-text` shows up). Read-only.
- **`concat`** — append one draft onto another's timeline: B's segments are time-shifted by A's duration, and any B material/segment id that collides with A is reassigned a fresh uuid (with references rewritten) so the merge stays valid. Writes to `--out` or in place.
- **`config`** — defaults (`drafts` dir, `jianying`, `cols`) can be set in a `.capcutrc` (cwd, then home; CLI flags win). `capcut config` prints the resolved file and effective values.
- **Windows `export --batch`** — the Windows path now ships: PowerShell opens each draft and sends CapCut's export shortcut (Ctrl+E). Same experimental UI-automation caveat as macOS. (Live render is host-dependent; the script generation is unit-tested.)

## [0.8.0] — 2026-06-03

Safety, discoverability, and a long-overdue track-order fix. No breaking changes; everything stays zero-dep, JSON-by-default, and pipeable.

### Added

- **Global `--dry-run`** ([#15](https://github.com/renezander030/capcut-cli/issues/15)) — any draft-mutating command now honors `--dry-run`: it computes and prints the normal JSON result with `"dryRun":true` added, but leaves the draft **and** its `.bak` untouched. Gated centrally in `saveDraft`, so it covers every write command at once. `translate` / `export --batch` keep their existing dry-run behavior.
- **`restore` command** ([#16](https://github.com/renezander030/capcut-cli/issues/16)) — `capcut restore <project>` undoes the last write by copying `<draft>.bak` back over the draft. Single-step (only one backup generation is kept); exits non-zero with a clear message when no `.bak` exists. Honors `--dry-run`.
- **Shell completions** ([#18](https://github.com/renezander030/capcut-cli/pull/18), [#19](https://github.com/renezander030/capcut-cli/pull/19), [#20](https://github.com/renezander030/capcut-cli/pull/20)) — `capcut completions <bash|zsh|fish>` generates a completion script for command names and global flags.

### Fixed

- **Track order scrambled on import** ([#21](https://github.com/renezander030/capcut-cli/issues/21)) — tracks were written in the order edit commands ran, but CapCut lays out the timeline from the tracks-array order, not from per-segment `render_index`, so building a draft incrementally produced a jumbled timeline. `saveDraft` now normalizes the tracks array to the canonical bottom→top layer order (`video → audio → sticker → effect → filter → text`) on every save; the sort is stable so same-type tracks keep their authored order. Also exported as `sortTracks` from the library entry point.

### Documentation

- **README** — added a from-source install path and a consolidated Prerequisites note (Node ≥ 18, whisper for `caption`, `ANTHROPIC_API_KEY` for `translate`); a worked-example block for the v0.4/v0.5 commands that had none (`mix-mode`, `audio-fade`, `add-filter`, `bubble-text`, `add-cover`, `add-sfx`, `chroma`, `import-ass`); `--dry-run` / `restore` usage; and a **Troubleshooting** table covering the CapCut-must-be-closed footgun, track-order normalization, `.bak` recovery, whisper/API-key setup, and the `--fade-out` flag.
- **`CONTRIBUTING.md`** — build / test / lint commands, the `npm test` pre-commit gate, and PR conventions.

### Internal

- **Pre-commit hook rebuilds `dist/` before tests** ([#23](https://github.com/renezander030/capcut-cli/pull/23)) — the hook ran `test:fast` (no build step), so it could pass-or-fail against a stale `dist/`. It now runs `npm test`, which builds first.

## [0.7.0] — 2026-05-31

### Added

- **`templates` command** ([#13](https://github.com/renezander030/capcut-cli/pull/13)) — `capcut templates` lists the bundled templates (slug + description). JSON by default, `-H` for a table.
- **Global `--version` / `-v` flag** ([#12](https://github.com/renezander030/capcut-cli/pull/12)) — print the installed CLI version without a subcommand.

### Documentation

- **Independent / non-affiliation disclaimer + trademark notice** — README and metadata clarify the project is unofficial and not affiliated with ByteDance; "CapCut" / "JianYing" are used nominatively.

### Internal

- **Pinned Biome to 2.4.15** ([#14](https://github.com/renezander030/capcut-cli/pull/14)) and cleared auto-fixable lint debt.

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
