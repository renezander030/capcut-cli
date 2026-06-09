---
name: capcut-edit
description: Edit CapCut / JianYing video projects — read and write subtitles, timing, speed, volume, templates, animations (fade/ken-burns), and cut long-form to shorts. Use when the user mentions capcut, jianying, subtitles, video editing, draft_content.json, draft_info.json, or cutting videos.
---

# capcut-edit

CLI for editing CapCut / JianYing draft files (`draft_content.json` on Windows, `draft_info.json` on macOS).

## Project locations

- **macOS**: `~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<project>/`
- **Windows**: `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft\<project>\`

## Core principle — deterministic scripts

Any recipe involving more than one `capcut` call, any arithmetic, or any branching ships as a parameterised shell script in `scripts/`. Claude invokes the script with inputs; the script runs a fixed sequence. If a recipe can be a script, it **must** be a script — not a narrative in `references/`.

`references/workflows.md` documents *which script to call and why*, never a reconstructable sequence.

## Progressive disclosure

Start broad, drill into what you need. Never dump full project JSON.

```bash
capcut info <project> -H           # overview
capcut tracks <project> -H         # all tracks
capcut materials <project> -H      # material summary
capcut segments <project> -H       # segments with timing
capcut segment <project> <id>      # one item, full detail
```

## Output modes

- **JSON** (default): pipe to `jq`, feed to scripts.
- **`-H`**: human-readable tables.
- **`-q`**: quiet, exit code only — for write commands in scripts.

## Batch writes

```bash
echo '{"cmd":"set-text","id":"a1b2c3","text":"Fixed"}
{"cmd":"volume","id":"d4e5f6","volume":0.5}' | capcut batch <project>
```

Operations: `set-text`, `shift`, `shift-all`, `speed`, `volume`, `opacity`, `trim`.

## Where to look

- **`references/api-reference.md`** — every command, every flag, every value format (time, percentages, degrees), the ID-prefix rule, the `.bak` invariant.
- **`references/workflows.md`** — recipes = which `scripts/X.sh` to run and why.
- **`references/pitfalls.md`** — close-project-first, `.bak`, `clip=null` on audio, `source_timerange` math with `speed`, alpha-keyframes-don't-render-use-animation-materials, etc.
- **Enum discovery** — call `capcut enums --<category>` (or `-H` for a table) to list every CapCut slug. Categories: `--transitions`, `--masks`, `--image-intros`, `--image-outros`, `--image-combos`, `--text-intros`, `--text-outros`, `--text-loop-anims`, `--scene-effects`, `--character-effects`, `--audio-effects`, `--fonts`. Add `--jianying` to switch namespace. The `enums.json` bundle is generated once via `python3 scripts/extract-enums.py`; runtime is Python-free.
- **`scripts/`** — the client library. Current:
  - `anim.sh` — attach any of 9 CapCut intro/outro animations; `fade-in.sh` and `fade-out.sh` are thin wrappers.
  - `ken-burns.sh` — scale + pan keyframes via `capcut keyframe --batch` (motion properties render; alpha does not — use `anim.sh fade-in` instead).
  - `long-to-short.sh` — cut a range, stamp title + CTA text.
  - `stamp-cta.sh` — apply a saved text template (see `assets/examples/subscribe-cta.json`).
  - `_test.sh` — run every wrapper against the fixture; run after any change here.
- **`assets/examples/`** — raw JSON snippets for hand-editing.

## Invariants

- Close the project in CapCut before editing; reopen after.
- Every write creates a `.bak` backup automatically.
- `clip` is `null` on audio segments (no opacity/scale).
- `capcut cut` writes to `--out`, never modifies the source.
- IDs: first 6+ chars of the UUID match as a prefix.
- Time formats: `1.5s`, `500ms`, `+0.5s`, `-1s`, `1:30`, `0:05.5`, bare number = seconds.
