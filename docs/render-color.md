# Source color in proxy renders

The proxy renderer does not preserve HDR or convert HDR and wide-gamut video into SDR. Its fidelity census reports known PQ, HLG, BT.2020, P3, and Dolby Vision source metadata under `hdr_color`. `render --strict` refuses these sources before writing the proxy; use the editor for a color-managed export.

Actual renders inspect source metadata with ffprobe. The `source_color` report gives the number of readable probes and lists paths whose color metadata remains unknown. Untagged or unreadable input is not proof of SDR, and this report does not assess how the picture looks on a display.

A normal dry run stays independent of ffprobe and reports `mode: "not_probed"`. To include a source metadata check in a dry run, select ffprobe explicitly:

```sh
capcut render ./project --dry-run --strict --ffprobe-cmd /path/to/ffprobe
```

This is a fidelity warning and strict refusal, not a tone-mapping filter. Choosing another encoder does not remove the warning.
