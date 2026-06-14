#!/usr/bin/env bash
set -euo pipefail

echo "Window Deck no longer installs a VS Code workbench patch."
echo "The floating UI is now provided by the packaged companion overlay window."
echo "If an old patch was installed, run:"
echo "  sudo bash scripts/uninstall-workbench-patch.sh"
