#!/usr/bin/env bash
set -euo pipefail

find_product_json() {
  if [[ -n "${WINDOW_DECK_PRODUCT_JSON:-}" ]]; then
    printf '%s\n' "$WINDOW_DECK_PRODUCT_JSON"
    return
  fi
  local candidates=(
    "/usr/share/code/resources/app/product.json"
    "/usr/share/code-insiders/resources/app/product.json"
    "/opt/visual-studio-code/resources/app/product.json"
    "/Applications/Visual Studio Code.app/Contents/Resources/app/product.json"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

TARGET="$(find_product_json || true)"
BACKUP="${TARGET}.window-deck.original"
if [[ -z "$TARGET" || ! -f "$BACKUP" ]]; then
  echo "Window Deck product.json backup not found; nothing to uninstall." >&2
  exit 1
fi
cp -p -- "$BACKUP" "$TARGET"
echo "Restored $TARGET. Fully quit and reopen VS Code."
