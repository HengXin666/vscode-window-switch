#!/usr/bin/env bash
set -euo pipefail

find_workbench_html() {
  if [[ -n "${WINDOW_DECK_WORKBENCH_HTML:-}" ]]; then
    printf '%s\n' "$WINDOW_DECK_WORKBENCH_HTML"
    return
  fi
  local candidates=(
    "/usr/share/code/resources/app/out/vs/code/electron-browser/workbench/workbench.html"
    "/usr/share/code-insiders/resources/app/out/vs/code/electron-browser/workbench/workbench.html"
    "/opt/visual-studio-code/resources/app/out/vs/code/electron-browser/workbench/workbench.html"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  if command -v code >/dev/null 2>&1; then
    candidate="$(readlink -f "$(command -v code)")"
    candidate="$(dirname "$(dirname "$candidate")")/share/code/resources/app/out/vs/code/electron-browser/workbench/workbench.html"
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  fi
  return 1
}

TARGET="$(find_workbench_html || true)"
if [[ -z "$TARGET" || ! -f "$TARGET" ]]; then
  echo "workbench.html not found. Set WINDOW_DECK_WORKBENCH_HTML=/path/to/workbench.html" >&2
  exit 1
fi

DEST="$(dirname "$TARGET")/window-deck-workbench.js"
BACKUP="$TARGET.window-deck.original"
OLD_BACKUP="$TARGET.window-deck.bak"

if [[ -f "$BACKUP" ]] && ! grep -q 'Window Deck workbench patch' "$BACKUP"; then
  cp "$BACKUP" "$TARGET"
else
  perl -0pi -e 's#<!-- Window Deck workbench patch --><script src="\./window-deck-workbench\.js"></script>##g' "$TARGET"
fi

rm -f "$DEST"

echo "Uninstalled Window Deck floating overlay patch:"
echo "  $TARGET"
if [[ -f "$OLD_BACKUP" ]] && grep -q 'Window Deck workbench patch' "$OLD_BACKUP"; then
  echo "Note: old backup contains the patch and was not used:"
  echo "  $OLD_BACKUP"
fi
echo "Restart VS Code."
