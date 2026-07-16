# Step 29 — resilient RPC lifecycle

This step replaces the one-shot RPC assumption with a persistent connection manager modeled after KaChat's node-pool behavior:

- probes an existing RPC connection before reuse;
- serializes concurrent connect attempts;
- reconnects stale WebSockets automatically;
- runs a lightweight 20-second health heartbeat;
- retries balance and UTXO reads once after reconnect;
- retries submission of the same signed pending transaction once after reconnect;
- reuses the same healthy RPC client across balance, UTXO, and broadcast operations.

No UI or Kasia protocol changes were made.
