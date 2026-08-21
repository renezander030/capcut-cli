<p align="center">
  <img src="https://raw.githubusercontent.com/renezander030/capcut-cli/master/media/og-card.png" alt="capcut-cli — 任何大模型 Agent 都能驱动的剪映 / CapCut 命令行：零依赖、无服务、双命名空间" width="640">
</p>

# capcut-cli

[![CI](https://github.com/renezander030/capcut-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/renezander030/capcut-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/capcut-cli.svg)](https://www.npmjs.com/package/capcut-cli)
[![npm downloads](https://img.shields.io/npm/dm/capcut-cli.svg)](https://www.npmjs.com/package/capcut-cli)
[![node](https://img.shields.io/node/v/capcut-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/capcut-cli.svg)](./LICENSE)

[English](./README.md) | 中文

> **隐私 — 若你曾运行过 `capcut fixture`，请升级到 0.18.0。** 在 0.17.2 及更早的所有版本中，该命令生成的分享包会原样带出 CapCut 写入草稿的 `device_id`、`mac_address` 与 `hard_disk_id`：脱敏器只处理了用户主目录路径和电子邮件地址，而 `SANITIZE_REPORT.json` 自身的 `source_dir` / `out_dir` 未经脱敏写入，又把用户名带了回来。由于文档建议的流程正是把该分享包附到公开 issue 上，照做即会公开一个稳定的设备 ID 与 MAC 地址——尽管文件名与报告都称其“已脱敏”。已在 0.18.0 修复（[#59](https://github.com/renezander030/capcut-cli/issues/59)）。**请将更早版本生成的任何分享包视为未脱敏。** `npm install -g capcut-cli@latest`。

> **安全提示 —— 请升级到 0.17.1 或更高版本。** 0.17.0 及更早版本在 `export --batch` 中把草稿文件夹名直接拼进要执行的自动化脚本，因此一个精心命名的文件夹可以在 macOS 与 Windows 上执行自己的命令。0.17.1 已修复，同时修复的还有：草稿的字幕颜色可注入 ffmpeg 滤镜参数（`render --burn-captions`）、`compile` 规格的 `name` 可写到草稿存储之外、每次草稿写入使用的临时文件名可被预测，以及 `serve` 把凭据值回显到自己的输出中。两处注入都需要一个并非你本人创建的草稿文件夹或草稿文件，因此影响范围是本地而非远程。升级：`npm install -g capcut-cli@latest`。详见 [更新日志](./CHANGELOG.md)。

> **免责声明：** 本项目为独立的、社区维护的项目，与 CapCut、剪映或字节跳动有限公司（ByteDance Ltd.）**无任何隶属、赞助或背书关系**。"CapCut" 与 "剪映" 为字节跳动有限公司的商标，所有产品名称、徽标与品牌均归各自所有者所有，此处仅用于标识（指称性使用）目的。

**任何大模型 Agent 都能驱动的剪映 / CapCut 命令行 —— 零依赖、无服务、CapCut + 剪映共用一个二进制。**

JSON 进、JSON 出：每个命令都直接读写本地草稿存储，不用 MCP 服务或 HTTP 守护进程。新版 CapCut 会自动检测并同步每个可读的时间线目标，不再假设只有 `draft_content.json` 是真源。这给任何模型（Claude、DeepSeek、GLM、Kimi）一个确定性边界，用于查看、构建、字幕、字幕烧录、翻译与长视频切短。

**三种用法：**

- **命令行（CLI）** —— `npm install -g capcut-cli`，然后 `capcut <command> <project>`
- **库（Library）** —— `import { loadDraft, lintDraft, saveDraft } from "capcut-cli"`（带类型、零依赖）
- **队列执行器** —— `capcut serve` 从 stdin 读取 JSONL 任务，对接 [n8n / Make / Coze](./examples/serve-automation.md)

> **v0.20.0 新增：** 字幕样式现在可以双向跨越草稿边界——`export-ass` 写出 `[V4+ Styles]`、逐区间覆盖标签与 `--karaoke` 逐词计时，`import-ass` 则保留内联的粗体/斜体/颜色/字号区间，不再压平为纯文本，并有往返测试兜底。原始录音的处理链路就此闭环：`detect-silence` 找出静音段（`--pad` 留出余量，不会把词切在半个音节上），`tts` 可通过任意本地 TTS 工具（piper、`say`、espeak-ng）把文稿直接配音到音频轨上。`render` 补完了 0.19.0 的快速失败工作——音频滤镜链与视频链一样接受预检（[#91](https://github.com/renezander030/capcut-cli/issues/91)）——并新增 `--encoder` 以启用硬件编码器。另有 `harvest-enums --sync`/`--add` 支持整库扫描与手工登记，`diagnose` 现在能为悬而未决的存储布局问题采集脱敏证据（[#50](https://github.com/renezander030/capcut-cli/issues/50)）。没有删除任何命令，现有参数含义均未改变。详见[更新日志](./CHANGELOG.md)。

> **v0.19.1 新增：** 此前每一处多区间文字高亮都被写到了文本末尾之外。`styles[].range` 存的是 UTF-16 码元（code unit）而非 UTF-16LE 字节，因此 `text-ranges`、`caption --karaoke`、`--highlight-words` 以及任何带 `text_ranges` 的预设，写入的偏移量都是应有值的两倍——普通的 `add-text` 看起来正常，只是因为整段区间会被裁回文本末尾（[#85](https://github.com/renezander030/capcut-cli/issues/85)，由 [@hillimited](https://github.com/hillimited) 在 38 个由 App 创建的草稿上实测得出）。所有读写该偏移量的位置均已修正，`lint --fix` 可修复旧版本写出的草稿（`text-range-doubled`）。详见[更新日志](./CHANGELOG.md)。

## 安装

**前置要求：** Node ≥ 18（仅用内置模块，无原生依赖）。可选工具解锁特定命令：Whisper 用于 `caption`，FFmpeg 用于 `render`，ffprobe 用于自动读取媒体元数据，`ANTHROPIC_API_KEY` 用于 `translate`。

```bash
npm install -g capcut-cli      # 或：npx capcut-cli <command>
```

从源码构建：`git clone https://github.com/renezander030/capcut-cli && cd capcut-cli && npm install && npm run build`（再 `npm link` 暴露 `capcut`）。

## 快速上手

```bash
capcut doctor                                  # 检查 Node、FFmpeg、whisper、草稿目录
capcut quickstart my-first --video clip.mp4    # 创建 + 加素材 + lint，并打印“在 CapCut 中打开”的步骤
capcut info ./my-first/                         # 查看草稿（加 -H 显示表格）
```

然后在 CapCut 中打开项目审阅并渲染。所有短视频平台都禁止自动上传，所以最后的发布按钮由你来点。

**剪映（国内版）用户：** 版本须知（6.0+ 加密）、草稿目录位置与 `--jianying` 命名空间，见 **[剪映快速上手](./docs/quickstart.zh-CN.md)**。

## 常用命令

默认输出 JSON（可管道给 `jq`）；加 `-H` 显示人类可读表格。加 `--jianying` 使用剪映枚举命名空间。运行 `capcut <command> --help` 查看完整参数。

| 分组 | 命令 |
|------|------|
| **查看** | `info` · `tracks` · `materials` · `version` · `lint` |
| **浏览 / 下钻** | `segments` · `texts` · `segment` · `material` |
| **创建** | `init` · `quickstart` · `compile`（用 JSON spec 构建草稿）|
| **预览** | `render`（低清 ffmpeg 代理预览 —— 非 CapCut 最终渲染）|
| **添加** | `add-video` · `add-audio` · `add-text`（支持 Wikimedia URL，自动校验授权）|
| **编辑 / 动画** | 裁剪 · 变速 · 音量 · 转场 · 蒙版 · 文字/图片动画 · 缓动曲线 |
| **模板** | 应用与提取可复用版式 · `make-preset`（可移植文字样式预设）|
| **字幕 / 多语言** | `caption` · `import-srt` · `export-srt`（行级/逐词 SRT + VTT）· `translate`（多语言草稿克隆）|
| **特效** | `sfx` · `chroma`（绿幕抠像）|
| **长视频切短** | `cut` · `detect-scenes`（ffmpeg 场景切点检测）|
| **自动化** | `serve`（无状态 JSONL 执行器）· `migrate` · `doctor` · `sync-timelines`（8.7 时间线镜像修复）|

**完整命令参考**（每个命令、参数与退出码）：**[docs/command-reference.zh-CN.md](./docs/command-reference.zh-CN.md)**（[英文原版](./docs/command-reference.md)）。

## 赞助

capcut-cli 采用 MIT 协议，永久免费。赞助会加速版本发布、让新版 CapCut / 剪映在同一周内得到支持 —— 同时解锁高级用户福利：

- **$5/月 · 支持者** —— 仅赞助者可见的发布说明，以及把你的名字写进 `BACKERS.md`。让项目持续前进。
- **$25/月 · Pro** —— 受邀加入私有仓库 `capcut-cli-pro`：高级模板与字幕样式包、完整的 Claude 爆款短视频流水线、开箱即用的 `compile` 配置，以及抢先体验版构建。外加优先处理你的 issue。
- **$100/月 · 团队** —— Pro 全部内容，覆盖最多 5 名团队成员；书面商用授权确认；你的 logo 展示在本 README；并优先快速实现你团队需要的功能。

[**成为赞助者 →**](https://github.com/sponsors/renezander030)

> 在工作中用 capcut-cli 吗？团队版只要帮工程师省下一个下午，当天就回本了。

## 工作原理

CapCut / 剪映把每个项目存为本地 JSON。capcut-cli 加载这个存储，按版本感知的 schema 校验，应用你的编辑，再原子写回（并留 `.bak`）。不上传任何项目文件，也不以服务方式运行。支持的 CapCut / 剪映版本与 schema 标志见 [docs/version-support.md](./docs/version-support.md)。

## 文档与示例

- [docs/command-reference.zh-CN.md](./docs/command-reference.zh-CN.md) —— 每个命令与参数（[英文原版](./docs/command-reference.md)）
- [docs/quickstart.zh-CN.md](./docs/quickstart.zh-CN.md) —— 剪映快速上手：版本须知、草稿目录、`--jianying` 命名空间
- [examples/](./examples/) —— 端到端示例（配音对齐、serve 自动化、批量字幕修正）
- [docs/version-support.md](./docs/version-support.md) · [docs/jianying-encryption.md](./docs/jianying-encryption.md)
- [CHANGELOG.md](./CHANGELOG.md) · [Releases](https://github.com/renezander030/capcut-cli/releases) —— 更新内容
- [draftcat](https://github.com/renezander030/draftcat) —— 姊妹项目：受治理的 AI 流水线（Go, MIT），同样单二进制、无需 API

## 商标声明

CapCut™ 与剪映™ 为字节跳动有限公司（ByteDance Ltd.）的商标。本项目为非官方项目，与字节跳动无隶属或背书关系；相关商标仅用于指称性描述以说明互操作性。

## License

MIT
