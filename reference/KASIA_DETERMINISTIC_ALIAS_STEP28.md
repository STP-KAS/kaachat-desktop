# Step 28 — KaChat deterministic aliases

Source tracing showed that contextual direct messages are indexed by sender address and a per-conversation alias, not by recipient address.

KaChat derives two aliases:

- `myAlias`: incoming/watch alias; the peer sends to this alias.
- `theirAlias`: outgoing/send alias; this wallet uses it when sending to the peer.

Both use secp256k1 ECDH and HKDF-SHA256 with a six-byte result encoded as 12 hex characters. The Rust WASM implementation in `vendor/kasia-cipher/src/lib.rs` mirrors `KaChat/Utilities/DeterministicAlias.swift`.
