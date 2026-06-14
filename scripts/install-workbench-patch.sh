#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/resources/window-deck-workbench.js"
TARGET="${WINDOW_DECK_WORKBENCH_HTML:-/usr/share/code/resources/app/out/vs/code/electron-browser/workbench/workbench.html}"
DEST="$(dirname "$TARGET")/window-deck-workbench.js"
MARK='<!-- Window Deck workbench patch -->'

if [[ ! -f "$TARGET" ]]; then
  echo "workbench.html not found: $TARGET" >&2
  exit 1
fi

cp "$TARGET" "$TARGET.window-deck.bak"
cp "$SRC" "$DEST"

if ! grep -q "$MARK" "$TARGET"; then
  perl -0pi -e "s#</html>#$MARK<script src=\"./window-deck-workbench.js\"></script></html>#" "$TARGET"
fi

echo "Installed Window Deck workbench patch:"
echo "  $TARGET"
echo "Restart VS Code."
