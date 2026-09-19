#!/usr/bin/env bash
# edge-tts writes MP3 whatever the file is called; `capcut tts` expects the
# engine to write a WAV at {out}. This wrapper bridges the two:
#   capcut tts <project> 0s --text-file script.txt \
#     --tts-cmd "bash examples/scripts/edge-tts-wav.sh {text} {out} zh-CN-XiaoxiaoNeural"
# Args: <text> <out.wav> [voice]. Needs edge-tts (pip install edge-tts) and ffmpeg.
set -euo pipefail
text="${1:?text}"
out="${2:?out.wav}"
voice="${3:-${EDGE_TTS_VOICE:-zh-CN-XiaoxiaoNeural}}"
tmp="$(mktemp -t edge-tts-XXXXXX).mp3"
trap 'rm -f "$tmp"' EXIT
edge-tts --voice "$voice" --text "$text" --write-media "$tmp" >/dev/null
ffmpeg -v error -y -i "$tmp" -ar 24000 -ac 1 "$out"
