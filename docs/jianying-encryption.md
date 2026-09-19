# Decision: JianYing 6.0+ draft encryption

Status: **decided — detect, do not decrypt** (revisit gated, see below).
Scope: `draft_content.json` encryption introduced by JianYing (剪映) 6.0+.
Related: `capcut decrypt`, `docs/version-support.md`, pyJianYingDraft #142/#169/#174.

## Context

JianYing is the Chinese build of CapCut. From 6.0+ it stores `draft_content.json`
as an AES-encrypted binary payload instead of plaintext JSON. The Chinese README
is one of the most-viewed paths in this repo, so the JianYing lane has real
demand. The adjacent project `pyJianYingDraft` is larger and gets steady requests
to "just decrypt it." CapCut International is **not** encrypted — only JianYing.

The question for this repo: should `capcut-cli` ship a decryption routine?

## Decision

No. The CLI **detects** encryption and explains the workaround; it does not
decrypt. This is implemented in `src/decrypt.ts` (`detectEncryption`) and surfaced
by `capcut decrypt <file>`.

This is a gated compatibility decision, not a permanent refusal. It changes only
if every tripwire below clears.

## Why

- **Legal posture.** Shipping a routine whose only purpose is to undo a vendor's
  encryption is a different risk class from reading a documented plaintext format.
  The community-known algorithms are reverse-engineered, not licensed.
- **Algorithm in flux.** The keys/algorithm have shifted across JianYing point
  releases (see pyJianYingDraft #142/#169/#174). A decryptor would be a moving
  maintenance target with a high breakage rate per JianYing update.
- **The repo's differentiated claim is "local, deterministic, agent-drivable."**
  A brittle, legally-grey decryptor fights that claim. Detection + a clear
  workaround keeps the trust surface clean.

## What encryption does and does not block (evidence as of 2026-09)

The encryption gates *reading* drafts the app authored. It does not gate
*writing* a new one: on JianYing 11.4 (macOS) a plaintext `draft_info.json`
is opened, upgraded to the encrypted format in place and completed with
`Timelines/` and a cover by the app itself — the engine probes each file for
plaintext vs cipher (`DraftIO::getUriCipherTypeStatically`), and the failure
people hit ("草稿内容已损坏") comes from writing the pre-6.0 file name
`draft_content.json`, which the app only recognises inside a draft-package
import ([pyJianYingDraft#198](https://github.com/GuanYixuan/pyJianYingDraft/issues/198),
calibrated on 11.4.0). This CLI already writes `draft_info.json` on the
info-primary layout; the write guard in `docs/version-support.md` stays
conservative for 6.0+ until a fixture from such a build is committed. The
decision below — detect, do not decrypt — is unchanged by this: it concerns
the encrypted documents, which generation never needs to read.

## What we do instead (and why it is enough for most users)

`capcut decrypt` reports the situation and points to, in order of preference:

1. Pin JianYing to 5.9.x and block auto-update (last widely-used plaintext line).
2. Use CapCut International — not encrypted.
3. For an already-encrypted draft, the community references (pyJianYingDraft #142,
   duoec/duo-video) — explicitly outside this tool.

Detection heuristic: a `draft_content.json` that does not begin with `{` and does
not parse as JSON is reported as the encrypted JianYing 6.0+ case; a file that
starts with `{` but fails to parse is reported as *corruption*, not encryption,
so the two failure modes are not conflated.

## Fixture collection (how we'd gather evidence without decrypting)

We can advance the JianYing lane without touching decryption:

- `capcut fixture <project> --out <dir>` produces a redacted, media-free bundle of
  the timeline files. For an *encrypted* draft this captures the envelope/markers
  (size, leading bytes via `diagnose`) so detection can be sharpened from real
  samples rather than guesses.
- Plaintext/exported JianYing variants (5.9.x, or 6.0+ "export project") can be
  added as committed fixtures and exercised by the normal command suite.

## Tripwires to revisit shipping decryption

Revisit only if **all** of these hold:

1. A stable, documented algorithm exists across at least two consecutive JianYing
   releases (not a single-version reverse-engineering).
2. The legal posture is clear enough to state in the README without hedging.
3. There is a maintainer commitment to track JianYing releases, because a
   decryptor that silently breaks is worse than an honest "not supported."

Until then: detect, explain, and collect fixtures. Do not decrypt.

## What the CLI says on such a store (0.24.0)

- `init`, `quickstart` and `compile` count the folder's projects in `template.store` (`encrypted` is the JianYing 6.0+ payloads). When none could seed the new draft, a WARNING names the fallback to the bundled template and `template.warning` carries the same text.
- `lint` reports `template-unverified-store` (info) for such a draft: not stale, since there is no readable version to compare against, but unverified for the app that wrote those projects. Opening the draft in JianYing is the test; 11.4 (macOS) is reported to open and upgrade it in place.
- `doctor` adds a `draft-store` check per project directory it finds (or the one folder named with `--drafts <dir>`): how many projects are readable, markerless, encrypted or unreadable. An encrypted store is a warning that says what still works, so the situation is named once, before the first command fails on it.
