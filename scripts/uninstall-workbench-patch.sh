#!/usr/bin/env bash
set -euo pipefail

TARGET="${WINDOW_DECK_WORKBENCH_HTML:-/usr/share/code/resources/app/out/vs/code/electron-browser/workbench/workbench.html}"
DEST="$(dirname "$TARGET")/window-deck-workbench.js"
MARK='<!-- Window Deck workbench patch -->'

if [[ ! -f "$TARGET" ]]; then
  echo "workbench.html not found: $TARGET" >&2
  exit 1
fi

perl -0pi -e "s#\\Q$MARK\\E<script src=\"\\./window-deck-workbench\\.js\"></script>##" "$TARGET"
rm -f "$DEST"

echo "Uninstalled Window Deck workbench patch:"
echo "  $TARGET"
echo "Restart VS Code."
