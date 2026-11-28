# Captions without inserted word spaces

Caption generation detects Thai (`th`), Lao (`lo`), Khmer (`km`) and Myanmar (`my`) text and joins source tokens without adding spaces. Spaces already inside a supplied token remain text. Mostly Latin captions keep the existing behavior.

If an aligner supplies an entire sentence as one timed token, `--max-chars` can split it into shorter cues. Splits prefer Unicode word boundaries and fall back to whole graphemes, preserving combining marks. The normal limits are 42 UTF-16 code units per line cue and 28 in karaoke/reveal grouping; select a different cap explicitly:

```sh
capcut caption ./project --words aligned.json --max-chars 28
```

Internal times derived from one coarse token are estimates. The JSON result reports `timing_interpolation.split_tokens` and `generated_chunks`, while preserving the original token span's endpoints. `from_cues` identifies timing derived from sentence cues rather than supplied word timings. Use a word aligner when accurate per-word highlights matter.

A grapheme larger than the cap, or a span too short to allocate positive chunk durations, stays intact and is counted in `unresolved_tokens`. The command does not split a combining cluster or manufacture zero-duration chunks to claim that the limit was met.

## Repair existing caption lines

`lint --fix --max-chars 28` also wraps existing Thai, Lao, Khmer and Myanmar caption lines at Unicode word or grapheme boundaries. It preserves cue times, existing line breaks and the characters selected by editable style ranges. Clause spaces use the existing space-wrap behavior; unbreakable Latin identifiers retain their behavior. A combining cluster that cannot fit the cap remains report-only.
