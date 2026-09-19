#!/usr/bin/env python3
"""Stand-in for the capcut binary: echoes what it was called with, as the real CLI would shape it."""

import json
import sys

argv = sys.argv[1:]
if argv == ["--version"]:
    print("0.0.0-fake")
    sys.exit(0)

cmd = argv[0] if argv else ""
rest = argv[1:]

if cmd == "serve":
    for line in sys.stdin:
        if not line.strip():
            continue
        job = json.loads(line)
        ok = job["cmd"] != "fail"
        print(
            json.dumps(
                {
                    "id": job.get("id"),
                    "ok": ok,
                    "cmd": job["cmd"],
                    "args": job.get("args", []),
                    "status": 0 if ok else 2,
                    "stdout": {"echo": job.get("args", [])} if ok else {"error": "boom"},
                    "stderr": "",
                    "attempts": 1,
                    "duration_ms": 1,
                    "deduplicated": False,
                },
                ensure_ascii=False,
            )
        )
    sys.exit(0 if "--fail-fast" not in rest else 1)

if cmd == "fail":
    print(json.dumps({"error": "boom", "args": rest}))
    sys.exit(2)

if cmd == "doctor":
    print(json.dumps({"ok": False, "checks": [{"name": "node", "status": "missing"}], "args": rest}))
    sys.exit(1)

if "-H" in rest:
    print("Project:    fake")
    print("Duration:   1.00s")
    sys.exit(0)

print(json.dumps({"ok": True, "cmd": cmd, "args": rest}, ensure_ascii=False))
