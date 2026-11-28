# Ripple removal with captions

Plain `remove --ripple` keeps its crossing-segment refusal. To close a removed time span while adjusting intersecting static captions, select both flags:

```sh
capcut remove ./project <segment-id> --ripple --ripple-captions
```

For a removed interval from 2 to 4 seconds:

| Caption span | Result |
| --- | --- |
| 1–3 s | 1–2 s |
| 1–5 s | 1–3 s |
| 3–5 s | 2–3 s |
| 2.5–3.5 s | Removed |
| 5–6 s | 3–4 s |

The command changes caption timing; surviving caption text and styles remain whole. It does not determine which words belonged to the removed speech. The JSON `ripple_captions` result reports trimmed and dropped cues and confirms that retained text was unchanged.

Crossing video/audio content remains a blocker. The neutral companion records created by subtitle import are retained. Captions carrying keyframes or other companion resources remain blockers when they would need partial trimming. An entire caption contained in the deleted span can be dropped safely. Every blocker is checked before draft changes.

The normal material sweep removes newly orphaned caption materials unless `--keep-materials` is selected. Caption tracks emptied by dropped cues are retained; the selected segment's own track still follows `--keep-track`.
