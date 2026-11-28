# Render a timeline range

Use `--start` and `--end` to export a short preview without creating another draft:

```sh
capcut render ./project --start 12.5 --end 18 --out ./preview.mp4 --verify
```

The values accept the CLI's existing time formats. An omitted start means zero; an omitted end means the timeline end. Both endpoints must fall within the timeline and the end must follow the start.

Video, audio and captions are clipped and rebased on an in-memory copy. The original draft and media remain unchanged. Source timing retains each segment's playback speed. Soft captions use the selected range's clock, starting at zero.

The JSON result includes `source_range` with the original `start_us`, `end_us` and `duration_us`. `--dry-run` reports the range and filter plan without producing media. Without either flag, render keeps its full-timeline behavior.

This selects a timeline interval; all existing proxy fidelity limitations and `--strict` refusals still apply.
