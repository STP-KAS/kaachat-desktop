// Kasia protocol adapter for KaChatShell.
// Step 25 aligns this module with the actual Kasia source that was uploaded.
//
// Grounded reference from Kasia-staging:
// - src/config/protocol.ts
// - src/utils/message-payload.ts
// - src/service/account-service.ts
// - cipher/src/lib.rs
//
// Actual Kasia wire shape for direct COMM messages:
//
//   ciph_msg:1:comm:<alias>:<base64(encrypted_message_bytes)>
//
// The whole protocol string is UTF-8 encoded and placed in the Kaspa transaction
// payload. The message body in production should be encrypted with Kasia's
// cipher WASM. This shell currently keeps encryption as a preview placeholder
// until cipher is imported, but the prefix/header/alias/base64 container now
// matches Kasia's structure.

export const VERSION = "1";
export const DELIM = ":";
const DEFAULT_ALIAS = "KaChat";

export function toHex(value) {
  return Array.from(new TextEncoder().encode(String(value)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function fromHex(hex) {
  const clean = String(hex || "").replace(/^0x/i, "");
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return "";
  const bytes = clean.match(/.{1,2}/g).map((byte) => Number.parseInt(byte, 16));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function hexToBytes(hex) {
  const clean = String(hex || "").replace(/^0x/i, "");
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return new Uint8Array();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToBase64(bytes) {
  let binary = "";
  Uint8Array.from(bytes || []).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

export function base64ToBytes(value) {
  try {
    const binary = atob(String(value || ""));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

export function base64ToHex(value) {
  return Array.from(base64ToBytes(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeAlias(alias) {
  return String(alias || DEFAULT_ALIAS).trim().replace(/\s+/g, "_").slice(0, 32) || DEFAULT_ALIAS;
}

function normalizeAddress(address) {
  const value = String(address || "").trim();
  return value.startsWith("kaspa:") ? value : null;
}

function header(type) {
  const string = `${VERSION}${DELIM}${type}${DELIM}`;
  return { type, string, hex: toHex(string) };
}

function checksumHex(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const KASIA_PROTOCOL = Object.freeze({
  name: "kasia",
  version: Number(VERSION),
  prefix: Object.freeze({
    type: "ciph_msg",
    string: `ciph_msg${DELIM}`,
    hex: toHex(`ciph_msg${DELIM}`),
  }),
  headers: Object.freeze({
    HANDSHAKE: Object.freeze(header("handshake")),
    COMM: Object.freeze(header("comm")),
    PAYMENT: Object.freeze(header("payment")),
    SELF_STASH: Object.freeze(header("self_stash")),
    BROADCAST: Object.freeze(header("bcast")),
  }),
});

export const KASIA_INTEGRATION_STATUS = Object.freeze({
  protocolContainer: "matched-to-kasia",
  directMessageHeader: "ciph_msg:1:comm:<alias>:<base64>",
  encryption: "official-kasia-cipher-wasm-bridge-added",
  transactionPayload: "utf8-protocol-bytes",
  defaultMessageAmountKas: "0.2",
});

// Current preview body:
// - Production Kasia encrypts the clear text via cipher.encrypt_message(toAddress, text)
//   and then base64-encodes the encrypted bytes.
// - Until cipher is imported, this creates a deterministic preview encryptedHex from
//   UTF-8 text so the rest of the app uses the real Kasia container shape.
export function encodeMessageBody(text) {
  const clearText = String(text || "");
  const previewEncryptedHex = toHex(clearText);
  const encryptedBytes = hexToBytes(previewEncryptedHex);
  return {
    clearText,
    encryptedHex: previewEncryptedHex,
    base64Body: bytesToBase64(encryptedBytes),
    encrypted: false,
    encryptionMode: "plaintext-preview",
  };
}

export function decodeMessageBody(base64Body) {
  const encryptedHex = base64ToHex(base64Body);
  return {
    encryptedHex,
    bodyText: fromHex(encryptedHex),
    clearText: fromHex(encryptedHex),
    encrypted: false,
    encryptionMode: "plaintext-preview",
  };
}

export function buildCommMessage({
  text,
  alias = DEFAULT_ALIAS,
  sender = null,
  receiver = null,
  createdAt = Date.now(),
  conversationId = null,
  contactId = null,
  localNonce = null,
} = {}) {
  const recipientAlias = normalizeAlias(alias);
  const body = encodeMessageBody(text);
  const protocolString = `ciph_msg:${VERSION}:comm:${recipientAlias}:${body.base64Body}`;
  const protocolBytes = new TextEncoder().encode(protocolString);
  const payloadHex = toHex(protocolString);
  const messageId = checksumHex(`${createdAt}:${conversationId || ""}:${contactId || ""}:${localNonce || ""}:${protocolString}`);

  return {
    id: messageId,
    protocol: KASIA_PROTOCOL.name,
    version: Number(VERSION),
    type: KASIA_PROTOCOL.headers.COMM.type,
    messageType: KASIA_PROTOCOL.headers.COMM.type,
    recipientAlias,
    sender: normalizeAddress(sender),
    receiver: normalizeAddress(receiver),
    createdAt,
    conversationId,
    contactId,
    localNonce,
    headerHex: KASIA_PROTOCOL.headers.COMM.hex,
    prefixHex: KASIA_PROTOCOL.prefix.hex,
    clearText: body.clearText,
    encryptedHex: body.encryptedHex,
    base64Body: body.base64Body,
    protocolString,
    protocolBytes,
    payloadHex,
    payloadBytes: protocolBytes.length,
    encrypted: body.encrypted,
    encryptionMode: body.encryptionMode,
    encoding: "kasia-comm-v1",
    transport: "kasia-comm-preview",
    wireShape: "ciph_msg:1:comm:<alias>:<base64>",
    checksum: messageId,
  };
}

export function makeKasiaCommPayload(details) {
  return buildCommMessage(details);
}

export function parseCommMessage(protocolString) {
  const raw = String(protocolString || "");
  if (!raw.startsWith("ciph_msg:1:comm:")) return null;
  const parts = raw.split(DELIM);
  if (parts.length < 5) return null;
  const recipientAlias = parts[3] || "";
  const base64Body = parts.slice(4).join(DELIM);
  const decoded = decodeMessageBody(base64Body);
  const payloadHex = toHex(raw);

  return {
    protocol: KASIA_PROTOCOL.name,
    version: Number(VERSION),
    type: KASIA_PROTOCOL.headers.COMM.type,
    messageType: KASIA_PROTOCOL.headers.COMM.type,
    recipientAlias,
    encryptedHex: decoded.encryptedHex,
    bodyHex: decoded.encryptedHex,
    bodyText: decoded.bodyText,
    clearText: decoded.clearText,
    base64Body,
    protocolString: raw,
    payloadHex,
    payloadBytes: new TextEncoder().encode(raw).length,
    encrypted: decoded.encrypted,
    encryptionMode: decoded.encryptionMode,
    encoding: "kasia-comm-v1",
    wireShape: "ciph_msg:1:comm:<alias>:<base64>",
    checksum: checksumHex(raw),
  };
}

// Mirrors Kasia-staging/src/utils/message-payload.ts.
export function parseKasiaPayloadHex(payloadHex) {
  const payload = String(payloadHex || "").toLowerCase().replace(/^0x/, "");
  const payloadString = fromHex(payload);

  const comm = parseCommMessage(payloadString);
  if (comm) return comm;

  if (!payload.startsWith(KASIA_PROTOCOL.prefix.hex)) return null;
  const withoutPrefix = payload.slice(KASIA_PROTOCOL.prefix.hex.length);

  for (const entry of Object.values(KASIA_PROTOCOL.headers)) {
    if (!withoutPrefix.startsWith(entry.hex)) continue;

    const payloadWithoutPrefixStr = fromHex(withoutPrefix);
    const parts = payloadWithoutPrefixStr.split(DELIM);
    let alias;
    let scope;
    let encryptedHex = withoutPrefix.slice(entry.hex.length);

    if (entry.type === "comm" && parts.length >= 4) {
      alias = parts[2];
      encryptedHex = withoutPrefix.slice(entry.hex.length + 2 + alias.length * 2);
    }

    if (entry.type === "self_stash" && parts.length >= 4) {
      scope = parts[2];
      encryptedHex = withoutPrefix.slice(entry.hex.length + 2 + scope.length * 2);
    }

    return {
      protocol: KASIA_PROTOCOL.name,
      version: Number(VERSION),
      type: entry.type,
      messageType: entry.type,
      recipientAlias: alias,
      scope,
      encryptedHex,
      bodyHex: encryptedHex,
      bodyText: fromHex(encryptedHex),
      payloadHex: payload,
      payloadBytes: Math.ceil(payload.length / 2),
      protocolString: payloadString,
      checksum: checksumHex(payload),
    };
  }

  return {
    protocol: KASIA_PROTOCOL.name,
    version: Number(VERSION),
    type: "unknown",
    messageType: "unknown",
    bodyHex: withoutPrefix,
    bodyText: fromHex(withoutPrefix),
    payloadHex: payload,
    payloadBytes: Math.ceil(payload.length / 2),
    protocolString: payloadString,
    checksum: checksumHex(payload),
  };
}

export function decodePayload(payloadHexOrProtocolString) {
  const raw = String(payloadHexOrProtocolString || "").trim();
  if (!raw) return null;
  const cleanHex = raw.replace(/^0x/i, "").replace(/\s+/g, "");
  if (/^[0-9a-f]+$/i.test(cleanHex) && cleanHex.length % 2 === 0) {
    return parseKasiaPayloadHex(cleanHex);
  }
  return parseCommMessage(raw) || parseKasiaPayloadHex(toHex(raw));
}


export async function buildEncryptedCommMessage({
  text,
  alias = DEFAULT_ALIAS,
  sender = null,
  receiver = null,
  createdAt = Date.now(),
  conversationId = null,
  contactId = null,
  localNonce = null,
  encryptMessage,
} = {}) {
  if (typeof encryptMessage !== "function") throw new Error("Kasia cipher encryptor is required.");
  const normalizedReceiver = normalizeAddress(receiver);
  if (!normalizedReceiver) throw new Error("A valid kaspa: receiver address is required for encryption.");

  const recipientAlias = normalizeAlias(alias);
  const encryptedResult = await encryptMessage(normalizedReceiver, String(text || ""));
  const encryptedHex = String(encryptedResult?.encryptedHex || "");
  if (!encryptedHex) throw new Error("Kasia cipher returned an empty encrypted message.");

  const encryptedBytes = hexToBytes(encryptedHex);
  const base64Body = bytesToBase64(encryptedBytes);
  const protocolString = `ciph_msg:${VERSION}:comm:${recipientAlias}:${base64Body}`;
  const protocolBytes = new TextEncoder().encode(protocolString);
  const payloadHex = toHex(protocolString);
  const messageId = checksumHex(`${createdAt}:${conversationId || ""}:${contactId || ""}:${localNonce || ""}:${protocolString}`);

  return {
    id: messageId,
    protocol: KASIA_PROTOCOL.name,
    version: Number(VERSION),
    type: KASIA_PROTOCOL.headers.COMM.type,
    messageType: KASIA_PROTOCOL.headers.COMM.type,
    recipientAlias,
    sender: normalizeAddress(sender),
    receiver: normalizedReceiver,
    createdAt,
    conversationId,
    contactId,
    localNonce,
    headerHex: KASIA_PROTOCOL.headers.COMM.hex,
    prefixHex: KASIA_PROTOCOL.prefix.hex,
    clearText: String(text || ""),
    encryptedHex,
    base64Body,
    protocolString,
    protocolBytes,
    payloadHex,
    payloadBytes: protocolBytes.length,
    encrypted: true,
    encryptionMode: "kasia-cipher-wasm",
    encoding: "kasia-comm-v1",
    transport: "kasia-comm-encrypted",
    wireShape: "ciph_msg:1:comm:<alias>:<base64>",
    checksum: messageId,
  };
}


// Matches the real KaChat iOS/Android wire format exactly (verified against
// KaChat/Services/KaChatTransactionBuilder.swift and
// KaChatForAndroid .../util/MessageProtocol.kt + services/WalletService.kt):
//
//   bytes = ASCII("ciph_msg:1:handshake:") ++ <raw ECIES bytes>
//
// The encrypted body is RAW BINARY (nonce(12) + ephemeral pubkey(33) +
// ciphertext) concatenated directly after the ASCII prefix bytes — NOT
// hex-as-text and NOT base64 (unlike COMM, which embeds a base64 *string*
// inside the ascii protocol string). The previous implementation here
// interpolated the hex-encoded ciphertext as literal text into the protocol
// string and then UTF-8 encoded that whole string again, which silently
// doubled the ciphertext's byte length and made every handshake sent by this
// app undecryptable by any real Kasia/KaChat client.
//
// The cleartext JSON mirrors iOS's `HandshakePayload` (Models.swift), which
// emits both camelCase and legacy snake_case keys for backward compatibility;
// Android's `HandshakePayload` (models/Models.kt) accepts the camelCase set.
// `alias` is the deterministic alias derived via the same HKDF scheme as the
// vendored Rust cipher's `derive_their_alias` (i.e. the alias this wallet
// will tag its own outgoing COMM messages to this peer with), not a display
// name — callers must resolve this via `engine.deriveConversationAliases()`
// before calling this function.
export async function buildEncryptedHandshake({
  alias = "",
  sender = null,
  receiver = null,
  conversationId = null,
  isResponse = false,
  createdAt = Date.now(),
  encryptMessage,
} = {}) {
  if (typeof encryptMessage !== "function") throw new Error("Kasia cipher encryptor is required.");
  const normalizedReceiver = normalizeAddress(receiver);
  if (!normalizedReceiver) throw new Error("A valid kaspa: receiver address is required for the handshake.");

  const conversationIdValue = conversationId ? String(conversationId) : null;
  const handshakePayload = {
    type: "handshake",
    alias: String(alias || ""),
    timestamp: createdAt,
    conversationId: conversationIdValue,
    conversation_id: conversationIdValue,
    version: 1,
    recipientAddress: normalizedReceiver,
    recipient_address: normalizedReceiver,
    sendToRecipient: true,
    send_to_recipient: true,
  };
  if (isResponse) {
    handshakePayload.isResponse = true;
    handshakePayload.is_response = true;
  }
  const clearText = JSON.stringify(handshakePayload);

  const encrypted = await encryptMessage(normalizedReceiver, clearText);
  const encryptedHex = String(encrypted?.encryptedHex || "").replace(/^0x/i, "");
  if (!encryptedHex) throw new Error("Kasia cipher returned an empty handshake payload.");

  const prefixString = `ciph_msg:${VERSION}:handshake:`;
  const prefixBytes = new TextEncoder().encode(prefixString);
  const cipherBytes = hexToBytes(encryptedHex);
  const protocolBytes = new Uint8Array(prefixBytes.length + cipherBytes.length);
  protocolBytes.set(prefixBytes, 0);
  protocolBytes.set(cipherBytes, prefixBytes.length);
  const payloadHex = Array.from(protocolBytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return {
    id: checksumHex(`${createdAt}:${conversationId || ""}:${payloadHex}`),
    protocol: KASIA_PROTOCOL.name,
    version: Number(VERSION),
    type: KASIA_PROTOCOL.headers.HANDSHAKE.type,
    messageType: KASIA_PROTOCOL.headers.HANDSHAKE.type,
    sender: normalizeAddress(sender),
    receiver: normalizedReceiver,
    createdAt,
    conversationId,
    clearText,
    encryptedHex,
    protocolString: `${prefixString}<${cipherBytes.length} encrypted bytes>`,
    protocolBytes,
    payloadHex,
    payloadBytes: protocolBytes.length,
    encrypted: true,
    encryptionMode: "official-kasia-cipher-wasm",
    transport: "kasia-handshake-onchain",
    wireShape: "ciph_msg:1:handshake:<raw_encrypted_bytes>",
  };
}

// Matches iOS's KaChatTransactionBuilder.buildHandshakeSelfStashTx exactly.
// After a handshake succeeds, iOS sends a second, separate self-payment
// transaction whose payload is the same handshake metadata encrypted to the
// wallet's OWN address (not the peer's) — a private, on-chain-only backup of
// "which contacts I have and which aliases we use" that lets the wallet
// rebuild its contact/alias list purely from chain history plus the seed
// phrase, with no local database at all (e.g. after a reinstall or moving to
// a new device). Android has no equivalent of this feature.
//
//   bytes = ASCII("ciph_msg:1:self_stash:saved_handshake:") ++ <raw ECIES bytes, encrypted to self>
export const SELF_STASH_SCOPE = "saved_handshake";

export async function buildSelfStash({
  ourAlias,
  theirAlias = null,
  partnerAddress,
  isResponse = false,
  createdAt = Date.now(),
  encryptToSelf,
} = {}) {
  if (typeof encryptToSelf !== "function") throw new Error("Kasia cipher encryptor is required.");
  const normalizedPartner = normalizeAddress(partnerAddress);
  if (!normalizedPartner) throw new Error("A valid kaspa: partner address is required for the self-stash.");

  const stashPayload = {
    type: "handshake",
    alias: String(ourAlias || ""),
    timestamp: createdAt,
    version: 1,
    theirAlias: theirAlias || null,
    partnerAddress: normalizedPartner,
    recipientAddress: normalizedPartner,
  };
  if (isResponse) stashPayload.isResponse = true;
  // Matches iOS's compactMapValues — nil/absent fields are dropped, not sent as null.
  const sanitized = Object.fromEntries(Object.entries(stashPayload).filter(([, value]) => value !== null && value !== undefined));
  const clearText = JSON.stringify(sanitized);

  const encrypted = await encryptToSelf(clearText);
  const encryptedHex = String(encrypted?.encryptedHex || "").replace(/^0x/i, "");
  if (!encryptedHex) throw new Error("Kasia cipher returned an empty self-stash payload.");

  const prefixString = `ciph_msg:${VERSION}:self_stash:${SELF_STASH_SCOPE}:`;
  const prefixBytes = new TextEncoder().encode(prefixString);
  const cipherBytes = hexToBytes(encryptedHex);
  const protocolBytes = new Uint8Array(prefixBytes.length + cipherBytes.length);
  protocolBytes.set(prefixBytes, 0);
  protocolBytes.set(cipherBytes, prefixBytes.length);
  const payloadHex = Array.from(protocolBytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return {
    protocol: KASIA_PROTOCOL.name,
    version: Number(VERSION),
    type: KASIA_PROTOCOL.headers.SELF_STASH.type,
    messageType: KASIA_PROTOCOL.headers.SELF_STASH.type,
    scope: SELF_STASH_SCOPE,
    partnerAddress: normalizedPartner,
    createdAt,
    clearText,
    encryptedHex,
    protocolString: `${prefixString}<${cipherBytes.length} encrypted bytes>`,
    protocolBytes,
    payloadHex,
    payloadBytes: protocolBytes.length,
    encrypted: true,
    encryptionMode: "official-kasia-cipher-wasm",
    transport: "kasia-self-stash-onchain",
    wireShape: "ciph_msg:1:self_stash:saved_handshake:<raw_encrypted_bytes>",
  };
}

// Extracts the encrypted body from a raw self-stash tx payload (hex), tolerant
// of the same OP_RETURN/prefix variations handshake parsing tolerates.
export function selfStashEncryptedCandidates(payloadHex) {
  const clean = String(payloadHex || "").replace(/^0x/i, "").trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return [];
  const candidates = [];
  const add = (value) => {
    const normalized = String(value || "").replace(/^0x/i, "").trim().toLowerCase();
    if (normalized && normalized.length % 2 === 0 && /^[0-9a-f]+$/.test(normalized) && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };
  add(clean);
  let body = clean;
  if (body.startsWith("6a") && body.length >= 4) body = body.slice(4);
  add(body);
  const prefix = toHex(`ciph_msg:${VERSION}:self_stash:${SELF_STASH_SCOPE}:`);
  for (const value of [...candidates]) {
    if (value.startsWith(prefix)) add(value.slice(prefix.length));
  }
  return candidates;
}

export function parseSelfStashPayload(clearText) {
  const fallback = { alias: "", theirAlias: "", partnerAddress: "", isResponse: false };
  try {
    const parsed = JSON.parse(String(clearText || ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    return {
      alias: String(parsed.alias || "").trim(),
      theirAlias: String(parsed.theirAlias || "").trim(),
      partnerAddress: String(parsed.partnerAddress || parsed.recipientAddress || "").trim(),
      isResponse: Boolean(parsed.isResponse || false),
      timestamp: Number(parsed.timestamp || 0),
    };
  } catch {
    return fallback;
  }
}
