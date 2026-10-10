import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Final

# Owner fork only (never the sangrokjung/jung-wan-kim/karpeleslab originals): the fork's
# default branch carries every local fix, so install its tip rather than a pinned commit.
UPSTREAM: Final = 'git+https://github.com/cineraria01/teamproxy.git#main'

# TeamCodex puts its provider routing in root `-c` overrides before the user's arguments. Codex drops
# those when a `-c` follows `exec`, sends the request with its own login and fails with
# "workspace routing discovery unauthorized (401)". The wrapper refuses that order (exit 2) and says
# how to fix it instead of letting the run fail later. POSIX sh only (dash on Linux).
EXEC_CONFIG_GUARD: Final = r'''# exec 뒤의 -c는 TeamCodex가 맨 앞에 붙이는 프록시 설정을 지워 401로 끝난다. 그 꼴이면 실행하지 않는다.
if [ "${1-}" = run ] && [ "${2-}" = -- ]; then
  sub= skip=
  for arg in "$@"; do
    if [ -n "$skip" ]; then skip=; continue; fi
    if [ -z "$sub" ]; then
      case $arg in
        run|--) ;;
        -c|--config) skip=1 ;;
        -*) ;;
        *) sub=$arg ;;
      esac
      continue
    fi
    case $sub in exec|e) ;; *) break ;; esac
    case $arg in
      --) break ;;
      -c|-c?*|--config|--config=*)
        printf '%s\n' "teamcodex: exec 뒤의 '$arg' 설정은 TeamCodex 프록시 설정을 지워 401로 실패합니다." \
          "teamcodex: -c 설정은 exec 앞에 두세요. 예: teamcodex run -- -c model_reasoning_effort=high exec --ignore-user-config -m MODEL ..." >&2
        exit 2 ;;
    esac
  done
fi
'''


# One command for people and scripts. The launcher runs through python3 because npm may drop its exec bit.
# Bare `teamcodex`, Codex flags (--dangerously-bypass-approvals-and-sandbox,
# --keep-alive, ...) and an interactive `login` open the footer launcher, which itself runs
# `teamcodex run -- …` and, for login, `teamcodex login` with stdin closed — so it never comes back here.
# Every other command (run, server, status, ...) stays with the proxy; `-h`/`--help` shows the proxy help.
LAUNCHER_ROUTE: Final = r'''case "${1-}" in
  -h|--help) ;;
  ''|-*) exec python3 "$LAUNCHER" "$@" ;;
  login) if [ -t 0 ]; then exec python3 "$LAUNCHER" "$@"; fi ;;
esac
'''


def install_proxy(prefix: Path) -> Path:
    existing = shutil.which('teamcodex')
    if existing:
        print(f'Using existing TeamCodex: {existing}')
        return Path(existing).absolute()
    command = prefix / 'bin/teamcodex'
    if command.exists() or command.is_symlink():
        raise SystemExit(f'Existing command left untouched: {command}. Add its directory to PATH.')
    for dependency in ('npm', 'node', 'git'):
        if not shutil.which(dependency):
            raise SystemExit(f'Install {dependency} first, then rerun python3 install.py.')
    npm_prefix = prefix / 'share/teamcodex-global'
    subprocess.run(['npm', 'install', '--global', '--prefix', str(npm_prefix),
                    '--ignore-scripts', UPSTREAM], check=True)
    entry = npm_prefix / 'lib/node_modules/teamcodex/src/index.js'
    if not entry.is_file():
        raise SystemExit(f'TeamCodex entry point is missing: {entry}')
    command.parent.mkdir(parents=True, exist_ok=True)
    with command.open('x') as stream:
        launcher = entry.parent / 'hud/launcher.py'  # the footer launcher ships in the package
        stream.write('#!/bin/sh\n'
                     'if [ "${1-}" = codex ]; then shift; fi\n'
                     f'LAUNCHER={shlex.quote(str(launcher))}\n'
                     + LAUNCHER_ROUTE + EXEC_CONFIG_GUARD +
                     'exec env LC_ALL=C TEAMCLAUDE_PROVIDER=codex \\\n'
                     '  TEAMCLAUDE_CONFIG="$HOME/.config/teamcodex.json" \\\n'
                     '  TEAMCODEX_CODEX_BIN="$(command -v codex)" \\\n'
                     f'  node {shlex.quote(str(entry))} codex "$@"\n')
    command.chmod(0o755)
    return command


def install_service(command: Path) -> None:
    if sys.platform != 'linux' or not shutil.which('systemctl'):
        raise SystemExit('--service requires Linux user systemd. See docs/install/SETUP.md for macOS launchd.')
    def quote(value: str) -> str:
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'

    path = Path.home() / '.config/systemd/user/teamcodex.service'
    content = ('# Installed by tcodex\n[Unit]\nDescription=TeamCodex account proxy\n'
               'After=network-online.target\n\n[Service]\nType=simple\n'
               f'ExecStart={quote(str(command))} server\n'
               f'Environment={quote("PATH=" + str(command.parent) + os.pathsep + os.environ.get("PATH", ""))}\n'
               'Restart=always\nRestartSec=5\nUMask=0077\n\n'
               '[Install]\nWantedBy=default.target\n')
    if path.exists() and not path.read_text().startswith('# Installed by tcodex\n'):
        raise SystemExit(f'Existing service left untouched: {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(0o600)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', 'teamcodex.service'], check=True)
    linger = subprocess.run(['loginctl', 'enable-linger', str(os.getuid())], check=False)
    if linger.returncode:
        print('To keep the service running after logout, ask an administrator to run:\n'
              f'  sudo loginctl enable-linger {os.getuid()}', file=sys.stderr)
    print('Service enabled. Status: systemctl --user status teamcodex')
