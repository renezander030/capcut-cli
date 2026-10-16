# whisper.cpp full JSON (`-ojf`)

`jfk-ojf.json` is the real output of `whisper-cli -m ggml-tiny.bin -f samples/jfk.wav -l en -ojf`
(whisper.cpp 1.9.5-dev, commit 0c7be69), run on the public-domain sample that ships with whisper.cpp.
Each `transcription[]` segment carries `tokens[]` with `offsets.from` / `offsets.to` in milliseconds;
word-start tokens begin with a space, and `[_BEG_]` / `[_TT_n]` are special tokens.
