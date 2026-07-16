#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/vendor/kasia-cipher"
OUTPUT_DIR="$ROOT_DIR/cipher"

if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust/Cargo is required to build the Kasia cipher runtime."
  echo "Install Rust once, then rerun: npm run setup:cipher"
  exit 1
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack is required to build the Kasia cipher runtime."
  echo "Install once with: brew install wasm-pack"
  exit 1
fi

if [[ ! -f "$SOURCE_DIR/Cargo.toml" ]]; then
  echo "Missing vendored Kasia cipher source at: $SOURCE_DIR"
  exit 1
fi

# Apple clang cannot compile secp256k1-sys for wasm32-unknown-unknown.
# Automatically select Homebrew LLVM, matching the known-good Rusty Kaspa setup.
if [[ "$(uname -s)" == "Darwin" ]]; then
  LLVM_PREFIX=""
  if [[ -x "/opt/homebrew/opt/llvm/bin/clang" ]]; then
    LLVM_PREFIX="/opt/homebrew/opt/llvm"
  elif [[ -x "/usr/local/opt/llvm/bin/clang" ]]; then
    LLVM_PREFIX="/usr/local/opt/llvm"
  fi

  if [[ -z "$LLVM_PREFIX" ]]; then
    echo "Homebrew LLVM is required for the Kasia cipher WASM build."
    echo "Install it once with: brew install llvm wasm-pack binaryen"
    exit 1
  fi

  export PATH="$LLVM_PREFIX/bin:$PATH"
  export CC_wasm32_unknown_unknown="$LLVM_PREFIX/bin/clang"
  export AR_wasm32_unknown_unknown="$LLVM_PREFIX/bin/llvm-ar"
  export CC_wasm32_unknown_unknown="$LLVM_PREFIX/bin/clang"
  export AR_wasm32_unknown_unknown="$LLVM_PREFIX/bin/llvm-ar"
fi

rustup target add wasm32-unknown-unknown >/dev/null

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

echo "Building the official Kasia cipher WASM runtime..."
(
  cd "$SOURCE_DIR"
  wasm-pack build --target web --release --out-dir "$OUTPUT_DIR" --out-name cipher
)

[[ -f "$OUTPUT_DIR/cipher.js" ]] || { echo "Missing cipher.js after build"; exit 1; }
[[ -f "$OUTPUT_DIR/cipher_bg.wasm" ]] || { echo "Missing cipher_bg.wasm after build"; exit 1; }

echo "Kasia cipher ready:"
echo "  $OUTPUT_DIR/cipher.js"
echo "  $OUTPUT_DIR/cipher_bg.wasm"
