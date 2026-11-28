# WebM proxy output

Choose a `.webm` output path to render VP9 video, Opus audio and optional WebVTT soft captions:

```sh
capcut render ./project --out preview.webm --soft-captions --verify
```

The default video encoder is `libvpx-vp9`. Constant-quality mode uses CRF 28 with zero target bitrate; `--video-bitrate 2M` selects bitrate mode instead. WebM does not receive the x264 `veryfast` preset. An uppercase `.WEBM` extension selects the same behavior.

An explicit `--encoder` must produce VP8, VP9 or AV1 for WebM. Incompatible encoders such as `libx264` are refused before rendering. The selected FFmpeg build must provide the video encoder and, when the timeline contains audio, `libopus`. A missing `webvtt` encoder disables optional soft captions with a warning in the render report.

MP4 keeps its H.264, AAC and `mov_text` defaults. WebM changes the container and codecs; the proxy's fidelity limits still apply.
