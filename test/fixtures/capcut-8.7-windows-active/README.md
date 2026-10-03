# CapCut 8.7.0 Windows active timeline

App-authored fixture supplied by fpisasale / Spirito Digitale on 2026-10-02:
https://gist.github.com/fpisasale/8b344dccd4f4a731a35ef49ca55f0ff0

Experiment and environment (CapCut desktop 8.7.0.3685, Windows 11, CLI 0.26.0):
https://github.com/renezander030/capcut-cli/issues/50#issuecomment-5954728670

The supplied files are preserved in their original form, with the gist's
flattened filenames restored to directories. No media is included. The author
ran fixture redaction and manually removed the Windows username missed by #134.

The capture follows an app close round-trip and one more root-only add-text.
Both root documents contain COPIA TIMELINES and SOLO RADICE; the document
selected by main_timeline_id contains only COPIA TIMELINES. The pointer's
project id differs from main_timeline_id.

This fixture establishes on-disk structure and divergence. The author reported
that the app loads the nested sentinel and overwrites the root on close.
A patched CLI open/close round-trip has not yet been independently verified.
It supplies no evidence for other OSes, versions, or root-only new drafts.
