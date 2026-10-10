#!/usr/bin/env bash
# Self-updater for teamclaude-statusline.
#
# Spawned fully detached by statusline-wrapper.py at most once a day. Compares
# the fork branch tip against the last installed commit and re-runs install.sh
# only when they differ, so a normal day costs one `git ls-remote` and nothing
# else. Every failure is silent — the status line must never be affected.
# Opt out with {"autoUpdate": false} in ~/.claude/teamclaude-statusline-config.json.
#
# The whole body lives in main() and the final line is `main "$@"; exit` so the
# running copy is immune to install.sh overwriting this very file mid-run.
set -u

# ponytail: the tip moves with every proxy commit, so this reinstalls the status line (idempotent) at most
# once a day even when statusline/ is unchanged; compare a path-filtered commit if that ever matters.
REPO="cineraria01/teamproxy"
BRANCH="main"
REPO_URL="https://github.com/$REPO"
INSTALL_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/statusline/install.sh"

main() {
  local claude_dir="${1:-$HOME/.claude}"
  local sha_file="$claude_dir/teamclaude-statusline-installed-sha"
  local log="$claude_dir/teamclaude-statusline-update.log"
  # NOT local: the EXIT trap expands $lock after main() has returned, when a
  # local would already be gone and the lock would leak (blocking every future
  # update until the stale-lock sweep an hour later).
  lock="$claude_dir/.teamclaude-statusline-update.lock"

  # Concurrent Claude sessions can spawn this at the same moment; one wins.
  if ! mkdir "$lock" 2>/dev/null; then
    # A crash can leave the lock behind; clear it once it is clearly stale.
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
      rmdir "$lock" 2>/dev/null || return 0
      mkdir "$lock" 2>/dev/null || return 0
    else
      return 0
    fi
  fi
  trap 'rmdir "$lock" 2>/dev/null' EXIT

  local remote=""
  remote=$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" 2>/dev/null | cut -f1)
  if [ -z "$remote" ]; then
    remote=$(curl -fsSL -m 10 "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])' 2>/dev/null)
  fi
  [ -z "$remote" ] && return 0  # offline, rate-limited, etc. — try again tomorrow

  local installed=""
  [ -f "$sha_file" ] && installed=$(cat "$sha_file" 2>/dev/null)
  [ "$remote" = "$installed" ] && return 0

  if curl -fsSL "$INSTALL_URL?$(date +%s)" | CLAUDE_DIR="$claude_dir" NO_PROBE=1 bash >>"$log" 2>&1; then
    echo "$remote" >"$sha_file"
    echo "$(date '+%Y-%m-%d %H:%M:%S') updated to $remote" >>"$log"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') update to $remote failed" >>"$log"
  fi
  tail -n 200 "$log" >"$log.tmp" 2>/dev/null && mv "$log.tmp" "$log"
  return 0
}

main "$@"; exit 0
