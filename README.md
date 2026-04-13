# capcut-cli

Stop reverse-engineering CapCut's JSON schema every time you need to change a subtitle.

## The problem

CapCut stores projects as `draft_content.json` -- deeply nested, undocumented, with timing in microseconds and text buried inside escaped JSON-in-JSON. Every manual edit means: find the right segment ID, trace it to the material, figure out the content format, convert your timestamp, edit, pray you didn't break the structure. **15 seconds per change**, minimum.

`capcut-cli` already knows the schema. One command, one change, **5 seconds**.

```
$ capcut texts ./project
[{"id":"a1b2c3d4-...","start_us":500000,"duration_us":2500000,"text":"Welcome to the video"}]

$ capcut set-text ./project a1b2c3 "Fixed subtitle"
{"ok":true,"id":"a1b2c3d4-...","old":"Welcome to the video","new":"Fixed subtitle"}
```

Zero dependencies. JSON output by default. Pipeable. Works with CapCut and JianYing.

## Install

```bash
npm install -g capcut-cli
```

Or run directly:
```bash
npx capcut-cli info ./my-project/
```

## Output modes

**JSON (default)** -- pipe to `jq`, feed to scripts, consume from agents:
```bash
capcut texts ./project | jq '.[].text'
capcut info ./project | jq '.duration_us'
```

**Human-readable** (`-H` / `--human`):
```bash
capcut texts ./project -H
ID        Start   -End       Text
a1b2c3d4  0:00.50- 0:03.00   Welcome to the video
```

**Quiet** (`-q` / `--quiet`) -- exit code only, zero stdout on writes:
```bash
capcut set-text ./project a1b2c3 "New text" -q && echo "done"
```

## Commands

### Read

```bash
capcut info ./project                        # Project overview
capcut tracks ./project                      # List all tracks
capcut segments ./project                    # List all segments with timing
capcut segments ./project --track text       # Filter by track type
capcut texts ./project                       # List all text/subtitle content
capcut export-srt ./project > subs.srt       # Export subtitles to SRT
```

### Write

Every write command creates a `.bak` backup before modifying the file.

```bash
capcut set-text ./project a1b2c3 "New subtitle"
capcut shift ./project a1b2c3 +0.5s
capcut shift ./project a1b2c3 -200ms
capcut shift-all ./project +1s
capcut shift-all ./project -0.5s --track text
capcut speed ./project a1b2c3 1.5
capcut volume ./project a1b2c3 0.8
capcut opacity ./project a1b2c3 0.5
capcut trim ./project a1b2c3 2s 5s
```

### Batch

Multiple edits, one JSON parse, one file write:

```bash
echo '{"cmd":"set-text","id":"a1b2c3","text":"Line one"}
{"cmd":"set-text","id":"d4e5f6","text":"Line two"}
{"cmd":"shift","id":"a1b2c3","offset":"+0.3s"}
{"cmd":"volume","id":"g7h8i9","volume":0.5}' | capcut batch ./project
```

Output: `{"ok":true,"succeeded":4,"failed":0}`

Batch operations: `set-text`, `shift`, `shift-all`, `speed`, `volume`, `opacity`, `trim`.

### IDs

Segment IDs are UUIDs. The first 6-8 characters work as prefix match:

```bash
$ capcut texts ./project | jq '.[0].id'
"a1b2c3d4-0000-0000-0000-000000000001"

$ capcut set-text ./project a1b2c3 "Hey everyone"
{"ok":true,"id":"a1b2c3d4-0000-0000-0000-000000000001","old":"Welcome","new":"Hey everyone"}
```

### Time formats

- `1.5s` -- 1.5 seconds
- `500ms` -- 500 milliseconds
- `+0.5s` / `-1s` -- relative offset
- `1:30` -- 1 minute 30 seconds
- `0:05.5` -- 5.5 seconds

## How it works

CapCut stores projects as JSON (`draft_content.json` on Windows, `draft_info.json` on macOS). This CLI reads and modifies that JSON directly. It preserves the original file's indentation style on save.

Typical project location:
- **Windows**: `C:\Users\<you>\AppData\Local\CapCut\User Data\Projects\com.lveditor.draft\<id>\`
- **macOS**: `/Users/<you>/Movies/CapCut/User Data/Projects/com.lveditor.draft/<id>/`

Close the project in CapCut before editing, reopen after. CapCut reads the JSON on project open.

## Workflow: batch subtitle correction

```bash
# Get all subtitle IDs and text
capcut texts ./project | jq '.[] | "\(.id) \(.text)"'

# Fix 3 typos + sync timing in one shot
echo '{"cmd":"set-text","id":"a1b2c3","text":"Corrected line one"}
{"cmd":"set-text","id":"d4e5f6","text":"Corrected line two"}
{"cmd":"set-text","id":"g7h8i9","text":"Corrected line three"}
{"cmd":"shift-all","offset":"+0.3s","track":"text"}' | capcut batch ./project
```

Four changes, one file write. Done in under 5 seconds.

## License

MIT
