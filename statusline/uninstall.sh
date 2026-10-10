#!/usr/bin/env bash
# Uninstaller for teamclaude-statusline: removes the statusLine entry it
# registered and deletes the script. Leaves everything else untouched.
set -euo pipefail

CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
SCRIPT_DEST="$CLAUDE_DIR/statusline-teamclaude.py"
WRAPPER_DEST="$CLAUDE_DIR/statusline-wrapper.py"
SELECTOR_DEST="$CLAUDE_DIR/teamclaude-selector.sh"
AUTOUPDATE_DEST="$CLAUDE_DIR/statusline-autoupdate.sh"
CONFIG_DEST="$CLAUDE_DIR/teamclaude-statusline-config.json"
SETTINGS="$CLAUDE_DIR/settings.json"

if [ -f "$SETTINGS" ]; then
  python3 - "$SETTINGS" "$SCRIPT_DEST" "$WRAPPER_DEST" "$CONFIG_DEST" <<'PY'
import json, shutil, sys

settings_path, script_path, wrapper_path, config_path = sys.argv[1:]
with open(settings_path) as f:
    settings = json.load(f)
sl = settings.get("statusLine")
command = sl.get("command") if isinstance(sl, dict) else None
if command in (script_path, wrapper_path):
    shutil.copy2(settings_path, settings_path + ".bak")
    try:
        with open(config_path) as f:
            previous = json.load(f).get("previousStatusLine")
    except (OSError, ValueError):
        previous = None
    if previous is None:
        del settings["statusLine"]
        message = "statusLine removed"
    else:
        settings["statusLine"] = previous
        message = "previous statusLine restored"
    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"{message} in {settings_path} (backup: .bak)")
else:
    print("statusLine in settings.json is not ours; leaving it as-is")
PY
fi

if [ -n "${TEAMCLAUDE_SHELL_RC:-}" ]; then
  SHELL_RCS=("$TEAMCLAUDE_SHELL_RC")
else
  SHELL_RCS=("$HOME/.bashrc" "$HOME/.zshrc")
fi

for SHELL_RC in "${SHELL_RCS[@]}"; do
  [ -f "$SHELL_RC" ] || continue
  python3 - "$SHELL_RC" <<'PY'
import shutil, sys

rc_path = sys.argv[1]
begin = "# >>> teamclaude-statusline selector >>>"
end = "# <<< teamclaude-statusline selector <<<"
with open(rc_path) as f:
    content = f.read()
start = content.find(begin)
finish = content.find(end, start) if start >= 0 else -1
if start >= 0 and finish >= 0:
    updated = (content[:start] + content[finish + len(end):]).rstrip() + "\n"
    shutil.copy2(rc_path, rc_path + ".bak")
    with open(rc_path, "w") as f:
        f.write(updated)
    print(f"numbered account selector removed from {rc_path}")
PY
done

# Revert the live-reload patch on @karpeleslab/teamclaude, if we applied it.
PATCHES_DIR="$CLAUDE_DIR/teamclaude-patches"
if [ -x "$PATCHES_DIR/teamclaude-reload-patch.sh" ]; then
  "$PATCHES_DIR/teamclaude-reload-patch.sh" --revert \
    || echo "note: live-reload patch not reverted (already gone, or backup missing); 'npm install -g @karpeleslab/teamclaude' restores stock sources" >&2
  rm -rf "$PATCHES_DIR"
fi

rm -f "$SCRIPT_DEST" "$WRAPPER_DEST" "$SELECTOR_DEST" "$CONFIG_DEST" \
  "$AUTOUPDATE_DEST" \
  "$CLAUDE_DIR/teamclaude-statusline-installed-sha" \
  "$CLAUDE_DIR/teamclaude-statusline-update-stamp" \
  "$CLAUDE_DIR/teamclaude-statusline-update.log"
rmdir "$CLAUDE_DIR/.teamclaude-statusline-update.lock" 2>/dev/null || true
echo "Removed TeamClaude status line files from $CLAUDE_DIR"
echo "Note: 'teamclaude probe' was left as-is; run 'teamclaude probe off' if you want it off."
