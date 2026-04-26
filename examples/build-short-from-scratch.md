# Build a short from scratch — no GUI

Generate a complete CapCut / JianYing project from raw assets. Useful when the pipeline upstream is automated (TTS, AI clips, faceless content) and you want CapCut as the *finishing* step, not the starting point.

## Inputs

```
./assets/
  clip.mp4       # 10s of footage
  voiceover.wav  # 10s of narration
  music.mp3      # background bed
```

## Build it

```bash
# 1. Empty draft (uses CapCut's default location on macOS)
capcut init "AI Short 001"

# 2. Video on the visual track
capcut add-video ./AI\ Short\ 001 ./assets/clip.mp4 0s 10s

# 3. Voiceover (loud)
capcut add-audio ./AI\ Short\ 001 ./assets/voiceover.wav 0s 10s --volume 0.9

# 4. Music bed (quiet, ducked under VO)
capcut add-audio ./AI\ Short\ 001 ./assets/music.mp3 0s 10s --volume 0.25

# 5. Hook title (first 3s, gold)
capcut add-text ./AI\ Short\ 001 0s 3s "ONE TRICK MOST EDITORS MISS" \
  --font-size 22 --color "#FFD700"

# 6. End card (last 2s)
capcut add-text ./AI\ Short\ 001 8s 2s "Follow for more" \
  --font-size 16 --color "#FFFFFF"
```

Open CapCut. The project is in your library, fully linked, ready to render.

## Why this is useful

- Files are *copied* into the draft assets dir — no broken links if you move the source folder.
- Every step is JSON-out by default, so an agent can drive the whole pipeline and inspect state between steps.
- Adding `-q` to write commands silences output for clean scripting.

## Faceless-content loop

```bash
for topic in "frameworks" "AI tools" "side projects"; do
  name="Short - $topic"
  capcut init "$name"
  capcut add-video "$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft/$name" \
    "./assets/$topic.mp4" 0s 30s -q
  capcut add-audio "$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft/$name" \
    "./assets/$topic-vo.wav" 0s 30s --volume 0.9 -q
done
```

Three drafts, ready to open and render.
