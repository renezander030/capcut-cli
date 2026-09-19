#!/usr/bin/env bash
# Silent clip -> narrated 9:16 draft, editable in CapCut / JianYing.
#
#   bash examples/scripts/narrate-short.sh <clip.mp4> <script.txt> ["Draft name"] [--drafts <dir>] [--voice <edge-tts voice>]
#
# script.txt is the narration, plain text, one sentence per line. Write it by
# hand, or let any vision model describe the clip first (see the recipe). The
# script never needs a model: text in, draft out.
#
# Steps (each is one capcut command; run them by hand if you prefer):
#   1. quickstart  --video <clip> --ratio 9:16     portrait draft with the clip on the main track
#   2. tts         --text-file script.txt          voiceover from the script via edge-tts (any --tts-cmd works)
#   3. caption     --from-segment <voiceover>      captions with whisper's timing and the script's wording
#   4. lint                                        the draft is clean before it is opened in the app
# Needs: capcut (npm i -g capcut-cli), ffmpeg, edge-tts (pip install edge-tts).
# Optional: whisper for step 3 — without it the draft still has the clip and the voiceover.
# CAPCUT_TTS_CMD overrides the engine template ({out} required, {text} optional).
set -euo pipefail

clip="${1:?usage: narrate-short.sh <clip.mp4> <script.txt> [name] [--drafts <dir>] [--voice <voice>]}"
script="${2:?script.txt (one sentence per line)}"
name="旁白短视频"
shift 2
# A third positional that does not start with "--" is the draft name.
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then name="$1"; shift; fi
drafts=()
voice="${EDGE_TTS_VOICE:-zh-CN-XiaoxiaoNeural}"
while [ $# -gt 0 ]; do
  case "$1" in
    --drafts) drafts=(--drafts "$2"); shift 2 ;;
    --voice) voice="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
[ -s "$script" ] || { echo "script is empty: $script" >&2; exit 2; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Built separately: a "{out}" inside "${VAR:-...}" would close the expansion early.
default_tts="bash $here/edge-tts-wav.sh {text} {out} $voice"
tts_cmd="${CAPCUT_TTS_CMD:-$default_tts}"

# Run a capcut command; on failure print its message and stop. On success print its JSON.
run() {
  local out
  if ! out="$("$@" 2>/dev/null)"; then
    echo "$1 ${2:-} failed:" >&2
    "$@" 2>&1 >/dev/null | head -c 400 >&2 || true
    echo "$out" | head -c 400 >&2
    echo >&2
    exit 1
  fi
  printf '%s' "$out"
}
# Read one top-level key from a JSON document on stdin (empty when absent or not JSON).
key() {
  python3 -c "import json,sys
try: d = json.load(sys.stdin)
except Exception: sys.exit(0)
v = d.get('$1', '')
print(len(v) if isinstance(v, list) else v)"
}

# 1. Portrait draft with the clip on the main track.
project="$(run capcut quickstart "$name" --video "$clip" --ratio 9:16 "${drafts[@]}" | key draft_path)"
[ -n "$project" ] || { echo "quickstart returned no draft_path" >&2; exit 1; }
echo "draft:     $project"

# 2. Voiceover from the script, placed at 0s.
segment="$(run capcut tts "$project" 0s --text-file "$script" --tts-cmd "$tts_cmd" | key segment_id)"
[ -n "$segment" ] || { echo "tts returned no segment_id" >&2; exit 1; }
echo "voiceover: segment $segment"

# 3. Captions: whisper supplies the timing, the script supplies the wording.
#    Whisper missing is not fatal — the draft already has clip + voiceover.
if captions="$(capcut caption "$project" --from-segment "$segment" --script "$script" 2>&1)"; then
  echo "captions:  $(printf '%s' "$captions" | key segments) cue(s)"
else
  echo "captions:  skipped — $(printf '%s' "$captions" | key error | head -n 1 | cut -c1-160)"
fi

# 4. Lint, then open in the app (restart CapCut/JianYing so it lists the new draft).
capcut lint "$project" -H
echo
echo "Open CapCut / JianYing and pick \"$name\"."
