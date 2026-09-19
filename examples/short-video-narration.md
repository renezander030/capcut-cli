# Short-video narration: silent clip → 9:16 voiced draft

English | [中文](./short-video-narration.zh-CN.md)

Three commands: `quickstart` creates a 9:16 draft with the clip on the main track, `tts` voices your script, `caption` writes captions with whisper's timing and your script's wording, then `lint` checks the result. No GUI in the loop; when you open the app, the video, voiceover and caption tracks are all still editable.

## You need

- capcut-cli (`npm install -g capcut-cli`, Node ≥ 18)
- ffmpeg
- a local TTS. The example uses [edge-tts](https://github.com/rany2/edge-tts) (`pip install edge-tts`, free neural voices); any command that can write a WAV plugs in through `--tts-cmd`
- optional: whisper (`pip install openai-whisper`) for the captions. Without it the draft still has the clip and the voiceover

## Inputs

```
clip.mp4     # silent footage, landscape or portrait (--ratio 9:16 sets the canvas)
script.txt   # narration, one sentence per line
```

Write the script yourself, or let any vision model look at the clip first. For example, sample frames and hand them to whatever model CLI you use:

```bash
mkdir -p frames && ffmpeg -v error -i clip.mp4 -vf fps=1/2 frames/%02d.jpg
<your vision-model CLI> "Write a 5-sentence spoken narration for these frames, one sentence per line, no title" frames/*.jpg > script.txt
```

The model is optional: the script is a plain text file and a hand-written one works the same.

## One command

```bash
bash examples/scripts/narrate-short.sh clip.mp4 script.txt "Narrated short" --voice en-US-AriaNeural
```

`--drafts <dir>` names the draft library; without it the machine's default directory is used. The script only chains the four steps below.

## Step by step

```bash
# 1. Portrait draft, clip on the main track
capcut quickstart "Narrated short" --video clip.mp4 --ratio 9:16
#    draft_path in the result is the draft folder

# 2. Voiceover at 0s. edge-tts only writes MP3 and `capcut tts` expects the engine
#    to write a WAV at {out}, so examples/scripts/edge-tts-wav.sh converts in between
capcut tts "<draft_path>" 0s --text-file script.txt \
  --tts-cmd "bash examples/scripts/edge-tts-wav.sh {text} {out} en-US-AriaNeural"
#    segment_id in the result is the voiceover segment

# 3. Captions: timing from whisper, wording from your script
capcut caption "<draft_path>" --from-segment <segment_id> --script script.txt

# 4. Check
capcut lint "<draft_path>" -H
```

Restart CapCut / JianYing once so it lists the new draft, then open it.

## Other voices, other engines, caption styling

- edge-tts voices: `edge-tts --list-voices` (`--voice` or the `EDGE_TTS_VOICE` environment variable)
- other engines: any command that writes a WAV to `{out}`. `{text}` is optional; without it the script is piped to stdin (how piper works). macOS `say`: `--tts-cmd "say -o {out} --data-format=LEI16@24000 {text}"`; in the script, override with the `CAPCUT_TTS_CMD` environment variable
- caption styling: `caption --preset <preset.json>` (extract one with `make-preset` from a caption you styled in the app) or `--style-ref <segment-id>`; `--karaoke` for word highlighting

## JianYing 6.0+

A draft created this way is plaintext; JianYing 11.4 (macOS) is reported to open and upgrade it in place, other builds are unverified. Existing encrypted drafts are not read by this CLI; `capcut decrypt <project>` reports the state, and [jianying-encryption.md](../docs/jianying-encryption.md) has the background.
