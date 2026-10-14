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

if [[ -n "$text" ]]; then
  node "$cli" apply-template "$project" "$template" "$start" "$duration" "$text"
else
  node "$cli" apply-template "$project" "$template" "$start" "$duration"
fi
