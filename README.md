# KaChat Desktop

donation address - brt25.kas or kaspa:qqpzpn5e7enn2ylfdxvlwtm3829gn6j9z9dnnmcsw5arkgnurktty6ulgzkfk

IMPORTANT

This is an experimental developer build.

Use a new disposable testing wallet only. Do not use a wallet containing meaningful funds.

KaChat uses the Kasia encrypted messaging protocol on top of the Kaspa BlockDAG — the vendored `kasia-cipher` crate under `vendor/` and `engine/kasia-protocol.js` / `engine/kasia-cipher.js` implement that protocol.

==================================================
QUICK START (Mac, Linux, Windows/WSL)
==================================================

No Rust, cargo, or wasm-pack needed for normal use — the Rusty Kaspa and
Kasia cipher WebAssembly builds are already included in this repository.

```
git clone <repo-url>
cd KaChat-Desktop
npm install
npm run dev
```

Then open the address Vite prints (typically `http://localhost:5173/`).

To stop KaChat, return to the terminal and press Control+C.

KaChat stores test accounts and settings in the browser. To remove them,
clear browser site data for localhost.

To run KaChat again later:

```
cd KaChat-Desktop && npm run dev
```

==================================================
ADVANCED: REBUILDING THE WASM FROM SOURCE (macOS)
==================================================

Only needed if you're modifying the vendored Rust source under `vendor/`
(the Rusty Kaspa SDK or the Kasia cipher crate) and need to regenerate the
`kaspa/` and `cipher/` build outputs. Regular app development and use does
not require anything in this section.

On Linux, this is usually just:

```
npm run setup:wasm && npm run setup:cipher
```

with a normal Rust toolchain (`cargo`, `rustup`, `wasm-pack`) — the
Homebrew/LLVM steps below are macOS-specific. Windows contributors should
use WSL for source rebuilds.

The first build can take several minutes because Rusty Kaspa WebAssembly
components must be compiled.

--------------------------------------------------
1. Install Apple Command Line Tools
--------------------------------------------------

Open Terminal and paste:

xcode-select --install

If Terminal says the command-line tools are already installed, continue.

Wait for the installation to finish before continuing.

--------------------------------------------------
2. Install Homebrew
--------------------------------------------------

Check whether Homebrew is installed:

brew --version

If Terminal says brew is not found, install Homebrew:

/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

When installation finishes, follow any PATH instructions Homebrew prints in Terminal.

Then close Terminal and open it again.

Confirm Homebrew works:

brew --version

--------------------------------------------------
3. Install Node and WASM build tools
--------------------------------------------------

Paste:

brew install node llvm wasm-pack binaryen

Confirm the tools are available:

node --version && npm --version && wasm-pack --version && wasm-opt --version

Each tool should print a version number.

--------------------------------------------------
4. Install Rust with rustup
--------------------------------------------------

Check whether Rust and rustup are already installed:

rustc --version && cargo --version && rustup --version

If any of those commands are not found, install Rust with rustup:

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

When prompted, choose the default installation.

Then load Rust into the current Terminal session:

source "$HOME/.cargo/env"

Confirm all three tools work:

rustc --version && cargo --version && rustup --version

--------------------------------------------------
5. Install JavaScript dependencies
--------------------------------------------------

From the project folder, paste:

npm install

--------------------------------------------------
6. Apply the Mac WASM build fix (if needed)
--------------------------------------------------

The vendored `build-web` script already sets `RUSTFLAGS=-Ctarget-cpu=mvp`
by default. On some Apple Silicon setups this environment variable doesn't
propagate correctly through the wasm-pack build subprocess, causing a
build failure. If `npm run setup:wasm` fails with a wasm target/codegen
error, apply this fix and retry.

Paste this entire command into Terminal exactly as shown:

python3 - <<'PY'
from pathlib import Path

p = Path("tools/setup-wasm-from-rusty-zip.sh")
s = p.read_text()

needle = 'cd "$RK/wasm"\necho "Building Rusty Kaspa browser WASM from included source..."\n./build-web --sdk\n'

replacement = 'cd "$RK/wasm"\n\n# Keep WebAssembly CPU flags limited to the WebAssembly target.\nmkdir -p .cargo\ncat > .cargo/config.toml <<\'EOF\'\n[target.wasm32-unknown-unknown]\nrustflags = ["-Ctarget-cpu=mvp"]\nEOF\n\nsed -i.bak \'/export RUSTFLAGS=-Ctarget-cpu=mvp/d\' build-web\nrm -f build-web.bak\n\necho "Building Rusty Kaspa browser WASM from included source..."\n./build-web --sdk\n'

if needle in s:
    p.write_text(s.replace(needle, replacement))
    print("Mac WASM build fix applied.")
elif 'target.wasm32-unknown-unknown' in s:
    print("Mac WASM build fix is already applied.")
else:
    raise SystemExit("The expected setup section was not found. Confirm that this is the correct KaChat release.")
PY

A successful patch prints:

Mac WASM build fix applied.

--------------------------------------------------
7. Build Rusty Kaspa and Kasia cipher WebAssembly
--------------------------------------------------

Paste:

rm -rf .rusty-build kaspa cipher && npm run setup:all

Let the process finish completely. This overwrites the committed `kaspa/`
and `cipher/` build outputs with a freshly compiled version — only do this
if you changed the vendored Rust source and mean to commit the result.

--------------------------------------------------
8. Start KaChat
--------------------------------------------------

Paste:

npm run dev

Wait for Terminal to display the Vite local address, then open it in a browser.

==================================================
COPYING COMMANDS
==================================================

- Copy only the command text.
- Do not copy Terminal prompt symbols such as %, $, or ~.
- Do not add Markdown backticks.
