#!/usr/bin/env bash
# Reload patch for @karpeleslab/teamclaude (tested against 1.4.2).
#
# Upstream teamclaude can only apply config changes (enable/disable/priority)
# to a RUNNING server via the TUI "R" key — a headless server must be fully
# restarted for every account change. This patch wires the existing reload
# logic (syncAccountsFromDisk + refreshQuotaAll, no new logic) to:
#
#   * POST /teamclaude/reload        endpoint on the proxy (localhost auth-exempt,
#                                    same as /teamclaude/status)
#   * `teamclaude reload`            CLI command
#   * `teamclaude enable|disable|priority`  auto-apply to the running server
#                                    ("Applied to the running server")
#
# Usage:
#   ./teamclaude-reload-patch.sh            apply (idempotent; skips when applied)
#   ./teamclaude-reload-patch.sh --check    report whether the patch is applied
#   ./teamclaude-reload-patch.sh --revert   restore the pre-patch sources
#
# After apply/revert, restart the proxy once: teamclaude restart
# After `npm update -g` overwrites the package, just run this script again.
#
# The .patch files are expected next to this script (patches/ in the repo,
# or the same directory when installed under ~/.claude/teamclaude-patches/).
# Backups go to <script dir>/backup-<version>/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -d "$HERE/patches" ]; then PATCH_DIR="$HERE/patches"; else PATCH_DIR="$HERE"; fi

NPM_ROOT="$(npm root -g 2>/dev/null || true)"
PKG="$NPM_ROOT/@karpeleslab/teamclaude"
SRC="$PKG/src"

if [ ! -d "$SRC" ]; then
  echo "note: @karpeleslab/teamclaude not found under $NPM_ROOT — skipping reload patch" >&2
  echo "      (a fork build may already ship its own reload; nothing to do)" >&2
  exit 0
fi

VERSION="$(node -p "require('$PKG/package.json').version" 2>/dev/null || echo unknown)"
BACKUP="$HERE/backup-$VERSION"
applied() { grep -q '/teamclaude/reload' "$SRC/server.js"; }

case "${1:-}" in
  --check)
    if applied; then echo "applied (teamclaude $VERSION)"; else echo "not applied (teamclaude $VERSION)"; fi
    exit 0
    ;;
  --revert)
    if [ ! -f "$BACKUP/server.js" ] || [ ! -f "$BACKUP/index.js" ]; then
      echo "error: no backup for teamclaude $VERSION at $BACKUP" >&2
      echo "reinstall instead: npm install -g @karpeleslab/teamclaude" >&2
      exit 1
    fi
    cp "$BACKUP/server.js" "$SRC/server.js"
    cp "$BACKUP/index.js" "$SRC/index.js"
    echo "reverted to pre-patch sources (teamclaude $VERSION). Restart: teamclaude restart"
    exit 0
    ;;
  '') ;;
  *)
    echo "usage: $(basename "$0") [--check|--revert]" >&2
    exit 2
    ;;
esac

if applied; then
  echo "reload patch already applied (teamclaude $VERSION) — nothing to do"
  exit 0
fi

for p in "$PATCH_DIR/reload-endpoint.server.js.patch" "$PATCH_DIR/reload-endpoint.index.js.patch"; do
  [ -f "$p" ] || { echo "error: missing patch file $p" >&2; exit 1; }
done
command -v patch >/dev/null || { echo "error: 'patch' command is required" >&2; exit 1; }

if [ "$VERSION" != "1.4.2" ]; then
  echo "warning: patch was written against 1.4.2, installed is $VERSION — attempting anyway" >&2
fi

mkdir -p "$BACKUP"
cp "$SRC/server.js" "$SRC/index.js" "$BACKUP/"

restore() {
  cp "$BACKUP/server.js" "$SRC/server.js"
  cp "$BACKUP/index.js" "$SRC/index.js"
  find "$SRC" -name '*.rej' -delete 2>/dev/null || true
}

if ! patch --forward --no-backup-if-mismatch "$SRC/server.js" < "$PATCH_DIR/reload-endpoint.server.js.patch" \
   || ! patch --forward --no-backup-if-mismatch "$SRC/index.js" < "$PATCH_DIR/reload-endpoint.index.js.patch"; then
  restore
  echo "error: patch did not apply cleanly against teamclaude $VERSION — sources restored" >&2
  echo "       (upstream changed; the patches need a context refresh)" >&2
  exit 1
fi

if ! node --check "$SRC/server.js" || ! node --check "$SRC/index.js"; then
  restore
  echo "error: patched sources failed syntax check — sources restored" >&2
  exit 1
fi

echo "reload patch applied (teamclaude $VERSION)."
echo "Restart the proxy once to load it: teamclaude restart"
echo "From then on enable/disable/priority apply instantly, and 'teamclaude reload' is available."
