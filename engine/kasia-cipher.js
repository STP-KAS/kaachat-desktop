// Runtime bridge to Kasia's actual cipher WASM.
// Source is vendored from Kasia-staging/cipher and built with `npm run setup:cipher`.

let cipherModule = null;

export async function loadKasiaCipher() {
  if (cipherModule) return cipherModule;

  try {
    // Keep this import runtime-only so Vite can still launch before the optional
    // cipher build exists. setup:cipher creates /cipher/cipher.js.
    const runtimePath = "/cipher/cipher.js";
    cipherModule = await import(/* @vite-ignore */ runtimePath);
    if (typeof cipherModule.default === "function") {
      await cipherModule.default();
    }
    return cipherModule;
  } catch (error) {
    cipherModule = null;
    throw new Error(
      `Kasia cipher runtime is not built. Run npm run setup:cipher, then refresh. (${error.message})`,
    );
  }
}


export async function deriveKasiaAliases(privateKeyHex, peerAddress) {
  const cipher = await loadKasiaCipher();
  if (typeof cipher.derive_my_alias !== "function" || typeof cipher.derive_their_alias !== "function") {
    throw new Error("Kasia cipher runtime is missing deterministic alias support. Re-run npm run setup:cipher.");
  }
  const myAlias = cipher.derive_my_alias(String(privateKeyHex), String(peerAddress));
  const theirAlias = cipher.derive_their_alias(String(privateKeyHex), String(peerAddress));
  return { myAlias, theirAlias };
}

export function isKasiaCipherLoaded() {
  return Boolean(cipherModule);
}

export async function encryptKasiaMessage(receiverAddress, clearText) {
  const cipher = await loadKasiaCipher();
  const encrypted = cipher.encrypt_message(String(receiverAddress), String(clearText));
  const encryptedHex = encrypted.to_hex();
  return {
    encryptedHex,
    encryptedBytes: hexToBytes(encryptedHex),
  };
}

export async function decryptKasiaMessage(encryptedHex, privateKeyHex) {
  const cipher = await loadKasiaCipher();
  const encrypted = new cipher.EncryptedMessage(String(encryptedHex));
  const privateKey = new cipher.PrivateKey(String(privateKeyHex));
  return cipher.decrypt_message(encrypted, privateKey);
}

function hexToBytes(hex) {
  const clean = String(hex || "").replace(/^0x/i, "");
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) {
    throw new Error("Invalid encrypted message hex.");
  }
  return Uint8Array.from(clean.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}
