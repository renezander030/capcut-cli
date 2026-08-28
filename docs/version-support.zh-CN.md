# 版本支持矩阵

> English version: [version-support.md](./version-support.md)

CapCut 和剪映在不断演进一套没有文档记录的本地磁盘 schema。本矩阵刻意把有 fixture 实证支持的内容，与仅是预期兼容的内容分开列出。

运行 `capcut version <project>` 查看 schema 标志；运行 `capcut diagnose <project> -H` 查看规范文件选择、时间线分歧与编辑器进程安全性。`capcut diagnose <project> --bundle support.json` 会生成一份适合附到 issue 里的脱敏报告。

## 证据等级

- **fixture-tested** —— 由已提交的 fixture、经自动化测试验证过。
- **synthetic-tested** —— 用一个最小化的版本/系统组合验证了某个已观察到的存储或 schema 行为；仍需要一份真实的、由应用创建的包。
- **reported** —— 行为来自可复现的用户报告，但尚未有脱敏后的真实 fixture 佐证。
- **expected-compatible** —— 根据 schema 检查推测兼容；不代表已在桌面应用中实测。
- **known-broken** —— CLI 能检测到该不兼容情况，并给出应对方案或拒绝执行。

## CapCut（`platform.app_source == "cc"`）

| 版本 | 证据 | 状态 | 说明 |
|---|---|---|---|
| 6.2.8 | fixture-tested | 已支持 | 权威 fixture 位于 `test/draft_content.json`；完整命令集均可用。 |
| 6.5–8.0 | expected-compatible | 未验证 | 尚无已提交的、由应用创建的 fixture。枚举/schema 变化看起来是增量式的。 |
| 7.9 / 8.9（国际版，macOS） | reported | 仅实测一个字段 | 在一台机器上扫描 38 份由 App 创建的草稿后确认：`materials.texts[].content` → `styles[].range` 存的是 UTF-16 码元，而非 UTF-16LE 字节 —— 211 个文本素材全部是码元，没有一个是字节（[#85](https://github.com/renezander030/capcut-cli/issues/85)）。这解决了一个真实的写入 bug，已在 0.19.1 修复。这只是对一个字段的实测，不是完整套件的测试 —— 这两个版本目前都还没有已提交的、脱敏后的应用创建文件夹，因此暂不标注为 fixture-tested。 |
| 8.7 Windows | reported + synthetic-tested | 适配已发布，真实验证待定 | Issue #35 报告称，对 `draft_content.json` 的修改可能被应用忽略，转而采用 `template-2.tmp` / `draft_meta_info.json`。v0.11 起可发现嵌套/字符串形式的 JSON 时间线信封，会选择更新的存储，同步每一个可读的目标，并提供 `diagnose --bundle` 与 `fixture --out`（一条命令生成脱敏包）。v0.13 新增 `sync-timelines`，用于协调已经漂移的镜像（默认只出计划，`--apply` 才写入）；`diagnose` 会把它列为应对方案。在标记为 fixture-tested 之前，仍需要报告者提供一份真实文件夹。 |
| 9.x | expected-compatible | 未验证 | `common_masks` 可能与旧版蒙版字段共存。请使用 `version`、`diagnose` 和 `migrate`；不要把这一行视为桌面应用层面的验证。 |
| 10.x（Mac 与 Windows） | reported | 写入被护栏拦截 | 据报告，新版本会把工具写入的草稿判定为已损坏（「内容已损坏」；pyJianYingDraft#177、#194 对应剪映 10.8 上的同类问题；Mac 主文件据报告为 `draft_info.json`，Jianying-CapCut2XML#4）。目前没有 fixture；修改类命令在没有 `--force-write` 时会拒绝执行。欢迎提供 fixture —— 见下方「写入时版本护栏」一节。 |

不存在笼统的「6.x–9.x 已测试」这种说法。只有已提交 fixture 的版本才能标注这个标签。`capcut version` 的注册表与本表一致：6.2.8 报告为 `fixture-tested`，8.7.0 为 `synthetic-tested`，而 6.5.0/7.0.0/8.0.0/9.0.0 报告为 `untested` + `expected-compatible`，而非一个「已测试」的结论。

## 剪映（`platform.app_source == "lv"`）

| 版本 | 证据 | 状态 | 说明 |
|---|---|---|---|
| 5.9.x | community-reported | expected-compatible | 最后一个被广泛使用的明文版本；目前没有已提交的、由应用创建的脱敏 fixture。 |
| 6.0+ | reported | known-broken for encrypted files | `capcut decrypt` 能检测到加密并说明应对方案；它本身不解密文件。明文/导出变体依然可以正常查看，但写入护栏会拒绝对明文变体的任何修改性写入，除非加 `--force-write` —— 因为 6.0+ 的应用已进入加密草稿时代，写回的明文可能被忽略或提示已损坏。 |

## v0.11 存储与写入安全

`capcut-cli` 会检查项目目录中的以下文件：

1. `draft_content.json`
2. `draft_info.json`
3. `draft_meta_info.json`
4. `template-2.tmp`

它能识别位于根层级、或嵌套在浅层 object/字符串 JSON 信封中的时间线。对于 CapCut 8.7+，可读的 `template-2.tmp` / `draft_meta_info.json` 时间线优先；更早的版本仍保留 content/info 优先的顺序。每一个可读的时间线目标都会在一次原子保存中被同步。

写入使用同目录下的临时文件、fsync 与重命名。提交前，如果目标自加载以来发生了变化，CLI 会拒绝写入。检测到剪映 / CapCut 桌面端编辑器正在运行时，受管理的草稿路径同样会受到保护。`--force-write` 是显式的覆盖开关，不是默认的恢复路径。

## 写入时版本护栏

每一个修改性命令（`saveDraft` 路径，以及会直接写入镜像的 `sync-timelines --apply`）在写入前都会评估草稿的版本标记。有效版本取 `platform.app_version`、`last_modified_platform.app_version`，与最新的可读同级文件三者中的数值最大值，因此即便是由更新的应用构建写出的镜像，也一样会触发护栏。按顺序匹配第一条命中的规则；标记缺失或无法解析时，对应规则永远不会触发：

| 条件 | 动作 |
|---|---|
| 剪映有效版本 >= 6.0（加密草稿时代） | 拒绝 |
| CapCut 有效版本超出已知范围（> 9.x） | 拒绝 |
| 顶层 `version` schema 整数 > 360000 | 拒绝 |
| 携带版本标记的未识别 `app_source`——或完全没有 `app_source`，但通过 `last_modified_platform` 或某个同级文件得到了有效应用版本 | 警告后写入 |
| 顶层 `version` schema 整数早于 360000 | 警告后写入 |
| 其余所有情况——包括没有任何标记的、由 CLI 创建的草稿 | 正常写入 |

360000 这个 schema 整数边界，是在一份脱敏参考语料库中，所有已知真实 CapCut 8.x fixture 里观察到的共同常量。证据等级：**reported**——这些 fixture 并未提交在本仓库中，因此更大的数值只说明「这是一个本仓库尚无证据的世代」，而不是一个已验证的不兼容结论。

`--force-write` 可以覆盖拒绝，但 WARNING 仍会打印到 stderr，所以强制写入绝不会是无声的。`--dry-run` 永远不会被拦截（因为它本来就不写入任何内容），并且同样会打印 WARNING。拒绝信息的结尾都会附上收集 fixture 的行动号召：如果项目在你的应用里能正常打开，`capcut fixture <project> --out <dir>` 可以构建一个脱敏包，从而把这个版本推进到 fixture-tested。`restore` 与所有只读命令永远不会被拦截——恢复备份是逃生通道，不是风险点。护栏不会凭空发明版本标记：`capcut create` 的输出始终不带标记，永远不会被打上 `platform` 或 `version` 字段。

## 应用自动升级绊线

上面的护栏回答的是「这个版本是否超出了已有证据」。还有一种更早发生的失败模式：应用自我更新，重写了它打开的草稿，而在写入行为开始变得不一样之前，流水线里的任何环节都不会提示这一点（GuanYixuan/pyJianYingDraft#115、#178）。针对这一点，CLI 会为每个草稿存储记住它上一次看到的版本证据——与护栏检测的是同一组有效元组（有效应用版本、app source、顶层 schema 整数）——并在每次修改性写入时进行比较：

- 状态保存在 CLI 自己的配置目录里：`~/.config/capcut-cli/app-versions.json`（遵循 `XDG_CONFIG_HOME`，`CAPCUT_CLI_APP_VERSIONS` 可覆盖路径）。不会往草稿里写入任何内容；写出的草稿始终保持字节级不变。
- 第一次看到某个存储时会静默记录。之后一旦证据出现差异，修改性命令会在 stderr 打印一条 `WARNING`，指出旧值 -> 新值（例如 `app version 8.7.0 -> 10.5.0`），其 JSON 结果也会带上 `app_version_drift` 字段（`store_dir`、带 `seen_at` 的 `from`、`to`、`changes`），随后更新记录。
- **只警告——绊线本身从不拒绝写入。** 拒绝逻辑始终由写入时版本护栏负责：在受支持范围内的漂移（比如 6.2.8 -> 8.7.0）只警告并写入；超出范围的漂移会警告，*并且*护栏会像之前一样拒绝写入。
- `capcut version <project>` 会只读地报告 `app_version_drift`（它从不更新记录，所以这个漂移会一直可见，直到下一次修改性写入确认它为止）。`capcut doctor` 会重新检查每一个被跟踪的存储，并把漂移作为 warn 级别的 `app-upgrade` 检查项报告出来。
- 状态文件损坏时会被当作空文件读取并打印 `WARNING`，下一次修改性写入会重建它——这与 `user-enums.json` 目录所遵循的健壮性规则相同。没有任何标记的、由 CLI 创建的草稿永远不会被跟踪。

## 固定应用版本

绊线能告诉你发生了一次升级，但无法阻止升级发生。无论 CapCut 还是剪映，都没有文档说明过一种受支持的、永久性的退出应用更新的方法，所以本节刻意只给出不依赖具体应用构建版本的保守措施。剪映那条注册表备注（「自动更新会破坏固定」）说的正是这个问题：一台固定在 5.9.x 的安装一旦自我更新，就会进入加密草稿时代，明文工具链也就不再能正常往返读写。

在两个系统上都成立的做法：

- **保留你验证过的那个版本的安装包。** 一旦厂商推出新版本，官方渠道就很难再获取旧安装包了；把你测试过的确切构建版本归档，是唯一能挺过一切变化的固定方式。
- **在更新后第一次启动应用之前，先备份草稿存储。** 更新后的应用在打开草稿时可能会就地迁移它；一旦迁移完成，旧版工具可能就无法再正常往返读写这个文件了。趁应用关闭时，把整个 `com.lveditor.draft` 文件夹复制一份——就是 `doctor` 检查的那些文件夹。
- **让绊线和护栏尽早看到写入。** 在任何疑似更新之后运行 `capcut version <project>` / `capcut doctor`，并把流水线写入时出现的漂移 WARNING 当作停下来、先验证再批量操作的信号。
- **让批量流水线操作存储的副本**，而不是正在使用的那一份，这样即便应用在运行过程中升级了，也不会有东西可供它在你眼皮底下迁移。

Windows：

- 草稿存储位于 `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft`（剪映：`%LOCALAPPDATA%\JianyingPro\...`）；流水线依赖的是这个文件夹本身，而不是应用安装目录——这也是在放任一次更新触碰它之前，应该快照的对象。
- 应用会自行管理更新，我们不知道有任何文档记录过的、能永久禁用更新的设置。社区讨论中有人建议对更新程序设置防火墙规则——这种做法不受官方支持、与具体构建版本强相关，还可能导致登录或特效下载失败，因此本文档不推荐任何具体规则。

macOS：

- 草稿存储位于 `~/Movies/CapCut/User Data/Projects/com.lveditor.draft`（剪映：`~/Movies/JianyingPro/...`）。
- 如果应用是从 **Mac App Store** 安装的，更新会遵循 App Store 自身的自动更新设置（App Store → 设置 → 自动更新）。关闭它可以防止无人值守的升级——之后只有你主动选择安装时才会更新。这是标准的 App Store 行为，不是 CapCut 的特有功能。
- 如果应用是直接从厂商下载的，它会像 Windows 版一样自行管理更新，同样适用上面的保守建议：归档安装包、备份存储、写入前用 `capcut version` 验证。

## Schema 特性检测

`capcut version` 会报告：

| 标志 | 含义 |
|---|---|
| `mask_field` | 旧版 `mask`、新版 `common_masks`，两者都有，或都没有。 |
| `has_text_ranges` | 至少有一个文本素材包含多样式区间。 |
| `has_audio_fades` | 存在 `materials.audio_fades[]`。 |
| `new_version_field` | 顶层 `new_version` 字段（如果存在）。 |
| `last_modified_platform` | 跨平台修改标记（如果存在）。 |

## 报告一个损坏的版本

1. 关闭 CapCut/剪映。
2. 运行 `capcut diagnose <project> --bundle support.json`。
3. 运行 `capcut version <project>`。
4. 提交 issue，附上应用版本、操作系统、具体命令、JSON 报错信息，以及 `support.json`。
5. 如果可以，附上一份脱敏后的项目文件夹。运行 `capcut fixture <project> --out <dir>` 可以自动生成一份：它只拷贝时间线 JSON（不含媒体文件），会脱敏用户主目录路径和邮箱地址，并附带一份 README 和一份 diagnose 报告。分享前请先自行检查这些文件。

只有在脱敏后的 fixture 与回归测试都被提交之后，一个版本才会被标注为 **fixture-tested**。
