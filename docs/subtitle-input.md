# Subtitle input

Subtitle files are decoded strictly before a draft is written. UTF-8 and UTF-16LE/BE byte-order marks are recognized automatically. A file without a BOM defaults to UTF-8.

For a legacy file, select the encoding you know it uses:

```sh
capcut import-srt ./project captions.srt --encoding windows-1252
capcut quickstart subtitled --srt captions.srt --encoding shift_jis --drafts ./drafts
```

The same option is available on `import-ass`, `detect-retakes --srt`, and `dub`. An explicit `--encoding` overrides BOM detection. SRT/WebVTT input from stdin (`import-srt ./project -`) uses the same decoder. BOM-marked UTF-16 input also works for `compile` caption files.

Supported labels are those provided by Node's `TextDecoder`, including `windows-1250` through `windows-1258`, `shift_jis`, `gbk`, `big5`, `euc-kr`, `utf-16le`, and `utf-16be`. The CLI never guesses a legacy code page. Choose `--encoding utf-16le` or `utf-16be` for UTF-16 files without a BOM; otherwise their NUL characters are refused. Unsupported labels and malformed encoded text produce an error without writing the draft.

## Inline styles

SRT and WebVTT imports turn `<b>`, `<i>`, `<u>`, and `<font color="…">` into editable text ranges. Nested styles preserve their ranges, including captions containing emoji. Colors accept CSS basic names, `#RGB`, or `#RRGGBB`.

Character references are decoded once: `&lt;i&gt;` becomes literal `<i>` text. Ordinary comparisons such as `2 < 3` stay text. WebVTT voice labels, ruby annotations, and inline timestamps are removed from the displayed caption. Quickstart and compile caption operations use the same reader.

Font face, font size, and strike-through tags are not reproduced. `import-srt` reports their count as `unsupported_styles`, and compile records a warning. This does not import WebVTT CSS blocks or layout settings.
