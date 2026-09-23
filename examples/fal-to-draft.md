# fal → editable CapCut draft: generated image, video and voice as real tracks

One prompt and one narration file in, one 9:16 draft out. [fal](https://fal.ai) generates a still, animates it and voices the script; `compile` lays the three files out as separate tracks, `caption` adds script-worded captions, and `lint` checks the result. When you open the app, every piece is still its own editable track: swap the clip, retime the still, restyle the captions.

## You need

- capcut-cli (`npm install -g capcut-cli`, Node ≥ 18)
- a fal API key: [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys), exported as `FAL_KEY`
- Python 3.9+ (the script uses only the standard library)
- ffprobe for exact durations (ships with ffmpeg)
- optional: whisper (`pip install openai-whisper`) for the captions. Without it the draft still has the clip, the still, the voiceover and the title

## Inputs

```
script.txt   # narration, one sentence per line
```

plus a `--prompt` describing the picture.

## One command

```bash
export FAL_KEY=...
python3 examples/scripts/fal-to-draft.py \
  --prompt "a lighthouse on a cliff at dusk, waves breaking below, cinematic" \
  --script script.txt --name "Lighthouse short"
```

`--drafts <dir>` names the draft library; without it the machine's default directory is used.

What lands in the draft:

| Track | Content | From |
|---|---|---|
| video | animated clip (0 s → clip end), then the still held until the voiceover ends | `fal-ai/kling-video/v2.1/standard/image-to-video`, `fal-ai/flux/schnell` |
| audio `voiceover` | the narration | `fal-ai/kokoro/american-english` |
| text `title` | title card, first 2.5 s (`--title`, default the draft name) | — |
| text `captions` | whisper timing, script wording (when whisper is installed) | `capcut caption --script` |

Restart CapCut / JianYing once so it lists the new draft, then open it.

## How it works

1. Three requests on fal's [queue API](https://docs.fal.ai/model-apis/model-endpoints/queue): the still (portrait 16:9), then the still animated from its URL, then the voiceover. Each is polled until it completes.
2. Every file is downloaded into `./fal-<name>/` and `compile` copies it into the draft, so the draft keeps working after fal's file URLs expire.
3. The layout is one JSON spec (`./fal-<name>/spec.json`) built by `capcut compile`. Edit it and rerun `capcut compile ./fal-<name>/spec.json` to rebuild without calling fal again.

Rerunning the script with the same `--work` directory reuses the files already there, so a failed caption or lint step never pays for generation twice.

## Other models

Each model is a flag. Any fal model whose output has `images[0].url`, `video.url` or `audio.url` plugs in:

```bash
python3 examples/scripts/fal-to-draft.py --prompt "..." --script script.txt \
  --image-model fal-ai/flux/dev \
  --video-model fal-ai/kling-video/v2.1/pro/image-to-video \
  --voice am_michael
```

`--motion` gives the video its own prompt (camera move, action) when it should differ from the picture prompt.

## Cost

With the default models one run costs well under a dollar; the 5 s video is most of it. Check each model's page on fal for current pricing.

## JianYing

Point `--drafts` at the JianYing draft directory. A compiled draft is plaintext; see [jianying-encryption.md](../docs/jianying-encryption.md) for what JianYing 6.0+ does with it.
