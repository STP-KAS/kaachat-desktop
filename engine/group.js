// Group-chat crypto + wire codec, a byte-for-byte port of iOS's GroupCipher.swift
// (itself a port of the Kasia web client's spike/groupchats reference). Keeping the
// derivations, AAD layout, nonce scheme, signing payloads, and on-chain payload
// format identical is what lets desktop groups interoperate with iOS/Android.
//
// Trust model: a single admin controls membership and per-epoch key rotation; all
// members share a symmetric epoch root key (forward secrecy at epoch granularity).
// Primitives match 1:1 messaging: ChaCha20-Poly1305 AEAD, HKDF-SHA256, secp256k1
// Schnorr (BIP340). This module is PURE crypto/codec — no tx building, storage, or
// network. The gctl control payloads it emits are JSON that the caller wraps in the
// existing 1:1 ECIES (KasiaCipher) channel; discovery/state live in higher layers.
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { schnorr } from "@noble/curves/secp256k1.js";

// --- byte helpers -----------------------------------------------------------
const UTF8 = new TextEncoder();
const FROM_UTF8 = new TextDecoder();

export function bytesToHex(bytes) {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export function hexToBytes(hex) {
  const clean = String(hex || "").trim().toLowerCase().replace(/^0x/, "");
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) throw new Error("Invalid hex string.");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Accepts a Uint8Array or a hex string, always returns Uint8Array.
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return hexToBytes(value);
  throw new Error("Expected bytes or hex string.");
}

function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

function utf8Bytes(str) { return UTF8.encode(String(str)); }

