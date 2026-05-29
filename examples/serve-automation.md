# Wire capcut-cli into n8n / Make / Coze — no HTTP server

`capcut serve` is a **stateless JSONL queue runner**. It reads one job per line from
stdin (or a `--queue` file), dispatches each to the CLI, and writes one JSON result
per line to stdout. No daemon, no port, no state between runs. That makes it a clean
fit for any automation tool that can run a shell command or pipe bytes.

## The job format

One JSON object per line. `cmd` is required; `project` and `args` are optional:

```jsonl
{"cmd":"info","project":"/work/draft_content.json"}
{"cmd":"add-text","project":"/work/draft_content.json","args":["8s","2s","Subscribe","--font-size","16"]}
{"cmd":"import-srt","project":"/work/draft_content.json","args":["/work/captions.srt"]}
{"cmd":"lint","project":"/work/draft_content.json"}
```

Each result line is `{ok, cmd, args, status, stdout, stderr}`. `ok` is `true` when the
command exited `0`; `stdout` is the parsed JSON the command would have printed. Because
`lint` exits `2` on errors, a lint job comes back `{"ok":false,"status":2,...}` — handle
that in your flow to gate a render.

## Local / cron

```bash
cat jobs.jsonl | capcut serve > results.jsonl
# or read from a file the upstream step wrote:
capcut serve --queue jobs.jsonl > results.jsonl
```

Add `--fail-fast` to stop at the first failing job.

## n8n (self-hosted — Execute Command node)

n8n's **Execute Command** node runs on the n8n host, so `capcut` just needs to be on its
`PATH` (`npm install -g capcut-cli`, or use the Docker image below). Build the JSONL in a
Function node, then pipe it in:

```
Command:  capcut serve
Input:    {{ $json.jobs }}        // a JSONL string from the previous node
```

A Function node to turn structured items into JSONL:

```js
// one n8n item per job → a single JSONL string
return [{ json: { jobs: items.map(i => JSON.stringify(i.json)).join("\n") } }];
```

Parse `results.jsonl` back out in the next Function node by splitting on newlines and
`JSON.parse`-ing each line.

## Make / Coze (cloud) — webhook → queue file → serve

Cloud builders can't run a binary directly. The stateless model still fits: have the
cloud scenario **write a queue file** (or POST JSONL to a tiny endpoint on a host you
control), then run `capcut serve --queue` on that host from cron or a file-watch. The
boundary is the JSONL file — the cloud side never needs to know about the CLI internals.

```bash
# on your host: drain whatever the cloud scenario dropped, every minute
* * * * * test -s /srv/capcut/inbox.jsonl && \
  capcut serve --queue /srv/capcut/inbox.jsonl > /srv/capcut/outbox.jsonl && \
  : > /srv/capcut/inbox.jsonl
```

## Docker (no global install)

The published image runs `serve` over a stdin pipe — drafts are mounted at `/work`:

```bash
cat jobs.jsonl | docker run --rm -i -v "$PWD:/work" capcut-cli serve > results.jsonl
```

Build the image from this repo with `docker build -t capcut-cli .`.

> **Why no HTTP mode?** A long-lived server adds a port to secure, state to reset, and a
> process to babysit. A queue runner that starts, drains, and exits composes with the
> retry/idempotency model your automation tool already has. If you genuinely need HTTP,
> put `serve` behind a one-line handler that pipes the request body to it.
