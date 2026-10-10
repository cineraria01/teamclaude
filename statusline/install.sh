#!/usr/bin/env bash
# Installer for teamclaude-statusline (the statusline/ folder of the cineraria01/teamclaude fork).
#
#   curl -fsSL "https://raw.githubusercontent.com/cineraria01/teamclaude/qjc/resilient-routing/statusline/install.sh?$(date +%s)" | bash
#
# Options (env vars):
#   CLAUDE_DIR               Claude Code config dir (default: ~/.claude)
#   TEAMCLAUDE_SHELL_RC      shell rc file override (default: ~/.bashrc or ~/.zshrc)
#   NO_PROBE=1               skip enabling `teamclaude probe 300`
#   NO_RELOAD_PATCH=1        skip patching @karpeleslab/teamclaude with the
#                            live-reload commands (see teamclaude-reload-patch.sh)
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/cineraria01/teamclaude/qjc/resilient-routing/statusline"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
SCRIPT_DEST="$CLAUDE_DIR/statusline-teamclaude.py"
WRAPPER_DEST="$CLAUDE_DIR/statusline-wrapper.py"
SELECTOR_DEST="$CLAUDE_DIR/teamclaude-selector.sh"
AUTOUPDATE_DEST="$CLAUDE_DIR/statusline-autoupdate.sh"
SHA_DEST="$CLAUDE_DIR/teamclaude-statusline-installed-sha"
CONFIG_DEST="$CLAUDE_DIR/teamclaude-statusline-config.json"
SETTINGS="$CLAUDE_DIR/settings.json"

command -v python3 >/dev/null || { echo "error: python3 is required" >&2; exit 1; }
CACHE_BUST=$(python3 -c 'import time; print(int(time.time()))')
if ! command -v teamclaude >/dev/null 2>&1; then
  echo "error: teamclaude is required" >&2
  echo "install: npm install -g @karpeleslab/teamclaude" >&2
  echo "then add an account: teamclaude login  (or: teamclaude import)" >&2
  exit 1
fi

TEAMCLAUDE_SERVER_DOWN=0
if TEAMCLAUDE_STATUS=$(teamclaude status --json 2>/dev/null); then
  ACCOUNT_COUNT=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("accounts", [])))' \
    <<< "$TEAMCLAUDE_STATUS" 2>/dev/null || true)
  if [ "$ACCOUNT_COUNT" = 0 ]; then
    echo "error: teamclaude has no accounts" >&2
    echo "add one: teamclaude login  (or: teamclaude import / teamclaude login --api)" >&2
    exit 1
  fi
else
  TEAMCLAUDE_ACCOUNTS=$(teamclaude accounts 2>/dev/null || true)
  if [[ "$TEAMCLAUDE_ACCOUNTS" == *"No accounts configured."* ]]; then
    echo "error: teamclaude has no accounts" >&2
    echo "add one: teamclaude login  (or: teamclaude import / teamclaude login --api)" >&2
    exit 1
  fi
  TEAMCLAUDE_SERVER_DOWN=1
fi

mkdir -p "$CLAUDE_DIR"

# Copy assets from a local checkout when run from the repo, otherwise download.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd || true)"
install_asset() {
  local name=$1 destination=$2
  if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/$name" ]; then
    cp "$SRC_DIR/$name" "$destination"
  else
    curl -fsSL "$REPO_RAW/$name?v=$CACHE_BUST" -o "$destination"
  fi
}

install_asset statusline-teamclaude.py "$SCRIPT_DEST"
install_asset statusline-wrapper.py "$WRAPPER_DEST"
install_asset teamclaude-selector.sh "$SELECTOR_DEST"
install_asset statusline-autoupdate.sh "$AUTOUPDATE_DEST"
chmod +x "$SCRIPT_DEST" "$WRAPPER_DEST" "$AUTOUPDATE_DEST"
chmod 644 "$SELECTOR_DEST"

# Record the installed commit so the self-updater reinstalls only on change.
# Best-effort: without a SHA the updater just reinstalls once and records it.
INSTALLED_SHA=""
if [ -n "$SRC_DIR" ] && command -v git >/dev/null 2>&1; then
  INSTALLED_SHA=$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)
fi
if [ -z "$INSTALLED_SHA" ] && command -v git >/dev/null 2>&1; then
  INSTALLED_SHA=$(git ls-remote "https://github.com/cineraria01/teamclaude" refs/heads/qjc/resilient-routing 2>/dev/null | cut -f1 || true)
fi
[ -n "$INSTALLED_SHA" ] && echo "$INSTALLED_SHA" > "$SHA_DEST"

# Preserve any existing status line, then register the combined wrapper.
python3 - "$SETTINGS" "$SCRIPT_DEST" "$WRAPPER_DEST" "$CONFIG_DEST" <<'PY'
import json, os, shutil, sys

