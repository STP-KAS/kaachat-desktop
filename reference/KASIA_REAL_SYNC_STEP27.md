# Step 27 — Real Kasia inbound synchronization

This build replaces the conversation's preview sync path with the public Kasia indexer:

- Default endpoint: `https://indexer.kasia.fyi`
- API route: `/contextual-messages/by-sender`
- Sender filter: the selected contact's Kaspa address
- Alias filter: UTF-8 hex for `KaChat`
- Cursor: last indexed `block_time` stored per conversation
- Decryption: official Kasia cipher WASM using the active session private key

The indexer can return messages from the contact that were encrypted for other recipients. Those rows are intentionally discarded when cipher decryption fails. Only payloads decryptable by the active wallet become incoming chat bubbles.

Private keys remain in page memory only and are never sent to the indexer.
