#!/usr/bin/env python3
"""Run a preserved Claude status line, then the TeamClaude status line."""

import json
import subprocess
import sys
import time
from pathlib import Path


base = Path(__file__).resolve().parent
config_path = base / "teamclaude-statusline-config.json"
statusline_path = base / "statusline-teamclaude.py"
payload = sys.stdin.buffer.read()
outputs = []

try:
    with config_path.open() as f:
        config = json.load(f)
except (OSError, ValueError):
    config = {}
if not isinstance(config, dict):
    config = {}
previous = config.get("previousStatusLine")

command = previous.get("command") if isinstance(previous, dict) else None
if command and command not in (str(Path(__file__).resolve()), str(statusline_path)):
    result = subprocess.run(
        command,
        shell=True,
        executable="/bin/sh",
        input=payload,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if result.stdout.strip():
        outputs.append(result.stdout.rstrip(b"\r\n"))

result = subprocess.run(
    [sys.executable, str(statusline_path)],
    input=payload,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
)
if result.stdout.strip():
    outputs.append(result.stdout.rstrip(b"\r\n"))

if outputs:
    sys.stdout.buffer.write(b"\n".join(outputs) + b"\n")

# Self-update check: at most once a day, spawned fully detached AFTER the
# status line is printed so display latency is never affected. The stamp is
# touched before spawning so a failed run still waits a day before retrying.
UPDATE_INTERVAL_SEC = 86400
update_script = base / "statusline-autoupdate.sh"
update_stamp = base / "teamclaude-statusline-update-stamp"
if config.get("autoUpdate", False) and update_script.exists():
    try:
        update_due = time.time() - update_stamp.stat().st_mtime >= UPDATE_INTERVAL_SEC
    except OSError:
        update_due = True
    if update_due:
        try:
            update_stamp.touch()
            subprocess.Popen(
                ["/bin/bash", str(update_script), str(base)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError:
            pass
