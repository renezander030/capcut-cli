# Save a styled title once, reuse across many projects

You spent 20 minutes designing a title card in CapCut — font, color, position, animation timing. You want that *exact* style on every short you ship.

## Save the template

Find the segment ID:

```bash
capcut texts ./hero-short | jq '.[] | select(.text == "MY TITLE")'
# → {"id":"a1b2c3d4-...","start_us":0,"duration_us":3000000,"text":"MY TITLE"}
```

Extract the segment as a portable template:

```bash
capcut save-template ./hero-short a1b2c3d4 "gold-title" --out ./templates/gold-title.json
```

The template captures the segment shape *and* the linked material (font, color, position, etc).

## Apply across projects

```bash
for f in ./shorts/*.json; do
  capcut apply-template "$f" ./templates/gold-title.json 0s 3s
done
```

Every short now has the same gold title at `0s` for `3s`.

## With a different text per short

Apply the template, then patch the text per-project:

```bash
declare -A titles=(
  [hook-1.json]="ONE TRICK MOST EDITORS MISS"
  [hook-2.json]="THIS IS WHY YOUR EDITS LOOK CHEAP"
  [hook-3.json]="STOP USING THE DEFAULT FONT"
)

for short in "${!titles[@]}"; do
  capcut apply-template "./shorts/$short" ./templates/gold-title.json 0s 3s -q

  # the template's text was "MY TITLE" — find its new ID and overwrite
  new_id=$(capcut texts "./shorts/$short" | jq -r '.[] | select(.text=="MY TITLE") | .id' | tail -1)
  capcut set-text "./shorts/$short" "$new_id" "${titles[$short]}" -q
done
```

## What `save-template` actually captures

Anything that lives as a `segment + material` pair: text/title, sticker, video, audio. The output JSON is human-readable — you can edit it by hand or generate it programmatically.
