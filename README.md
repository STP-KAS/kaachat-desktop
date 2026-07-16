# KaChat Browser Shell — Step 70

Step 70 makes the saved-account landing screen functional. Create New Account generates a real Rusty Kaspa keypair, saves the account in the browser account registry, creates an isolated wallet data scope, and signs into the new account. Existing Step 69 accounts migrate automatically into the registry.

Private keys remain stored in browser localStorage during this architecture phase. Encrypted key storage is a later security phase.

# KaspaEngine KaChat Shell — Step 59

Phase 3A adds a real Rusty Kaspa UTXO subscription for the active wallet. The subscription is rebuilt after RPC promotion/reconnect and triggers immediate balance and Kasia reconciliation; five-second polling remains the fallback.

The top-right action is now New Message. A new address sends an encrypted on-chain KaChat handshake request and stores the relationship as pending instead of silently creating a manual contact. Existing contacts remain compatible as legacy/manual contacts.

# KaspaEngine KaChat Shell — Step 56

Phase 2B node-pool foundation built from the verified Step 55 baseline.

- remembers the last successful RPC endpoint
- tries the last-good endpoint first on startup
- uses an 8-second direct-node timeout
- falls back to the Rusty Kaspa resolver with a 15-second timeout
- records endpoint successes, failures, latency, and last error
- persists node history in browser storage
- exposes node-pool history in Settings

This phase still maintains one active RPC connection. Warm standby, peer discovery,
and automatic multi-node failover are intentionally deferred to later phases.


## Step 57 — Phase 2C warm standby and failover

- Keeps one scored primary mainnet RPC and attempts to maintain one independent warm standby.
- Promotes a healthy standby when the primary heartbeat or an RPC operation fails.
- Rebuilds standby protection after promotion.
- Persists endpoint success/failure latency and failover history.
- Drives the header LED from actual runtime, primary, standby, failover, wallet, and Kasia states.


## Step 61
Fixes reciprocal handshake acceptance. A pending outgoing request is promoted to established when a valid encrypted incoming contextual message from that exact contact is successfully decrypted. Existing conversations are reconciled on startup, and normal desktop sends are then unlocked.


## Step 62

- Phase 3B live UTXO subscriptions now track the active wallet plus every known valid contact address.
- Contact-address activity triggers immediate balance and Kasia reconciliation; the 5-second indexer poll remains as fallback.
- Subscription tracking is rebuilt after contact creation, handshake establishment, reconnect, and RPC failover.
- Confirmed communication-request transactions now explicitly receive the same filled green delivery check as normal confirmed messages.


## Step 65
Incoming handshake discovery now mirrors original KaChat: the Kasia indexer sender/receiver/transaction row establishes the request, while decrypted metadata is optional. Legacy and alias-less handshakes are accepted. Contextual history is withheld until an incoming request is accepted.

## Step 66 — Account and session architecture frame

This step keeps the existing active wallet and protocol state intact while adding the KaChat V2-inspired Profile, account/session, storage, connection, diagnostics, and danger-zone UI frame. Account switching, wallet-scoped data migration, logout, and encrypted key storage are intentionally not activated yet.


## Step 69 regression repair

Fixed the saved-account screen crash caused by an undefined `shorten()` call. Logout now reliably transitions out of the app shell, and logged-out startup no longer prevents Rusty Kaspa/Kasia initialization from being registered.


## Step 73 account flow
- Create New Account opens 12/24-word generation directly.
- Import Existing Account accepts and validates a 12- or 24-word recovery phrase.
- Closing either flow while signed out returns to Saved Accounts and never opens the wallet-less chat shell.
- The redundant Accounts & Sessions modal was removed.
