# Match synthesized dub clip peaks

Local TTS tools can return clips at different levels. Normalize each played clip while placing the dub:

```sh
capcut dub ./project ./captions.srt \
  --tts-cmd 'my-local-tts --output {out}' \
  --normalize-peak -6 --max-gain-db 20
```

`--normalize-peak` accepts a true-peak target from -60 to 0 dBFS. FFmpeg measures each clip's played prefix, including any `--trim-overlap` shortening, before the command writes any segment gains. Select another binary with `--ffmpeg-cmd`.

The command sets individual segment volumes and keeps synthesized source files unchanged. Use this option without an additional `--volume` adjustment. Without it, dub retains its normal volume behavior and requires no FFmpeg peak measurement.

Each clip's JSON `normalization` reports its measured peak, applied gain, volume, estimated output peak and whether the maximum boost prevented reaching the target. The default maximum boost is 20 dB. Attenuation remains available when a clip is louder than the target. A silent clip, an unreadable measurement or a failing meter causes the command to remove its newly synthesized files and leave the saved draft unchanged.

`--dry-run` reports the cues and requested target without running TTS, metering audio or writing assets. Peak matching is separate from integrated loudness normalization: use `loudness` for a LUFS delivery target. Overlapping clips, later effects and lossy encoding can change the final mix peak; check the exported result for delivery.
