# KaChat Desktop — Local Builder Test

donation address - brt25.kas or kaspa:qqpzpn5e7enn2ylfdxvlwtm3829gn6j9z9dnnmcsw5arkgnurktty6ulgzkfk

Experimental local development build for builders to inspect and modify.

**Use only a new disposable testing wallet. Do not use a wallet containing valuable KAS.** Recovery phrases and private keys are currently stored in the browser's local storage.

## macOS requirements

You need:

- macOS Terminal
- Homebrew
- Node.js and npm
- Rust and Cargo
- LLVM, wasm-pack, and Binaryen

### 1. Install Homebrew only if `brew` is not already available

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

After Homebrew finishes, follow any PATH command it prints, or close Terminal and open it again.

Verify Homebrew:

```bash
brew --version
```

### 2. Install the required tools

```bash
brew install node llvm wasm-pack binaryen
```

Install Rust if it is not already installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

## Run the GitHub download locally

GitHub downloads the project as `KaChat-Desktop-main`. Safari may automatically unzip it into a blue folder.

### When Downloads contains the blue `KaChat-Desktop-main` folder

Paste this entire command into Terminal:

```bash
cd ~/Downloads/KaChat-Desktop-main && rm -rf node_modules package-lock.json && npm config set registry https://registry.npmjs.org/ && npm install && npm run setup:all && npm run dev
```

### When Downloads contains `KaChat-Desktop-main.zip`

Paste this entire command into Terminal:

```bash
cd ~/Downloads && rm -rf KaChat-Desktop-main && unzip -o 'KaChat-Desktop-main.zip' && cd KaChat-Desktop-main && rm -rf node_modules package-lock.json && npm config set registry https://registry.npmjs.org/ && npm install && npm run setup:all && npm run dev
```

The first setup can take several minutes because it builds the Kaspa WebAssembly files.

## Open KaChat Desktop

Leave Terminal running and open:

```text
https://localhost:5173/
```

Your browser may show a local certificate warning. Continue to `localhost` to open the local development page.

## Later launches

After the first setup succeeds:

```bash
cd ~/Downloads/KaChat-Desktop-main && npm run dev
```

Then open:

```text
https://localhost:5173/
```

## Stop the server

Return to Terminal and press:

```text
Control + C
```

## Reset local KaChat data

Wallets, recovery phrases, private keys, messages, and preferences created in this build may remain in that browser's local storage. Clear the site data for `localhost:5173` in the browser used for testing to remove them.

## Troubleshooting

### `zsh: command not found: brew`

Homebrew is not installed or is not yet in the Terminal PATH. Install Homebrew using the command above, follow the PATH instructions printed by the installer, and reopen Terminal.

### npm tries to access an internal OpenAI package address

Run this inside the project folder:

```bash
rm -rf node_modules package-lock.json && npm config set registry https://registry.npmjs.org/ && npm install
```

This public release intentionally does not include the broken internal `package-lock.json`.

This build is experimental and is not intended for storing valuable funds.
