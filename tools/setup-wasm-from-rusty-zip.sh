#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_ZIP="$ROOT/vendor/rusty-kaspa-master-2.zip"
ZIP="${1:-$DEFAULT_ZIP}"
WORK="$ROOT/.rusty-build"

# Use Homebrew LLVM for wasm C builds on macOS if available. Apple clang often fails
# with: No available targets are compatible with triple "wasm32-unknown-unknown".
if [[ "$(uname -s)" == "Darwin" ]]; then
  LLVM_CLANG=""
  if [[ -x "/opt/homebrew/opt/llvm/bin/clang" ]]; then
    LLVM_CLANG="/opt/homebrew/opt/llvm/bin/clang"
    export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
    export AR_wasm32_unknown_unknown="/opt/homebrew/opt/llvm/bin/llvm-ar"
  elif [[ -x "/usr/local/opt/llvm/bin/clang" ]]; then
    LLVM_CLANG="/usr/local/opt/llvm/bin/clang"
    export PATH="/usr/local/opt/llvm/bin:$PATH"
    export AR_wasm32_unknown_unknown="/usr/local/opt/llvm/bin/llvm-ar"
  fi

  if [[ -n "$LLVM_CLANG" ]]; then
    export CC_wasm32_unknown_unknown="$LLVM_CLANG"
    export CC_wasm32_unknown_unknown="$LLVM_CLANG"
  else
    echo "Homebrew LLVM was not found. Install it once, then rerun setup:"
    echo "  brew install llvm wasm-pack binaryen"
    exit 1
  fi
fi

if [[ ! -f "$ZIP" ]]; then
  echo "Could not find Rusty Kaspa ZIP at: $ZIP"
  echo "This project includes the expected source ZIP at: $DEFAULT_ZIP"
  echo "Run: npm run setup:wasm"
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust/Cargo is required. Install Rust once, then rerun setup:"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "  source \"$HOME/.cargo/env\""
  echo "  npm run setup:wasm"
  exit 1
fi

rustup target add wasm32-unknown-unknown >/dev/null

if ! command -v wasm-pack >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing wasm-pack and binaryen with Homebrew..."
    brew install wasm-pack binaryen
  else
    echo "wasm-pack is required. Install wasm-pack, then rerun setup."
    exit 1
  fi
fi

rm -rf "$WORK"
mkdir -p "$WORK"
unzip -q "$ZIP" -d "$WORK"
RK="$(find "$WORK" -maxdepth 2 -type d -name 'wasm' | head -1 | xargs dirname)"
if [[ -z "$RK" || ! -d "$RK/wasm" ]]; then
  echo "Could not locate rusty-kaspa/wasm inside $ZIP"
  exit 1
fi

cd "$RK/wasm"
echo "Building Rusty Kaspa browser WASM from included source..."
./build-web --sdk

mkdir -p "$ROOT/kaspa"
if [[ -f web/kaspa/kaspa.js && -f web/kaspa/kaspa_bg.wasm ]]; then
  cp web/kaspa/kaspa.js web/kaspa/kaspa_bg.wasm "$ROOT/kaspa/"
  cp web/kaspa/kaspa.js "$ROOT/kaspa/kaspa-wasm.js"
  cp web/kaspa/kaspa_bg.wasm "$ROOT/kaspa/kaspa-wasm_bg.wasm"
else
  echo "Build finished, but expected web/kaspa/kaspa.js and web/kaspa/kaspa_bg.wasm were not found."
  find web -maxdepth 3 -type f | sort
  exit 1
fi

echo "Done. Browser WASM files copied into: $ROOT/kaspa"
ls -lh "$ROOT/kaspa"
