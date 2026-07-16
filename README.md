# KaChat Desktop — Local Builder Test

donation address - brt25.kas or kaspa:qqpzpn5e7enn2ylfdxvlwtm3829gn6j9z9dnnmcsw5arkgnurktty6ulgzkfk

This guide runs KaChat locally on a Mac.

IMPORTANT

This is an experimental developer build.

Use a new disposable testing wallet only. Do not use a wallet containing meaningful funds.

SUPPORTED MACS

- Apple Silicon Macs
- Intel Macs
- macOS with an internet connection

The first setup can take several minutes because Rusty Kaspa WebAssembly components must be compiled.

==================================================
1. INSTALL APPLE COMMAND LINE TOOLS
==================================================

Open Terminal and paste:

xcode-select --install

If Terminal says the command-line tools are already installed, continue.

Wait for the installation to finish before continuing.

==================================================
2. INSTALL HOMEBREW
==================================================

Check whether Homebrew is installed:

brew --version

If Terminal says brew is not found, install Homebrew:

/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

When installation finishes, follow any PATH instructions Homebrew prints in Terminal.

Then close Terminal and open it again.

Confirm Homebrew works:

brew --version

==================================================
3. INSTALL NODE AND WASM BUILD TOOLS
==================================================

Paste:

brew install node llvm wasm-pack binaryen

Confirm the tools are available:

node --version && npm --version && wasm-pack --version && wasm-opt --version

Each tool should print a version number.

==================================================
4. INSTALL RUST WITH RUSTUP
==================================================

Check whether Rust and rustup are already installed:

rustc --version && cargo --version && rustup --version

If any of those commands are not found, install Rust with rustup:

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

When prompted, choose the default installation.

Then load Rust into the current Terminal session:

source "$HOME/.cargo/env"

Confirm all three tools work:

rustc --version && cargo --version && rustup --version

==================================================
5. OPEN THE PROJECT FOLDER
==================================================

Safari normally unzips a GitHub download automatically.

The blue project folder should normally be here:

~/Downloads/KaChat-Desktop-main

Enter the folder:

cd ~/Downloads/KaChat-Desktop-main

If the download is still a ZIP, paste:

cd ~/Downloads && unzip -o KaChat-Desktop-main.zip && cd KaChat-Desktop-main

==================================================
6. INSTALL JAVASCRIPT DEPENDENCIES
==================================================

Paste:

rm -rf node_modules package-lock.json && npm config set registry https://registry.npmjs.org/ && npm install

==================================================
7. APPLY THE MAC WASM BUILD FIX
==================================================

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

==================================================
8. BUILD RUSTY KASPA WEBASSEMBLY
==================================================

Paste:

rm -rf .rusty-build && npm run setup:all

Let the process finish completely.

The first build can take several minutes.

==================================================
9. START KACHAT
==================================================

Paste:

npm run dev

Wait for Terminal to display the Vite local address.

==================================================
10. OPEN KACHAT
==================================================

Open this address in a browser:

https://localhost:5173/

The browser may warn that the local development certificate is not trusted.

Choose the option to continue to the local page.

==================================================
STOP KACHAT
==================================================

Return to Terminal and press:

Control+C

==================================================
RUN KACHAT AGAIN LATER
==================================================

After the first setup has completed, open Terminal and paste:

cd ~/Downloads/KaChat-Desktop-main && npm run dev

Then open:

https://localhost:5173/

==================================================
COMMON FOLDER ERROR
==================================================

If Terminal reports:

cd: no such file or directory

Check the exact folder name:

ls ~/Downloads

Rename the downloaded project folder to:

KaChat-Desktop-main

Then run:

cd ~/Downloads/KaChat-Desktop-main

==================================================
CLEAR LOCAL KACHAT DATA
==================================================

KaChat stores test accounts and settings in the browser.

To remove them, clear browser site data for localhost.

==================================================
COPYING COMMANDS
==================================================

- Copy only the command text.
- Do not copy Terminal prompt symbols such as %, $, or ~.
- Do not add Markdown backticks.
- Run each numbered section in order.
