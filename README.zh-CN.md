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

**在终端里创建和编辑真正的 CapCut / 剪映项目 —— 或者交给任何大模型 Agent 来做。**

在 CapCut 中打开成果，每条轨道依然可编辑。capcut-cli 直接操作本地草稿存储：JSON 进、JSON 出，没有上传、没有 API、没有 MCP 服务，也没有 HTTP 守护进程。

`原始录音` → `静音感知剪辑 + 样式化字幕` → `可编辑的 CapCut / 剪映草稿`

**▶ 带字幕的成片示例（60 秒）**

https://github.com/user-attachments/assets/4e6ee99c-0745-4cfb-8e9b-ad873fb1259b

## 安装并打开你的第一个可编辑草稿

**前置要求：** Node ≥ 18（仅用内置模块，无原生依赖）。可选工具解锁特定命令：Whisper 用于 `caption`，FFmpeg 用于 `render`，ffprobe 用于自动读取媒体元数据，`ANTHROPIC_API_KEY` 用于 `translate`。

```bash
npm install -g capcut-cli
```

在 Python 里用：`pip install capcut` 封装同一个命令行 —— `capcut.run("quickstart", "我的短视频", video="clip.mp4", ratio="9:16")`，见 [python/README.md](https://github.com/renezander030/capcut-cli/blob/master/python/README.md)。

```bash
capcut doctor
capcut quickstart my-first --video clip.mp4 --srt captions.srt
capcut info ./my-first/ -H
```

**结果：** 一个真实的本地项目，视频和字幕都在可编辑的轨道上 —— 不是压平后的导出文件。在 CapCut 或剪映中打开它，进行审阅、调整与渲染。发布这一下点击，始终留给人来完成。

有用的话，[给 capcut-cli 加个 Star](https://github.com/renezander030/capcut-cli)，帮助更多剪辑师和 Agent 开发者发现它。

入选[《科技爱好者周刊》第 413 期](https://github.com/ruanyf/weekly/blob/master/docs/issue-413.md)。

想了解更多实用的 AI Agent 工具，从视频自动化到交付前的检查，[在 GitHub 上关注 René](https://github.com/renezander030)。

也可以从源码构建：`git clone https://github.com/renezander030/capcut-cli && cd capcut-cli && npm install && npm run build`（然后用 `npm link` 暴露出 `capcut`）。或者不安装，直接运行任意命令：`npx capcut-cli <command>`。

> [!IMPORTANT]
> **请先升级，不要继续使用旧版本。** 0.17.2 及更早版本生成的 fixture 包，可能带有稳定的设备标识符，必须视为未脱敏处理（[#59](https://github.com/renezander030/capcut-cli/issues/59)）。0.17.0 及更早版本还存在本地命令/过滤器注入路径，以及不安全的临时文件与凭据输出行为。这些问题分别已在 0.18.0 与 0.17.1 中修复。运行 `npm install -g capcut-cli@latest`，完整说明见[更新日志](./CHANGELOG.md)。

> **免责声明：** 本项目为独立的、社区维护的项目，与 CapCut、剪映或字节跳动有限公司（ByteDance Ltd.）**无任何隶属、赞助或背书关系**。"CapCut" 与 "剪映" 为字节跳动有限公司的商标，所有产品名称、徽标与品牌均归各自所有者所有，此处仅用于标识（指称性使用）目的。

**任何大模型 Agent 都能驱动的剪映 / CapCut 命令行 —— 零依赖、无服务、CapCut + 剪映共用一个二进制。**

JSON 进、JSON 出：每个命令都直接读写本地草稿存储，不用 MCP 服务或 HTTP 守护进程。新版 CapCut 会自动检测并同步每个可读的时间线目标，不再假设只有 `draft_content.json` 是真源。这给任何模型（Claude、DeepSeek、GLM、Kimi）一个确定性边界，用于查看、构建、字幕、字幕烧录、翻译与长视频切短。

**三种用法：**

- **命令行（CLI）** —— `npm install -g capcut-cli`，然后 `capcut <command> <project>`
- **库（Library）** —— `import { loadDraft, lintDraft, saveDraft } from "capcut-cli"`（带类型、零依赖）
- **队列执行器** —— `capcut serve` 从 stdin 读取 JSONL 任务，对接 [n8n / Make / Coze](./examples/serve-automation.md)

### 把它装进你的 Agent

一条命令即可把 `capcut-edit` 技能装进 Claude Code、Codex、Cursor、OpenCode 以及 [`skills`](https://skills.sh) 安装器支持的其他 Agent：

```bash
npx skills add renezander030/capcut-cli
```

Claude Code 也可以把它作为插件加载：

```
/plugin marketplace add renezander030/capcut-cli
/plugin install capcut-cli@capcut-cli
```

这个技能会教 Agent 每条命令、渐进式读取的习惯（先看概要，绝不整份倒出草稿）、macOS 与 Windows 上草稿目录的位置，以及淡入淡出、Ken Burns、长视频切短的确定性脚本。中英文请求都能触发（剪映、字幕、草稿）。

## 发布说明

> **v0.25.0 新增：** `caption` 按转写文本的文字来分句。Whisper 对中文、日文给出的"词"是单个字或很短的片段，按拉丁默认（每句 4 词、用空格连接）会生成字与字之间带空格的碎片；现在中日文按字直接连接、只按字数上限分句，上限就是 `lint` 对字幕的行宽（zh 16、ja 13、ko 16），结果里会报告 `caption_script`。显式传入的 `--max-words` / `--max-chars` 仍然优先。完整说明见[更新日志](./CHANGELOG.md)。

> **v0.24.0 新增：** 中文、日文、韩文字幕按各自的规范检查 —— `lint` 会指出 32 字的中文单行和每秒 15 字的字幕（拉丁默认的 42 字 / 每秒 20 字会放过它们），`--fix` 按字重新折行（zh 16/9、ja 13/4、ko 16/12；显式传入 `--max-chars` / `--max-cps` 仍对所有文字生效）。在剪映 6.0+ 的草稿目录里（应用写出的项目全部加密），`init` / `quickstart` / `compile` 现在会明确说明没有任何项目可作为种子（`template.store` 与 WARNING），`lint` 会报告 `template-unverified-store` 而不是沉默。另外，一条命令即可把它装进 Agent：`npx skills add renezander030/capcut-cli`。完整说明见[更新日志](./CHANGELOG.md)。

## 使用 capcut-cli 构建

- [OpenChatCut](https://github.com/0xsline/OpenChatCut) — 将 Agent 编辑后的时间线、本地视频、音频和字幕导出为可在 CapCut / 剪映中继续审阅和渲染的真实草稿。

使用 capcut-cli 构建了公开项目？请[提交 showcase issue](https://github.com/renezander030/capcut-cli/issues/new?template=showcase.yml)，附上公开链接、一句话说明，以及可选的截图或演示。

项目描述须经其维护者确认。收录不代表背书或关联。


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
| **特效** | `sfx` · `chroma`（绿幕抠像）· `matting`（智能抠像/去背景）|
| **长视频切短** | `cut` · `detect-scenes`（ffmpeg 场景切点检测）· `detect-silence` · `detect-retakes`（重复口播段落）|
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
- [docs/version-support.zh-CN.md](./docs/version-support.zh-CN.md)（[英文原版](./docs/version-support.md)）· [docs/jianying-encryption.zh-CN.md](./docs/jianying-encryption.zh-CN.md)（[英文原版](./docs/jianying-encryption.md)）
- [CHANGELOG.md](./CHANGELOG.md) · [Releases](https://github.com/renezander030/capcut-cli/releases) —— 更新内容
- [draftcat](https://github.com/renezander030/draftcat) —— 姊妹项目：受治理的 AI 流水线（Go, MIT），同样单二进制、无需 API

## 商标声明

CapCut™ 与剪映™ 为字节跳动有限公司（ByteDance Ltd.）的商标。本项目为非官方项目，与字节跳动无隶属或背书关系；相关商标仅用于指称性描述以说明互操作性。

## License

MIT
