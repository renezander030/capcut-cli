"""capcut — a thin Python client for capcut-cli, the CapCut / JianYing (剪映) draft CLI.

Every call spawns the ``capcut`` binary once, without a shell, and returns the one
JSON document it prints. Nothing runs in the background; the draft on disk is the
only state.

    import capcut
    d = capcut.run("quickstart", "旁白短视频", video="clip.mp4", ratio="9:16")
    capcut.run("add-text", d["draft_path"], "0s", "3s", "你好，世界", font_size=16)
    print(capcut.run("lint", d["draft_path"])["summary"])

Keyword arguments become flags: ``font_size=16`` → ``--font-size 16``, ``karaoke=True``
→ ``--karaoke``, a list repeats the flag, ``None``/``False`` are dropped. Positional
arguments are passed through as they are, each as one argv token, so text with spaces
or quotes never needs escaping.

The binary is found through ``CAPCUT_CLI`` (a command line, e.g.
``"node /path/to/capcut-cli/dist/index.js"``) or ``capcut`` on PATH.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Any, Iterable, List, Mapping, Optional, Sequence, Union

__version__ = "0.1.0"
__all__ = [
    "CapcutError",
    "CliNotFound",
    "CommandError",
    "Job",
    "Result",
    "cli_command",
    "describe",
    "doctor",
    "flag_args",
    "run",
    "run_raw",
    "serve",
    "version",
]

INSTALL_HINT = (
    "capcut-cli not found.\n"
    "  安装：npm install -g capcut-cli （需要 Node ≥ 18，之后运行 capcut doctor 检查环境）\n"
    "  Install: npm install -g capcut-cli (needs Node >= 18; then run `capcut doctor`)\n"
    '  Or point CAPCUT_CLI at the binary, e.g. CAPCUT_CLI="node /path/to/capcut-cli/dist/index.js".'
)


class CapcutError(Exception):
    """Base class for everything this module raises."""


class CliNotFound(CapcutError):
    """The ``capcut`` binary is not on PATH and ``CAPCUT_CLI`` is not set."""


@dataclass
class Result:
    """One CLI invocation: exit status, raw streams, and the parsed JSON (``data``)."""

    cmd: str
    args: List[str]
    status: int
    stdout: str
    stderr: str
    data: Any = None

    @property
    def ok(self) -> bool:
        return self.status == 0

    @property
    def error(self) -> Optional[str]:
        """The CLI's own error message when it printed ``{"error": ...}``."""
        if isinstance(self.data, dict) and isinstance(self.data.get("error"), str):
            return self.data["error"]
        return None


class CommandError(CapcutError):
    """The command exited non-zero. ``result`` carries status, streams and parsed JSON."""

    def __init__(self, result: Result):
        self.result = result
        message = result.error or result.stderr.strip() or result.stdout.strip() or f"exit {result.status}"
        super().__init__(f"capcut {result.cmd} failed (exit {result.status}): {message}")

    @property
    def status(self) -> int:
        return self.result.status

    @property
    def data(self) -> Any:
        return self.result.data

    @property
    def stdout(self) -> str:
        return self.result.stdout

    @property
    def stderr(self) -> str:
        return self.result.stderr


def cli_command() -> List[str]:
    """The argv prefix that runs capcut-cli: ``CAPCUT_CLI`` split like a shell would, else ``capcut`` on PATH."""
    configured = os.environ.get("CAPCUT_CLI", "").strip()
    if configured:
        return shlex.split(configured, posix=(os.name != "nt"))
    found = shutil.which("capcut")
    if found:
        return [found]
    raise CliNotFound(INSTALL_HINT)


def flag_args(flags: Mapping[str, Any]) -> List[str]:
    """``{"font_size": 16, "karaoke": True, "tag": ["a", "b"]}`` → ``["--font-size", "16", "--karaoke", "--tag", "a", "--tag", "b"]``."""
    out: List[str] = []
    for key, value in flags.items():
        flag = "--" + key.replace("_", "-")
        if value is None or value is False:
            continue
        if value is True:
            out.append(flag)
        elif isinstance(value, (list, tuple)):
            for item in value:
                out.extend([flag, str(item)])
        else:
            out.extend([flag, str(value)])
    return out


def _spawn(argv: List[str], *, input: Optional[str], timeout: Optional[float], cwd: Optional[str]) -> "subprocess.CompletedProcess[str]":
    """Run argv with stdout/stderr captured to temporary files, not pipes.

    Large documents (``describe`` is >64 KiB) can be cut at the pipe buffer when the CLI
    exits; the repository's own test helper captures to files for the same reason.
    """
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as out, tempfile.TemporaryFile(
        mode="w+", encoding="utf-8", errors="replace"
    ) as err:
        try:
            proc = subprocess.run(
                argv,
                input=input,
                stdout=out,
                stderr=err,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                cwd=cwd,
            )
        except FileNotFoundError as exc:
            raise CliNotFound(INSTALL_HINT) from exc
        out.seek(0)
        err.seek(0)
        return subprocess.CompletedProcess(argv, proc.returncode, out.read(), err.read())


