# 短视频旁白：无声素材 → 9:16 口播草稿

[English](./short-video-narration.md) | 中文

三条命令：`quickstart` 建一个 9:16 草稿并放入素材，`tts` 用你的文案生成旁白，`caption` 用 whisper 的时间轴配上你的文案生成字幕，最后 `lint` 检查。全程不开剪映界面；打开剪映时，视频轨、旁白轨、字幕轨都还是可编辑的。

## 你需要

- capcut-cli（`npm install -g capcut-cli`，Node ≥ 18）
- ffmpeg
- 一个本地 TTS。示例用 [edge-tts](https://github.com/rany2/edge-tts)（`pip install edge-tts`，微软中文神经网络音色，免费）；任何能写出 WAV 的命令都可以通过 `--tts-cmd` 接入
- 可选：whisper（`pip install openai-whisper`），用于字幕。没有它，草稿仍然包含素材和旁白

## 输入

```
clip.mp4     # 无声素材（横竖都行，--ratio 9:16 决定画布）
script.txt   # 旁白文案，一行一句
```

文案自己写，或者先让任意视觉模型看一遍素材再写。例如先抽帧，再把帧交给你手头的模型 CLI：

```bash
mkdir -p frames && ffmpeg -v error -i clip.mp4 -vf fps=1/2 frames/%02d.jpg
<你的视觉模型 CLI> "根据这些画面写一段 5 句的中文口播文案，一行一句，不要标题" frames/*.jpg > script.txt
```

模型不是必需的：文案就是一个普通文本文件，手写同样可以。

## 一键

```bash
bash examples/scripts/narrate-short.sh clip.mp4 script.txt "旁白短视频" --voice zh-CN-XiaoxiaoNeural
```

`--drafts <目录>` 指定草稿库；不指定就用本机的默认目录。脚本只是把下面四步串起来。

## 分步

```bash
# 1. 9:16 草稿，素材上主轨
capcut quickstart "旁白短视频" --video clip.mp4 --ratio 9:16
#    结果里的 draft_path 就是草稿目录

# 2. 旁白，放在 0s。edge-tts 只会写 MP3，capcut tts 要求引擎把 WAV 写到 {out}，
#    所以经过 examples/scripts/edge-tts-wav.sh 转一次
capcut tts "<draft_path>" 0s --text-file script.txt \
  --tts-cmd "bash examples/scripts/edge-tts-wav.sh {text} {out} zh-CN-XiaoxiaoNeural"
#    结果里的 segment_id 是旁白片段

# 3. 字幕：时间来自 whisper，文字来自你的文案。中文默认每条最多 16 个字，按字断句，不加空格
capcut caption "<draft_path>" --from-segment <segment_id> --script script.txt

# 4. 检查
capcut lint "<draft_path>" -H
```

重启一次剪映，让它读到新草稿，然后在草稿列表里打开它。

## 换音色、换引擎、改字幕样式

- edge-tts 中文音色：`edge-tts --list-voices | grep zh-CN`（Xiaoxiao、Yunxi、Yunyang……），用 `--voice` 或环境变量 `EDGE_TTS_VOICE` 指定
- 其他引擎：任何能把 WAV 写到 `{out}` 的命令都行。`{text}` 可选；模板里没有 `{text}` 时，文案从 stdin 传入（piper 就是这样用）。macOS 自带的 `say`：`--tts-cmd "say -o {out} --data-format=LEI16@24000 {text}"`，脚本里用 `CAPCUT_TTS_CMD` 环境变量覆盖
- 字幕样式：`caption --preset <preset.json>`（先用 `make-preset` 从你调好的字幕段提取）或 `--style-ref <segment-id>`；卡拉 OK 高亮加 `--karaoke`

## 剪映 6.0+ 用户

这样新建的草稿是明文，据报告剪映 11.4（macOS）打开后会就地升级，其他版本未验证。已有的加密草稿本 CLI 不读取，`capcut decrypt <草稿>` 会报告加密状态；来龙去脉见 [jianying-encryption.zh-CN.md](../docs/jianying-encryption.zh-CN.md)。
