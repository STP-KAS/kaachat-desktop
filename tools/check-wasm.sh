#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$ROOT/kaspa/kaspa.js" || ! -f "$ROOT/kaspa/kaspa_bg.wasm" ]]; then
  echo "Missing Rusty Kaspa browser WASM files."
  echo "Run this once from the KaspaEngine folder:"
  echo "  npm run setup:wasm"
  exit 1
fi
