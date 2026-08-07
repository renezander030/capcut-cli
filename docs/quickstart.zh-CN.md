# 剪映快速上手

[English quickstart](../README.md#quickstart) | 中文

capcut-cli 是一个独立的 CapCut / 剪映命令行工具：零依赖、不起服务，直接读写本地草稿文件，任何大模型 Agent 或脚本都能驱动。本页专门面向**剪映（国内版）**用户 —— 剪映和 CapCut 共用一个二进制，但版本形势、草稿目录和资源命名空间都不一样，先把这三件事讲清楚。

> **免责声明：** 本项目为独立的社区项目，与剪映、CapCut 或字节跳动无任何隶属、赞助或背书关系。"剪映"与 "CapCut" 为字节跳动有限公司的商标，此处仅作指称性使用。

## 第一件事：版本须知（比安装更重要）

- **剪映 5.9.x 是最后一个广泛使用的明文草稿版本**，也是配合本 CLI 的推荐版本。
- **剪映 6.0 起 `draft_content.json` 被加密。** CLI 只检测、不解密：`capcut decrypt <草稿>` 会报告加密状态并给出应对方案。明文变体虽然还能正常查看，但写入护栏会拒绝对 6.0+ 时代的草稿做任何修改（`--force-write` 可强制覆盖，后果自负）—— 因为写回的明文可能被应用忽略或提示已损坏。
- **首选做法：把剪映固定在 5.9.x 并阻止自动更新。** 注意应用的自动更新会破坏固定 —— 一台"钉死"在 5.9 的机器悄悄升级后，明文工具链就全部失效。逐系统的固定方法见 [version-support.md](./version-support.md) 的 "Pinning app updates" 一节；CLI 自带升级绊线，草稿存储的应用版本变化后，第一次写入就会在 stderr 打出 WARNING。
- CapCut 国际版**不加密**，以上限制只针对剪映。支持矩阵全文见 [version-support.md](./version-support.md)，加密决策的来龙去脉见 [jianying-encryption.md](./jianying-encryption.md)。

## 安装

前置要求只有 Node ≥ 18（纯内置模块，无原生依赖）。可选工具解锁个别命令：Whisper 用于 `caption`，FFmpeg 用于 `render`，ffprobe 用于自动读媒体元数据。

```bash
npm install -g capcut-cli      # 或：npx capcut-cli <command>
capcut doctor                  # 预检：Node、FFmpeg、whisper、草稿目录
```

## 草稿在哪里

剪映的草稿存储位置：

| 系统 | 路径 |
|------|------|
| Windows | `%LOCALAPPDATA%\JianyingPro\User Data\Projects\com.lveditor.draft` |
| macOS | `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft` |

CLI 会自动探测：环境变量 `CAPCUT_DRAFT_DIR` 优先，其次取磁盘上第一个真实存在的存储（CapCut 与剪映的候选路径都在列），命令上也可以用 `--drafts <目录>` 显式指定。列出现有草稿：

```bash
capcut projects            # 所有草稿文件夹（JSON；加 -H 显示表格）
capcut projects 婚礼        # 按关键词过滤
```

## 三条命令出第一个草稿

```bash
capcut doctor
capcut quickstart 我的第一个草稿 --video 素材.mp4
capcut info <上一步打印的草稿路径> -H
```

`quickstart` 一步完成创建、添加素材、lint 检查，并打印"在应用中打开"的收尾步骤。之后在剪映里打开草稿审阅、渲染 —— 所有短视频平台都禁止自动上传，最后的发布按钮由你来点。

所有命令默认输出 JSON（可直接管道给 `jq` 或喂给 Agent），加 `-H` 切换为人类可读表格。

## 剪映命名空间：`--jianying`

转场、蒙版、特效等资源在剪映和 CapCut 里不是同一套。加 `--jianying` 切换到剪映的枚举命名空间：

```bash
capcut enums --transitions --jianying     # 列出剪映转场
capcut enums --masks --jianying           # 列出剪映蒙版
```

`enums` 支持的类别：`--transitions`、`--masks`、`--image-intros`、`--image-outros`、`--image-combos`、`--text-intros`、`--text-outros`、`--text-loop-anims`、`--scene-effects`、`--character-effects`、`--audio-effects`、`--fonts`、`--filters`、`--bubbles`。

不少剪映资源的 slug 为空、只有中文标识名 —— CLI 同样支持按名称查找：

```bash
capcut transition <草稿> <片段ID> "_3D空间" --jianying
```

应用里自己用过、但内置表还不认识的商店特效，可以用 `capcut harvest-enums <草稿> --apply` 从应用生成的草稿里学习进来，之后就能按 slug 直接写入。

## 剪映功能 → 命令对照

| 剪映里的操作 | 命令 |
|--------------|------|
| 查看草稿 / 轨道 / 片段 | `info` · `tracks` · `segments` · `timeline` |
| 字幕（导入 / 识别 / 导出） | `import-srt` · `caption` · `export-srt` |
| 转场 | `transition` |
| 蒙版 | `mask` |
| 滤镜 / 特效 | `add-filter` · `add-effect` |
| 关键帧 | `keyframe` |
| 贴纸 / 音效 | `add-sticker` · `add-sfx` |
| 模板 | `save-template` · `apply-template` |
| 变速 / 音量 / 裁剪 | `speed` · `volume` · `trim` · `crop` |
| 检查草稿 | `lint`（退出码 0/1/2，可进 CI） |
| 撤销写入 | `restore` |

完整的命令、参数与说明见 **[命令参考（简体中文）](./command-reference.zh-CN.md)**。

## 写入安全

- 每次写入都是原子操作，先留 `.bak` 再落盘；`capcut restore <草稿>` 可按步撤销。
- 检测到剪映 / CapCut 桌面端正在运行时，受管理的草稿路径会拒绝写入。
- 版本护栏：超出已验证范围或已知不兼容的草稿（包括剪映 6.0+ 时代）会拒绝写入，`--force-write` 是显式覆盖而不是默认恢复路径。

## 接下来

- [命令参考（简体中文）](./command-reference.zh-CN.md) —— 全部命令一览
- [中文 README](../README.zh-CN.md) —— 项目总览、安装与赞助
- [examples/](../examples/) —— 端到端示例（英文：配音对齐、serve 自动化、批量字幕修正）
- [version-support.md](./version-support.md) · [jianying-encryption.md](./jianying-encryption.md) —— 版本矩阵与加密说明（英文）
