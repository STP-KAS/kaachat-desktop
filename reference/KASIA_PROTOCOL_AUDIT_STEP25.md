# Kasia Protocol Audit - Step 25

This checkpoint compared the KaChatShell engine against the uploaded Kasia source.

Important Kasia files inspected:

- `Kasia-staging/src/config/protocol.ts`
- `Kasia-staging/src/utils/message-payload.ts`
- `Kasia-staging/src/service/account-service.ts`
- `Kasia-staging/cipher/src/lib.rs`

## Direct COMM wire shape

Kasia direct messages use this payload container:

```text
ciph_msg:1:comm:<alias>:<base64(encrypted_message_bytes)>
```

The whole protocol string is UTF-8 encoded and placed into the Kaspa transaction payload.

## Message transaction amount

Kasia's `AccountService.sendMessageWithContext()` uses a minimum/default message amount of:

```text
0.2 KAS
```

Step 25 updates the app's on-chain message amount default to `0.2` so the tester follows Kasia's expected behavior.

## Encryption status

Kasia production encryption is handled by the `cipher` WASM crate:

```rust
encrypt_message(receiver_address, message)
decrypt_message(encrypted_message, private_key)
```

This app does **not** yet import the cipher WASM. Step 25 matches the Kasia payload container and transaction payload byte behavior, but message encryption is still marked as:

```text
plaintext-preview
```

Next required milestone for real Kasia-compatible private messages:

1. Build/import the Kasia `cipher` WASM.
2. Replace `encodeMessageBody()` with real `encrypt_message(receiver, text)`.
3. Replace `decodeMessageBody()` with real `decrypt_message(...)`.
4. Test one on-chain COMM payload against the Kasia decoder.
