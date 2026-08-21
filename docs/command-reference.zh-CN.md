# 命令参考（简体中文）

[English](./command-reference.md) | 中文

> 英文版 [command-reference.md](./command-reference.md) 由 `npm run docs:commands` 从 v2 命令注册表自动生成，是权威版本；本页是它的人工维护中文翻译。命令有新增或变更时，请先重新生成英文版，再同步更新本翻译。用法（Usage）一列与命令名保持英文原样 —— 那就是你在终端里输入的内容。

| 命令 | 用法 | 修改草稿 | 说明 |
|---|---|:---:|---|
| `info` | `capcut info <project>` | 否 | 项目概览与素材汇总。 |
| `version` | `capcut version <project>` | 否 | 检测 CapCut/剪映版本、schema 标志与支持状态。 |
| `lint` | `capcut lint <project> [options]` | 否 | 基于 schema 的检查（片段重叠、字幕行长、缺失文件、主轨道空隙、外部媒体）；退出码 0/1/2，可直接用于 CI。 |
| `tracks` | `capcut tracks <project>` | 否 | 列出所有轨道。 |
| `segments` | `capcut segments <project> [--track <type>]` | 否 | 列出片段及其时间信息；可用 --track <type> 按轨道类型过滤。 |
| `texts` | `capcut texts <project>` | 否 | 列出所有文本/字幕内容。 |
| `set-text` | `capcut set-text <project> <id> <text>` | 是 | 修改一个文本片段的内容。 |
| `shift` | `capcut shift <project> <id> <offset>` | 是 | 按偏移量平移单个片段的时间（如 +0.5s）。 |
| `shift-all` | `capcut shift-all <project> <offset> [--track <type>]` | 是 | 按偏移量平移所有片段（可用 --track 限定某一类轨道）。 |
| `speed` | `capcut speed <project> <id> <multiplier>` | 是 | 设置片段的播放速度。 |
| `volume` | `capcut volume <project> <id> <level>` | 是 | 设置片段音量（0.0-1.0）。 |
| `trim` | `capcut trim <project> <id> <start> <duration>` | 是 | 把片段裁剪到指定的起点/时长窗口。 |
| `opacity` | `capcut opacity <project> <id> <alpha>` | 是 | 设置片段不透明度（0.0-1.0）。 |
| `export-srt` | `capcut export-srt <project> [options]` | 否 | 把字幕导出为 SRT 或 WebVTT（输出到 stdout），按行或按词。 |
| `export-ass` | `capcut export-ass <project> [--karaoke] [--out <file.ass>]` | 否 | 把带样式的 ASS 字幕导出到 stdout 或 --out，支持按区间的样式覆盖；--karaoke 输出逐词时间。 |
| `export-timeline` | `capcut export-timeline <project> [--out <file.otio>]` | 否 | 把视频/音频轨道导出为 OpenTimelineIO JSON，交接给 NLE（DaVinci Resolve 原生导入 .otio）。 |
| `import-timeline` | `capcut import-timeline <file.otio> (--out <new-project> \| --into <project>)` | 是 | 导入 OpenTimelineIO JSON（export-timeline 输出的 schema 集合），生成新草稿（--out）或追加到已有草稿（--into）；不支持的 OTIO 特性一律报告，绝不静默丢弃。 |
| `materials` | `capcut materials <project> [--type <type>]` | 否 | 列出素材类型与数量；用 --type 过滤。 |
| `segment` | `capcut segment <project> <id>` | 否 | 单个片段及其素材的完整详情。 |
| `material` | `capcut material <project> <id>` | 否 | 单个素材的完整详情。 |
| `add-audio` | `capcut add-audio <project> <file-or-url> <start> [duration] [options]` | 是 | 在音频轨道上添加本地或 Wikimedia 音频文件。 |
| `add-video` | `capcut add-video <project> <file-or-url> <start> [duration] [options]` | 是 | 在视频轨道上添加本地或 Wikimedia 视频/图片。 |
| `add-text` | `capcut add-text <project> <start> <duration> <text> [options]` | 是 | 添加文本片段，带字体/颜色/位置选项。 |
| `tts` | `capcut tts <project> [start] [duration] (--text <string> \| --text-file <path>) --tts-cmd <template> [options]` | 是 | 通过本地 TTS 命令（--tts-cmd）从文本合成配音，并作为音频片段添加。 |
| `crop` | `capcut crop <project> <segment-id> [--ratio <r> \| --rect <x,y,w,h> \| --reset]` | 是 | 读取或设置视频/图片片段的源素材裁剪（--ratio 预设、--rect x,y,w,h 或 --reset）。 |
| `cut` | `capcut cut <project> <start> <end> --out <path>` | 是 | 把一段时间范围提取为一个独立的新草稿。 |
| `duplicate` | `capcut duplicate <project> <segment-id> [--track <track-name>] [--new-track]` | 是 | 在相同的时间线位置，把片段复制到源轨道上方的轨道。 |
| `remove` | `capcut remove <project> <segment-id> [--keep-track] [--keep-materials]` | 是 | 删除片段、被它清空的轨道，以及由此孤立的素材。 |
| `keyframe` | `capcut keyframe <project> <id> <property> <time> <value> [--easing <name>] \| --batch` | 是 | 添加关键帧（位置/缩放/旋转/透明度/音量）；单个或 --batch 批量。 |
| `transition` | `capcut transition <project> <id> <slug> [--duration <time>]` | 是 | 在片段之间添加转场。 |
| `mask` | `capcut mask <project> <id> <slug> [options] \| --off` | 是 | 应用蒙版（线性/圆形/爱心/……），带几何参数，或用 --off 移除。 |
| `bg-blur` | `capcut bg-blur <project> <id> <level> \| --off` | 是 | 设置背景模糊等级 1-4，或 --off 关闭。 |
| `text-style` | `capcut text-style <project> <id> [options]` | 是 | 设置文本样式（透明度/阴影/描边/背景框）。 |
| `text-anim` | `capcut text-anim <project> <id> [options]` | 是 | 添加文字入场/出场/组合动画。 |
| `image-anim` | `capcut image-anim <project> <id> [options]` | 是 | 为图片/视频片段添加入场/出场/组合动画。 |
| `add-sticker` | `capcut add-sticker <project> <resource-id> <start> <duration> [options]` | 是 | 在独立轨道上添加贴纸并设置变换。 |
| `mix-mode` | `capcut mix-mode <project> <id> <mode>` | 是 | 设置视频片段的混合模式。 |
| `audio-fade` | `capcut audio-fade <project> <id> [--in <seconds>] [--fade-out <seconds>]` | 是 | 为音频片段添加淡入/淡出（--in / --fade-out）。 |
| `add-cover` | `capcut add-cover <project> <image> [--time <milliseconds>]` | 是 | 用本地图片设置项目封面/缩略图。 |
| `add-filter` | `capcut add-filter <project> <slug-or-name> (<start> <duration> \| --full) [options]` | 是 | 在独立轨道上添加调色滤镜。 |
| `bubble-text` | `capcut bubble-text <project> <id> --bubble <slug>` | 是 | 为文本片段应用气泡形状。 |
| `add-effect` | `capcut add-effect <project> <slug-or-name> (<start> <duration> \| --full) [options]` | 是 | 在独立轨道上添加画面特效。 |
| `save-template` | `capcut save-template <project> <id> <name> --out <path>` | 否 | 把片段提取为可复用的模板 JSON。 |
| `apply-template` | `capcut apply-template <project> <template> <start> <duration> [text] [options]` | 是 | 用新的时间/文本把模板盖印到项目里。 |
| `make-preset` | `capcut make-preset <project> <text-segment-id> --out <preset.json>` | 否 | 把文本片段的样式提取为可复用的预设 JSON（通过 --preset 应用）。 |
| `templates` | `capcut templates <project>` | 否 | 列出内置的可复用模板。 |
| `batch` | `capcut batch <project> [--continue-on-error] < operations.jsonl` | 是 | 从 stdin（JSONL）批量执行多个编辑，只写一次文件。 |
| `import-srt` | `capcut import-srt <project> <srt-or-> [options]` | 是 | 导入 SRT 文件/stdin，每条字幕生成一个文本片段。 |
| `import-ass` | `capcut import-ass <project> <ass-or-> [options]` | 是 | 把 ASS/SSA 字幕文件导入为文本片段，并把内联覆盖标签保留为按区间的样式。 |
| `text-ranges` | `capcut text-ranges <project> <id> --styles <json-or-@file>` | 是 | 为文本片段应用字节级精确的多样式区间。 |
| `caption` | `capcut caption <project> (--audio <path> \| --from-segment <id>) [options]` | 是 | 用 whisper 转写音频，生成真正的字幕轨道片段。 |
| `translate` | `capcut translate <project> --to <language> --out <path> [options]` | 是 | 通过 Anthropic API 把草稿克隆为另一种语言。 |
| `migrate` | `capcut migrate <project> --from <version> --to <version>` | 是 | 在版本边界之间应用已知的 schema 迁移。 |
| `add-sfx` | `capcut add-sfx <project> <slug> <start> <duration> [options]` | 是 | 在专用轨道上添加音效。 |
| `chroma` | `capcut chroma <project> <id> (--color <hex> \| --off) [options]` | 是 | 对视频片段做绿幕/色度抠像，或 --off 关闭。 |
| `prune` | `capcut prune <project>` | 是 | 删除没有任何片段引用的素材。 |
| `register` | `capcut register <project-dir> [--apply] [--drafts <dir>]` | 是 | 从只读的 draft_content.json 修复已有草稿的注册元数据（draft_meta_info.json + root_meta_info.json 条目），让 CapCut 应用能列出它（默认只出计划；--apply 写入并留 .bak）。 |
| `rename` | `capcut rename <project> <new-name> [--drafts <dir>]` | 是 | 在创建后重命名草稿：磁盘上的文件夹，加上 draft_meta_info.json 和存储 root_meta_info.json 条目里的 draft_name 及所有自引用路径，事务性完成（目标文件夹已存在时拒绝）。 |
| `relink` | `capcut relink <project> (--dir <path> \| --from <prefix> --to <prefix>)` | 是 | 修复失效的媒体路径（--dir 或 --from/--to）。 |
| `replace-media` | `capcut replace-media <project> <segment-id> <new-file> [--retime]` | 是 | 替换片段的源文件（占位素材 → 成片素材），保留其时间、特效与关键帧。 |
| `timeline` | `capcut timeline <project> [--cols <number>]` | 否 | 显示轨道/片段布局（JSON；-H 显示 ASCII 条形图）。 |
| `projects` | `capcut projects [query] [--drafts <path>] [--names]` | 否 | 列出磁盘上的 CapCut/剪映草稿文件夹。 |
| `diff` | `capcut diff <project-a> <project-b>` | 否 | 比较两个草稿（片段/素材/轨道的增、删、改）。 |
| `concat` | `capcut concat <project-a> <project-b> [--out <path>]` | 是 | 把一个草稿追加到另一个的时间线末尾（ID 安全），写入 --out 或原地写入。 |
| `config` | `capcut config` | 否 | 显示解析后的配置（.capcutrc + 生效的默认值）。 |
| `describe` | `capcut describe` | 否 | 以 JSON 输出完整命令面（Agent 工具规范）。 |
| `completions` | `capcut completions <bash\|zsh\|fish>` | 否 | 生成 shell 补全（bash\|zsh\|fish）。 |
| `enums` | `capcut enums <category-flag> [--jianying]` | 否 | 按类别列出枚举 slug（转场、蒙版、特效等）。 |
| `harvest-enums` | `capcut harvest-enums [<project> \| --sync \| --add <kind> <slug> <resource-id>] [--apply] [--catalogue <path>]` | 否 | 把商店资源 ID 学习进用户级素材目录：来源可以是单个草稿、整个草稿库（--sync），或手动添加（--add）。 |
| `doctor` | `capcut doctor` | 否 | 环境预检（Node、whisper、API key、项目目录）。 |
| `diagnose` | `capcut diagnose <project> [--bundle <report.json>]` | 否 | 检查草稿的规范文件、文件间分歧与编辑器写入安全性。 |
| `fixture` | `capcut fixture <project> --out <dir>` | 否 | 构建可分享、已脱敏的兼容性包（仅时间线 JSON），用于版本支持 issue，内含蒙版关键帧证据报告（#44）。 |
| `sync-timelines` | `capcut sync-timelines <project-dir> [--apply]` | 是 | 从只读的 draft_content.json 出发，协调已漂移的时间线镜像文件（template-2.tmp、draft_info.json）（默认输出带 mtime 的计划；--apply 只重写发生漂移的镜像）。 |
| `restore` | `capcut restore <project> [--step <number> \| --list]` | 是 | 从 .bak / 快照历史撤销写入（--step N、--list）。 |
| `serve` | `capcut serve [--queue <path>] [options]` | 否 | 从 stdin/--queue 运行无状态的 JSONL 任务队列。 |
| `decrypt` | `capcut decrypt <project-or-file>` | 否 | 检测剪映 6.0+ 加密并说明应对方法。 |
| `export` | `capcut export <drafts-dir> --batch [options]` | 是 | 实验性的 UI 自动化渲染队列（macOS）。 |
| `init` | `capcut init <name> [--template <dir>] [--drafts <dir>]` | 是 | 从模板创建一个新的空草稿。 |
| `quickstart` | `capcut quickstart <name> [--video <f>] [--audio <f>] [--srt <f>] [--drafts <dir>]` | 是 | 一条命令生成第一个草稿：创建 + 添加一个素材 + lint + 打印“在 CapCut 中打开”的步骤。 |
| `compile` | `capcut compile <spec.json> [--out <draftdir>] [--data <rows.jsonl\|->] [--check \| --plan]` | 是 | 从声明式 JSON spec 构建草稿（describe 的逆操作）。 |
| `render` | `capcut render <project> [--out <preview.mp4>] [options]` | 否 | 渲染低清 ffmpeg 代理预览（裁剪+变速+音频，--burn-captions）；不是 CapCut 的最终渲染。 |
| `detect-scenes` | `capcut detect-scenes <video> [options]` | 否 | 检测视频中的场景切换切点（ffmpeg scene 滤镜）；输出切点与片段列表，供 compile/cut 使用。 |
| `detect-silence` | `capcut detect-silence <media> [options]` | 否 | 检测媒体文件中的静音区间（ffmpeg silencedetect）；输出静音与保留片段列表，供 compile/cut 使用。 |
