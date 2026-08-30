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

[**▶ 观看一个带字幕的成片示例（60 秒）**](./media/two-sisters-vietnam-short.mp4)

## 安装并打开你的第一个可编辑草稿

**前置要求：** Node ≥ 18（仅用内置模块，无原生依赖）。可选工具解锁特定命令：Whisper 用于 `caption`，FFmpeg 用于 `render`，ffprobe 用于自动读取媒体元数据，`ANTHROPIC_API_KEY` 用于 `translate`。

```bash
npm install -g capcut-cli
```

```bash
capcut doctor
capcut quickstart my-first --video clip.mp4 --srt captions.srt
capcut info ./my-first/ -H
```

**结果：** 一个真实的本地项目，视频和字幕都在可编辑的轨道上 —— 不是压平后的导出文件。在 CapCut 或剪映中打开它，进行审阅、调整与渲染。发布这一下点击，始终留给人来完成。

有用的话，[给 capcut-cli 加个 Star](https://github.com/renezander030/capcut-cli)，帮助更多剪辑师和 Agent 开发者发现它。

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

## 发布说明

> **v0.21.1 新增：** 只有一个修复，但如果你通过 `npx` 使用 CLI，它就是这个版本的全部：`refused [editor-open]` 守卫会把 CLI *自己的* npm 进程识别为正在运行的编辑器——npm 会把自身进程标题改写为完整命令行（其中含有 `capcut-cli`），而守卫对拼接后的整张进程表做子串匹配——因此在文档记载的免安装路径（`npx capcut-cli …`）上，即使 CapCut 已关闭，所有写入也一律被拒绝（[#99](https://github.com/renezander030/capcut-cli/issues/99)，由 [@hansuk94](https://github.com/hansuk94) 报告，诊断与修复方向随报告一并给出）。编辑器检测现在在 macOS、Linux 与 Windows 上都按进程逐个精确比较进程名——真正运行中的 CapCut/JianYing 仍会拒绝写入，npm 进程不再触发。详见[更新日志](./CHANGELOG.md)。

> **v0.21.0 新增：** issue [#50](https://github.com/renezander030/capcut-cli/issues/50) 中 CapCut Mac 9.2.8 嵌套 Timelines 布局的报告有了修复路径——`sync-timelines --nested` 以显式选择的方式把根时间线复制进 `Timelines/<id>/` 文档（每个文档保留自己的 GUID，即讨论串中验证过的解决办法），`fixture --check` 会在你附上诊断包之前机械化地检查是否残留家目录路径、邮箱或设备 ID。每次写入拒绝现在都会标明触发的守卫（`refused [editor-open]` / `[version-boundary]` / `[draft-changed-on-disk]`），粘贴的 stderr 不再有歧义。另有 `catalogue <query>`（按名称在全部内置与采集目录中查 resource_id）、`lint --pip`（画中画+蒙版工作流校验，[#78](https://github.com/renezander030/capcut-cli/issues/78)）、`import-srt --clone-style`（无需先查段 ID 即沿用草稿现有字幕样式）、`relink --stage`（修复后的草稿可随文件夹迁移）、只观察不写入的 `media-unregistered` 提示（pyCapCut#13），以及 version-support 与 jianying-encryption 的中文文档。没有删除任何命令，现有参数含义均未改变。详见[更新日志](./CHANGELOG.md)。

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
- [docs/version-support.zh-CN.md](./docs/version-support.zh-CN.md)（[英文原版](./docs/version-support.md)）· [docs/jianying-encryption.zh-CN.md](./docs/jianying-encryption.zh-CN.md)（[英文原版](./docs/jianying-encryption.md)）
- [CHANGELOG.md](./CHANGELOG.md) · [Releases](https://github.com/renezander030/capcut-cli/releases) —— 更新内容
- [draftcat](https://github.com/renezander030/draftcat) —— 姊妹项目：受治理的 AI 流水线（Go, MIT），同样单二进制、无需 API

## 商标声明

CapCut™ 与剪映™ 为字节跳动有限公司（ByteDance Ltd.）的商标。本项目为非官方项目，与字节跳动无隶属或背书关系；相关商标仅用于指称性描述以说明互操作性。

## License

MIT
