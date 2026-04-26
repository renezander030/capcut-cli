# Cut one long video into multiple shorts

You have a 30-minute interview or podcast loaded into CapCut and want three 60-second clips for social.

## One short

```bash
capcut cut ./my-podcast 5:30 6:30 --out ./short-1.json
```

`cut` does four things in one shot:
- Clips segments that cross the boundary
- Rebases timing so the new file starts at `0`
- Drops empty tracks
- Cleans orphaned materials

The output is a standalone `draft_content.json` you can drop into a CapCut project folder.

## Three shorts in a loop

```bash
# pairs of start/end timestamps
clips=(
  "5:30 6:30 hook-moment"
  "12:15 13:15 best-quote"
  "22:00 23:00 punchline"
)

for clip in "${clips[@]}"; do
  read start end name <<< "$clip"
  capcut cut ./my-podcast "$start" "$end" --out "./shorts/$name.json"
done
```

## Add an end-card title to each short

```bash
for f in ./shorts/*.json; do
  capcut add-text "$f" 55s 5s "Full episode in description" \
    --font-size 18 --color "#FFFFFF"
done
```

## Tips

- Use `capcut info ./my-podcast -H` first to see total duration.
- `capcut texts ./my-podcast` gives you every subtitle with timestamps — easy to find quotable moments programmatically (or pipe to an LLM).
- `cut` is non-destructive. The source project is untouched; you get a new file.
