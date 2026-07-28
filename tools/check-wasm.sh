#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$ROOT/kaspa/kaspa.js" || ! -f "$ROOT/kaspa/kaspa_bg.wasm" ]]; then
  echo "Missing kaspa/kaspa.js or kaspa/kaspa_bg.wasm."
  echo "These are normally committed to the repo, so this shouldn't happen."
  echo "  - If your clone is incomplete or shallow, re-clone the repo."
  echo "  - If you deleted them intentionally, rebuild from source with:"
  echo "      npm run setup:wasm"
  exit 1
fi
