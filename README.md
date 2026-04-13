# capcut-cli

Stop reverse-engineering CapCut's JSON schema every time you need to change a subtitle.

## The problem

CapCut stores projects as `draft_content.json` -- deeply nested, undocumented, with timing in microseconds and text buried inside escaped JSON-in-JSON. Every manual edit means: find the right segment ID, trace it to the material, figure out the content format, convert your timestamp, edit, pray you didn't break the structure. **15 seconds per change**, minimum.

`capcut-cli` already knows the schema. One command, one change, **5 seconds**.

```
$ capcut texts ./project
ID        Start   -End       Text
a1b2c3d4  0:01.00- 0:03.50   Welcome to the video

$ capcut set-text ./project a1b2c3 "Fixed subtitle"
"Welcome to the video" -> "Fixed subtitle"
```

Zero dependencies. Works with CapCut (international) and JianYing (Chinese version).

## Install

```bash
npm install -g capcut-cli
```

Or run directly:
```bash
npx capcut-cli info ./my-project/
```

## Commands

### Read

```bash
capcut info ./project              # Project overview: resolution, duration, track count
capcut tracks ./project            # List all tracks with segment counts
capcut segments ./project          # List all segments with timing
capcut segments ./project --track text   # Filter by track type
capcut texts ./project             # List all text/subtitle content with IDs
capcut export-srt ./project > subs.srt   # Export subtitles to SRT file
```

### Write

Every write command creates a `.bak` backup before modifying the file.

```bash
capcut set-text ./project a1b2c3 "New subtitle"     # Change text content
capcut shift ./project a1b2c3 +0.5s                  # Move segment forward 0.5s
capcut shift ./project a1b2c3 -200ms                 # Move segment back 200ms
capcut shift-all ./project +1s                        # Shift everything forward 1s
capcut shift-all ./project -0.5s --track text         # Shift only text track
capcut speed ./project a1b2c3 1.5                     # Set 1.5x playback speed
capcut volume ./project a1b2c3 0.8                    # Set volume to 80%
capcut opacity ./project a1b2c3 0.5                   # Set opacity to 50%
capcut trim ./project a1b2c3 2s 5s                    # Trim to 5s starting at 2s
```

### IDs

Segment IDs are UUIDs. You don't need the full thing -- the first 6-8 characters work:

```bash
$ capcut texts ./project
ID        Start   -End       Text
a1b2c3d4  0:01.00- 0:03.50   Welcome to the video
e5f6a7b8  0:04.00- 0:06.00   Let me show you

$ capcut set-text ./project a1b2c3 "Hey everyone"
"Welcome to the video" -> "Hey everyone"
```

### Time formats

- `1.5s` -- 1.5 seconds
- `500ms` -- 500 milliseconds
- `+0.5s` / `-1s` -- relative offset
- `1:30` -- 1 minute 30 seconds
- `0:05.5` -- 5.5 seconds

## How it works

CapCut stores projects as JSON (`draft_content.json` on Windows, `draft_info.json` on macOS). This CLI reads and modifies that JSON directly.

Typical project location:
- **Windows**: `C:\Users\<you>\AppData\Local\CapCut\User Data\Projects\com.lveditor.draft\<id>\`
- **macOS**: `/Users/<you>/Movies/CapCut/User Data/Projects/com.lveditor.draft/<id>/`

Close the project in CapCut before editing, reopen after. CapCut reads the JSON on project open.

## Workflow: batch subtitle correction

```bash
# See all subtitles
capcut texts ./project

# Fix typos
capcut set-text ./project a1b2c3 "Corrected line one"
capcut set-text ./project d4e5f6 "Corrected line two"
capcut set-text ./project g7h8i9 "Corrected line three"

# Shift all subtitles forward to sync with audio
capcut shift-all ./project +0.3s --track text
```

Five changes in under 25 seconds. Doing it by hand in the JSON: 75+ seconds of navigating nested objects, matching IDs, and converting microseconds.

## Workflow: speed ramp

```bash
# List video segments
capcut segments ./project --track video

# Slow down the intro, speed up the middle
capcut speed ./project a1b2c3 0.5
capcut speed ./project d4e5f6 2.0
capcut speed ./project g7h8i9 1.0
```

## License

MIT
