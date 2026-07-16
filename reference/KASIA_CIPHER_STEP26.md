# Step 26 — Kasia Cipher Bridge

This step vendors the actual `cipher` crate from the uploaded Kasia staging source and adds a browser WASM build/runtime bridge.

## What is real in this step

- Kasia's Rust cipher source is included under `vendor/kasia-cipher/`.
- `npm run setup:cipher` builds `cipher/cipher.js` and `cipher/cipher_bg.wasm` with `wasm-pack`.
- The engine dynamically loads the resulting cipher module.
- Real on-chain direct-message mode calls Kasia's `encrypt_message(receiverAddress, clearText)` before building the `ciph_msg:1:comm:<alias>:<base64>` payload.
- The encrypted protocol bytes are handed to the already-working Kaspa transaction builder/sign/broadcast path.

## Still pending

- Real inbound/indexer sync and transaction discovery.
- Automatic decryption of discovered incoming transactions.
- Handshake/contact alias protocol parity.
- Confirmation tracking from network DAA rather than immediate submitted state.
