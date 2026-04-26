# Translate subtitles via SRT round-trip

CapCut has no built-in translation. Round-trip through SRT: export, translate with any tool, re-import via `batch`.

## Export

```bash
capcut export-srt ./project > en.srt
```

`en.srt` is a standard SubRip file — works with any translation service.

## Translate

Pick whatever tool fits your stack:

```bash
# Example: a hypothetical translation CLI
your-translator --to es en.srt > es.srt

# Or in-line via an LLM:
cat en.srt | your-llm-cli "Translate to Spanish. Keep SRT timing intact." > es.srt
```

## Re-import via batch

`capcut-cli` doesn't have a `set-text-from-srt` command — you compose it with `texts` + `batch`:

```bash
# Pair existing IDs (in order) with translated lines
paste \
  <(capcut texts ./project | jq -r '.[].id') \
  <(awk '/^[0-9]+$/{n=1;next} n==1 && /-->/ {n=2;next} n==2 && NF {print; n=0}' es.srt) \
  | awk -F'\t' '{printf "{\"cmd\":\"set-text\",\"id\":\"%s\",\"text\":\"%s\"}\n", $1, $2}' \
  | capcut batch ./project
```

Three pieces:
1. `texts ... | jq '.id'` — subtitle IDs in document order.
2. `awk` extracts the text line from each SRT entry (skip number, skip timestamp, take content).
3. `paste` joins them, JSONL converts, `batch` writes.

## Why round-trip instead of API

CapCut subtitles often come from auto-transcription with non-deterministic IDs. SRT is the boundary that everyone's translator already understands, and `batch` lets you write the result back without touching the project structure.
