# Version support matrix

CapCut and JianYing evolve an undocumented on-disk schema. This matrix deliberately separates fixture-backed evidence from compatibility expectations.

Run `capcut version <project>` for schema flags and `capcut diagnose <project> -H` for canonical-file selection, timeline divergence, and editor-process safety. `capcut diagnose <project> --bundle support.json` creates a redacted report suitable for an issue.

## Evidence levels

- **fixture-tested** — committed fixture exercised by automated tests.
- **synthetic-tested** — a minimal version/OS shape exercises an observed storage or schema behavior; still needs a real app-created bundle.
- **reported** — behavior comes from a reproducible user report but is not yet represented by a sanitized real fixture.
- **expected-compatible** — schema inspection suggests compatibility; not a claim of testing in the desktop app.
- **known-broken** — the CLI detects the incompatibility and reports a workaround or refusal.

## CapCut (`platform.app_source == "cc"`)

| Version | Evidence | Status | Notes |
|---|---|---|---|
| 6.2.8 | fixture-tested | supported | Canonical fixture in `test/draft_content.json`; full command suite. |
| 6.5–8.0 | expected-compatible | unverified | No committed app-created fixtures. Enum/schema changes appear additive. |
| 8.7 Windows | reported + synthetic-tested | adapter shipped, real validation pending | Issue #35 reports that `draft_content.json` edits may be ignored in favour of `template-2.tmp` / `draft_meta_info.json`. v0.11 discovers nested/string JSON timeline envelopes, selects modern storage, synchronizes every readable target, and provides `diagnose --bundle` and `fixture --out` (one-command sanitized bundle). v0.13 adds `sync-timelines` to reconcile an already-drifted mirror (plan by default, `--apply` to write); `diagnose` names it as the remedy. A reporter-provided real folder is still required before marking this fixture-tested. |
| 9.x | expected-compatible | unverified | `common_masks` may coexist with legacy mask fields. Use `version`, `diagnose`, and `migrate`; do not treat this row as desktop-app verification. |
| 10.x (Mac and Windows) | reported | write-guarded | New builds are reported to reject tool-written drafts as corrupted ("内容已损坏"; pyJianYingDraft#177, #194 for the JianYing 10.8 counterpart; Mac primary file reported as `draft_info.json`, Jianying-CapCut2XML#4). No fixture exists; mutating commands refuse without `--force-write`. Fixture wanted — see the write guard section below. |

There is no blanket “6.x–9.x tested” claim. Only versions with committed fixtures receive that label. The `capcut version` registry mirrors this table: 6.2.8 reports `fixture-tested`, 8.7.0 `synthetic-tested`, and 6.5.0/7.0.0/8.0.0/9.0.0 report `untested` + `expected-compatible` rather than a tested claim.

## JianYing (`platform.app_source == "lv"`)

| Version | Evidence | Status | Notes |
|---|---|---|---|
| 5.9.x | community-reported | expected-compatible | Last widely used plaintext line; no sanitized app-created fixture is currently committed. |
| 6.0+ | reported | known-broken for encrypted files | `capcut decrypt` detects encryption and explains the workaround; it does not decrypt the file. Plaintext/exported variants can still be inspected normally, but the write guard refuses mutating writes even on plaintext variants without `--force-write` — the 6.0+ app is the encrypted-draft era and a plaintext write may be ignored or shown as corrupted. |

## v0.11 storage and write safety

`capcut-cli` inspects these files in a project directory:

1. `draft_content.json`
2. `draft_info.json`
3. `draft_meta_info.json`
4. `template-2.tmp`

It recognizes a timeline at the root or inside a shallow object/string JSON envelope. For CapCut 8.7+, readable `template-2.tmp` / `draft_meta_info.json` timelines take precedence; older versions retain the content/info preference. Every readable timeline target is synchronized by one atomic save.

Writes use same-directory temporary files, fsync, and rename. Before committing, the CLI refuses if a target changed since it was loaded. Managed CapCut/JianYing draft paths are also protected while the desktop editor is detected. `--force-write` is an explicit override, not a default recovery path.

## Write-time version guard

Every mutating command (the `saveDraft` path, plus `sync-timelines --apply`, which writes mirrors directly) assesses the draft's version markers before writing. The effective version is the numeric max of `platform.app_version`, `last_modified_platform.app_version`, and the newest readable sibling file, so a mirror written by a newer app build trips the guard too. First matching row wins; a missing or unparseable marker simply never triggers its row:

| Condition | Action |
|---|---|
| JianYing effective version >= 6.0 (encrypted-draft era) | refuse |
| CapCut effective version beyond the known range (> 9.x) | refuse |
| Top-level `version` schema integer > 360000 | refuse |
| Unrecognized `app_source` that carries version markers — or no `app_source` at all while an effective app version arrives via `last_modified_platform` or a sibling file | warn, then write |
| Top-level `version` schema integer older than 360000 | warn, then write |
| Everything else — including markerless CLI-created drafts | write normally |

The schema-integer boundary (360000) is the constant observed across all known real CapCut 8.x fixtures in a sanitized reference corpus. Evidence level: **reported** — those fixtures are not committed in this repo, so a larger value only means "a generation nothing here has evidence for", not a verified incompatibility.

`--force-write` overrides a refusal, but the WARNING still lands on stderr so a forced write is never silent. `--dry-run` never blocks (it writes nothing) and still prints the WARNING. Refusal messages end with a fixture-collection call to action: if the project opens fine in your app, `capcut fixture <project> --out <dir>` builds a redacted bundle that can move the version to fixture-tested. `restore` and read-only commands are never gated — restoring a backup is the escape hatch, not the hazard. The guard invents no version markers: `capcut create` output stays markerless and is never stamped with a `platform` or `version` field.

## App auto-upgrade tripwire

The guard above answers "is this version beyond the evidence?". A different failure precedes it: the app updates itself, rewrites the drafts it opens, and nothing in a pipeline says so until writes start behaving differently (GuanYixuan/pyJianYingDraft#115, #178). For that, the CLI remembers the last version evidence it saw per draft store — the same effective tuple the guard detects (effective app version, app source, top-level schema integer) — and compares on every mutating write:

- The state lives in the CLI's own config area: `~/.config/capcut-cli/app-versions.json` (`XDG_CONFIG_HOME` respected, `CAPCUT_CLI_APP_VERSIONS` overrides the path). Nothing is ever written into a draft; written drafts stay byte-identical.
- First sighting of a store records silently. When the evidence later differs, the mutating command prints a stderr `WARNING` naming old -> new (e.g. `app version 8.7.0 -> 10.5.0`) and its JSON result gains an `app_version_drift` field (`store_dir`, `from` with its `seen_at`, `to`, `changes`), then updates the record.
- **Warn only — the tripwire never refuses.** Refusals stay with the write-time version guard; a drift within the supported range (say 6.2.8 -> 8.7.0) warns and writes, a drift beyond it warns *and* the guard refuses as before.
- `capcut version <project>` reports `app_version_drift` read-only (it never updates the record, so the drift stays visible until the next mutating write acknowledges it). `capcut doctor` re-inspects every tracked store and reports drift as a warn-level `app-upgrade` check.
- A corrupt state file reads as empty with a `WARNING` and the next mutating write rebuilds it — the same robustness rule as the `user-enums.json` catalogue. Markerless CLI-created drafts carry no evidence and are never tracked.

## Pinning app updates

The tripwire tells you an upgrade happened; it cannot prevent one. Neither CapCut nor JianYing documents a supported, permanent way to opt out of application updates, so this section deliberately sticks to conservative measures that hold regardless of app build. The registry note for JianYing ("auto-update destroys pinning") is exactly this problem: a pinned 5.9.x install that updates itself enters the encrypted-draft era and plaintext tooling stops round-tripping.

What holds on both OSes:

- **Keep the installer of the version you validated.** Once the vendor moves on, old installers are hard to obtain from official channels; archiving the exact build you tested is the only pin that survives everything.
- **Back up the draft store before the first launch after any update.** An updated app can migrate a draft in place when it opens it; once migrated, older tooling may no longer round-trip the file. Copy the whole `com.lveditor.draft` folder while the app is closed — the same folders `doctor` checks.
- **Let the tripwire and guard see writes early.** Run `capcut version <project>` / `capcut doctor` after any suspected update, and treat a drift WARNING on a pipeline write as the signal to stop and validate before bulk operations.
- **Run bulk pipelines against a copy of the store** rather than the live one, so an app that upgraded mid-run has nothing to migrate underneath you.

Windows:

- The draft store is `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft` (JianYing: `%LOCALAPPDATA%\JianyingPro\...`); that folder — not the app installation — is what your pipelines depend on, and what to snapshot before letting an update touch it.
- The app manages its own updates; we know of no documented setting that permanently disables them. Community threads suggest firewall rules against the updater — that approach is unsupported, build-specific, and can break sign-in or effect downloads, so this document does not recommend a specific rule.

macOS:

- The draft store is `~/Movies/CapCut/User Data/Projects/com.lveditor.draft` (JianYing: `~/Movies/JianyingPro/...`).
- If the app came from the **Mac App Store**, updates follow the App Store's own automatic-update setting (App Store → Settings → Automatic Updates). Disabling that prevents unattended upgrades — updates then only apply when you choose to install them. This is standard App Store behaviour, not a CapCut feature.
- If the app was downloaded directly from the vendor, it manages its own updates like the Windows build, and the same conservative advice applies: archive the installer, back up the store, verify with `capcut version` before writing.

## Schema feature detection

`capcut version` reports:

| Flag | Meaning |
|---|---|
| `mask_field` | Legacy `mask`, newer `common_masks`, both, or neither. |
| `has_text_ranges` | At least one text material contains multi-style ranges. |
| `has_audio_fades` | `materials.audio_fades[]` exists. |
| `new_version_field` | Top-level `new_version`, when present. |
| `last_modified_platform` | Cross-platform modification marker, when present. |

## Reporting a broken version

1. Close CapCut/JianYing.
2. Run `capcut diagnose <project> --bundle support.json`.
3. Run `capcut version <project>`.
4. Open an issue with app version, OS, exact command, JSON error, and `support.json`.
5. If possible, attach a sanitized project folder. Run `capcut fixture <project> --out <dir>` to build one automatically: it copies only the timeline JSON (no media), redacts user home paths and emails, and writes a README plus a diagnose report. Review the files before sharing.

A version moves to **fixture-tested** only after the sanitized fixture and regression test are committed.
