"""Offline lifecycle check with real tmux and PTYs; no login or inference."""

import fcntl
import json
import os
from pathlib import Path
import pty
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

HUD = Path(__file__).resolve().parents[2] / "src/hud"
sys.path.insert(0, str(HUD))
import launcher  # noqa: E402


def eventually(predicate):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("lifecycle condition timed out")


def alive(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
    return result.returncode == 0 and not result.stdout.strip().startswith("Z")


def check():
    tmux = shutil.which("tmux")
    assert tmux, "Install tmux to run this check"
    root = HUD
    # agy print mode answers once and exits, so it never gets a footer.
    assert launcher.prints(["-p", "hi"]) and launcher.prints(["--print=x"]) and launcher.prints(["--model", "m", "--prompt", "x"])
    assert not launcher.prints(["--prompt-interactive", "x"]) and not launcher.prints(["hi -p"]) and not launcher.prints([])
    with tempfile.TemporaryDirectory(prefix="tcodex-test-") as directory:
        fake = Path(directory) / "teamagy"
        fake.write_text(f"#!{sys.executable}\nimport json, sys\nprint(json.dumps(sys.argv[1:]))\n")
        fake.chmod(0o755)
        env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]}
        for arguments in (["-p", "hi"], ["--model", "m"]):  # print mode, or no terminal: run directly
            result = subprocess.run([sys.executable, str(HUD / "launcher.py"), "--agy", *arguments], env=env,
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
            assert json.loads(result.stdout) == ["run", "--", *arguments], (arguments, result.stdout, result.stderr)
    print("PASS: agy print mode and no terminal skip the footer")
    for mode in ("close", "detach", "keep-alive", "two-clients", "attach-failure", "keep-attach-failure",
                 "stale-server-cwd", "agy"):
        with tempfile.TemporaryDirectory(prefix="tcodex-test-") as directory:
            path = Path(directory)
            socket = path.name
            base = [tmux, "-L", socket, "-f", "/dev/null"]
            wrapper = path / "tmux"
            wrapper.write_text(f"#!{sys.executable}\n" +
                               "import os, sys\na = sys.argv[1:]\n" +
                               f"a[a.index('-L') + 1] = {socket!r}\n" +
                               # respawn-pane closes and reopens a PTY at once; macOS then
                               # intermittently fails with "fork failed: Device not configured".
                               "if 'respawn-pane' in a: sys.exit('respawn-pane races macOS PTY allocation')\n" +
                               ("if 'attach-session' in a: sys.exit(1)\n" if mode.endswith("attach-failure") else "") +
                               f"os.execv({tmux!r}, [{tmux!r}] + a)\n")
            wrapper.chmod(0o755)
            proxy = path / ("teamagy" if mode == "agy" else "teamcodex")
            record = path / "processes.json"
            proxy.write_text(f"#!{sys.executable}\n" +
                             "import json, os, subprocess, sys, time\nfrom pathlib import Path\n" +
                             "child = subprocess.Popen(['sleep', '300'])\n" +
                             f"Path({str(record)!r}).write_text(json.dumps([os.getpid(), child.pid, sys.argv[1:], os.getcwd()]))\n" +
                             "time.sleep(300)\n")
            proxy.chmod(0o755)
            arguments = (["--keep-alive"] if mode.startswith("keep") else []) + ["resume", "test-id"]
            if mode == "agy":
                arguments = ["--agy", "--model", "m"]
            runner = ("import launcher, shutil\noriginal = shutil.which\n" +
                      f"launcher.shutil.which = lambda name: {str(wrapper)!r} if name == 'tmux' else " +
                      f"{str(proxy)!r} if name == {proxy.name!r} else original(name)\n" +
                      "launcher.read_status = lambda path: {}\nlauncher.render = lambda data, agy=False: ['footer']\n" +
                      f"raise SystemExit(launcher.launch({arguments!r}))\n")
            masters, clients, pids = [], [], []

            def connect(command):
                master, slave = pty.openpty()
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
                client = subprocess.Popen(command, cwd=root, stdin=slave, stdout=slave, stderr=slave,
                                          env={**os.environ, "TERM": "xterm-256color"}, start_new_session=True)
                os.close(slave)
                masters.append(master)
                clients.append(client)
                return master

            def sessions():
                result = subprocess.run(base + ["list-sessions", "-F", "#{session_name} #{session_attached}"],
                                        capture_output=True, text=True)
                return result.stdout.strip()

            try:
                if mode == "stale-server-cwd":
                    # tmux 3.7 keeps the server's start directory; once it is gone, new
                    # panes ignore `-c` and Codex would exit with ENOENT. Seed the server
                    # from a directory that is deleted before teamcodex launches.
                    stale = tempfile.mkdtemp(prefix="tcodex-stale-")
                    subprocess.run(base + ["new-session", "-d", "-s", "seed", "sleep 300"], check=True, cwd=stale)
                    os.rmdir(stale)
                master = connect([sys.executable, "-c", runner])
                if mode.endswith("attach-failure"):
                    eventually(lambda: clients[0].poll() is not None)
                    eventually(lambda: not sessions())
                    assert clients[0].returncode != 0
                else:
                    if mode == "stale-server-cwd":
                        eventually(record.exists)
                        subprocess.run(base + ["kill-session", "-t", "seed"], check=True)
                    eventually(lambda: sessions().endswith(" 1") and record.exists())
                    parent, child, forwarded, launched_in = json.loads(record.read_text())
                    pids = [parent, child]
                    expected = ["--model", "m"] if mode == "agy" else ["resume", "test-id"]
                    assert forwarded == ["run", "--", *expected], forwarded
                    assert launched_in == str(root), launched_in
                    session = sessions().split()[0]
                    panes = subprocess.check_output(base + ["list-panes", "-t", session, "-F", "#{pane_pid}"], text=True)
                    pids += [int(pid) for pid in panes.splitlines()]
                    if mode == "two-clients":
                        second = connect(base + ["attach-session", "-t", session])
                        eventually(lambda: sessions().endswith(" 2"))
                    if mode == "detach":
                        subprocess.run(base + ["detach-client", "-s", session], check=True)
                    else:
                        os.close(master)
                        masters.remove(master)
                    eventually(lambda: clients[0].poll() is not None)
                    if mode in ("keep-alive", "two-clients"):
                        expected = " 0" if mode == "keep-alive" else " 1"
                        eventually(lambda: sessions().endswith(expected))
                        assert all(alive(pid) for pid in pids)
                        if mode == "two-clients":
                            os.close(second)
                            masters.remove(second)
                        else:
                            # Normal Codex exit still closes its session in keep-alive mode.
                            os.kill(parent, signal.SIGTERM)
                    eventually(lambda: not sessions())
                    eventually(lambda: not any(alive(pid) for pid in pids))
                print(f"PASS: {mode}")
            finally:
                subprocess.run(base + ["kill-server"], capture_output=True)
                for master in masters:
                    os.close(master)
                for client in clients:
                    if client.poll() is None:
                        client.terminate()
                    client.wait(timeout=5)
                if record.exists():
                    for pid in json.loads(record.read_text())[:2]:
                        if alive(pid):
                            os.kill(pid, signal.SIGTERM)


if __name__ == "__main__":
    check()
