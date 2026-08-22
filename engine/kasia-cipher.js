// Runtime bridge to Kasia's actual cipher WASM.
// Source is vendored from Kasia-staging/cipher and built with `npm run setup:cipher`.

let cipherModule = null;

export async function loadKasiaCipher() {
  if (cipherModule) return cipherModule;

  try {
    // Bundler-friendly relative import (mirrors engine/wasm-loader.js). The old absolute,
    // @vite-ignore'd "/cipher/cipher.js" only works on the dev server: a production `vite build`
    // never emitted it, so a statically-served build 404'd → SPA fallback served index.html →
    // "expected a JS module but got text/html". A dynamic relative import makes rolldown bundle
    // the cipher glue AND emit cipher_bg.wasm as a hashed asset.
    cipherModule = await import("../cipher/cipher.js");
    if (typeof cipherModule.default === "function") {
      // Fetch the wasm ourselves and instantiate from bytes, bypassing instantiateStreaming's
      // application/wasm MIME requirement (a reverse proxy / static host often serves it wrong).
      const wasmUrl = new URL("../cipher/cipher_bg.wasm", import.meta.url);
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`Could not fetch Kasia cipher WASM (HTTP ${response.status}) from ${wasmUrl.pathname}`);
      const bytes = await response.arrayBuffer();
      await cipherModule.default({ module_or_path: bytes });
    }
    return cipherModule;
  } catch (error) {
    cipherModule = null;
    throw new Error(
      `Kasia cipher runtime failed to load. If this is a build, ensure npm run setup:cipher ran before it. (${error.message})`,
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
