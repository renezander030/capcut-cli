---
description: Edit CapCut / JianYing video projects — read and write subtitles, timing, speed, volume, templates, and cut long-form to shorts. Use when the user mentions capcut, jianying, subtitles, video editing, draft_content.json, draft_info.json, or cutting videos.
---

# capcut-cli

CLI for editing CapCut and JianYing project files directly. Reads and writes `draft_content.json` (Windows) / `draft_info.json` (macOS).

## Project locations

- **macOS**: `/Users/<user>/Movies/CapCut/User Data/Projects/com.lveditor.draft/<project-name>/`
- **Windows**: `C:\Users\<user>\AppData\Local\CapCut\User Data\Projects\com.lveditor.draft\<project-name>\`

## Navigation (progressive disclosure)

Start broad, drill into what you need. Never dump full project JSON.

```bash
# Level 0: overview
capcut info <project> -H

# Level 1: discovery
capcut tracks <project> -H
capcut materials <project> -H
capcut materials <project> --type audios -H

# Level 2: browse
capcut segments <project> --track video -H
capcut texts <project> -H

# Level 3: detail (one item)
capcut segment <project> <id>
capcut material <project> <id>
```

## Read commands

```bash
capcut info <project>                         # Project overview + material summary
capcut tracks <project>                       # List all tracks
capcut materials <project>                    # All material types + counts
capcut materials <project> --type <type>      # Items of one type
capcut segments <project> [--track <type>]    # Segments with timing
capcut texts <project>                        # Text/subtitle content
capcut export-srt <project>                   # Export subtitles to SRT
capcut segment <project> <id>                 # Full detail for one segment
capcut material <project> <id>                # Full detail for one material
```

## Write commands

Every write creates a `.bak` backup automatically.

```bash
capcut set-text <project> <id> <text>              # Change text
capcut shift <project> <id> <offset>               # Shift timing (+0.5s, -1s)
capcut shift-all <project> <offset> [--track <t>]  # Shift all segments
capcut speed <project> <id> <multiplier>           # Set speed (1.5)
capcut volume <project> <id> <level>               # Set volume (0.0-1.0)
capcut opacity <project> <id> <alpha>              # Set opacity (0.0-1.0)
capcut trim <project> <id> <start> <duration>      # Trim segment
```

## Add commands

```bash
capcut add-text <project> <start> <duration> <text> [options]
  --font-size <n>      Font size (default: 15)
  --color <hex>        Color (default: #FFFFFF)
  --align <0|1|2>      Left/center/right (default: 1)
  --x <n> --y <n>      Position (-1 to 1)
  --track-name <name>  Track name (default: "text")
```

## Templates

Save any element from one project, stamp into another:

```bash
capcut save-template <project> <id> <name> --out <path>
capcut apply-template <project> <template.json> <start> <duration> [text override]
  --x <n> --y <n>      Override position
```

## Cut (long-form to short)

```bash
capcut cut <project> <start> <end> --out <path>
```

Clips edge segments, rebases timing to 0, removes empty tracks, cleans orphaned materials.

## Batch

```bash
echo '{"cmd":"set-text","id":"a1b2c3","text":"Fixed"}
{"cmd":"volume","id":"d4e5f6","volume":0.5}' | capcut batch <project>
```

Operations: `set-text`, `shift`, `shift-all`, `speed`, `volume`, `opacity`, `trim`.

## IDs and time formats

- **IDs**: First 6+ chars of UUID work as prefix match
- **Time**: `1.5s`, `500ms`, `+0.5s`, `-1s`, `1:30`, `0:05.5`

## Output modes

- **JSON** (default): pipe to `jq`, feed to scripts
- **`-H`**: Human-readable tables
- **`-q`**: Quiet, exit code only

## Important

- Close the project in CapCut before editing, reopen after
- All writes create `.bak` backups
- `clip` is `null` on audio segments (no opacity/scale)
- The `cut` command writes to `--out`, never modifies the source
