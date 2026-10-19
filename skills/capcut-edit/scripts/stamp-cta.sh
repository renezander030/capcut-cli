#!/usr/bin/env bash
# stamp-cta.sh — apply a saved CTA template into a project at a given time.
#
# Usage:
#   stamp-cta.sh <project> <template.json> <start> <duration> [<text>]
#
#   <project>       CapCut project directory or draft JSON
#   <template.json> saved template (e.g. ../assets/examples/subscribe-cta.json)
#   <start>         start time (e.g. 0:27, 2:30.5)
#   <duration>      duration (e.g. 3s, 5000ms)
#   <text>          optional: override the template's text body
#
# Thin wrapper around `capcut apply-template` so the CTA stamping recipe is
# a one-line script call rather than a remembered CLI invocation.

set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo "Usage: $0 <project> <template.json> <start> <duration> [<text>]" >&2
  exit 2
fi

project="$1"
template="$2"
start="$3"
duration="$4"
text="${5:-}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve how to launch the CLI, so this script also works when the skill is
# used outside a capcut-cli checkout. A JavaScript entry runs under node; a
# launcher (an npm shim, a .cmd wrapper, a shell script) runs as it is, since
# node cannot execute it. Priority:
#   1. $CAPCUT_CLI                        (explicit override: a .js entry or a launcher)
#   2. <repo>/dist/index.js               (this checkout)
#   3. <dir>/node_modules/capcut-cli/dist/index.js, walking up from here
#   4. capcut-cli / capcut on PATH        (run as a launcher)
cli_cmd=()
resolve_cli() {
  local entry
  if [[ -n "${CAPCUT_CLI:-}" && -f "${CAPCUT_CLI}" ]]; then
    case "$CAPCUT_CLI" in
      *.js | *.mjs | *.cjs) cli_cmd=(node "$CAPCUT_CLI") ;;
      *) cli_cmd=("$CAPCUT_CLI") ;;
    esac
    return 0
  fi
  entry="$script_dir/../../../dist/index.js"
  if [[ -f "$entry" ]]; then
    cli_cmd=(node "$entry")
    return 0
  fi
  local dir="$script_dir" i
  for i in 1 2 3 4 5 6; do
    dir="$(dirname "$dir")"
    entry="$dir/node_modules/capcut-cli/dist/index.js"
    if [[ -f "$entry" ]]; then
      cli_cmd=(node "$entry")
      return 0
    fi
  done
  for entry in capcut-cli capcut; do
    if command -v "$entry" >/dev/null 2>&1; then
      cli_cmd=("$(command -v "$entry")")
      return 0
    fi
  done
  return 1
}

if ! resolve_cli; then
  echo "capcut CLI not found — set \$CAPCUT_CLI to its dist/index.js or a launcher, install it (npm install -g capcut-cli), or run \`npm run build\` in capcut-cli/" >&2
  exit 1
fi

if [[ -n "$text" ]]; then
  "${cli_cmd[@]}" apply-template "$project" "$template" "$start" "$duration" "$text"
else
  "${cli_cmd[@]}" apply-template "$project" "$template" "$start" "$duration"
fi
