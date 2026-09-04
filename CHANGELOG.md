# Changelog

All notable changes to capcut-cli are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.22.0] — 2026-09-04

Nine items, each mined from a pain users are hitting now — this repo's own
threads, the forks ahead of it, the downstream projects that build on it
(vertir, qcut, OpenChatCut) and the neighbouring CapCut/JianYing libraries —
and each checked against what the CLI already did before it was built. The
cross-repo intersection was thin this cycle (the repo is mature; most hot
ecosystem pains are already shipped here), so the list leans on Tier-1
evidence: the sidecar registration is the one item with a concrete, reproduced
app failure behind it; the OTIO, script-alignment and retake items ride
long-standing asks in neighbouring tools; the last four are ergonomics the
downstream integrators and the most-diverged fork had to build for themselves.
No command was removed, no existing flag changed meaning, and every existing
JSON output keeps its shape — new fields appear only when the new flag is used.

### Added

- **`register --materials` — the CapCut 9.1 "file inaccessible" fix ([pyCapCut#13](https://github.com/GuanYixuan/pyCapCut/issues/13))** —
  newer builds decide which media is imported from draft_meta_info.json's `draft_materials`, not from the timeline's
  paths, so every tool-built draft (this CLI's included: the sidecar's groups were always empty) opened with each clip
  shown as inaccessible and a relink prompt. v0.21 could only observe the empty state (`media-unregistered`);
  `--materials` writes the registration: one type-0 entry per distinct local file, matched by `file_Path`, shape per
  pyCapCut PR [#14](https://github.com/GuanYixuan/pyCapCut/pull/14) (verified by its author against the 9.1.0 prompt;
  photos get the 5 s nominal duration, audio registers as `music`). It folds into register's own sidecar write — a
  missing sidecar is recreated and registered in one write, one `.bak`, one changed-on-disk check — merges rather than
  replaces (app-written entries untouched), and re-runs are no-ops. `lint`'s `media-unregistered` note and `diagnose`
  now name the command instead of asking for a fixture first; an app-authored 9.1 sidecar is still welcome as ground
  truth (`docs/draft-schema/00-overview.md` records what is measured and what is inferred).
- **`export-timeline --captions markers` + caption import in `import-timeline`** — OTIO has had no title/subtitle
  schema since the request was opened in 2017 ([OpenTimelineIO#62](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/issues/62),
  [#805](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/issues/805) still WIP), so the export dropped every
  text track. With `--captions markers` each cue becomes a `Marker.1` on the Stack — name = cue text, `marked_range` =
  cue timing, `metadata.capcut.kind = "caption"` plus the text and track name, and Resolve's own `Resolve_OTIO.Note` so
  the text shows in its marker panel — which Resolve/Premiere import as timeline markers. `import-timeline` turns
  flagged caption markers back into text segments on the recorded track name (de-collided like the clip tracks) and
  reports any foreign timeline marker instead of dropping it. Default stays `skip`, so today's documents are
  byte-identical; the skip note now points at the flag.
- **`caption --script <file>` — whisper's timing, your wording** — names, product terms and punctuation are what speech
  recognition gets wrong most, and the pipelines that most want burned-in captions already have the script
  (neo9su/autoclipvideo#174, baizhiheizi/enjoy_player#540 both ask for word timing on a KNOWN text). The script and the
  recognised words are aligned globally (Needleman–Wunsch on normalised tokens, with a near-miss term so
  "chanel"/"channel" pair with each other rather than with a neighbour); every script word inherits its recognised
  word's start/end, unheard words are spread across the gap between timed neighbours. Each non-empty script line is a
  cue (split only past `--max-chars`); with `--karaoke` the timed script words group as usual. The result's `script`
  block reports matched / substituted / inserted / dropped words and the match ratio; below 50 % it warns that the
  script probably belongs to other audio.
- **`detect-retakes` — the repeat the silence pass cannot see** — talking-head recordings are full of second attempts;
  the one ecosystem tool that tried (mrbuslov/capcut-ai-editor, [PR #3](https://github.com/mrbuslov/capcut-ai-editor/pull/3))
  shows the failure to design against: its sentence-similarity pass matched unrelated sentences 27 minutes apart and
  collapsed a 29-minute recording to 1:47. Three explicit guards here: a `--window` (later take must start within 60 s
  of the earlier one ending), `--min-words` (cues under 4 normalised words never count — "okay so" repeats constantly),
  and a `--similarity` floor on the word sequences (2·LCS/(a+b), default 0.8, so a rephrased sentence is not a repeat).
  The later take is the keeper; earlier spans become cuts, merged where they touch, with the complementary keep spans
  in seconds and microseconds — the detect-silence shape, so `cut`/`compile` consume it unchanged. Reads the draft's
  text tracks (or one `--track-name`) or `--srt <file>` with no draft; never writes.
- **`render --soft-captions`** — a toggleable `mov_text` subtitle stream in the proxy instead of (or as well as) pixels
  burned in (munimtechnologies/munim-ffmpeg#3, home-lang/home-os#86 — "soft subtitle muxing"). The cues are written
  as `<preview>.srt` next to the output (players auto-load it by name anyway) and muxed as stream `0:s:0`; a build
  without the `mov_text` encoder skips with a note like the drawtext fallback. The plan drops `-shortest` only when a
  subtitle stream is muxed, because ffmpeg would otherwise end the file at the last cue.
- **Keyframe property aliases** — `scale` (= `uniform_scale`), `x`, `y`, `opacity` are accepted by `keyframe`,
  `keyframe --batch` and compile's keyframe op and stored under the canonical `property_type`; the two downstream IR
  compilers built on this CLI (FullFran/vertir's PROP_MAP, Quriosity-agent/qcut's spec.py) had each re-implemented the
  same translation table. `describe`/`--help` list both forms; the error for an unknown name lists the aliases.
- **`keyframe --easing hold`** — the step easing the same integrators carried in their IR and had to degrade to linear
  because CapCut always interpolates. The step is emulated the way an editor does it by hand: a helper keyframe with
  the held value one frame before the NEXT keyframe on that property, so the whole ramp happens inside one frame.
  Works in `--batch` even when the held keyframe is named before its pair; a hold with no later keyframe, or one whose
  neighbour already carries the value, is reported (`hold_keyframes`, warnings) rather than invented. The schema docs
  list a `"Hold"` curveType, but no app-authored draft carries it, so the CLI does not write an unverified encoding.
- **`matting <project> <segment-id> [--off]` — smart matting / "Remove background" / 智能抠像** — writes `flag: 3`
  (smart portrait matting) on the segment's VIDEO MATERIAL and leaves the cache fields at their empty defaults for the
  app to fill on next open; `--off` writes the documented flag-0 object back, keeping any app-authored cache. Encoding
  per the pyJianYingDraft contributor PRs [#183](https://github.com/GuanYixuan/pyJianYingDraft/pull/183)/[#184](https://github.com/GuanYixuan/pyJianYingDraft/pull/184)
  (built twice, never merged); provenance recorded in `docs/draft-schema/02-materials.md`. Per material: segments
  sharing the material are reported as `shared_segments`.
- **`init` / `quickstart` `--ratio 9:16` (or `--width/--height`)** — the bundled template is 1920×1080, so a portrait
  short needed a `compile` spec or a second step; the most-diverged community fork shipped `init --width/--height` for
  exactly this. Presets at CapCut's native sizes (`16:9`, `9:16`, `1:1`, `4:3`, `3:4`); explicit width+height win over
  the preset's size and keep its label (or get `"original"`). The canvas is stamped into every timeline file the
  template ships, so the mirrors never disagree; without the flags the template canvas is kept and the output carries
  `canvas: null`.

### Changed

- `lint`'s `media-unregistered` issue suggests `capcut register <project> --materials --apply` (it used to ask for a
  `fixture` bundle); still info-severity and `fixable: false` — a sidecar write is register's job, not `lint --fix`'s.
- `diagnose`'s media-registration note names the same repair.
- `export-timeline` reports text tracks as skipped with a pointer to `--captions markers` as well as `export-srt`.

## [0.21.1] — 2026-08-30

### Fixed

- **`refused [editor-open]` on every write under `npx` / `npm exec`, with CapCut closed
  ([#99](https://github.com/renezander030/capcut-cli/issues/99))** — `editorProcesses()` substring-matched the
  joined process listing, and npm rewrites its own process title to the full command line — which contains
  `capcut-cli` — so the CLI detected itself as a running editor and the README's zero-install path could never
  complete a write. Process names are now compared per process, by exact basename, case-insensitively (macOS
  `ps -o comm=` prints the executable's full bundle path, so whole-line equality would have broken real
  detection). The Windows branch had the same substring shape and now compares the exact `tasklist` image name,
  which also stops an image merely *containing* `capcut.exe` from tripping the guard. Pinned by the reporter's
  fixture: a listing whose only `capcut` is an `npm exec capcut-cli@0.21.0 …` title returns nothing, while the
  full CapCut bundle path still detects. Diagnosis, scope table and fix direction all came with the report —
  thanks [@hansuk94](https://github.com/hansuk94).

## [0.21.0] — 2026-08-28

One thread runs through most of this release: the issue-[#50](https://github.com/renezander030/capcut-cli/issues/50)
cluster finally got movement. The CapCut Mac 9.2.8 report confirmed the nested
`Timelines/<id>/` documents as the file the app actually reads on that build,
with a hand-verified workaround — this release mechanizes that workaround as an
explicit opt-in repair, makes the fixture bundle that issue is still waiting on
mechanically checkable for private data, and tags every write refusal with a
stable gate id so the next pasted stderr line cannot be misread. Around it:
ecosystem-mined portability and discovery work (`catalogue`, `relink --stage`,
the `media-unregistered` note), the PIP + local-mask validation issue
[#78](https://github.com/renezander030/capcut-cli/issues/78) asked for, id-free
caption styling on import, and Chinese docs parity. No command was removed. The
only existing-output changes are additive JSON fields, the `refused [gate-id]:`
prefix on refusal messages, and `sync-timelines`' applied summary naming the
actual canonical file instead of hardcoding `draft_content.json`.

### Added

- **`sync-timelines --nested` — the issue [#50](https://github.com/renezander030/capcut-cli/issues/50) repair, as an explicit opt-in** — on
  CapCut International for Mac 9.2.8 the nested `Timelines/<main_timeline_id>/draft_info.json` is authoritative and
  root-file writes are silently discarded; the reporter's hand-verified fix was copying the CLI-written root file over
  the nested documents, keeping the timeline id. `--nested` does exactly that: the plan additionally covers every
  `Timelines/<id>/` timeline document plus its same-directory `template-2.tmp`, in the same canonical → mirror
  direction, behind the same newer-mirror refusal (`--force-write` to override), with each nested document keeping its
  own GUID and comparing by id-normalized timeline hash. `Timelines/project.json` — the pointer that names the active
  timeline — is never touched, and nothing changes without the flag: a default run that sees nested documents says so
  and points at the opt-in instead of reporting "in sync" about files it never read. PR #51's canonical-read flip
  stays rejected pending a field artifact; this changes which files an explicit repair can *write*, never which file
  any command *reads*. Fork-proven demand: the most-diverged community fork shipped its own `sync-timelines` repair.
- **`lint --pip` — validation for the PIP + local-mask workflow ([#78](https://github.com/renezander030/capcut-cli/issues/78))** — the discussion-#43 build
  (duplicate a clip onto an upper layer, mask the copy) has four ways to be silently wrong: the overlay never landed,
  the mask never got attached, the keyframes did not write, the copy points at missing media. `--pip` reports the
  counts (`overlays`, `overlay_keyframes`, `masks_attached`, `masks_orphaned`, `missing_media` — by path, not just a
  count) in the JSON and `-H` outputs, and raises a `mask-orphaned` warning per never-attached mask so the exit code
  fails CI exactly as the issue's acceptance criteria ask. Gated behind the flag deliberately: an ordinary draft
  carrying an unreferenced mask is not necessarily damaged (the [#88](https://github.com/renezander030/capcut-cli/issues/88) lesson), but in a pipeline that just tried
  to attach one it is precisely the failure being looked for.
- **`catalogue <query>` — name → resource_id in one call** — the ecosystem's most repeated resource pain is hand-
  extracting effect ids from the app when a display name is all you have (pyJianYingDraft#174 has no extraction path
  for encrypted-era resources; pyCapCut#12's static tables miss newer ids). `catalogue` searches every bundled table,
  the filters/bubbles starter catalogues, and the `harvest-enums` user catalogue at once — exact matches first, then
  prefix, then substring, `--kind <category>` to narrow, `--limit` to cap, and each row labelled `bundled` or `user`.
  Pasting a resource id answers the reverse question ("what is this id?") — ids match exactly, never fuzzily.
- **`import-srt` / `import-ass` `--clone-style` — keep the draft's caption look without hunting a segment id** —
  `--style-ref <id>` already copied styling from an existing segment, but agents and one-liners had to query `texts`
  first to find the id. `--clone-style` resolves it: the newest text segment on the target track (any text track as
  fallback), then rides the `--style-ref` machinery unchanged. An explicit `--style-ref` wins; a draft with no text
  segment fails fast with guidance instead of importing unstyled cues.
- **`relink --stage` — portable repair** — `relink` rewrote paths but left the draft depending on files outside its
  folder, which is exactly what black-screens a draft the moment the folder moves machines
  (pyJianYingDraft#177's Mac-sandbox "content corrupted" case). With `--stage`, each video/audio file this run
  relinks is copied into `assets/<kind>/` via the same content-hash-deduplicating path `add-video`/`add-audio` use,
  and the material points at the copy. Only files the run actually relinked are staged; `--dry-run` skips the copy —
  a file copy is a side effect no draft write can roll back.
- **`lint` `media-unregistered` — observe-only sidecar note (pyCapCut#13)** — CapCut International 9.1.0 on macOS is
  reported to show timeline media as "file inaccessible" and demand per-clip relinking when `draft_meta_info.json`'s
  `draft_materials` registers nothing, even with valid paths in the timeline. The registration *write* stays
  deliberately out of scope — no real entry shape has been captured yet — so lint now names the hazard where CI will
  actually see it: info severity (never fails an exit code), only when the sidecar exists, provably registers
  nothing, and the referenced media is actually present on disk, with the `capcut fixture` ask attached — the one
  artifact the write could be built from.
- **`fixture --check` — mechanical redaction verification** — the bundle README has always ended with "review the
  files yourself", and that burden is measurably what stalls contributions: the 9.2.8 reporter in
  [#50](https://github.com/renezander030/capcut-cli/issues/50) held the bundle back until confident nothing private
  leaked. `--check` scans every text file in the finished bundle — `SANITIZE_REPORT.json` and the README included,
  the [#59](https://github.com/renezander030/capcut-cli/issues/59) lesson — for residual home-path shapes, emails
  (the redactor's `redacted@example.com` placeholder excepted), unredacted `device_id`/`mac_address`/`hard_disk_id`
  values, and the machine's account name, reporting `file:line` and `kind` per finding (never the leaked value
  itself) and exiting non-zero on any. `capcut fixture <bundle-dir> --check` re-checks an existing bundle without
  rebuilding.
- **Chinese docs parity** — `README.zh-CN.md` caught up with the English README's restructure (#97), and
  `docs/version-support.zh-CN.md` + `docs/jianying-encryption.zh-CN.md` now exist alongside the quickstart and
  command-reference translations — the version-support and encryption stories were previously invisible to the
  project's largest user segment.

### Changed

- **Write refusals name their gate** — a refusal now reads `refused [editor-open]: …`, `refused [version-boundary]: …`,
  `refused [draft-changed-on-disk]: …` (and `sync-timelines --apply`'s `refused [mirror-newer]: …`). Motivated by a
  [#50](https://github.com/renezander030/capcut-cli/issues/50) side report where "CapCut is running" was quoted with
  no CapCut process alive: two of the three write gates mention `--force-write`, so a paraphrased report could not
  identify which gate fired. The tag is stable and greppable; the message text after it is unchanged.
- **`sync-timelines --apply`'s summary names the plan's canonical** — the applied line hardcoded
  `Reconciled from draft_content.json:` even on the draft_info-primary layout, where the canonical is
  `draft_info.json`. It now prints the file the repair actually read from.

### Fixed

- **The pre-commit test gate could pass on a red suite** — `npm test --silent 2>&1 | tail -20` reports the *pipeline's*
  exit status, which is `tail`'s, so `set -e` never saw a test failure and a failing suite could commit silently
  (plain `sh` has no `pipefail`). The hook now captures the run to a file and propagates the real status, printing the
  last 40 lines on failure.
- **`action.yml` passed composite-action inputs through shell interpolation** — inputs are now passed via `env`
  ([#94](https://github.com/renezander030/capcut-cli/issues/94)); shipped on master since 2026-08-23, first release
  here.
- **9.x stores got nested-Timelines evidence with no explanation** — `diagnose` attached the redacted
  `nested_evidence` block on ≥ 8.7 storage and `fixture` bundled the nested documents, but the human-readable
  next-action and the `version` note were gated on the layout value, which stops at 8.7 by design — so a 9.x user got
  a report carrying `Timelines/` evidence with no line of prose saying why it was collected
  ([#95](https://github.com/renezander030/capcut-cli/issues/95),
  [#96](https://github.com/renezander030/capcut-cli/pull/96)); shipped on master since 2026-08-23, first release
  here. The note asserts neither the 7.x discard finding nor the 8.5.0 survival finding — both predate the 8.7
  storage change.

## [0.20.0] — 2026-08-21

Two threads run through this release. Subtitles now carry their styling across
the draft boundary in both directions — `export-ass` writes it out,
`import-ass` stops throwing it away. And the raw-recording pipeline closes:
find the speech (`detect-silence`), voice the script (`tts`), and the ffmpeg
fail-fast work from 0.19.0 is finished on the audio chain, with hardware
encoders selectable where the build has them. `diagnose` now captures, in
sanitized form, the evidence the two open store-layout questions are waiting
on. No command was removed and no existing flag changed meaning.

### Fixed

- **`render` no longer reaches ffmpeg's raw parser error when a base filter is missing** — the render chain applies `fps`/`scale`/`pad`/`setsar`/`format`/`concat`/`trim`/`setpts` to every segment unconditionally, but `probeFfmpegCapabilities` only checked `drawtext`/`overlay`/`libx264`, the flag-gated ones. A build missing one of the unconditional filters — reported on Remotion's bundled compositor ffmpeg binary, a minimal build that compiles in only an explicit `--enable-filter=` allowlist — reached `spawnSync` anyway and surfaced ffmpeg's own parse error verbatim (`No option name near '30'`, `Failed to set value '...' for option 'filter_complex': Invalid argument`), naming a fragment of the filter graph rather than the missing filter ([#89](https://github.com/renezander030/capcut-cli/issues/89)). The probe now checks all eight against the same `-filters` output already fetched, and `render` fails fast — before building the plan — naming exactly which filter(s) are missing and pointing at `--ffmpeg-cmd`, the same style as the existing "ffmpeg lacks drawtext" fallback message. `--dry-run` is unaffected by design: `cmdRender` routes it through `buildRenderPlan` directly rather than `renderDraft`, so a plan stays inspectable on a machine with no ffmpeg at all — the same reason the pre-existing `--dry-run` test already ran ungated on ffmpeg-less machines. Swapping `fps=` for an output-level `-r` is deliberately out of scope here (would change per-segment CFR normalization ahead of `concat`); this PR is the fail-fast fix only.

- **`render` probed the video chain but not the audio chain**
  ([#91](https://github.com/renezander030/capcut-cli/issues/91)). The audio
  side of the render graph applies `atrim`/`asetpts`/`adelay` plus `anull`
  (one audio segment) or `amix` (several) unconditionally, with
  `atempo`/`volume`/`afade` joining when a draft carries a speed change,
  volume or fades — none of them probed, so a minimal ffmpeg build missing one
  still reached `spawnSync` and died on the same raw parser error class #89
  eliminated for video. The probe now reads the audio filter names from the
  same single `-filters` output (no extra spawn); `render` fails fast up front
  for the unconditional five, and for the conditional three exactly when the
  built plan uses them — refusing rather than silently dropping a retime or a
  fade. A guard test builds a plan from a draft exercising speed, volume,
  fades, captions, overlays and multi-track audio, extracts every filter name
  from the generated `filter_complex`, and asserts each one is probed or
  explicitly allowlisted — for both chains, so chain and probe cannot drift
  apart again.
- **`import-ass` dropped every inline override tag.** A styled ASS file —
  bold or italic spans, per-word colour, size changes — flattened to plain
  text on import: the parser deleted `{...}` blocks wholesale and never read
  `[V4+ Styles]`. Inline `\b`/`\i`/`\u`/`\c`/`\1c`/`\fs`/`\r` overrides now
  become per-range styles through the same writer `text-ranges` uses (ranges
  in UTF-16 code units of the stored text — the #85 rule), and the Dialogue's
  referenced Style line seeds font size, colour and alignment unless flags
  override them. Unknown tags (`\pos`, `\an`, karaoke `\k`, `\2c`–`\4c`) are
  still stripped, now deliberately. The round-trip is pinned by test:
  `export-ass` output re-imported reproduces the same `styles[]` arrays and
  timings exactly.

### Added

- **`export-ass` — styled subtitles can finally leave a draft.** `export-srt`
  stays bare by design; `export-ass <project>` writes the styling too: PlayRes
  from the draft canvas, one `[V4+ Styles]` line per distinct text styling
  (size, colour and alpha, bold/italic/underline, alignment, border, shadow
  and background), one Dialogue per text segment, and `styles[].range` blocks
  becoming inline override tags with explicit resets — ASS colour order is
  `&HAABBGGRR`, tested in both directions. `--karaoke` emits `{\k}`
  centisecond word timing from the same word timestamps the WebVTT karaoke
  writer uses, with the highlight colour as PrimaryColour over the base
  SecondaryColour. CapCut's border/shadow numbers pass through unscaled — they
  are text-size-relative and ASS wants PlayRes pixels, and inventing a scale
  would be worse than none (documented in the code).
- **`detect-silence` — the audio twin of `detect-scenes`.** ffmpeg's
  silencedetect filter run deterministically over any media file, no draft
  required: the silence spans and the complementary keep segments (the
  speech), in seconds and draft-native microseconds, directly consumable by
  `cut`/`compile` the way `detect-scenes` segments already are.
  `--threshold-db` (default −30 dBFS) and `--min-silence` (default 0.5 s) map
  onto the filter's noise/duration; `--pad` (default 0.1 s) shrinks every
  silence span on both ends so a cut keeps a margin around speech and never
  clips a word mid-syllable — a pad wider than a span makes the span
  disappear, never a negative time. Silence running into end-of-file is an
  open span, `--limit` keeps the N longest, and `--ffmpeg-cmd`/`--json`/`-H`
  behave exactly as in `detect-scenes`, including the actionable no-ffmpeg
  error.
- **`tts` — voiceover without leaving the CLI.** `capcut tts <project>
  --text "..." --tts-cmd "<template>"` runs any local TTS tool (piper, macOS
  `say`, espeak-ng — the missing-flag error carries working examples) and
  lands the result as a real audio segment through the exact `add-audio`
  path: same ffprobe duration probing with the same `--no-probe`/
  `--ffprobe-cmd` escape hatches, same `--volume`/`--track-name`,
  collision-safe `voiceover[-N].wav` naming. The template never passes
  through a shell: `{out}` and `{text}` substitute as single argv tokens, and
  a template without `{text}` gets the text on stdin instead. A tool that
  exits non-zero or writes an empty file reports a bounded stderr tail and
  cleans up after itself. `doctor` reports the configuration the way it
  reports whisper.
- **`harvest-enums --sync` and `--add`.** `--sync` sweeps every draft the
  `projects` listing can see (honouring `--drafts`) into one merged catalogue
  write: unreadable or damaged drafts are skipped with a one-line note
  instead of aborting, cross-draft repeats merge to one entry, the report
  counts drafts scanned and skipped plus entries new and already known, and a
  second sync adds nothing. `--add <kind> <slug> <resource-id>
  [--effect-id <id>]` registers an entry whose witness draft is gone —
  refusing unknown kinds, the deliberately excluded ambiguous kinds, unclean
  slugs (suggesting the clean form) and duplicate ids (naming the entry that
  owns them). Both keep the command's plan-by-default/`--apply` convention
  and both funnel through the existing fsynced atomic catalogue writer.
- **`render --encoder`** picks the video encoder for proxy renders —
  `h264_videotoolbox`, `h264_nvenc`, `h264_qsv`, anything the build
  enumerates. Validation is lazy: only when the flag is given does `render`
  spawn `ffmpeg -encoders`, failing fast with the encoder name and how to
  list what is available; without the flag the ffmpeg invocation is
  byte-identical to 0.19.1 (a test diffs the two argument arrays at exactly
  one slot).
- **`diagnose` captures the nested-Timelines evidence #50 is waiting on**
  ([#50](https://github.com/renezander030/capcut-cli/issues/50)). When a
  draft carries the nested `Timelines/` layout, the report — and the
  `--bundle`/`fixture` output, through the existing #59 redaction rules —
  attaches the `Timelines/project.json` pointer, the draft-file tree with
  sizes and mtimes, the app version and OS marker, and a root-vs-nested
  divergence comparison per nested document: content hashes, which side is
  mtime-newer, per-track segment and text counts and a text hash — never raw
  text. That is precisely the before/after that decides whether the nested
  pointer is authoritative; the write-path question stays open until it
  arrives. A non-nested draft's diagnose output is unchanged, byte for byte.
- **`diagnose` notes unregistered timeline media in `draft_meta_info.json`.**
  Newer CapCut builds (reported on CapCut International 9.1.0, macOS) mark
  every clip "file inaccessible" and demand per-clip relinking when the
  sidecar's `draft_materials` does not register the timeline's media — even
  with valid paths in `draft_content.json`, and this CLI has never written
  `draft_materials`. `diagnose` now says so, read-only, when the condition
  provably holds (sidecar missing, key missing, or every group empty while
  the timeline references local media), and asks for the one thing that lets
  the write side be built from evidence rather than guesswork: a
  `capcut fixture` bundle from an app-authored draft on such a build — the
  bundle already carries `draft_meta_info.json`. Nothing writes or invents
  `draft_materials` content anywhere.

## [0.19.1] — 2026-08-16

One bug, reported with the measurement that settled it, plus the repair for
drafts already written. No command was removed and no existing flag changed
meaning.

### Fixed

- **Every multi-range text highlight was written past the end of its text**
  ([#85](https://github.com/renezander030/capcut-cli/issues/85)). A text
  material's `content.styles[].range` holds UTF-16 **code units** — plain JS
  string indices — and this CLI wrote UTF-16LE **bytes**, so every stored
  offset was doubled. A single full-span range survived the mistake, because
  `[0, 2n]` clamps back to the end of the text when CapCut opens the draft,
  which is exactly why ordinary `add-text` looked correct and the premise went
  unchallenged. A multi-range highlight did not: on the 17 code-unit string
  `อย่าไปซื้อ Claude`, `text-ranges --styles '[{"start":11,"end":17,…}]'` wrote
  the emphasised span at `[22, 34]`, entirely past the end, and CapCut painted
  nothing. `text-ranges`, `caption --karaoke`, `--highlight-words` and any
  preset carrying `text_ranges` were all affected.

  The premise came from this repo's own schema notes and had never been
  measured. @hillimited measured it: across 38 app-authored drafts on one
  machine, 211 text materials from CapCut International 7.9.0 and 8.9.1 store
  code units and none store bytes — and CLI-written drafts read back as code
  units once the app has re-saved them, the app parsing the doubled values,
  clamping them, and writing its own interpretation back.

  Eight sites shared the assumption — the writer, preset capture, the
  `lint --fix` re-wrap, `export-srt`'s karaoke word matching, `edit`'s text
  replacement, the text factory and the schema doc — so flipping the writer
  alone would have broken the readers. All of them now go through one module,
  `text-offsets.ts`, which is also the single place to branch should a
  JianYing draft ever turn out to store something else. Side effect worth
  having: in the code-unit domain `range` *is* the JS string index, so the BMP
  assumption that came with the byte conversion is gone and an emoji highlight
  is correct by construction.

- **`export-srt --granularity word` still collapses old karaoke drafts.** It
  matches highlight ranges against word offsets, so it now reads the doubled
  form as well and lines the words up either way.

### Added

- **`lint` reports and repairs the doubled ranges earlier versions wrote**
  (`text-range-doubled`, fixable). The doubled form is identifiable with
  certainty rather than by guess — every offset even, every range inside
  `[0, 2n]`, and the last one ending at exactly `2n`, which is out of bounds
  as code units and precisely where the old writer's trailing block landed —
  so `lint --fix` halves them. App-authored drafts, drafts written from 0.19.1
  on, and drafts already repaired all end at `n` and are never touched.

- `extractCodeUnitStyleRanges` and the `text-offsets` helpers are exported
  from the library entry for anyone reading `styles[].range` themselves.

### Documentation

- `docs/draft-schema/02-materials.md` said "UTF-16 BYTE offsets, not character
  indices". It now says code units, shows the measurement behind that, and
  points at the repair for drafts written by earlier versions.

## [0.19.0] — 2026-08-14

Nine items from an opportunity-mining pass over this repo's own issues and the
surrounding ecosystem (pyJianYingDraft, capcut-mate, auto-subs, ffsubsync,
moviepy, video-subtitle-extractor and the vertical-video tools). Two clusters
carried the signal: ffmpeg robustness, where this CLI had one unguarded spawn
left, and caption quality, where the lint rules measured length but never
readability. No command was removed and no existing flag changed meaning.

### Fixed

- **A long `render` could fail on a draft that was perfectly fine.** The ffmpeg
  spawn in `render` was the only media spawn in the codebase with no
  `maxBuffer`, so it kept Node's 1 MiB default. ffmpeg writes one stats line per
  frame to stderr — roughly 18k lines for a ten-minute 30fps render — and once
  that overran the cap, `spawnSync` reported it through `r.error` with code
  `ENOBUFS` rather than by throwing. The old code folded that into its generic
  failure branch and told the user to install ffmpeg: advice that was wrong
  twice over, since ffmpeg was installed and had already rendered most of the
  file. The cap is now 64 MiB, and `ENOBUFS` and `ETIMEDOUT` each get their own
  message that says ffmpeg ran. `probe.ts`, `scenes.ts` and
  `probeFfmpegCapabilities` already did this; `render` now matches them.
- **`export-timeline` could emit a zero-length OTIO clip**
  ([#82](https://github.com/renezander030/capcut-cli/issues/82)). `draftToOtio`
  carried its own `Math.round((us / 1e6) * rate)` alongside the one in
  `time.ts`, and the two disagreed in exactly the cases that reach the file: a
  clip shorter than half a frame rounded to zero frames, which an NLE either
  drops or refuses, and a small negative gap rounded to `-0`, which serialises
  into the JSON as `-0`. It now calls `framesFor`, so there is a single frame
  grid. A sub-half-frame clip exports as one frame instead of none.

### Added

- **`lint` now measures reading speed, not just length** (`caption-too-fast`).
  `cue-too-long` caps how long a caption may stay up; nothing capped how fast it
  goes by, so 45 characters in 1.2s — 37.5 chars/s, roughly double what anyone
  can read — passed every rule. The ceiling is 20 chars/s by default
  (`--max-cps`, `0` disables), counted on visible characters so whitespace does
  not inflate the rate. Report-only: the repair is either more screen time,
  which moves every later caption, or fewer words, which is an authoring
  decision. The suggested command names the segment and the duration that would
  clear it.
- **`lint --fix` can finally re-wrap CJK captions.** The re-wrapper only ever
  swapped a space for a newline, because `styles[]` ranges are UTF-16LE *byte*
  offsets and a length-neutral edit keeps them valid. Space-less scripts have no
  space to swap, so a Chinese or Japanese caption tripped `line-too-long`
  forever with no way to clear it — on a tool whose other namespace is JianYing.
  Breaks are now inserted between characters, with every later style boundary
  shifted by exactly 2 bytes per insertion, so per-range styling (karaoke
  highlights above all) stays on its characters. Line-start punctuation is
  respected: a break never strands `。`, `、` or a closing bracket at the head of
  a line. Over-long Latin words are still never split and stay reported.
- **`lint` flags captions that land under the platform UI**
  (`caption-outside-safe-area`). On a vertical canvas, a caption parked near
  either edge sits where TikTok, Reels and Shorts draw their own controls. The
  rule only runs when the canvas is taller than it is wide and is deliberately
  direction-agnostic — both bands are unsafe — so it needs no assumption about
  which way CapCut's `transform.y` points. `--safe-area` tunes the fraction
  (default `0.85`).
- **`lint` catches segments whose speed contradicts itself**
  (`speed-timerange-mismatch`, `speed-material-mismatch`). `capcut speed`
  maintains two things at once: the segment's `speed`, and the source span it
  consumes. A draft that has been through another tool can carry a `speed` that
  disagrees with its own timeranges, or with the linked speed material the app
  actually reads. The app then plays the clip at one rate while every UI surface
  reports another, and anything aligned to it — captions above all — drifts with
  no visible cause. A 1% tolerance keeps ordinary sub-frame rounding quiet.
- **`render --progress`** streams ffmpeg's own output to stderr instead of
  capturing it. A 600s render otherwise prints nothing at all, so a working job
  and a hung one look identical. It doubles as the escape hatch for a render
  whose output would outgrow the buffer, since inherited output is never
  buffered by this process — which is what the `ENOBUFS` message now points at.
- **A failed `render` explains itself.** `explainFfmpegFailure` maps ffmpeg's
  stderr onto one actionable line: a missing decoder is named (the AV1/HEVC
  case), a missing encoder points at `capcut doctor`, a missing filter names the
  flag that needs it, a truncated container points at `lint`, and a missing
  input points at `relink`. It returns nothing rather than inventing a hint for
  a diagnostic it does not recognise, and is pure and exported so the mapping is
  tested without ffmpeg.
- **Frame-grid helpers let library callers match CapCut's duration rounding**
  ([#76](https://github.com/renezander030/capcut-cli/issues/76)).
  `quantizeToFrame(us, fps)` returns the nearest on-grid microsecond duration,
  while `framesFor(us, fps)` exposes the frame count. Both fall back to 30 fps
  for missing or invalid rates, floor positive durations at one frame, and keep
  negative durations signed; existing commands remain unchanged and callers opt
  in through the public library API. `draftToOtio` is now the first in-tree
  caller, which is what closed #82 above.

### Documentation

- **The keyframe schema documented a `property_type` the code never writes**
  ([#80](https://github.com/renezander030/capcut-cli/issues/80)).
  `docs/draft-schema/03-keyframes-and-animations.md` listed
  `KFTypeUniformScale`; `PROPERTY_MAP` writes the bare `UNIFORM_SCALE`, the one
  property that breaks the `KFType` pattern. A keyframe hand-built from the
  table was silently ignored by the app. The table and the example now match the
  code, the asymmetry is called out as CapCut's rather than a typo, and a test
  fails if the two drift apart again.
- **The mask-keyframe section records what the encoding search has already ruled out** ([#44](https://github.com/renezander030/capcut-cli/issues/44)). `docs/draft-schema/03-keyframes-and-animations.md` said no capture exists in the neighbouring ecosystem tools without naming what had been checked, so anyone picking the issue up starts that search from zero. It now names the negative result: `pyJianYingDraft`'s `KeyframeProperty` enum — the upstream `src/enums.json` is extracted from — carries the same eleven properties this CLI exposes and nothing for mask geometry, so there is no encoding to borrow and the ground truth has to come from an app-authored capture. No behaviour change; the CLI still declines to write mask keyframes.

## [0.18.0] — 2026-08-09

Upgrade if you have ever run `capcut fixture`. Bundles produced by earlier versions carry your device identifiers, and the command's documented flow is to attach one to a public issue.

### Security

- **`capcut fixture` no longer leaks device identifiers** ([#59](https://github.com/renezander030/capcut-cli/issues/59), reported by @scornik). The redactor handled home paths and email addresses only, so the `device_id`, `mac_address` and `hard_disk_id` CapCut stamps into every `platform` and `last_modified_platform` block were copied verbatim into `draft_info.json`, `template-2.tmp` and every nested timeline document. `SANITIZE_REPORT.json` compounded it by writing `source_dir` and `out_dir` raw, reintroducing the username the timeline files had just had scrubbed. Anyone following the documented "run `capcut fixture` and attach the bundle" flow published a stable device ID and MAC address while the filename and the report both said the bundle was sanitised. The new redactor keys on the field name rather than the value shape — `device_id` and `mac_address` are plain 32-hex, and a bare hex pattern would also blank legitimate material and segment UUIDs — handles the escaped-quote form `template-2.tmp` uses for its string-JSON, and matches only non-empty values so an already-blank `hard_disk_id` is not reported as removed. Keys are kept with empty values, because the on-disk shape is the point of a fixture. `app_id` is left alone: it identifies the app, not the machine. **Bundles generated before this release should be treated as unsanitised.**

### Added

- **`init` warns when the bundled template predates the target store's CapCut** ([#67](https://github.com/renezander030/capcut-cli/issues/67), reported by @scornik). The template declares `app_version 6.5.0` and carries none of the schema markers a modern draft has; dropped into a materially newer store, CapCut lists the draft at 00:00 and then refuses to open it, reporting "Current project is from an unusual path and cannot be used currently" — which is wrong about the cause and sends people hunting the path. `init` now reads the newest `platform.app_version` across the projects already in the drafts folder, before copying the template, and warns when the store is a major version ahead, naming the real reason and pointing at `--template`. Warn, never refuse: the evidence is a single 8.5.0 report and `--template` is a working escape hatch.

### Changed

- **The nested-`Timelines/` guidance is gated on detected app version** ([#68](https://github.com/renezander030/capcut-cli/issues/68), reported by @scornik). It fired on layout alone while its text is explicitly about CapCut 7.x and cites [#50](https://github.com/renezander030/capcut-cli/issues/50). On 8.5.0 the reported behaviour is the opposite: after a CLI-written draft was opened and closed, the nested document and the project-root file were byte-identical, so the app regenerated the mirror from the tool's content. 8.5.0+ now gets that wording; 7.x and unknown versions keep the cautious text, since the 8.5.0 reporter did not test 7.x. Three call sites carried a copy of this guidance — the write guard, the `version` command's support notes, and `sync-timelines`, which rewrites mirrors outside `saveDraft`.
- Builds against TypeScript 7, which no longer implicitly includes packages under `node_modules/@types`; `compilerOptions.types` now names `node` explicitly. No source change was needed and no runtime behaviour differs.

### Documentation

- **Frame quantisation is documented** ([#69](https://github.com/renezander030/capcut-cli/issues/69), reported by @scornik). CapCut snaps every duration to the project's frame grid the first time it opens a draft, so what you read back is not what you wrote. `docs/draft-schema/01-tracks-and-segments.md` now records the measured 30fps behaviour, that drift stays sub-frame and the timeline contiguous, that sub-frame distinctions are lost (866ms and 867ms both land on 26 frames) while sub-frame segments survive, and the pre-quantisation formula for callers who need what they write to equal what the app stores.

## [0.17.2] — 2026-08-08

Documentation only. No source changed, so the shipped `dist/` is identical to 0.17.1 and there is nothing to gain by upgrading from it — this release exists so the npm page carries the security notice, because npm renders the README from the published tarball rather than from the repository.

### Changed

- **The README leads with the 0.17.1 security notice, in both languages** — anyone arriving from npm now sees, above everything else, that versions up to and including 0.17.0 build the `export --batch` automation script by pasting the draft folder's name into it, what else 0.17.1 closed alongside it (the `drawtext` colour injection, the `compile` spec name escaping the draft store, predictable temp files, credential values in `serve`'s echoed args), that both injection paths need a draft folder or file the user did not author and are therefore local rather than remote, and the one command that fixes it. Versions below 0.17.1 are deprecated on npm with the same pointer, so an install of an affected version warns on the way past. The release-highlight blockquotes are trimmed to the two most recent versions as usual; a documentation release adds no highlight line of its own.

## [0.17.1] — 2026-08-07

A maintenance release: nothing was added to the command surface, which is identical to 0.17.0 flag for flag. What changed is what the same commands cost and what they let a hostile draft do.

Security is the part to read. `export --batch` built the AppleScript and PowerShell it runs by splicing the draft folder's name into a quoted string literal, so a folder named with the right characters could break out and run arbitrary commands; both now pass the path as an argument or a provably complete escape. Alongside those: `render --burn-captions` validated a draft's caption colour before it reaches the ffmpeg filter, `compile` refuses a spec `name` that escapes the draft store, draft writes stage through an unpredictable exclusively-created temp file, `serve` masks credential values in the args it echoes, and Wikimedia downloads take only the last component of a `File:` title.

Performance was measured, not estimated — base and branch interleaved run-for-run. On a 4000-caption / 2.9 MB project `lint --fix` drops 3193 ms to 596 ms and `lint` 1465 ms to 367 ms, with `texts`, `segments`, `export-srt`, `shift`, `set-text` and `restore` between 41% and 53% faster; the CLI now compiles 7 modules at startup instead of 32, so every invocation begins 22-27% sooner. The package is 7% smaller unpacked and ships 28 fewer files.

Behaviour changes, all narrow: a caption colour that is neither a hex form nor a known ffmpeg colour name now falls back to the default instead of reaching the filter; a `compile` spec whose `name` leaves the draft store is rejected; `serve`'s echoed args carry a mask where a credential value used to sit; and history snapshots inherit the `.bak`'s `0600` rather than the umask's `0644`. **Drafts written are byte-identical to 0.17.0** — held to a 72-command oracle covering every add/edit/read command, both preset paths and 22 error paths, plus per-command file comparison on a synthetic project and the committed `capcut-8.7-windows` fixture.

### Changed

- **Cold start: the CLI compiles 7 modules on startup instead of 32, so every invocation begins 22-27% sooner** — `index.ts` statically imported every command module, so the whole module graph was compiled and evaluated before `main()` ran its first line. `capcut --version` therefore paid for the whisper caption path, the OTIO importer/exporter, the renderer, the compile-spec engine, the scene detector, and the queue server, on the way to printing a version string. Those 25 modules are now `await import()`ed at their dispatch sites. What stays static is only what every invocation genuinely reaches: `command-specs` (flag parsing, `--help`, `describe`, the shell completions), `draft` together with the core it pulls in itself (`app-versions`, `bom`, `store`, `version`), and `time` for the read commands' formatting. Nothing was reachable at module scope to begin with — `COMMANDS`, `HELP`, `SUMMARIES`, and `ENUM_FLAG_MAP` are literals, so no imported value is read before a command has been chosen, which is what makes the whole move mechanical rather than a redesign. `describe` and the completions are unaffected by construction: both are generated from `COMMANDS` plus `SUMMARIES` through `command-specs`, which imports no command module and so never knew about the modules that became lazy; the full 80-command surface is emitted without loading any of them. `lib.ts`, the published library entry, resolves its exports directly rather than through `index.ts`, so every value and type a library consumer imports is untouched. The 35 command entry points that had to become `async` return their promise to a `main()` that was already `async` and already awaited four commands, and every `process.exit` still runs after the awaited call has returned, so exit codes and flush ordering are unchanged. Measured over 15 interleaved repetitions per command, baseline and branch alternating run-for-run (medians):

  | command | before | after | |
  | --- | --- | --- | --- |
  | `texts <project>` | 126 ms | 91 ms | −27% |
  | `completions bash` | 113 ms | 83 ms | −26% |
  | `tracks <project>` | 130 ms | 95 ms | −26% |
  | `--version` | 119 ms | 89 ms | −25% |
  | `describe` | 109 ms | 82 ms | −24% |
  | `--help` | 108 ms | 84 ms | −22% |
  | `info <project>` | 114 ms | 88 ms | −22% |
  | `enums --masks` | 118 ms | 108 ms | −8% |

  `enums` gains least because its own cost is dominated by parsing the 727 KB enum table rather than by the module graph. The saving is per-process, so it compounds wherever the CLI is invoked in a loop: the test suite spawns it 549 times and `npm run test:fast` drops from 47.8 s to 41.4 s over four interleaved pairs. Behaviour was held to an output-level check rather than assumed: 88 invocations spanning the spec surface, all 14 `enums` flags in both namespaces, ten read commands, and 31 error paths were captured on both builds and compared on stdout, stderr, and exit code — zero differences; and 25 mutating commands were each run against an identical copy of one draft on both builds, with the written `draft_content.json` compared byte-for-byte after normalizing only the freshly minted ids (which differ between two runs of the *same* build too). A 25-step lifecycle — `init`, four `add-*`, `text-style`, `save-template`, `apply-template`, `make-preset`, `prune`, `relink`, `quickstart`, `diff`, `concat`, `harvest-enums` — was then run end to end in a fresh draft store per build, and all 13 files each produced (drafts, sidecar metadata, the root store index, the template and the preset) plus every command's output matched, the sole difference being a wall-clock `mtime` in `projects`. `lib.ts` was exercised separately on both builds: all 19 exports resolve, the load/lint/save round trip agrees, and `runCommand` — which spawns the CLI, so it also covers the lazy dispatch from the library side — returns identical results including its unknown-command error. The one class of mistake the compiler cannot catch here is a dropped `await` on a call whose result is discarded — a mutating command would then race its own `process.exit` — so the 27 such call sites were found by walking the file for unawaited calls to a now-`async` function rather than by reading, and the walk is clean. A failure raised *inside* one of these modules still surfaces exactly as before — it reaches the same `main().catch`, so the same `{"error": ...}` line and exit 1 — verified by making a lazily-loaded module throw on both builds. The one difference anywhere in this change is a module that cannot be *parsed*: that used to fault in the loader before `main()` existed and printed Node's own stack trace, and now rejects the dynamic import and prints the standard JSON error instead. Exit code 1 either way, and it takes a corrupt install (a syntax error in a shipped file) to reach at all. `test/cold-start.test.mjs` pins the result going forward: the static-import allow-list fails the build if a module quietly rejoins the startup graph, every command `describe` lists is checked to still have a dispatch site, and the commands that exit early are checked to still print — the shape a dropped `await` takes at runtime. Each of those assertions was mutation-tested against a deliberately broken build.
- **Hot-path pass: large projects are 2-5x faster, and every byte written is unchanged** — seven independent changes (each its own entry below) removed work that no command's output depended on: two quadratic scans in `lint`, an eager `ffprobe` spawn, a whole-timeline hash taken on every discovery, a second full store discovery on every write, a duplicated pre-write of the backup content, and a deep clone on every load. Measured end to end on a 4000-caption / 2.9 MB project with three readable siblings, baseline and branch interleaved run-for-run over nine repetitions (medians):

  | command | before | after | |
  | --- | --- | --- | --- |
  | `lint --fix` | 3193 ms | 596 ms | −81% |
  | `lint` | 1465 ms | 367 ms | −75% |
  | `texts` | 640 ms | 300 ms | −53% |
  | `segments` | 648 ms | 325 ms | −50% |
  | `export-srt` | 619 ms | 341 ms | −45% |
  | `shift` | 791 ms | 444 ms | −44% |
  | `set-text` | 763 ms | 434 ms | −43% |
  | `restore` | 1197 ms | 708 ms | −41% |
  | `info` | 434 ms | 315 ms | −27% |

  `diagnose` and `sync-timelines` are the two commands that read every timeline hash, so deferring that hash cannot help them; they do the same work as before and are unchanged within this machine's run-to-run spread. Behaviour was held to a byte-level check throughout: for each of eleven commands, exit code, stdout, stderr, all three timeline files, all three `.bak` files, and every history snapshot (by name and by content) were fingerprinted on both builds and compared — zero differences.
- **`loadDraft` hands back the parsed timeline instead of a deep copy of it** — every load ran `structuredClone` over the whole draft so the store cached alongside it kept a pristine copy. Nothing consulted that copy. The store `loadDraft` caches never leaves `draft.ts` — `loadContexts` is module-private and `saveDraft` is its only reader — and everything `saveDraft` takes from it is either fixed at discovery time (`version`, `layout`, `projectDir`) or a string snapshot of the file on disk (`raw`, `path`, `envelopePath`); none of it is re-derived from `canonical.draft`. Every call site was re-checked on this branch, including the store consumers v0.17 added: `concat`, `import-timeline`, `restore`'s mirror re-sync, `compile`, and `quickstart` all take the draft and never reach for the store, and `diagnose`, `sync-timelines`, `fixture`, and the app-version tripwire run their own discovery rather than this one. The clone was therefore pure cost — tens of milliseconds on a multi-megabyte project, paid by read commands too. `test/load-draft-aliasing.test.mjs` pins the invariant that makes the removal safe: an edit made after the load never reaches the pre-write bytes the `.bak` is built from, repeated saves of the same object keep the write set correct, and two loads of one project still get independent drafts. The comment on `loadDraft` states the rule for anything added to `saveDraft` later — re-read the file, do not reach for `store.canonical.draft`. Measured on a 4000-caption / 2.9 MB draft: `info` 364 ms → 285 ms, `lint` 435 ms → 354 ms, `set-text` 503 ms → 422 ms.
- **The pre-write content is written once and published under both recovery names** — every write saves the bytes it is about to replace twice: once to the single `.bak` that `restore` reads, and again, byte-identically, to the rolling history snapshot that `restore --step 1` reads. On a multi-megabyte project with three readable siblings that is a second full multi-megabyte write per target, of bytes already on disk. The snapshot is now hard-linked to the `.bak` instead, so both recovery names refer to one file. Nothing in the write path ever edits a file in place — `.bak` is replaced by temp-and-rename, snapshots are only ever created or unlinked — so the two names cannot drift: the next write gives `.bak` a fresh file and leaves the older snapshot holding exactly what it held. Filesystems that refuse hard links (FAT/exFAT sticks, some network shares) fall back to the full write, so the snapshot always exists whatever the draft folder sits on. Two side effects, both in the safe direction: the history directory now costs one copy per write instead of two, and a snapshot inherits the `.bak`'s `0600` mode rather than the process umask's `0644` — history snapshots are draft content, and the `.bak` beside them was already `0600`. Measured on a 4000-caption / 2.9 MB three-file project: `set-text` 528 ms → 503 ms, `lint --fix` 669 ms → 617 ms. `test/backup-snapshot-pair.test.mjs` pins the shared-bytes contract end to end: the `.bak` and step 1 agree, each snapshot stays frozen at its own write across a three-write run, replacing the `.bak` never reaches back into the snapshot that shared its bytes, and `restore` and `restore --step 1` land on identical bytes.
- **A write rolls its store forward instead of re-discovering the project** — `saveDraft` keeps a per-path store so a library caller can save the same loaded draft more than once without tripping its own changed-on-disk guard, and it refreshed that store by calling `discoverDraftStore` a second time: re-reading, re-parsing, and re-hashing every sibling from disk to establish something the write already knew — each target now holds exactly the bytes just handed to it. `commitDraftTargets` now returns the content it committed per target path, and the store is rebuilt from that. Everything a re-discovery would recompute still is: `size` and `mtime` come from a `stat` of the file just renamed into place; `version` (and with it `modernStorage` and `layout`) is re-derived from the timelines the targets now hold, which is how a mirror that used to raise the store version stops raising it once overwritten; `diverged` collapses to false on its own because every written target now exposes the same timeline; and a candidate the write did not touch — an unreadable `template-2.tmp`, say — is carried over untouched, error text included. Candidate order is preserved as well: the re-discovery was keyed on the canonical *file* rather than the project directory (so an explicitly addressed `A.json` is not lost), which puts the canonical first, and that is the order targets are written in and named in on a changed-on-disk report. `test/store-after-write.test.mjs` asserts field-by-field equality between the rolled-forward store and a real re-discovery across a single-file project, an enveloped mirror, a version drop, a divergence collapse, and an unreadable sibling. Measured on a 4000-caption project: `set-text` 593 ms → 528 ms, `lint --fix` 715 ms → 669 ms. Written drafts stay byte-identical.
- **Store discovery no longer hashes every sibling timeline up front** — `parseCandidate` stamped each readable candidate with `timelineHash`, a sha256 over a full `JSON.stringify` of that file's whole timeline, and `discoverDraftStore` then folded those into the `diverged` flag. Discovery runs on every command, on every readable sibling — so `info`, `lint`, `segment`, and every mutating write paid for a stringify-plus-hash of the entire draft per file, several megabytes of work each, for a value only three surfaces ever read: `diverged`, `sync-timelines`' plan, and `diagnose`'s candidate table. `timelineHash` is now computed on first access and memoized, and `diverged` became a getter so it does not force the hashes it compares. The value is unchanged — still sha256 over `JSON.stringify` of the timeline the candidate exposes, which is why two files that hold the same timeline behind different envelopes and different indentation still agree on it while their raw `sha256` differs — and a candidate is a discovery snapshot that nothing mutates between discovery and use. `diagnose` and `sync-timelines` read the hash and therefore still pay for it, unchanged. Measured on a 4000-caption / 2.9 MB three-file project: `info` 419 ms → 331 ms, `lint` 513 ms → 426 ms, `set-text` 783 ms → 593 ms, `lint --fix` 943 ms → 715 ms. Written drafts stay byte-identical.
- **`findMaterial` resolves through a per-array id index instead of a fresh scan** — the helper was `arr.find((m) => m.id === id)`, which is fine for a one-shot lookup and quadratic for the callers that run it per segment: `lint` resolves `materials.texts` once per caption both when checking line length and when re-wrapping under `--fix`. It now keeps an id → material `Map` per materials array in a `WeakMap`, so the first lookup on an array builds the index and every later id on that array is a hash lookup. The array itself is the cache key and its length is the validity check, which covers how membership actually changes here: adding a material pushes onto the array (length moves), dropping one replaces the array with a filtered copy (a new key, so a new index), and `migrate` moves entries between arrays (both lengths move). A material mutated *in place* — `--fix` rewriting a text material's `content` — needs no invalidation at all, because the index holds the array's own objects. The signature, the return value, and the `undefined` for a miss are unchanged; a repeated id still resolves to the first entry, and a cache miss still answers from the original `arr.find`, so a malformed draft fails with the identical `TypeError`. `test/find-material-index.test.mjs` pins each of those cases, plus an end-to-end `batch` run that adds a caption and then edits it twice in the same process. Measured on a 4000-caption draft: `lint` 634 ms → 513 ms, `lint --fix` 1296 ms → 943 ms. Written drafts stay byte-identical.
- **`lint` only shells out to `ffprobe` once it has a file to probe** — the local-path pass resolved `ffprobeAvailable(probeCmd)` before the material loop, and that call spawns `ffprobe -version`. Every `lint` on a project with local-path checking on therefore paid for a process spawn, including the large class of drafts that have nothing to probe at all: caption-only projects, projects whose media is all remote URLs, and projects whose media files are missing (those are reported as `missing-file` and skipped before any probe). The availability check is now resolved on the first material that reaches the probe step. `probe.ts` already memoizes the answer per command string, so the spawn still happens at most once per process and cannot change mid-run; `probeMedia: false` short-circuits without spawning exactly as it did. Measured on a 4000-caption draft with no local media: `lint` 761 ms → 634 ms, `lint --fix` 1455 ms → 1296 ms. Locked by `test/lint-hot-path.test.mjs`, which points `ffprobeCmd` at a shim that logs its own invocations and asserts the log stays absent for an unprobeable draft and appears for a draft whose media is on disk.
- **`lint` resolves material ids from one precomputed set instead of rescanning every materials array — same report, no longer quadratic** — `lintDraft` asks "does this material exist anywhere?" once per segment (for `material_id`) and once per entry in `extra_material_refs`, and `fixDraft`'s dangling-ref sweep asks it again for every surviving ref. Each of those questions used to walk every array under `materials.*` until it found a hit or ran out, so a draft with S references and M materials did O(S × M) work: on a 4000-caption draft that is roughly 32 million entry visits per lint, and `--fix` pays it three times (a lint before, the sweep, a lint after). The membership rule is unchanged — *any* `materials.*` array, string ids only, so a material whose id is not a string still cannot answer a string lookup — it is now collected in a single pass and probed as a `Set`. The set is built lazily on the first lookup that needs it, not up front, because a draft with no `materials` object at all must still fail at exactly the reference the scan failed at, and `lintDraft`'s first loop skips those segments before ever asking. Nothing between the build and the last lookup adds or drops a material: `fixDraft`'s passes move timeranges, rewrap caption text, and rewrite media paths, but never touch materials membership. Measured on a 4000-caption / 8000-material draft: `lint` 1537 ms → 761 ms, `lint --fix` 3091 ms → 1455 ms. Written drafts, stdout, stderr, and exit codes are byte-for-byte identical across every case in the harness.
- **Dead code removed — no user-visible behaviour change** — a re-audit after the v0.17.0 feature bundle confirmed a set of symbols that nothing calls, on any surface: `probe.ts`'s legacy dimension pipeline (`parseProbeStreams`, `displayDimensions`, `probeVideoDimensions`, the `ProbedDimensions` interface), superseded by `parseMediaProbe`/`probeMedia` and referenced only by its own tests; `decorators.ts`'s `transitionSlugs()` (the `enums --transitions` listing reads `listEnum`, never this wrapper); `time.ts`'s `usToSeconds()`; and `migrate.ts`'s `SchemaVersion` type. None is re-exported from `lib.ts`, none is reachable through the `describe`/`completions` dynamic surfaces, and the package exposes no deep imports, so the library's public API is unchanged. `normalizeRotation` stays — both the surviving parser and the rotation math use it. Coverage that the deleted tests provided for *surviving* behaviour was re-homed onto `parseMediaProbe` rather than dropped: the Display-Matrix `side_data_list` rotation path, the no-usable-stream null, and the malformed-JSON null are now asserted against the function that still implements them, and the add-video ffprobe test reads its expected dimensions through `probeMedia`. Written drafts stay byte-identical.
- **`--font` is no longer stored after parsing** — the flag was parsed into a `flags.font` field that no command ever read. The field and its assignment are gone; the flag itself still consumes its value token exactly as before, because it predates the release-scoped-flag mechanism and is therefore parsed globally on every command, where swallowing the pair is observable in the positional stream (`add-text ... hello --font Arial world` yields the text `hello world`, unchanged). That behaviour is now pinned by a regression test in `test/flag-scoping.test.mjs` — it had none.
- **`bin/capcut` removed** — a two-line launcher that nothing referenced: `package.json`'s `bin` entries both point at `dist/index.js`, the `files` whitelist never included `bin/`, so it was absent from the published package, and neither the Dockerfile nor `action.yml` invoked it.
- **Ten duplicated blocks folded into shared helpers — no user-visible behaviour change** — copy-paste that had accumulated across the add-\* and text commands, consolidated only where the copies were provably identical. Empty tracks are now built by one `makeTrack(type, name, isDefaultName)` in `draft.ts` instead of nine hand-written object literals (eight in `factory.ts`, one in `sfx.ts`); `addEffect`/`addFilter` share their id-minting + find-or-create-track prologue (`effectTrackSlot`) and their 27-line material-push + segment + return tail (`pushEffectSegment`), with the material object the only parameter that differs; `setMixMode` stops re-implementing `findCropMaterial`'s video-material lookup and calls it, the differing error wording carried by a `label` argument; `setTextStyle`, `setTextRanges`, `setBubble`, `extractTextPreset`, and `applyTextPreset` share one `requireTextMaterial(draft, segmentId, label?)` whose optional label preserves each caller's exact track-type message (`bubble-text` / `make-preset` / `--preset`); text and image animations share `ensureAnimContainer`; `preset.ts` imports `hexToRgb01` from `decorators.ts` rather than keeping a byte-identical copy; and in `index.ts` the text-styling flag block (two sites), the `import.meta.url`-relative template-dir resolution (five sites — `init`, `quickstart`, `compile`, `compile --data`, `import-timeline --out`), and the Wikimedia licence payload (two sites, where the audio key set is a strict prefix of the video one) each became one function. Key **order** was treated as load-bearing throughout, because it is the order these objects serialize into the draft and into command JSON: every helper builds its object in the order the literals did, and the Wikimedia builder appends `width`/`height`/`mime` after the six shared keys rather than interleaving them. Verified by a 72-command oracle — every add/edit/read command, both preset paths, all five template-resolution sites, and 22 error paths — captured before and after and compared byte-for-byte after normalizing only UUIDs, temp paths, and wall-clock stamps: the six drafts it writes, all stdout, all stderr, and all exit codes are identical. The Wikimedia payloads were additionally diffed against live Commons fetches on both `add-video` and `add-audio`. Three guard messages that no test covered — `mix-mode`/`crop`'s "only applies to video/photo materials" and "Text material not found for segment" — are now pinned verbatim in `test/material-guard-messages.test.mjs`, since the refactor moved the code that emits them. Net 139 lines removed from `src/`.
- **`dist/enums.json` ships minified — same table, 65 KB smaller** — the build step re-serializes `src/enums.json` through `JSON.parse`/`JSON.stringify` instead of copying it verbatim, dropping the two-space indentation that only ever existed to keep the generated source diff-readable. The checked-in `src/enums.json` is untouched, so `extract-enums` and its git diffs are unaffected. Nothing reads the file as text — `enums.ts`'s `load()` is the single consumer and it parses immediately — and the round trip was verified lossless for values *and* key order (the table carries no integer-like keys, which are the one thing a JS object would reorder). All 56 `enums` invocations (14 flags × both namespaces × JSON and `-H`) were captured before and after and are byte-for-byte identical. 793,645 → 726,782 bytes.
- **`@types/node` pinned to the oldest runtime the package supports** — the dev dependency sat on `^25.x` while `engines` declares `node >=18` and CI runs 18/20/22, so `tsc` was type-checking against a standard library far newer than the floor: an API added after Node 18 compiled cleanly and would then throw at runtime on a supported version, with CI catching it only if a test happened to exercise that line. Pinned to `^18.19.130` so the compiler enforces the floor the package advertises. No source change was needed — `tsc --noEmit` exits 0 as-is, confirming nothing had already drifted past Node 18 — and the emitted `dist` is byte-for-byte identical under both type lines, so the published output is unchanged. The pin is load-bearing rather than cosmetic: a probe importing Node 22's `fs.glob` compiles under the old types and is now rejected.
- **Unreachable type declarations dropped from the tarball** — `tsc` emits a `.d.ts` for all 36 modules, but `exports` exposes exactly one entry (`./dist/lib.d.ts`), so a consumer can only resolve the declarations reachable from it; the other 28 were unresolvable by any import and shipped as dead weight. `files` now drops `dist/*.d.ts` and re-adds the reachable eight — `lib`, `command-specs`, `doctor`, `draft`, `lint`, `runner`, `store`, `version` — where `store` is reachable only transitively, which is why the set is computed rather than hand-listed. Every compiled `.js` still ships, so the CLI and the runtime library are untouched. Verified end-to-end: the packed tarball was installed into a clean project that imports all 19 exported values and all 24 exported types, and `tsc --noEmit` with `skipLibCheck: false` exits 0. `test/packaging.test.mjs` re-runs the reachability walk on every build and fails if the shipped set and the reachable set diverge, so adding a module to the public entry cannot silently strip its types.

### Security

- **`export --batch` no longer interpolates the draft folder name into the AppleScript it runs (macOS)** — the draft directory was pasted into a double-quoted AppleScript literal (`open POSIX file "<dir>/draft_content.json"`) and the whole string handed to `osascript -e`, so a folder whose name contained a double quote closed the literal early and the rest of the name was compiled as AppleScript — `do shell script` included, which is arbitrary command execution as the user, triggered by nothing more than pointing `export --batch` at a directory someone else created. The path is no longer part of the script: the script declares `on run argv` and reads the path back out of `item 1 of argv`, and the path travels as its own `osascript` argument, where AppleScript never parses it. Quoting a folder name can no longer reach the compiler, so this is closed by construction rather than by filtering the characters that happen to be dangerous today. The generated argument list is now built by the exported, I/O-free `macosExportArgs(draftDir, app)` — the `windowsExportScript` pattern — so the property is asserted off-macOS in `test/export-macos.test.mjs`. Every legitimate folder name opens exactly the same draft file as before.
- **`export --batch` escapes the draft folder name for the PowerShell literal it runs (Windows)** — the same shape on the Windows path: the draft directory went raw into the single-quoted `Start-Process -FilePath '<dir>\draft_content.json'` string that `windowsExportScript` builds for `powershell -NoProfile -Command`, so a folder name containing an apostrophe closed the literal and the remainder ran as PowerShell statements. Every single-quote character is now doubled, which is the complete escape for that context — and deliberately all four characters PowerShell's tokenizer accepts as a single quote (`'` plus the Unicode curly variants `U+2018`/`U+2019`/`U+201A`/`U+201B`), since any one of them closes a literal opened with any other. Because PowerShell decodes a doubled quote back to the character itself, this also fixes a latent bug for legitimate paths: a folder like `C:\Users\Rene's Drafts` previously produced a broken script and now opens correctly. Round-tripping the literal back through PowerShell's own rule is pinned in `test/export-windows.test.mjs`; a path with no quote in it generates a byte-identical script to before, verified across ASCII, spaced, UNC, umlaut, and CJK paths.
- **A `compile` spec's `name` can no longer name a path out of the draft store** — without `--out`, the output directory is `resolve(<draft store>, spec.name)`, and with `compile --data` every row derives its own name from row data through the same resolve. Neither the spec nor the rows are the CLI's own input — a spec is exactly the artifact an agent or an upstream pipeline hands over — yet nothing checked the name's shape, so `"name": "../../elsewhere"` built a full draft outside the store, and a JSONL row could do the same for any name it templated. `validateSpec` now refuses a name that is empty/whitespace, `.` or `..`, carries either OS's path separator, or opens with a drive prefix — the same refusal `rename` already applies to a folder name, plus the `X:` prefix (`C:name` carries no separator yet still resolves against that drive's own working directory on Windows). Containment then follows from the shape rather than from a filter: a single component with no separator and no drive prefix can only ever resolve to a child of the directory it is resolved against. The check runs on the single-draft path and on every per-row derived name, and because it lives in the spec validator it fires under `compile --check` too — before `initDraft` seeds any directory, so a rejected spec never leaves a half-built draft behind. `--out` is unaffected: it names the directory explicitly and always did. Every name that was legal before still builds to exactly the same path, byte-identically.
- **Draft writes are staged in an unpredictable temp file that is created exclusively** — every mutating command writes through temp+fsync+rename, and the temp path was `<target>.capcut-cli-<pid>-<now>.tmp` opened with a plain `"w"`. That is both guessable — pid and clock are the only inputs — and symlink-following, so anyone able to create files in the draft folder could pre-place a symlink at the path the next save would pick and turn every draft save into a write to a file of their choosing, with the victim's own permissions. Not a theoretical folder either: a draft store is routinely a synced or shared directory, and the CLI is built to run unattended. The name now carries a crypto random component *and* the open is exclusive (`"wx"`, i.e. `O_EXCL`), which refuses a path that already exists — a symlink included — rather than following it; a collision simply draws another name, up to eight attempts. Both stagers, the multi-file draft save and the `writeAtomic` used for metadata sidecars and `.bak` files, now share the one helper. The bytes written and the rename that commits them are unchanged, and the added cost is one 8-byte `randomBytes` call (~5 µs) against a write path that is fsync-bound at ~1.3 ms — measured at +1.3% median over nine paired runs, inside the run-to-run noise.
- **`serve` no longer echoes credential values into its result lines** — every job's fully resolved argv was echoed back in the JSON result line, and those lines are `serve`'s stdout: for the n8n/Make/Coze/cron callers the command exists for, that is a log file, a workflow execution record, or a CI artifact. A job passing `--api-key` therefore wrote the Anthropic key verbatim into all of them. The echoed args now carry `***` in place of the value of a credential-bearing flag — `--api-key` is the CLI's only one today — in both the `--api-key VALUE` form the CLI parses and the `--api-key=VALUE` form it does not (a caller who typed it still put a key on the wire). The spawned child receives the real argv unchanged, so no job behaves differently, and every non-credential token is still echoed exactly as before.
- **Wikimedia downloads take the last component of the `File:` title, never a path** — `capcut add-video`/`add-audio` accept a Wikimedia URL and stage the asset into the draft's `assets/` folder under a filename derived from the URL's own `File:` title. Percent-encoded separators survive `decodeURIComponent` (`File:..%2F..%2Fx.jpg` decodes to `../../x.jpg`), and the result was joined onto the destination directory unchecked, so a crafted Commons URL could place a downloaded file outside the draft. Latent rather than live — the title also has to resolve through the Commons imageinfo API for the download to happen at all — and fixed as defence in depth: the title now contributes its basename only, and the resolved path is asserted to sit inside the destination directory before anything is written, which additionally covers a caller-supplied `destFilename`. Ordinary titles save to exactly the path they always did.
- **`render --burn-captions` validates a draft's caption colour before writing it into the ffmpeg filter** — a text material's `text_color` was interpolated straight into `drawtext`'s `fontcolor=` option. `drawtext` options are colon-separated, so a draft could end the colour with a `:` and append options of its own; `textfile=` reads an arbitrary local file and burns its contents into the rendered video, turning a shared or downloaded draft into a local-file-disclosure channel. The colour is now accepted only in ffmpeg's two colour spellings — `0xRRGGBB[AA]` hex (what a `#rrggbb` value becomes) or a bare colour name, each with an optional `@alpha` — and anything else falls back to the existing `white` default, so a caption still burns in rather than the render failing. Colour names are checked on shape rather than against ffmpeg's ~140-entry list: the charset is what makes the value safe (it admits no `:` and no backslash, so a matching value provably cannot leave the option it is written into), and passing names through keeps an unknown one failing in ffmpeg the way it does today instead of being silently repaired. Verified byte-identical filter graphs across every hex form, named colour, `@alpha` form, and the non-string fallback; the only values whose output changes are ones ffmpeg already rejected outright (`""`, `#`, `#zzz`, names carrying digits), which never produced a render.
- **`tsx` refreshed so the dev toolchain pulls a patched `esbuild`** — `npm audit` reported one low-severity advisory, [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) (esbuild's development server allows arbitrary file read on Windows), reaching the tree only as `tsx`'s transitive `esbuild@0.27.7`. `npm audit fix` could not clear it: `tsx` 4.21.x pins `esbuild ~0.27.0`, and the advisory covers that entire line. `tsx` 4.22.0 moved to `esbuild ~0.28.0`, so refreshing within the existing major resolves `tsx@4.23.10` / `esbuild@0.28.1` and `npm audit` now reports 0 vulnerabilities. The declared floor moves `^4.0.0` → `^4.23.10` so a lockfile-less install cannot resolve back onto the affected line; this stays inside `tsx` 4.x, so no tooling major changes. Nothing shipped is affected either way — `tsx` is a devDependency used only by `npm run dev`, and the advisory concerns a dev server this project never starts.

## [0.17.0] — 2026-08-07

Eight features in one release — the next slice of the opportunity backlog, bundled — plus the honest slice of the ninth: keyframeable mask geometry (#44) stays evidence-gated because no credible on-disk encoding ground truth exists anywhere public, so what ships is the `fixture` evidence harvest that unblocks it, not a guessed encoding the app would silently no-op. The headline is pipeline round-trips: `import-timeline` brings OpenTimelineIO documents back into the draft format (the inverse of `export-timeline`), and `compile --data` turns one spec plus N JSONL rows into N built-and-registered drafts. Behaviour changes are called out inline; the ones to know: `lint` gains the warning-severity `main-track-gap` check — a draft whose only finding is a main-track gap linted exit 0 before and exits 1 now (`lint --fix` closes gaps up where safe) — while the new `media-outside-draft` check is info-severity and changes no exit codes; and mutating writes now WARN on stderr in two new cases — a CapCut 7.x nested `Timelines/` layout whose root-mirror edit the app may discard, and an app auto-upgrade since the last CLI write — warn only, never a refusal. With none of the new commands or flags in play, written drafts stay byte-identical to v0.16.1.

### Added

- **CapCut 7.x nested `Timelines/` layout — detected, named, and warned about (previously silent)** — a real CapCut 7.7 project is reported to keep its live document at `Timelines/<main_timeline_id>/draft_info.json` (pointer: `Timelines/project.json`), with the project-root `draft_info.json` a mirror the app regenerates on open (#50). Store discovery only ever considered root candidates, so a CLI edit reported success, rewrote the root mirror, and the app discarded the edit on the next open — without one word from the CLI. The structure is now detected: `discoverDraftStore` reports layout `timelines-nested` (pre-8.7 stores only; CapCut >= 8.7 keeps its `template-2.tmp` selection and layout value untouched) plus the nested document paths, `diagnose` names the layout with a next_action carrying the discard risk and the fixture CTA (JSON gains `nested_timelines`), `version` carries the same note, and every mutating write on such a project — the `saveDraft` path plus `sync-timelines --apply` — prints a stderr WARNING that the root-mirror edit may be discarded by the app. **Warn only, no canonical flip:** reads and writes still target the project-root files byte-identically to v0.16.1, covered by test — promoting the nested file to canonical (#51) was rejected because no field artifact backs the claim yet. That artifact is exactly what `capcut fixture` now collects: `Timelines/project.json` and the nested timeline documents ride along in the redacted bundle (relative paths preserved), so a reporter can finally attach the evidence #50 is blocked on.
- **`import-timeline <file.otio> (--out <new-project> | --into <project>)` — OpenTimelineIO in, the inverse of `export-timeline`** — the ecosystem has an export story but no road back INTO the draft format from standard NLE interchange: OTIO/XML-adjacent import is a standing ask across the neighbouring tools (OpenCut-app/OpenCut#719, Ersiter/Jianying-CapCut2XML#4, ArcReel/ArcReel#1657). Reads the exact schema set `export-timeline` emits — `Timeline.1`/`Stack.1`/`Track.1`/`Clip.1`/`Gap.1`, `ExternalReference`/`MissingReference`, `LinearTimeWarp` — and builds the cut through the same factory functions the `add-*` commands use. Clips become video/audio segments with their source ranges; gaps become timeline offsets; a `LinearTimeWarp` inverts the exporter's documented relationship exactly (timeline duration = source range / time_scalar, so speed = time_scalar and the segment's target duration is recomputed from its source duration); `metadata.capcut.volume` rides back onto the segment; times convert from frames at each RationalTime's own rate. `ExternalReference` media that exists on disk is staged into the draft's `assets/video/`/`assets/audio/` through the same collision-safe copy `add-video`/`add-audio` use; a reference whose file is absent keeps its `target_url` verbatim (point `relink` at the media folder), and a `MissingReference` becomes an empty-path placeholder material — both are placeholder clips in the `replace-media` sense, listed in the JSON result's `placeholders` and named on stderr with the swap command. `--out <new-project>` builds a fresh draft (folder name from the path, display name from the timeline name, draft fps from the document's rate, so a re-export converts at the same frame rate); `--into <project>` appends the timeline onto an existing draft as NEW tracks — imported clips never land on an existing track, so existing segments can never be overlapped or re-timed, and a track-name collision de-collides with a numeric suffix. Unsupported OTIO features — non-Track stack children, unknown track kinds, transitions and other non-Clip/Gap items, effects beyond a single positive-scalar LinearTimeWarp, generator/other references, markers, a non-zero `global_start_time` — are reported in the result's `skipped` array and on stderr, never silently dropped (the `export-timeline` house rule). Round-trip covered by test: export a draft, import the document into a fresh one, and track/segment counts, target ranges, source ranges, and speeds reproduce exactly. With the command not in play every write path, `add-video`/`add-audio` included, stays byte-identical to v0.16.1.
- **`compile --data <rows.jsonl|->` — one spec + N JSONL rows = N built-and-registered drafts** — mass-production pipelines (one video per product, quote, or listing) hand-loop the CLI today, invoking `compile` once per output with a freshly rewritten spec each time (ArcReel/ArcReel#923, Gardene-el/Coze2JianYing#85). `--data` takes a JSONL file (or `-` for stdin) and builds one draft per row through the exact single-draft compile path — same validation, same factory functions, same store registration. The templating rule is deliberately minimal: a `{{key}}` placeholder inside a STRING value of the spec (nested objects and arrays included, so the draft `name` too) is replaced with the row's value for that key — strings, numbers, and booleans; anything else is a row error — and nothing cleverer: no expressions, no defaults, no nested lookups. Non-string spec values are never templated (keep numeric fields numeric), and a placeholder with no matching row key is a row error rather than a draft that silently ships reading `{{title}}`. Row errors mirror `batch`'s per-line contract exactly: by default every row is validated up front (JSON shape, spec validation, media pre-flight, name/directory collisions) and the first bad row aborts with its 1-based row number before any draft is written; with `--continue-on-error` the rows that validate are built, failures are reported per row, and the exit code is 1 when any row failed. Output is a summary JSON array — `row`, `ok`, then `name` + `draft_path` or `error` per row. Each row names its own draft, so `--out` (a single directory) is rejected with `--data` — use `--drafts <dir>` — and duplicate post-substitution names are a row error. Without `--data`, `compile` behaves exactly as before: placeholder-looking text in a spec compiles verbatim, and written drafts stay byte-identical to v0.16.1.
- **`lint`: `media-outside-draft` detection + `--fix` stage-in** — flags video/audio materials whose `path` points outside the draft folder. Externally-referenced media plays fine on the machine that authored the draft and breaks on any move: copy the draft to another machine, reorganize the media folder, or open it on a sandboxed macOS build that cannot read outside the draft, and the app shows the black-screen/missing-media class (sun-guannan/VectCutAPI#48, #65; luoluoluo22/jianying-editor-skill#16). Severity info, deliberately not warning: app-authored drafts routinely reference local imports wherever they live on disk, so a warning would flip exit codes (0 -> 1) on a huge installed base of perfectly valid drafts — the `unknown-effect-slug` trust model. **No exit code changes for any draft.** `--fix` stages the file into the draft's `assets/video/` / `assets/audio/` through the same collision-safe copy `add-video`/`add-audio` use — a basename already present with different content de-collides under a content-hashed name, re-staging identical content is a no-op — and rewrites the material path (plus its display-name fields, the `replace-media` convention) to the staged copy; the rewritten path is regenerated from the draft folder, so wrong-OS separators in the old value disappear by construction, never by string conversion. A missing source file stays report-only (`fixable:false`) with the `relink` repair as `suggested_command` — there is nothing on disk to stage, and repointing the material first is the deliberate step. Only absolute paths are judged (a relative or placeholder path resolves against the draft folder, and both separator styles count as inside), URLs are skipped, `--no-check-paths` disables the check, and `--fix --dry-run` previews without copying — a file copy is a side effect a discarded draft write cannot roll back. Drafts whose media already lives inside the folder write byte-identically to v0.16.1.
- **App auto-upgrade tripwire** — the ecosystem's hottest standing pain: the desktop app updates itself, rewrites the drafts it opens, and a pipeline validated against one version quietly crosses a support boundary with nothing in the toolchain saying so until writes start misbehaving (GuanYixuan/pyJianYingDraft#115 — 33 comments of exactly this — and #178). The CLI now remembers the last version evidence it saw per draft store — in its own config area, `~/.config/capcut-cli/app-versions.json` (`XDG_CONFIG_HOME` respected, `CAPCUT_CLI_APP_VERSIONS` override; following the `harvest-enums` catalogue pattern, state never lands inside a draft) — and every mutating write (the `saveDraft` path plus `sync-timelines --apply`) compares the current evidence, the same effective tuple the v0.15 write guard detects, against that record. On a difference the command prints a stderr WARNING naming old -> new (`app version 8.7.0 -> 10.5.0`; app-source and schema-generation moves likewise) and its JSON result gains `app_version_drift` (`store_dir`, `from` with its `seen_at`, `to`, `changes`), then the record is updated. **Warn only — the tripwire never refuses**: beyond-evidence writes stay gated by the existing `--force-write` guard; the tripwire exists so the *first* write after an unnoticed upgrade says so, not the tenth. First sighting records silently; markerless CLI-created drafts carry no evidence and are never tracked; a corrupt state file reads as empty with a WARNING and the next mutating write rebuilds it (the `user-enums.json` robustness rule). `capcut version` reports `app_version_drift` read-only (it never updates the record, so the drift stays visible until a mutating write acknowledges it) plus an `App drift:` line under `-H`; `doctor` gains an `app-upgrade` check that re-inspects every tracked store and reports drift as warn, never a failure. docs/version-support.md gains the tripwire's contract and a "Pinning app updates" section with per-OS (Windows/macOS) guidance built from conservative, verifiable statements — including that no supported permanent update opt-out is documented for either app. Written drafts stay byte-identical to v0.16.1 with or without tripwire state in play.
- **zh-CN documentation: translated command reference + JianYing-first quickstart** — the JianYing half of the user base reads Chinese first: the Chinese README is one of this repo's most-viewed paths (the demand signal already recorded in docs/jianying-encryption.md), and the largest neighbouring tools (GuanYixuan/pyJianYingDraft, sun-guannan/VectCutAPI) document in Chinese first — yet beyond the translated README every page here was English-only. `docs/command-reference.zh-CN.md` is a full Simplified-Chinese translation of the generated command reference — all 80 commands as of this release, `import-timeline`, `compile --data`, and `rename` included — using the app's own terminology (剪映/草稿/轨道/片段/关键帧/蒙版/字幕/特效/转场/滤镜) with command names and usage strings kept verbatim; the English file stays the generated source of truth (`npm run docs:commands`) and the translation states that contract in its header. `docs/quickstart.zh-CN.md` is a quickstart written FOR JianYing users rather than translated from the CapCut one: it leads with the version reality (5.9.x as the last plaintext line, 6.0+ encryption detected but never decrypted, the write guard refusing the 6.0+ era without `--force-write`), then the JianYing draft-store paths per OS, the three-command first draft, the `--jianying` enum namespace with Chinese-name lookup (`"_3D空间"`), and a JianYing-feature → command map. Both READMEs and docs/README.md link the new pages. Docs only — no command, flag, or write-path behaviour changes anywhere.
- **`lint`: `main-track-gap` detection + `--fix` close-up** — flags gaps between consecutive segments on the main video track (the first `type: "video"` track — the bottom layer). CapCut's main track is magnetic: the app closes such gaps the moment the draft is opened, silently pulling every later segment left (sun-guannan/VectCutAPI#54), so a generated draft that looks correct in JSON re-times itself on open and captions, overlays, and audio aligned to the shifted content drift out of sync. Severity warning — **exit-code change: a draft whose only finding is a main-track gap linted exit 0 before and exits 1 now**, so CI gates on `capcut lint` start failing on drafts that were always going to shift in the app. `--fix` closes a gap up (shifts the later main-track segments left — the same motion the app performs, so the written timing matches what CapCut will show) only where that is mechanically safe: no other track may have content playing at or after the gap, because then nothing can desync. Where other tracks are aligned to the segments that would move, the instance stays report-only (`fixable:false`) with a `suggested_command` — re-timing the dependent tracks in lockstep is a deliberate, content-touching repair the CLI won't run on its own. Gaps on overlay video tracks are never flagged; only the first video track is magnetic.
- **`rename <project> <new-name>`** — give a draft a new name after creation, which no tool in the ecosystem offers (sun-guannan/VectCutAPI#45 asked; the working answer to date is recreating the whole draft under the new name). Renames the draft folder on disk and rewrites the name and every self-referential path recorded about it — `draft_name` plus any field pointing at or under the old folder (`draft_fold_path`, `draft_json_file`, and any other absolute path an app build stores, e.g. an absolute `draft_cover`) — in `draft_meta_info.json` and in the draft's entry in the store's `root_meta_info.json`, with `tm_draft_modified` bumped, as one transaction: the same temp+fsync+rename writes `register` uses, a `.bak` per rewritten file, and a failed step restores the already-rewritten files and puts the folder back under its old name. Refuses when the target folder already exists, when the name is empty or contains a path separator, when either metadata file exists but does not parse (rename never renames around a file it cannot update — repair the sidecar with `register --apply`, restore the index from a backup), and while the editor is running unless `--force-write`. A missing sidecar or index entry is only reported in `targets` and the folder is renamed anyway — `register --apply` recreates them afterwards; store-root discovery matches `register` (parent `root_meta_info.json`, managed `com.lveditor.draft` path, or `--drafts <dir>`). Timeline files (`draft_content.json` / `draft_info.json`) are never touched, so absolute media references under the old folder path go stale: they are counted (`stale_media_refs`) and the exact `relink` repair command is printed. The JSON result carries the old/new names, the old/new folder paths, and `updated` — every file path rewritten; `--dry-run` previews the same plan without moving anything.
- **Mask-keyframe evidence harvest in `fixture` — #44 stays evidence-gated instead of guessed** — keyframeable mask geometry (the #43 stroke-following local-retouch flow) needs ground truth that still does not exist publicly: the desktop app can keyframe mask position/size/rotation/feather, but no app-authored draft carrying that encoding has been captured in this repo or the neighbouring ecosystem, the sample draft offered in #43 was never attached, and an invented encoding would save without error and silently no-op in the app — the pyJianYingDraft#160 failure class. So the feature does not ship on guesswork; the harvest that unblocks it does: every `fixture` bundle now includes `mask-keyframe-report.json`, mapping each mask material across all three variant arrays (`masks`/`common_mask`/`common_masks`) — JSON path, config keys, keys beyond the CLI's own write set, keyframe-shaped nodes inside the entry — plus every `property_type` in the draft split known/unknown and the segments carrying both a mask ref and keyframes; `template-2.tmp`-style embedded string-JSON documents are walked too. The report's verdict names a draft that actually contains mask-keyframe structures, and the bundle README, the JSON result (new `mask_keyframe_evidence` field), and the notes point the reporter straight at #44 when it does — animate a mask in the app, run `fixture`, attach the bundle, and the encoding is harvested. Extraction runs on the redacted text only (nothing scrubbed can re-enter through the report), `fixture` stays read-only — covered by a byte-identical source-draft test — and the gap plus both unverified candidate shapes (segment-level `KFTypeMask*` family vs a container inside the mask material) are now documented in `docs/draft-schema/03-keyframes-and-animations.md`. Written drafts everywhere stay byte-identical to v0.16.1.

## [0.16.1] — 2026-08-03

### Fixed

- `init`, `quickstart`, and `compile` (without `--out`) resolved their default draft store from a hardcoded macOS path built on `$HOME`, on every platform. `doctor` already knew the per-OS stores, but nothing else used them, so on Windows — where `HOME` is normally unset — the default collapsed to a literal `~/Movies/CapCut/User Data/Projects/com.lveditor.draft` folder created next to the working directory. CapCut refuses a draft there with "this draft comes from an unconventional path and is temporarily unsupported" (#52), on any app version. The per-OS candidate list now lives in `store.ts` as `draftDirCandidates()` (`doctor` delegates to it) and draft-creating commands resolve through `defaultDraftsDir()`: `CAPCUT_DRAFT_DIR` wins, then the first store that exists on disk, then the first candidate for the platform. Windows derives the store from `LOCALAPPDATA` (falling back to `USERPROFILE`), never from `HOME`. On a platform with no known store (Linux) the commands now exit 1 naming `--drafts` and `CAPCUT_DRAFT_DIR` instead of silently writing a draft the editor will not open. `compile --out` never touches the store. Existing drafts already stranded in a wrong location are repaired with `register --apply`.

## [0.16.0] — 2026-07-31

Six features in one release — the next slice of the opportunity backlog, bundled. The headline is version-compat: the draft_info-primary Mac layout becomes first-class instead of edit-only, and masks land in the array variant the installed app build actually reads. Behaviour changes are called out inline; the ones to know: `sync-timelines`/`register` now *work* on Mac-layout projects where they previously refused, `mask` on a version-marked JianYing draft targets the correct variant array (that is the fix), `migrate` also consolidates `common_mask[]`, `lint` probes existing local media by default (`--no-probe` opts out) and gains a warning-severity dangling-ref check — a draft carrying those now exits 1 (run `lint --fix`). Markerless and CapCut drafts write byte-identically to v0.15.0 with no new flags in play.

### Added

- **First-class draft_info-primary layout** — newer Mac builds drive a project from `draft_info.json` with no `draft_content.json` beside it, and every ecosystem tool breaks there (jianying-mcp#5, pyJianYingDraft#177, #194). `discoverDraftStore` now reports a `layout` (`content-primary` | `info-primary` | `unknown`), surfaced by `diagnose` (plus a next_action naming the layout and the fixture CTA). **Behaviour change:** `sync-timelines` on such a project previously refused outright; it now promotes `draft_info.json` to the sync canonical and reconciles mirrors from it — the plan carries `layout` and a `canonical_note` naming the promotion and the synthetic-only evidence. `register` previously errored; it now derives id/name/duration from `draft_info.json` when `draft_content.json` is absent (plan gains `identity_source`, and the written sidecar's `draft_json_file` points at the real timeline file). Canonical filenames in both commands' output are no longer hardcoded. Round-trip evidence for this layout is synthetic-only, so the fixture CTA ships on every surface — if a Mac project opens fine in your app, `capcut fixture <project> --out <dir>` moves it to fixture-tested.
- **Version-aware mask writes** — three mask array variants exist in the wild (`masks` legacy, `common_masks` JianYing 9.6+, `common_mask` the CapCut-verified struct this CLI writes), the app reads exactly one, and masks in the wrong one silently never appear (pyJianYingDraft#160). `mask` now picks its target: explicit `--mask-field <masks|common_mask|common_masks>` wins, a version-marked JianYing draft follows its version evidence (a populated-but-wrong variant is deliberately not trusted — it may be exactly the #160 failure), otherwise an already-populated variant (newest era first), else `common_mask`. Markerless CLI-created drafts write byte-identically to before. `mask --off` and the one-mask-per-segment guard now cover all three variants; the JSON result gains `field`. `migrate` consolidates `common_mask[]` into the target array on both directions of the 9.6 jump (**behaviour change:** those entries were previously left behind). New info-severity, report-only lint check `mask-field-mismatch` flags masks split across variants (any app) and the wrong-array-for-this-JianYing-version case, naming the exact `migrate` call. `capcut version`'s `mask_field` gains the `common_mask` value, and `both` now means any two-plus populated variants.
- `export-timeline <project> [--out <file.otio>]` — the cut as OpenTimelineIO JSON, the exit ramp when an app build rejects a draft (Ersiter/Jianying-CapCut2XML#4): clip order, trims, per-track gaps, speed as `LinearTimeWarp` (timeline duration = source range / time_scalar — exactly CapCut's source/target relationship), media paths with available ranges, and segment/material ids under `metadata.capcut`. Emits the stable OTIO schema set (`Timeline.1`/`Stack.1`/`Track.1`/`Clip.1`) that every reader accepts — DaVinci Resolve imports `.otio` natively. Raw document on stdout (pipe-able, like `export-srt`); `--out` writes the file and prints a JSON summary. Read-only and deterministic. Text tracks are skipped with a pointer to `export-srt`, sticker/effect/filter tracks with a no-portable-equivalent note — always reported, never silent.
- `harvest-enums <project> [--apply] [--catalogue <path>]` — learn store resource ids from a draft the app itself authored, instead of guessing at app internals (GuanYixuan/pyCapCut#12: newer store effects missing from every ecosystem table). Every harvested `effect_id`/`resource_id` joins lint's known-id set, so app-authored effects stop flagging `unknown-effect-slug`/`unknown-font-id`; named entries from cleanly-mapped kinds (effects, filters, transitions, masks, sound effects) become writable slugs through the normal `findEnum` path — harvest a draft that uses "Snowfly" once and `add-effect snowfly` works from then on. Ambiguous kinds stay id-only, never guessed: animations (intro/outro/combo indistinguishable in a draft), text-shape bubbles (would resolve as the wrong material shape), nameless font ids. The catalogue lives at `~/.config/capcut-cli/user-enums.json` (`--catalogue` or `$CAPCUT_CLI_USER_ENUMS` override); the bundled table wins slug collisions; a hand-broken catalogue reads as empty everywhere, is surfaced with a WARNING, and `--apply` refuses to clobber it. Plan by default; `--apply` writes the catalogue — never the draft.
- **Media compatibility probe in `lint`** — two best-effort info checks on local media files that exist, only when ffprobe runs (a host without ffprobe lints exactly as before; `--no-probe` and `--ffprobe-cmd` are on `lint`): `vfr-media` flags variable-frame-rate video (avg vs base frame rate diverging >1% — the screen-recording/phone-capture class that drifts preview/render timing and breaks frame-based pipelines, 0xsline/OpenChatCut#1) with the exact `ffmpeg -fps_mode cfr` normalize line, and `media-unreadable` flags a file that exists but ffprobe cannot parse. `probe.ts` now reports `avgFps`/`baseFps` separately plus an `isVfr` helper.
- **`dangling-companion-ref` + remediation hints** — new warning-severity lint check for `extra_material_refs` entries that resolve to no material (the leftover of a partial edit); always safely fixable, and `lint --fix` drops the ref — never a segment, never a material. **Behaviour change:** a draft carrying dangling refs now lints exit 1. `missing-material` and `missing-file` stay deliberately report-only (the only mechanical repair would delete timeline content or guess a path) and now carry a `suggested_command` (`capcut remove <project> <segment>` / `capcut relink <project> --dir <dir>`) in JSON and human output. `lint`'s command spec now declares `--fix`, `--no-probe`, and `--ffprobe-cmd`.

### Fixed

- `capcut version` no longer claims the mask migration is unshipped — the old `common_masks` note said "use `capcut migrate --to common_masks` once shipped" although `migrate` has carried that jump since v0.4, and misdescribed the write target as the legacy field. The note now describes the version-aware write behaviour, and a split-across-variants draft gets its own consolidation note.

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
