KASPAENGINE / KACHAT BROWSER SHELL
LOCAL BUILDER TESTING INSTRUCTIONS

This is an experimental development build for builders to inspect and run locally.
Use only a new disposable testing wallet. Do not use a wallet holding valuable KAS.
Recovery phrases and private keys are currently stored in the browser's local storage.

============================================================
MAC REQUIREMENTS
============================================================

- macOS
- Terminal
- Node.js and npm
- Homebrew
- Rust / Cargo
- Homebrew packages: llvm, wasm-pack, and binaryen

Install Homebrew if it is not already installed:

/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

Install the required build tools:

brew install node llvm wasm-pack binaryen

Install Rust if it is not already installed:

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

============================================================
FIRST-TIME SETUP AND LAUNCH
============================================================

1. Download this ZIP into your Mac Downloads folder.

2. Open Terminal and paste this command exactly:

cd ~/Downloads && unzip -o 'KaspaEngine_KaChatShell_Step126_ProfileNameAndSearchScopeFix(2).zip' -d KaspaEngine_Step126 && cd KaspaEngine_Step126/KaspaEngine && npm install && npm run setup:all && npm run dev

3. Leave Terminal open while the application is running.

4. Open this local webpage in your browser:

https://localhost:5173/

Your browser may display a local-certificate privacy warning. Choose the option to
continue to localhost. The application is running only on your computer unless you
intentionally expose the Vite development server to another device or network.

============================================================
LATER LAUNCHES
============================================================

After the first-time setup has completed, use:

cd ~/Downloads/KaspaEngine_Step126/KaspaEngine && npm run dev

Then open:

https://localhost:5173/

============================================================
STOPPING THE LOCAL SERVER
============================================================

Return to the Terminal window and press:

Control + C

============================================================
RESETTING LOCAL APP DATA
============================================================

Accounts, recovery phrases, private keys, messages, and preferences created by this
build may remain in that browser's local storage. To remove them, clear the site data
for localhost:5173 in the browser used for testing.

This build is experimental and is not intended for storing valuable funds.
