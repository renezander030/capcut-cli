#!/usr/bin/env bash
# ken-burns.sh — animate uniform scale + position on a video/image segment.
#
# Usage:
#   ken-burns.sh <project> <segment-id> \
#     <start-scale> <end-scale> \
#     <tx-start> <tx-end> \
#     <ty-start> <ty-end> \
#     <duration> [easing]
#
#   <start/end-scale>  uniform scale values (1.0 = no zoom, 1.2 = 20% zoom-in)
#   <tx-start/tx-end>  horizontal position in half-canvas units (-1..1, 0 = center)
#   <ty-start/ty-end>  vertical position in half-canvas units (-1..1)
#   <duration>         time string (e.g. 3s, 500ms)
#   [easing]           linear | ease-in | ease-out | ease-in-out
#                      default ease-out — the easing CapCut's own UI applies to
#                      a ken-burns zoom ("Cubic Out")
#
# Writes 6 keyframes total via `capcut keyframe --batch`: uniform_scale,
# position_x, position_y — each with a start keyframe at t=0 and an end
# keyframe at t=duration. Keyframes for motion properties render correctly
# in CapCut (unlike alpha — see pitfalls.md).

set -euo pipefail

if [[ $# -lt 9 || $# -gt 10 ]]; then
  echo "Usage: $0 <project> <segment-id> <start-scale> <end-scale> <tx-start> <tx-end> <ty-start> <ty-end> <duration> [easing]" >&2
  exit 2
fi

project="$1"
segment_id="$2"
start_scale="$3"
end_scale="$4"
tx_start="$5"
tx_end="$6"
ty_start="$7"
ty_end="$8"
duration="$9"
easing="${10:-ease-out}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve the CLI entry, so this script also works when the skill is used
# outside a capcut-cli checkout. Priority:
#   1. $CAPCUT_CLI                        (explicit override)
#   2. <repo>/dist/index.js               (this checkout)
#   3. <dir>/node_modules/capcut-cli/dist/index.js, walking up from here
#   4. capcut-cli / capcut on PATH
resolve_cli() {
  if [[ -n "${CAPCUT_CLI:-}" && -f "${CAPCUT_CLI}" ]]; then
    printf '%s\n' "$CAPCUT_CLI"
    return 0
  fi
  local repo_cli="$script_dir/../../../dist/index.js"
  if [[ -f "$repo_cli" ]]; then
    printf '%s\n' "$repo_cli"
    return 0
  fi
  local dir="$script_dir" i
  for i in 1 2 3 4 5 6; do
    dir="$(dirname "$dir")"
    if [[ -f "$dir/node_modules/capcut-cli/dist/index.js" ]]; then
      printf '%s\n' "$dir/node_modules/capcut-cli/dist/index.js"
      return 0
    fi
  done
  if command -v capcut-cli >/dev/null 2>&1; then
    command -v capcut-cli
    return 0
  fi
  if command -v capcut >/dev/null 2>&1; then
    command -v capcut
    return 0
  fi
  printf '%s\n' "$repo_cli"
}
cli="$(resolve_cli)"

if [[ ! -f "$cli" ]]; then
  echo "capcut CLI not found — set \$CAPCUT_CLI to its dist/index.js, install it (npm install -g capcut-cli), or run \`npm run build\` in capcut-cli/" >&2
  exit 1
fi

node "$cli" keyframe "$project" "$segment_id" --batch --easing "$easing" <<EOF
{"property":"uniform_scale","time":"0","value":"$start_scale"}
{"property":"uniform_scale","time":"$duration","value":"$end_scale"}
{"property":"position_x","time":"0","value":"$tx_start"}
{"property":"position_x","time":"$duration","value":"$tx_end"}
{"property":"position_y","time":"0","value":"$ty_start"}
{"property":"position_y","time":"$duration","value":"$ty_end"}
EOF