def _parse(stdout: str) -> Any:
    text = stdout.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        pass
    # Commands print one JSON document; if anything else reached stdout, the document is the last line.
    last = text.splitlines()[-1].strip()
    try:
        return json.loads(last)
    except ValueError:
        return None


def run_raw(
    cmd: str,
    *args: Any,
    human: bool = False,
    timeout: Optional[float] = None,
    cwd: Optional[str] = None,
    input: Optional[str] = None,
    **flags: Any,
) -> Result:
    """Run one command and return the :class:`Result` whatever the exit status.

    ``human=True`` appends ``-H`` and leaves ``data`` as ``None`` (the table is in ``stdout``).
    """
    argv_args = [str(a) for a in args] + flag_args(flags) + (["-H"] if human else [])
    argv = cli_command() + [cmd] + argv_args
    proc = _spawn(argv, input=input, timeout=timeout, cwd=cwd)
    data = None if human else _parse(proc.stdout)
    if data is None and proc.returncode != 0:
        data = _parse(proc.stderr)  # the CLI prints {"error": ...} on stderr
    return Result(cmd=cmd, args=argv_args, status=proc.returncode, stdout=proc.stdout, stderr=proc.stderr, data=data)


def run(cmd: str, *args: Any, **kwargs: Any) -> Any:
    """Run one command; return its parsed JSON (or the ``-H`` text). Raise :class:`CommandError` on a non-zero exit."""
    result = run_raw(cmd, *args, **kwargs)
    if not result.ok:
        raise CommandError(result)
    return result.data if result.data is not None else result.stdout


def version() -> str:
    """The installed capcut-cli version, e.g. ``"0.25.0"``."""
    result = run_raw("--version")
    if not result.ok:
        raise CommandError(result)
    return result.stdout.strip()


def describe() -> Any:
    """The full command surface as JSON (``capcut describe``): names, usage, options, exit codes."""
    return run("describe")


def doctor(**flags: Any) -> Any:
    """The ``capcut doctor`` report. Returned even when a hard requirement is missing (exit 1); check ``["ok"]``."""
    result = run_raw("doctor", **flags)
    if result.data is None:
        raise CommandError(result)
    return result.data


@dataclass
class Job:
    """One line of the ``capcut serve`` JSONL queue."""

    cmd: str
    project: Optional[str] = None
    args: Sequence[Any] = field(default_factory=list)
    id: Optional[str] = None
    retries: Optional[int] = None
    timeout: Optional[int] = None

    def to_dict(self) -> dict:
        job: dict = {"cmd": self.cmd}
        if self.project is not None:
            job["project"] = self.project
        if self.args:
            job["args"] = [str(a) for a in self.args]
        if self.id is not None:
            job["id"] = self.id
        if self.retries is not None:
            job["retries"] = self.retries
        if self.timeout is not None:
            job["timeout"] = self.timeout
        return job


def serve(
    jobs: Iterable[Union[Job, Mapping[str, Any]]],
    *,
    workers: Optional[int] = None,
    fail_fast: bool = False,
    retries: Optional[int] = None,
    job_timeout_ms: Optional[int] = None,
    backoff_ms: Optional[int] = None,
    max_buffer_mb: Optional[int] = None,
    timeout: Optional[float] = None,
) -> List[dict]:
    """Feed jobs to ``capcut serve`` over stdin and return one result dict per job.

    Each result is ``{id, ok, cmd, args, status, stdout, stderr, attempts, duration_ms, deduplicated}``
    with ``stdout`` already parsed. A failed job is a result with ``ok: false``, not an exception;
    only a queue that produced no results at all raises :class:`CommandError`.
    """
    lines = [json.dumps(j.to_dict() if isinstance(j, Job) else dict(j), ensure_ascii=False) for j in jobs]
    flags = flag_args(
        {
            "workers": workers,
            "fail_fast": fail_fast,
            "retries": retries,
            "timeout": job_timeout_ms,
            "backoff_ms": backoff_ms,
            "max_buffer_mb": max_buffer_mb,
        }
    )
    argv = cli_command() + ["serve"] + flags
    proc = _spawn(argv, input="\n".join(lines) + "\n", timeout=timeout, cwd=None)
    results: List[dict] = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            results.append(json.loads(line))
        except ValueError:
            continue
    if not results and proc.returncode != 0:
        raise CommandError(Result(cmd="serve", args=flags, status=proc.returncode, stdout=proc.stdout, stderr=proc.stderr))
    return results
