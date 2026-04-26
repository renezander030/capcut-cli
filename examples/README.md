# Examples

Copy-paste recipes for common CapCut / JianYing workflows. Every recipe is one shell block — run it as-is.

| Recipe | Use case |
|---|---|
| [cut-to-shorts.md](./cut-to-shorts.md) | Slice one long video into multiple shorts |
| [batch-fix-subtitles.md](./batch-fix-subtitles.md) | Fix typos and re-sync timing in one pass |
| [build-short-from-scratch.md](./build-short-from-scratch.md) | CLI-only: clip + VO + music + title → finished short |
| [translate-subtitles.md](./translate-subtitles.md) | Export SRT, translate, re-import via batch |
| [reusable-title-template.md](./reusable-title-template.md) | Save a styled title once, apply across many projects |
| [keyframe-zoom.md](./keyframe-zoom.md) | Programmatic Ken Burns zoom-in/out keyframes on one segment |
| [keyframe-pan.md](./keyframe-pan.md) | Unfinished-pan keyframe pattern for epilogue / payoff stills |
| [verify-vo-alignment.md](./verify-vo-alignment.md) | Pre-flight check on ElevenLabs voiceover + word-level timestamps |

All shell-only recipes assume `capcut` is on your `$PATH` (`npm install -g capcut-cli`).
The three keyframe / VO recipes ship with companion Python scripts under [`./scripts/`](./scripts/) — Python 3.9+, no external deps.

> **JianYing (剪映) users:** every recipe works on JianYing projects too — point `<project>` at the JianYing draft directory.

> **中文 / Chinese:** the project README has a Chinese translation at [`README.zh-CN.md`](../README.zh-CN.md). Translation of these recipes is pending.
