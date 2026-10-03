#!/bin/bash
# Narrow the Tuff file-index watch roots so ~/work_file and ~/orca are never crawled.
#
# Why: on darwin resolveFileProviderBaseWatchPaths() returns ['home'] -- the whole home
# directory -- with no settings key to change it (file-provider-watch-paths.ts). A non-empty
# TUFF_FILE_PROVIDER_BASE_WATCH_PATHS replaces that list entirely, and because a login item
# launch inherits only launchd's environment, the value is set with `launchctl setenv` from a
# RunAtLoad LaunchAgent.
#
# Usage:
#   bash tuff-roots-apply.sh apply    # compute roots, install + load the env agent
#   bash tuff-roots-apply.sh revert   # unset env, unload + remove the agent
#   bash tuff-roots-apply.sh show     # print the active value
set -euo pipefail

ROOT_NAME="com.tagzxia.app.tuff.roots"
PLIST="$HOME/Library/LaunchAgents/$ROOT_NAME.plist"
HOME_DIR="$HOME"
# Library is pruned by the traversal rules anyway; skipping it keeps the root list honest.
EXCLUDE="work_file orca Library"
# Dot-dirs are dropped by the hidden-name rule (.Trash, .cache, .bun, ...) -- never index them.
DROP_DOT_DIRS=1
LOG="$HOME/Library/Logs/tuff-roots-env.log"

build_env() {
  python3 - "$HOME_DIR" "$EXCLUDE" "$DROP_DOT_DIRS" <<'PY'
import os, sys
home, exclude, drop_dot = sys.argv[1], set(sys.argv[2].split()), sys.argv[3] == "1"
names = sorted(os.listdir(home))
if drop_dot:
    names = [n for n in names if not n.startswith(".")]
roots = [os.path.join(home, n) for n in names
         if os.path.isdir(os.path.join(home, n)) and n not in exclude]
assert roots, "no roots resolved"
assert not any(":" in r for r in roots), "colon in a path would break the env value"
joined = ":".join(roots)
assert len(joined) < 30000, f"env value too long: {len(joined)}"
sys.stdout.write(joined)
PY
}

case "${1:-show}" in
  apply)
    ENV_VALUE="$(build_env)"
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$ROOT_NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/launchctl</string><string>setenv</string>
    <string>TUFF_FILE_PROVIDER_BASE_WATCH_PATHS</string>
    <string>$ENV_VALUE</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "gui/$(id -u)/$ROOT_NAME" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    ROOTS_NOW="$(launchctl getenv TUFF_FILE_PROVIDER_BASE_WATCH_PATHS)"
    echo "applied: $(printf '%s' "$ROOTS_NOW" | tr ':' '\n' | grep -c .) roots"
    echo "excluded: ~/work_file, ~/orca, dot-dirs (~/Library is traversal-pruned)"
    ;;
  revert)
    launchctl bootout "gui/$(id -u)/$ROOT_NAME" 2>/dev/null || true
    launchctl unsetenv TUFF_FILE_PROVIDER_BASE_WATCH_PATHS || true
    rm -f "$PLIST"
    echo "reverted: env unset, $PLIST removed"
    ;;
  show)
    printf '%s' "$(launchctl getenv TUFF_FILE_PROVIDER_BASE_WATCH_PATHS)" | tr ':' '\n' | sed -n '1,6p'
    echo "roots: $(printf '%s' "$(launchctl getenv TUFF_FILE_PROVIDER_BASE_WATCH_PATHS)" | tr ':' '\n' | grep -c .)"
    ;;
  *)
    echo "usage: $0 {apply|revert|show}" >&2; exit 2;;
esac
