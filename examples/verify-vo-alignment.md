# Verify VO + alignment files before assembling the draft

A pre-flight check that fails loudly if your voiceover audio or word-level timestamp files are missing, malformed, or out of sync. Run this **before** you build the CapCut draft. If it fails, fix the VO step rather than guessing offsets later in the timeline.

> Chinese translation pending — see `README.zh-CN.md` at the repo root.

## Why this exists

If you drive cut points from word-level timestamps — the standard way to do faceless / documentary edits — every shot boundary depends on the alignment data being trustworthy. One missing per-act file or one non-monotonic stitch point silently corrupts the entire edit, and you only notice when a clip lands on the wrong word three minutes in.

This script catches the four failure modes that actually happen:

1. **Wrong endpoint.** Someone called `/v1/text-to-speech/{voice_id}` instead of `/v1/text-to-speech/{voice_id}/with-timestamps` — there's no alignment to drive cuts from.
2. **Truncated audio.** A `.mp3` exists but is < 1 KB because the API call timed out.
3. **Length mismatch.** ElevenLabs returned `characters`, `character_start_times_seconds`, and `character_end_times_seconds` arrays of unequal length.
4. **Stitch missing offsets.** A master `words.json` was concatenated from per-act files but the per-act `startMs` values were never shifted forward — so the timeline rewinds halfway through.

## Required layout

```
<vo-dir>/
  <slug>-act1.mp3
  <slug>-act1-words.json    ← raw ElevenLabs response
  <slug>-act2.mp3
  <slug>-act2-words.json
  …
  <slug>-vo.mp3             ← stitched master
  words.json                ← stitched word-level array with cumulative offsets
```

Each entry in `words.json` is `{"word": "...", "startMs": int, "endMs": int}`, monotonically increasing, total duration ≥ 60s.

## Prerequisites

- ElevenLabs voiceover already generated using the `with-timestamps` endpoint, one file per act.
- A stitched master `<slug>-vo.mp3` and a `words.json` with cumulative offsets applied.
- Python 3.9+. No external deps.

## Run it

```bash
python3 scripts/verify-vo-timestamps.py my-video \
  --vo-dir ./projects/my-video/voiceover \
  --acts 5
```

Exit code `0` only if every check passes. On failure, the diagnostic on stderr names the file and the specific problem.

## Sample output

```
Verifying VO timestamps for 'my-video' (5 acts) in ./projects/my-video/voiceover
  act1: OK (my-video-act1.mp3, my-video-act1-words.json)
  act2: OK (my-video-act2.mp3, my-video-act2-words.json)
  act3: OK (my-video-act3.mp3, my-video-act3-words.json)
  act4: OK (my-video-act4.mp3, my-video-act4-words.json)
  act5: OK (my-video-act5.mp3, my-video-act5-words.json)
  master mp3: OK (my-video-vo.mp3)
  master words.json: OK
PASS: all 5 acts have audio + alignment, master VO + words.json present and well-formed.
```

## Adapt to your layout

The filename convention (`<slug>-act{N}.mp3`, `<slug>-act{N}-words.json`) is wired into the script. If you stitch differently, change the file patterns inside `main()` — the validation logic per file is independent and reusable.