settings_path, script_path, wrapper_path, config_path = sys.argv[1:]
try:
    with open(settings_path) as f:
        settings = json.load(f)
    shutil.copy2(settings_path, settings_path + ".bak")
    print(f"backed up settings to {settings_path}.bak")
except FileNotFoundError:
    settings = {}
except ValueError:
    sys.exit(f"error: {settings_path} is not valid JSON; fix it and re-run")

previous = settings.get("statusLine")
previous_command = previous.get("command") if isinstance(previous, dict) else None
if previous is not None and previous_command not in (script_path, wrapper_path):
    config = {"previousStatusLine": previous}
    print("preserved existing statusLine; it will run before TeamClaude")
elif os.path.exists(config_path):
    config = None
else:
    config = {"previousStatusLine": None}

if config is not None:
    temporary = config_path + ".tmp"
    with open(temporary, "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(temporary, config_path)

settings["statusLine"] = {
    "type": "command",
    "command": wrapper_path,
    "refreshInterval": 30,
}
with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"statusLine registered in {settings_path}")
PY
chmod 600 "$CONFIG_DEST"

if [ "$TEAMCLAUDE_SERVER_DOWN" = 1 ]; then
  echo "warning: TeamClaude proxy is not running; start it with 'teamclaude service install' or 'teamclaude server'" >&2
fi

# Source the numbered account selector after existing aliases/functions. The
# marked block is replaced idempotently and uninstall removes only this block.
SHELL_RC="${TEAMCLAUDE_SHELL_RC:-}"
if [ -z "$SHELL_RC" ]; then
  case "${SHELL##*/}" in
    bash) SHELL_RC="$HOME/.bashrc" ;;
    zsh) SHELL_RC="$HOME/.zshrc" ;;
  esac
fi

if [ -n "$SHELL_RC" ]; then
  python3 - "$SHELL_RC" "$SELECTOR_DEST" <<'PY'
import os, shlex, shutil, sys

rc_path, selector_path = sys.argv[1], sys.argv[2]
begin = "# >>> teamclaude-statusline selector >>>"
end = "# <<< teamclaude-statusline selector <<<"
quoted_selector = shlex.quote(selector_path)
block = f"{begin}\n[ -r {quoted_selector} ] && . {quoted_selector}\n{end}"

try:
    with open(rc_path) as f:
        content = f.read()
except FileNotFoundError:
    content = ""
original = content

start = content.find(begin)
if start >= 0:
    finish = content.find(end, start)
    if finish < 0:
        sys.exit(f"error: incomplete teamclaude-statusline selector block in {rc_path}")
    content = content[:start] + content[finish + len(end):]

base = content.rstrip()
updated = (base + "\n\n" if base else "") + block + "\n"
if updated != original:
    if os.path.exists(rc_path):
        shutil.copy2(rc_path, rc_path + ".bak")
    os.makedirs(os.path.dirname(rc_path) or ".", exist_ok=True)
    with open(rc_path, "w") as f:
        f.write(updated)
print(f"numbered account selector registered in {rc_path}")
PY
else
  echo "warning: numbered selector supports Bash/Zsh only; set TEAMCLAUDE_SHELL_RC to a Bash/Zsh rc file" >&2
fi

# Enable the background quota probe so idle accounts' usage stays fresh.
# It only reads the usage endpoint and does not spend quota.
if [ -z "${NO_PROBE:-}" ]; then
  teamclaude probe 300 || echo "warning: could not enable probe (proxy stopped, or this teamclaude build lacks the probe command; quota still refreshes as requests flow)" >&2
fi

# Live-reload patch for @karpeleslab/teamclaude: adds `teamclaude reload` and
# makes enable/disable/priority apply to the running server without a restart.
# Assets land in ~/.claude/teamclaude-patches/ so the patch can be re-applied
# after `npm update -g` overwrites the package. Skips itself when the build
# already has the endpoint (a fork, or a future upstream) or on NO_RELOAD_PATCH=1.
PATCHES_DIR="$CLAUDE_DIR/teamclaude-patches"
if [ -z "${NO_RELOAD_PATCH:-}" ]; then
  mkdir -p "$PATCHES_DIR"
  install_asset teamclaude-reload-patch.sh "$PATCHES_DIR/teamclaude-reload-patch.sh"
  install_asset patches/reload-endpoint.server.js.patch "$PATCHES_DIR/reload-endpoint.server.js.patch"
  install_asset patches/reload-endpoint.index.js.patch "$PATCHES_DIR/reload-endpoint.index.js.patch"
  chmod +x "$PATCHES_DIR/teamclaude-reload-patch.sh"
  "$PATCHES_DIR/teamclaude-reload-patch.sh" \
    || echo "warning: live-reload patch not applied; account changes need 'teamclaude restart' as before" >&2
fi

echo
echo "Done. Restart Claude Code (or start a new session) to see the status line."
echo "Open a new shell, then use 'claude 1', 'claude 2', ... to pin an account."
