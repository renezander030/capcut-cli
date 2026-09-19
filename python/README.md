# capcut（Python 客户端） · capcut (Python client)

中文 | [English](#english)

用 Python 创建和编辑 CapCut / 剪映草稿。这是 [capcut-cli](https://github.com/renezander030/capcut-cli) 的一层薄封装：每次调用启动一次 `capcut` 命令，不经过 shell，返回它打印的那一份 JSON。没有服务、没有守护进程，磁盘上的草稿就是全部状态。打开剪映时，每一轨都还是可编辑的。

## 安装

```bash
npm install -g capcut-cli   # 命令行本体，需要 Node ≥ 18
pip install capcut          # 本包，纯 Python，无依赖
capcut doctor               # 检查环境
```

## 五行起步

```python
import capcut

d = capcut.run("quickstart", "旁白短视频", video="clip.mp4", ratio="9:16")
capcut.run("add-text", d["draft_path"], "0s", "3s", "你好，世界", font_size=16)
print(capcut.run("lint", d["draft_path"])["summary"])
```

- **关键字参数就是命令行选项**：`font_size=16` → `--font-size 16`，`karaoke=True` → `--karaoke`，列表会重复该选项，`None` / `False` 直接省略。
- **位置参数原样传递**，每个参数就是一个 argv，中文、空格、引号都不需要转义。
- 全部命令、参数和选项见[命令参考（中文）](https://github.com/renezander030/capcut-cli/blob/master/docs/command-reference.zh-CN.md)，或者在 Python 里 `capcut.describe()`。

## 出错时

命令非零退出会抛出 `capcut.CommandError`，带 `status`、`data`（CLI 打印的 JSON，通常含 `error`）、`stdout`、`stderr`：

```python
try:
    capcut.run("lint", path)
except capcut.CommandError as e:
    print(e.status, e.data)          # lint 有错误时退出码为 2
```

不想抛异常就用 `capcut.run_raw(...)`，它返回 `Result`（`ok`、`status`、`data`、`error`）。找不到 `capcut` 命令时抛 `capcut.CliNotFound`，提示里有安装命令；也可以用环境变量 `CAPCUT_CLI` 指定，例如 `CAPCUT_CLI="node /path/to/capcut-cli/dist/index.js"`。

## 批量：`serve`

`capcut serve` 是一个无状态的 JSONL 任务队列。从 Python 喂任务进去，拿回每个任务一条结果：

```python
results = capcut.serve([
    capcut.Job("add-text", project=path, args=["8s", "2s", "关注我"], id="title"),
    capcut.Job("lint", project=path),
], workers=2)
for r in results:
    print(r["id"], r["ok"], r["status"], r["stdout"])
```

失败的任务是一条 `ok: false` 的结果，不是异常。

## 剪映 6.0+ 用户

新建的草稿是明文，据报告剪映 11.4（macOS）能打开并就地升级，其他版本未验证；已有的加密草稿本 CLI 不读取。`capcut.doctor()` 会报告环境，`capcut.run("decrypt", path)` 会报告某个草稿的加密状态；来龙去脉见 [jianying-encryption.zh-CN.md](https://github.com/renezander030/capcut-cli/blob/master/docs/jianying-encryption.zh-CN.md)。

---

## English

Create and edit CapCut / JianYing drafts from Python. A thin layer over [capcut-cli](https://github.com/renezander030/capcut-cli): each call spawns the `capcut` binary once, without a shell, and returns the one JSON document it prints. No server, no daemon; the draft on disk is the only state, and every track stays editable in the app.

### Install

```bash
npm install -g capcut-cli   # the CLI itself, Node >= 18
pip install capcut          # this package, pure Python, no dependencies
capcut doctor               # environment check
```

### Five lines

```python
import capcut

d = capcut.run("quickstart", "Narrated short", video="clip.mp4", ratio="9:16")
capcut.run("add-text", d["draft_path"], "0s", "3s", "Hello, world", font_size=16)
print(capcut.run("lint", d["draft_path"])["summary"])
```

- **Keyword arguments are flags**: `font_size=16` → `--font-size 16`, `karaoke=True` → `--karaoke`, a list repeats the flag, `None` / `False` are dropped.
- **Positional arguments pass through as they are**, one argv token each: text with spaces or quotes never needs escaping.
- Every command, argument and option: [command reference](https://github.com/renezander030/capcut-cli/blob/master/docs/command-reference.md), or `capcut.describe()` from Python.

### Errors

A non-zero exit raises `capcut.CommandError` with `status`, `data` (the CLI's JSON, usually with `error`), `stdout`, `stderr`:

```python
try:
    capcut.run("lint", path)
except capcut.CommandError as e:
    print(e.status, e.data)          # lint exits 2 on errors
```

`capcut.run_raw(...)` never raises; it returns a `Result` (`ok`, `status`, `data`, `error`). A missing binary raises `capcut.CliNotFound` with the install line; `CAPCUT_CLI` can point at one explicitly, e.g. `CAPCUT_CLI="node /path/to/capcut-cli/dist/index.js"`.

### Batch: `serve`

`capcut serve` is a stateless JSONL job queue. Feed it jobs from Python and get one result per job:

```python
results = capcut.serve([
    capcut.Job("add-text", project=path, args=["8s", "2s", "Subscribe"], id="title"),
    capcut.Job("lint", project=path),
], workers=2)
for r in results:
    print(r["id"], r["ok"], r["status"], r["stdout"])
```

A failed job is a result with `ok: false`, not an exception.

### Development

```bash
cd python && python -m unittest discover -s tests -v
python -m build
```

MIT, same as capcut-cli.