// 8-byte little-endian encoding of a u64 (epoch / message counter). Accepts a
// Number or BigInt; matches iOS's `value.littleEndian` over UInt64.
export function leBytes8(value) {
  let n = typeof value === "bigint" ? value : BigInt(Math.max(0, Math.floor(Number(value) || 0)));
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

// --- primitives -------------------------------------------------------------
export function groupSha256(input) {
  return sha256(typeof input === "string" ? utf8Bytes(input) : asBytes(input));
}

// HKDF-SHA256. Argument order mirrors iOS's hkdf(ikm, salt, info, outputByteCount).
export function hkdf(ikm, salt, info, length = 32) {
  return nobleHkdf(sha256, asBytes(ikm), asBytes(salt), asBytes(info), length);
}

// --- key derivation (exact info strings + endianness from iOS) --------------
// group_id = SHA256("ciph_msg:groupid" || group_seed)
export function deriveGroupId(groupSeed) {
  return groupSha256(concatBytes(utf8Bytes("ciph_msg:groupid"), asBytes(groupSeed)));
}
// group_root_epoch_N = HKDF(group_seed, salt = group_id || epoch_le, info = "kasia:groot")
export function deriveGroupRootEpoch(groupSeed, groupId, epoch) {
  return hkdf(asBytes(groupSeed), concatBytes(asBytes(groupId), leBytes8(epoch)), utf8Bytes("kasia:groot"));
}
// blinding_key = HKDF(group_seed, salt = group_id, info = "kasia:blinding_key")
export function deriveBlindingKey(groupSeed, groupId) {
  return hkdf(asBytes(groupSeed), asBytes(groupId), utf8Bytes("kasia:blinding_key"));
}
// blinded_group_id = HKDF(blinding_key, salt = member x-only pubkey, info = "kasia:blinded_gid")
export function deriveBlindedGroupId(blindingKey, memberXOnlyPubKey) {
  return hkdf(asBytes(blindingKey), asBytes(memberXOnlyPubKey), utf8Bytes("kasia:blinded_gid"));
}
// sender_id = SHA256(sender_address_string_bytes)
export function deriveSenderId(senderAddress) {
  return groupSha256(utf8Bytes(senderAddress));
}
// sender_key = HKDF(group_root, salt = group_id || epoch_le, info = "kasia:gcomm:key" || sender_id)
export function deriveSenderKey(groupRootEpoch, groupId, epoch, senderId) {
  return hkdf(asBytes(groupRootEpoch), concatBytes(asBytes(groupId), leBytes8(epoch)), concatBytes(utf8Bytes("kasia:gcomm:key"), asBytes(senderId)));
}
// sender_nonce_key = HKDF(group_root, salt = group_id || epoch_le, info = "kasia:gcomm:nonce" || sender_id)
export function deriveSenderNonceKey(groupRootEpoch, groupId, epoch, senderId) {
  return hkdf(asBytes(groupRootEpoch), concatBytes(asBytes(groupId), leBytes8(epoch)), concatBytes(utf8Bytes("kasia:gcomm:nonce"), asBytes(senderId)));
}
// nonce = HKDF(sender_nonce_key, salt = msg_id, info = "kasia:gcomm:nonce")[0:12]
export function deriveNonce(senderNonceKey, msgId) {
  return hkdf(asBytes(senderNonceKey), asBytes(msgId), utf8Bytes("kasia:gcomm:nonce"), 12);
}

export function deriveMessageKeys(groupRootEpoch, groupId, epoch, senderId, msgId) {
  const senderKey = deriveSenderKey(groupRootEpoch, groupId, epoch, senderId);
  const senderNonceKey = deriveSenderNonceKey(groupRootEpoch, groupId, epoch, senderId);
  const nonce = deriveNonce(senderNonceKey, msgId);
  return { senderKey, nonce };
}

// msg_id = device_id (16 bytes) || counter_le (8 bytes) = 24 bytes
export function buildMsgId(deviceId, counter) {
  return concatBytes(asBytes(deviceId), leBytes8(counter));
}

export function generateGroupSeed() { return crypto.getRandomValues(new Uint8Array(32)); }
export function generateDeviceId() { return crypto.getRandomValues(new Uint8Array(16)); }

// --- gcomm AEAD -------------------------------------------------------------
// AAD = version(0x01) || "gcomm" || group_id || epoch_le(8) || sender_id || msg_id
export function buildMessageAAD(groupId, epoch, senderId, msgId) {
  return concatBytes(new Uint8Array([0x01]), utf8Bytes("gcomm"), asBytes(groupId), leBytes8(epoch), asBytes(senderId), asBytes(msgId));
}

// Returns ciphertext || tag(16) — no nonce prefix (nonce is deterministic and
// recomputed on decrypt).
export function encryptGroupMessage({ plaintext, groupRootEpoch, groupId, epoch, senderId, msgId }) {
  const { senderKey, nonce } = deriveMessageKeys(groupRootEpoch, groupId, epoch, senderId, msgId);
  const aad = buildMessageAAD(groupId, epoch, senderId, msgId);
  return chacha20poly1305(senderKey, nonce, aad).encrypt(utf8Bytes(plaintext));
}

export function decryptGroupMessage({ ciphertextWithTag, groupRootEpoch, groupId, epoch, senderId, msgId }) {
  const ct = asBytes(ciphertextWithTag);
  if (ct.length < 16) throw new Error("Invalid group ciphertext.");
  const { senderKey, nonce } = deriveMessageKeys(groupRootEpoch, groupId, epoch, senderId, msgId);
  const aad = buildMessageAAD(groupId, epoch, senderId, msgId);
  return FROM_UTF8.decode(chacha20poly1305(senderKey, nonce, aad).decrypt(ct));
}

// --- Schnorr signing (raw BIP340 over arbitrary bytes) ----------------------
export function signBytes(message, privateKey) {
  return schnorr.sign(asBytes(message), asBytes(privateKey));
}
export function verifyBytes(signature, message, xOnlyPublicKey) {
  try { return schnorr.verify(asBytes(signature), asBytes(message), asBytes(xOnlyPublicKey)); }
  catch { return false; }
}
// x-only (32-byte) Schnorr public key for a private key.
export function xOnlyPublicKey(privateKey) {
  return schnorr.getPublicKey(asBytes(privateKey));
}

// Signing payloads (concatenations that get Schnorr-signed).
export function buildMessageSigningPayload(aad, ciphertextWithTag) {
  return concatBytes(asBytes(aad), asBytes(ciphertextWithTag));
}
// v || "gctl_root" || group_id || epoch_le || group_root_epoch || blinding_key || admin_signing_pub
export function buildRootSigningPayload({ v = 1, groupId, epoch, groupRootEpoch, blindingKey, adminSigningPub }) {
  return concatBytes(new Uint8Array([v]), utf8Bytes("gctl_root"), asBytes(groupId), leBytes8(epoch), asBytes(groupRootEpoch), asBytes(blindingKey), asBytes(adminSigningPub));
}
// v || "gctl_epoch" || group_id || epoch_le || reason
export function buildEpochSigningPayload({ v = 1, groupId, epoch, reason }) {
  return concatBytes(new Uint8Array([v]), utf8Bytes("gctl_epoch"), asBytes(groupId), leBytes8(epoch), utf8Bytes(reason));
}

// A self-addressed "I deleted this group" marker so a delete survives a seedless re-import
// (the recovery invite would otherwise resurrect the group). Signed by the deleter and only
// honored when the signature matches the reader's OWN key — nobody else can tombstone a group
// out from under you, and it can't touch other members' copies.
export function buildTombstoneSigningPayload({ v = 1, groupId }) {
  return concatBytes(new Uint8Array([v]), utf8Bytes("gctl_tombstone"), asBytes(groupId));
}

export function buildSignedTombstonePayload({ groupId, signingPub, privateKey }) {
  const sig = signBytes(buildTombstoneSigningPayload({ v: 1, groupId }), privateKey);
  return {
    type: "gctl_tombstone",
    v: 1,
    group_id: bytesToHex(asBytes(groupId)),
    signing_pub: bytesToHex(asBytes(signingPub)),
    sig: bytesToHex(sig),
  };
}

export function verifyTombstonePayload(payload) {
  try {
    const signingPayload = buildTombstoneSigningPayload({ v: payload.v ?? 1, groupId: payload.group_id });
    return verifyBytes(payload.sig, signingPayload, payload.signing_pub);
  } catch { return false; }
}

// --- gcomm on-chain payload codec -------------------------------------------
// kchat:1:gcomm:{blinded_group_id}:{epoch}:{sender_id}:{sender_pub}:{msg_id}:{ciphertext}:{signature}
// `kchat:` migration: write the new root, still read the legacy `ciph_msg:` root (tail identical).
const GCOMM_PREFIX = "kchat:1:gcomm:";        // write
const GCTL_PREFIX = "kchat:1:gctl:";          // write
const LEGACY_GCOMM_PREFIX = "ciph_msg:1:gcomm:"; // read-only
const LEGACY_GCTL_PREFIX = "ciph_msg:1:gctl:";   // read-only

// Returns the payload body after whichever known root it carries (new or legacy), or null.
function stripGroupPrefix(s, newPrefix, legacyPrefix) {
  if (s.startsWith(newPrefix)) return s.slice(newPrefix.length);
  if (s.startsWith(legacyPrefix)) return s.slice(legacyPrefix.length);
  return null;
}

export function buildGroupMessagePayload({ blindedGroupId, epoch, senderId, senderPubKey, msgId, ciphertext, signature }) {
  return GCOMM_PREFIX
    + bytesToHex(asBytes(blindedGroupId)) + ":"
    + String(epoch) + ":"
    + bytesToHex(asBytes(senderId)) + ":"
    + bytesToHex(asBytes(senderPubKey)) + ":"
    + bytesToHex(asBytes(msgId)) + ":"
    + bytesToHex(asBytes(ciphertext)) + ":"
    + bytesToHex(asBytes(signature));
}

export function parseGroupMessagePayload(payloadString) {
  const s = String(payloadString || "");
  const body = stripGroupPrefix(s, GCOMM_PREFIX, LEGACY_GCOMM_PREFIX);
  if (body == null) return null;
  const parts = body.split(":");
  if (parts.length !== 7) return null;
  try {
    const epoch = Number(parts[1]);
    if (!Number.isSafeInteger(epoch) || epoch < 0) return null;
    return {
      blindedGroupId: hexToBytes(parts[0]),
      epoch,
      senderId: hexToBytes(parts[2]),
      senderPubKey: hexToBytes(parts[3]),
      msgId: hexToBytes(parts[4]),
      ciphertext: hexToBytes(parts[5]),
      signature: hexToBytes(parts[6]),
    };
  } catch { return null; }
}

export const GROUP_PAYLOAD_PREFIXES = Object.freeze({ gcomm: GCOMM_PREFIX, gctl: GCTL_PREFIX });

// Builds the recipient-addressed gctl wire payload. `encryptedHex` is the gctl
// JSON already ECIES-encrypted to the recipient by the caller (KasiaCipher).
// ciph_msg:1:gctl:{recipient_xonly_pubkey_hex}:{encrypted_hex}
export function buildControlPayload({ recipientXOnlyPubKey, encryptedHex }) {
  return GCTL_PREFIX + bytesToHex(asBytes(recipientXOnlyPubKey)) + ":" + String(encryptedHex);
}

export function parseControlPayload(payloadString) {
  const s = String(payloadString || "");
  const rest = stripGroupPrefix(s, GCTL_PREFIX, LEGACY_GCTL_PREFIX);
  if (rest == null) return null;
  // Two on-wire shapes have to be accepted here:
  //  - live block scan / our own sends: {recipient_xonly(64 hex)}:{encrypted_hex}
  //  - indexer REST catch-up: the indexer strips the recipient routing prefix, so
  //    message_payload comes back as bare {encrypted_hex} (this is desktop's only
  //    source — no live block stream — and it matches iOS normalizeControlPayload).
  const idx = rest.indexOf(":");
  if (idx === 64 && /^[0-9a-f]{64}$/i.test(rest.slice(0, idx))) {
    try { return { recipientXOnlyPubKey: hexToBytes(rest.slice(0, idx)), encryptedHex: rest.slice(idx + 1) }; }
    catch { /* fall through to the no-recipient shape */ }
  }
  // No (valid) recipient prefix: the whole remainder is the encrypted hex.
  return { recipientXOnlyPubKey: null, encryptedHex: rest };
}

// --- gctl control payloads (JSON, signed) -----------------------------------
// Field names are the on-the-wire snake_case keys, matching iOS's CodingKeys so
// the JSON is identical across clients.
// `groupSeed` (optional) is included ONLY in the admin's self-addressed copy, so an admin can
// fully rebuild the group (any epoch) after a seedless re-import. It is NOT signed — instead
// the recipient verifies it by re-deriving group_id/blinding_key from it (see the consistency
// check in group-store._applyRoot), which cryptographically binds it to the signed fields.
// Members' copies omit it, and it is encrypted to the admin's own key, so members never see it.
export function buildSignedRootPayload({ groupId, epoch, groupRootEpoch, blindingKey, adminSigningPub, members, name, adminPrivateKey, groupSeed = null }) {
  const sig = signBytes(buildRootSigningPayload({ v: 1, groupId, epoch, groupRootEpoch, blindingKey, adminSigningPub }), adminPrivateKey);
  const payload = {
    type: "gctl_root",
    v: 1,
    group_id: bytesToHex(asBytes(groupId)),
    epoch: Number(epoch),
    group_root_epoch: bytesToHex(asBytes(groupRootEpoch)),
    blinding_key: bytesToHex(asBytes(blindingKey)),
    admin_signing_pub: bytesToHex(asBytes(adminSigningPub)),
    members: Array.isArray(members) ? members.slice() : [],
    name: String(name || ""),
    sig: bytesToHex(sig),
  };
  if (groupSeed) payload.group_seed = bytesToHex(asBytes(groupSeed));
  return payload;
}

export function verifyRootPayload(payload) {
  try {
    const signingPayload = buildRootSigningPayload({
      v: payload.v ?? 1,
      groupId: payload.group_id,
      epoch: payload.epoch,
      groupRootEpoch: payload.group_root_epoch,
      blindingKey: payload.blinding_key,
      adminSigningPub: payload.admin_signing_pub,
    });
    return verifyBytes(payload.sig, signingPayload, payload.admin_signing_pub);
  } catch { return false; }
}

export function buildSignedEpochPayload({ groupId, epoch, reason, adminPrivateKey }) {
  const sig = signBytes(buildEpochSigningPayload({ v: 1, groupId, epoch, reason }), adminPrivateKey);
  return {
    type: "gctl_epoch",
    v: 1,
    group_id: bytesToHex(asBytes(groupId)),
    epoch: Number(epoch),
    reason: String(reason),
    sig: bytesToHex(sig),
  };
}

export function verifyEpochPayload(payload, adminSigningPubHex) {
  try {
    const signingPayload = buildEpochSigningPayload({ v: payload.v ?? 1, groupId: payload.group_id, epoch: payload.epoch, reason: payload.reason });
    return verifyBytes(payload.sig, signingPayload, adminSigningPubHex);
  } catch { return false; }
}

// --- high-level seal / open --------------------------------------------------
// Encrypt + sign + encode a full gcomm payload. Caller supplies the epoch root
// for `epoch`, the sender's Schnorr key material, device id, and monotonic
// counter. Returns the on-chain payload string.
export function sealGroupMessage({ plaintext, groupId, epoch, groupRootEpoch, blindingKey, senderAddress, senderPrivateKey, senderXOnlyPub, deviceId, counter }) {
  const senderId = deriveSenderId(senderAddress);
  const msgId = buildMsgId(deviceId, counter);
  const pub = senderXOnlyPub != null ? asBytes(senderXOnlyPub) : xOnlyPublicKey(senderPrivateKey);
  const blindedGroupId = deriveBlindedGroupId(blindingKey, pub);
  const ciphertext = encryptGroupMessage({ plaintext, groupRootEpoch, groupId, epoch, senderId, msgId });
  const aad = buildMessageAAD(groupId, epoch, senderId, msgId);
  const signature = signBytes(buildMessageSigningPayload(aad, ciphertext), senderPrivateKey);
  return buildGroupMessagePayload({ blindedGroupId, epoch, senderId, senderPubKey: pub, msgId, ciphertext, signature });
}

// Verify the signature and decrypt a parsed gcomm message. `groupId` and
// `groupRootEpoch` are the caller's values for THIS group at parsed.epoch (the
// caller has already matched the blinded id and confirmed the sender's roster
// membership + sender_id == SHA256(address)). Throws on bad signature/decrypt.
export function openGroupMessage(parsed, { groupId, groupRootEpoch }) {
  const aad = buildMessageAAD(groupId, parsed.epoch, parsed.senderId, parsed.msgId);
  const ok = verifyBytes(parsed.signature, buildMessageSigningPayload(aad, parsed.ciphertext), parsed.senderPubKey);
  if (!ok) throw new Error("Group message signature verification failed.");
  return decryptGroupMessage({
    ciphertextWithTag: parsed.ciphertext,
    groupRootEpoch,
    groupId,
    epoch: parsed.epoch,
    senderId: parsed.senderId,
    msgId: parsed.msgId,
  });
}
