# capcut-cli

[English](./README.md) | 中文

命令行编辑 CapCut / 剪映 (JianYing) 项目文件。从零创建草稿、添加素材、修改字幕、把长视频切成短片。

## 解决什么问题

CapCut / 剪映把项目存为 `draft_content.json` —— 嵌套很深、没有官方文档、时间单位是微秒、文字内容嵌套在转义过的 JSON 字符串里。每次手动修改都要：找到正确的 segment ID，关联到 material，搞清楚内容格式，转换时间戳，编辑，然后祈祷自己没把结构改坏。**最少 15 秒一次。**

`capcut-cli` 已经懂这套 schema。一条命令，一处修改，**5 秒搞定。**

```
$ capcut texts ./project
[{"id":"a1b2c3d4-...","start_us":500000,"duration_us":2500000,"text":"欢迎来到本视频"}]

$ capcut set-text ./project a1b2c3 "字幕已修正"
{"ok":true,"id":"a1b2c3d4-...","old":"欢迎来到本视频","new":"字幕已修正"}
```

零依赖。默认 JSON 输出。可管道。同时支持 CapCut 和剪映 (JianYing)。

## 安装

```bash
npm install -g capcut-cli
```

或直接运行：
```bash
npx capcut-cli info ./my-project/
```

### Claude Code 插件

```
/plugin marketplace add https://github.com/renezander030/capcut-cli
/plugin enable capcut-cli
```

启用后 Claude Code 拥有 `/capcut-cli:capcut-edit` 技能，自动安装 CLI、识别命令、定位 macOS/Windows 上的项目目录。

## 常用命令

```bash
# 查看项目概览
capcut info ./project

# 列出所有字幕
capcut texts ./project

# 修改某条字幕文字
capcut set-text ./project <id> "新文字"

# 平移单条片段
capcut shift ./project <id> +0.5s

# 平移所有字幕轨
capcut shift-all ./project +1s --track text

# 改播放速度
capcut speed ./project <id> 1.5

# 调音量
capcut volume ./project <id> 0.8

# 长视频切短：从 1:00 到 2:00 切出 60 秒
capcut cut ./project 1:00 2:00 --out ./short.json

# 导出 SRT
capcut export-srt ./project > subtitles.srt
```

## 从零创建剪映 / CapCut 草稿

不用先打开 CapCut，命令行就能拼出一个完整草稿：

```bash
# 创建空草稿
capcut init "我的短片"

# 加视频
capcut add-video ./我的短片 ./clip.mp4 0s 10s

# 加配音
capcut add-audio ./我的短片 ./voiceover.wav 0s 10s --volume 0.9

# 加背景音乐
capcut add-audio ./我的短片 ./music.mp3 0s 30s --volume 0.3

# 加标题
capcut add-text ./我的短片 0s 5s "标题" --font-size 24 --color "#FFD700"
```

`add-video` / `add-audio` 会把文件复制到草稿的 assets 目录，CapCut / 剪映打开后可以正常关联。

## 批量编辑

一次写入多条修改，一个 IO：

```bash
echo '{"cmd":"set-text","id":"a1b2c3","text":"第一行已修正"}
{"cmd":"set-text","id":"d4e5f6","text":"第二行已修正"}
{"cmd":"shift-all","offset":"+0.3s","track":"text"}' | capcut batch ./project
```

## 模板复用

把任意 segment（标题、贴纸、视频、音频）抽成模板，跨项目复用：

```bash
# 抽出来
capcut save-template ./project <id> "我的标题样式" --out ./title.json

# 用到别的项目
capcut apply-template ./other ./title.json 0s 5s
```

## 输出格式

**默认 JSON**（适合脚本和 agent 调用）：
```bash
capcut texts ./project | jq '.[].text'
```

**人类可读表格**（加 `-H` 或 `--human`）：
```bash
capcut info ./project -H
```

**静默模式**（写入命令加 `-q`，仅看返回码）：
```bash
capcut set-text ./project a1b2c3 "新文字" -q
```

## 工作原理

直接读写 `draft_content.json`。所有写入操作前自动创建 `.bak` 备份。

时间单位内部用微秒（`start_us`、`duration_us`），命令行接受 `1.5s`、`500ms`、`1:00`、`1:30:45` 等格式自动转换。

## 项目位置

- **macOS**：`~/Movies/CapCut/User Data/Projects/com.lveditor.draft/`
- **Windows**：`%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft\`
- **剪映**：`~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`

## 示例

更多端到端的例子见 [`examples/`](./examples/)。

## License

MIT
