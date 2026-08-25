// Encrypted Backup Envelope (v1) — the cross-platform at-rest encryption for
// cloud copies of the chat archive (the shared Nextcloud `kachat-backup.json`).
// iOS, Android and desktop all implement this codec identically; see
// MESSAGING.md "Encrypted Backup Envelope (v1)" in the iOS repo.
//
// Envelope (the file's ENTIRE content):
//   { "kachatEncryptedBackup": 1,
//     "cipher": "aes-256-gcm",
//     "nonce": "<base64, 12 random bytes, fresh per write>",
//     "ciphertext": "<base64, AES-256-GCM ciphertext with the 16-byte tag appended>",
//     "walletHint": "<first 8 bytes of SHA-256(walletAddress), hex>" }
//
// Key derivation (identical on every platform):
//   key = SHA-256( identity_private_key_bytes || UTF8("kachat-backup-v1") )
// where identity_private_key_bytes is the raw 32-byte private key of the
// chatting/identity address (m/44'/111111'/0'/0/0). Any device holding the
// seed derives the same key; nothing else can read the archive.
//
// Readers: legacy plaintext archives stay restorable indefinitely (a file whose
// top level lacks kachatEncryptedBackup == 1 passes through unchanged).
// Writers ALWAYS encrypt. A failed decrypt throws so callers abort before any
// upload — the existing remote file is never overwritten.

const BACKUP_KEY_SUFFIX = "kachat-backup-v1";
const BACKUP_NONCE_BYTES = 12;

export const BACKUP_DECRYPT_FAILED_MESSAGE =
  "Could not decrypt the backup. It may belong to a different account.";

function hexToBytes(hex) {
  const clean = String(hex || "").trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("Backup key material is not valid hex.");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Chunked btoa/atob — an archive with photos or group history can be megabytes,
// and String.fromCharCode(...bytes) would blow the call stack on one that size.
function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(String(base64 || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** First 8 bytes of SHA-256(walletAddress), hex — lets a device skip a foreign
 *  wallet's file without decrypting it. */
export async function backupWalletHint(walletAddress) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(walletAddress || "")));
  return bytesToHex(new Uint8Array(digest).slice(0, 8));
}

async function deriveBackupKey(identityPrivateKeyHex) {
  const keyBytes = hexToBytes(identityPrivateKeyHex);
  if (keyBytes.length !== 32) {
    throw new Error("Backup encryption needs the 32-byte identity private key.");
  }
  const suffix = new TextEncoder().encode(BACKUP_KEY_SUFFIX);
  const material = new Uint8Array(keyBytes.length + suffix.length);
  material.set(keyBytes, 0);
  material.set(suffix, keyBytes.length);
  const digest = await crypto.subtle.digest("SHA-256", material);
  material.fill(0);
  keyBytes.fill(0);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Parses `json` and returns the envelope object when it IS one (top level has
 *  kachatEncryptedBackup == 1), else null (legacy plaintext or unreadable —
 *  those flow to the existing plaintext validators unchanged). */
export function parseBackupEnvelope(json) {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object" && Number(parsed.kachatEncryptedBackup) === 1) return parsed;
  } catch { /* not JSON — let the legacy path report it */ }
  return null;
}

/** Encrypts a plaintext archive JSON string into the envelope (a JSON string,
 *  the file's entire content). Fresh random nonce per write. */
export async function sealBackupEnvelope(plaintextJson, identityPrivateKeyHex, walletAddress) {
  const key = await deriveBackupKey(identityPrivateKeyHex);
  const nonce = crypto.getRandomValues(new Uint8Array(BACKUP_NONCE_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(String(plaintextJson)),
  ));
  return JSON.stringify({
    kachatEncryptedBackup: 1,
    cipher: "aes-256-gcm",
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
    walletHint: await backupWalletHint(walletAddress),
  });
}

/**
 * The reader: envelope in, plaintext archive JSON out. Legacy plaintext passes
 * through unchanged. Throws BACKUP_DECRYPT_FAILED_MESSAGE on a walletHint
 * mismatch (foreign wallet, skipped without decrypting) or any decrypt failure
 * (wrong key, corrupt file) — callers abort before uploading anything.
 */
export async function openBackupEnvelope(json, identityPrivateKeyHex, walletAddress) {
  const envelope = parseBackupEnvelope(json);
  if (!envelope) return json;
  if (envelope.walletHint && walletAddress) {
    const expected = await backupWalletHint(walletAddress);
    if (String(envelope.walletHint).toLowerCase() !== expected) {
      throw new Error(BACKUP_DECRYPT_FAILED_MESSAGE);
    }
  }
  try {
    const key = await deriveBackupKey(identityPrivateKeyHex);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.nonce) },
      key,
      base64ToBytes(envelope.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error(BACKUP_DECRYPT_FAILED_MESSAGE);
  }
}
