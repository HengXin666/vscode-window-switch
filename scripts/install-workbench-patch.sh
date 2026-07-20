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
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/product.json"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  if command -v code >/dev/null 2>&1; then
    local code_bin
    code_bin="$(command -v code)"
    if resolved="$(readlink -f "$code_bin" 2>/dev/null)"; then
      code_bin="$resolved"
    fi
    candidate="$(dirname "$(dirname "$code_bin")")/resources/app/product.json"
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  fi
  return 1
}

TARGET="$(find_product_json || true)"
if [[ -z "$TARGET" || ! -f "$TARGET" ]]; then
  echo "VS Code product.json not found. Set WINDOW_DECK_PRODUCT_JSON=/path/to/product.json" >&2
  exit 1
fi

BACKUP="$TARGET.window-deck.original"
if [[ ! -f "$BACKUP" ]]; then
  cp -p -- "$TARGET" "$BACKUP"
fi

PRODUCT_JSON="$TARGET" node <<'NODE'
const fs = require("node:fs");
const path = process.env.PRODUCT_JSON;
const extensionId = "HengXin666.window-deck";
const proposal = "terminalDataWriteEvent";
const product = JSON.parse(fs.readFileSync(path, "utf8"));
const enabled = product.extensionEnabledApiProposals || {};
const current = Array.isArray(enabled[extensionId]) ? enabled[extensionId] : [];
enabled[extensionId] = [...new Set([...current, proposal])];
product.extensionEnabledApiProposals = enabled;
const temp = `${path}.${process.pid}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(product, null, "\t")}\n`, "utf8");
fs.renameSync(temp, path);
console.log(`Enabled ${proposal} for ${extensionId} in ${path}`);
NODE

echo "Window Deck terminal API permission installed. Fully quit and reopen VS Code normally."
