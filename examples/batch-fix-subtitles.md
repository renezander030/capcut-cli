# Fix typos and re-sync subtitle timing in one pass

Auto-generated subtitles always need cleanup. Doing it in CapCut means clicking each line, fixing the text, then nudging the start point. With `capcut-cli`, one pipeline handles dozens of changes.

## See what you've got

```bash
capcut texts ./project | jq -r '.[] | "\(.id[0:8])  \(.start_us / 1000000 | floor)s  \(.text)"'
```

```
a1b2c3d4  0s   Welcom to the chanel
e5f6g7h8  3s   today were lookng at
i9j0k1l2  6s   the new framwork release
```

## Batch the fixes

`capcut batch` reads JSONL from stdin. One IO, one backup, one write.

```bash
capcut batch ./project <<'EOF'
{"cmd":"set-text","id":"a1b2c3d4","text":"Welcome to the channel"}
{"cmd":"set-text","id":"e5f6g7h8","text":"Today we're looking at"}
{"cmd":"set-text","id":"i9j0k1l2","text":"the new framework release"}
{"cmd":"shift-all","offset":"+0.3s","track":"text"}
EOF
```

`shift-all` with `--track text` nudges every subtitle by 300ms — useful when the speaker leads the captions.

## Drive it from a spreadsheet

Export your fixes to a CSV (`id,text`), then convert to JSONL:

```bash
awk -F',' 'NR>1 {printf "{\"cmd\":\"set-text\",\"id\":\"%s\",\"text\":\"%s\"}\n", $1, $2}' fixes.csv \
  | capcut batch ./project
```

## Drive it from an LLM

```bash
# extract → send to your LLM of choice → pipe back
capcut texts ./project \
  | your-llm-cli "Fix typos. Output JSONL of {cmd:'set-text',id,text}." \
  | capcut batch ./project
```

That's the whole loop. The CLI's JSON-in/JSON-out shape exists for exactly this.
