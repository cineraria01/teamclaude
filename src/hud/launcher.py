#!/usr/bin/env python3
"""Launch Codex (teamcodex) or agy (teamagy --agy) with a read-only account footer in an isolated tmux session."""

import os
import shlex
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from statusline import read_status, render
from codex_login import login


def prints(arguments):
    """agy print mode (-p/--print/--prompt) answers once and exits; a footer would vanish with it."""
    return any(a.startswith("-") and a.lstrip("-").split("=")[0] in ("p", "print", "prompt") for a in arguments)


def launch(arguments):
    # The teamagy wrapper passes --agy first; teamcodex passes the arguments as they are.
    agy = bool(arguments and arguments[0] == "--agy")
    if agy:
        arguments = arguments[1:]
    command, cli = ("teamagy", "agy") if agy else ("teamcodex", "Codex")
    keep_alive = bool(arguments and arguments[0] == "--keep-alive")
    if keep_alive:
        arguments = arguments[1:]
    if arguments and arguments[0] == "login" and not agy:
        return login(arguments[1:])
    if arguments == ["--help"]:
        print(f"Usage: {command} [{cli} flags]\n"
              f"  {command}                  {cli} + live account footer\n"
              + ("  teamcodex login [--name NAME]  Add an account with browser callback paste\n"
                 "  teamcodex -- resume ID     Continue an existing conversation\n" if not agy else
                 "  teamagy -p PROMPT          Print mode, no footer (also without a terminal)\n"
                 "  teamagy -- SUBCOMMAND      agy subcommand (models, mcp, ...), no footer\n")
              + f"  {command} --keep-alive [{cli} arguments]  Keep running after detach\n"
              "  Closing the terminal or Ctrl-b d stops the session by default.\n"
              f"  tmux -L {command}-hud attach   Reattach\n"
              f"Requires: tmux, Python 3, running {command} proxy")
        return 0
    # `teamcodex -- resume ID`: the `--` only gets Codex subcommands past the teamcodex wrapper.
    if arguments and arguments[0] == "--":
        arguments = arguments[1:]
    tmux, proxy = shutil.which("tmux"), shutil.which(command)
    if not proxy:
        sys.exit(f"Requires {command} on PATH")
    terminal = sys.stdin.isatty() and sys.stdout.isatty()
    if agy and (prints(arguments) or not terminal):
        os.execv(proxy, [proxy, "run", "--", *arguments])
    if not tmux:
        sys.exit("Requires tmux. macOS: brew install tmux")
    if not terminal:
        sys.exit("Open teamcodex in a terminal. For scripts, use teamcodex run -- exec ...")
    try:
        data = read_status(Path.home() / f".config/{command}.json")
    except Exception:
        sys.exit(f"{command} proxy unavailable. Start it with: {command} server")
    size = shutil.get_terminal_size()
    # Codex adds a cache-usage row under the accounts.
    rows = len(render(data, agy=agy)) + (not agy)
    if size.lines < rows + 10 or size.columns < 70:
        sys.exit(f"Enlarge the terminal to at least 70 columns and {rows + 10} rows.")
    session = cli.lower() + "-" + uuid.uuid4().hex[:8]
    base = [tmux, "-L", command + "-hud", "-f", "/dev/null"]
    env = dict(os.environ)
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    statusline = Path(__file__).resolve().with_name("statusline.py")
    cwd = os.getcwd()
    # Every tmux client runs from the home directory so a freshly spawned HUD
    # server never inherits a project directory. tmux 3.7 keeps the server's
    # start directory forever; once that directory is deleted, new panes ignore
    # `-c` and start in the dead directory, and Codex exits with ENOENT.
    home = str(Path.home())
    # A separate socket leaves the user's normal tmux server and config alone.
    def run(*args):
        return subprocess.run([*base, *args], check=True, env=env, cwd=home,
                              capture_output=True, text=True).stdout.strip()

    # Codex starts in its own pane process once the layout is ready. Replacing a
    # placeholder with `respawn-pane -k` closes one PTY and opens another at once,
    # which macOS intermittently rejects with "fork failed: Device not configured"
    # (ENXIO from a /dev/ptmx slot race near a 16-PTY boundary).
    gate = "hud-" + session
    # Exiting the CLI also closes the footer, including in keep-alive mode.
    # The explicit cd keeps the caller's directory even on a HUD server whose
    # own start directory no longer exists (see the note above).
    script = (shlex.join([*base, "wait-for", gate]) + " && cd " + shlex.quote(cwd) + " && "
               + shlex.join([proxy, "run", "--", *arguments]) + "; "
               + shlex.join([*base, "kill-session", "-t", session]))
    created = False
    try:
        codex_home = [] if agy else ["-e", "CODEX_HOME=" + env.get("CODEX_HOME", str(Path.home() / ".codex"))]
        top = run("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session,
                  "-n", cli, "-c", cwd, "-x", str(size.columns), "-y", str(size.lines),
                  *codex_home, "/bin/sh", "-c", script)
        created = True
        run("set-option", "-t", session, "status", "off")
        run("set-option", "-t", session, "mouse", "on")
        run("set-window-option", "-t", session, "pane-border-style", "fg=colour238")
        footer = run("split-window", "-d", "-P", "-F", "#{pane_id}", "-v", "-l", str(rows), "-t", top,
                     sys.executable, str(statusline), "--watch", *(["--agy"] if agy else ["--codex-pane", top]))
        for event in ("client-attached", "client-resized"):
            run("set-hook", "-t", session, event, f"resize-pane -t {footer} -y {rows}")
        if not keep_alive:
            # Setting this before the first attachment destroys the new session immediately.
            run("set-hook", "-a", "-t", session, "client-attached",
                f"set-option -t {session} destroy-unattached on")
        run("select-pane", "-t", top)
        run("wait-for", "-S", gate)
    except subprocess.CalledProcessError as error:
        if created:
            subprocess.run([*base, "kill-session", "-t", session], env=env, cwd=home, capture_output=True)
        sys.exit(f"Could not start the {cli} footer: " + (error.stderr or str(error)).strip())
    try:
        return subprocess.call([*base, "attach-session", "-t", session], env=env, cwd=home)
    finally:
        # Failed attachment must not orphan a new session or stop another attached client.
        state = subprocess.run([*base, "display-message", "-p", "-t", session,
                                "#{session_attached} #{session_last_attached}"],
                               env=env, cwd=home, capture_output=True, text=True).stdout.split()
        if state and state[0] == "0" and (not keep_alive or len(state) == 1):
            subprocess.run([*base, "kill-session", "-t", session], env=env, cwd=home, capture_output=True)


if __name__ == "__main__":
    sys.exit(launch(sys.argv[1:]))
