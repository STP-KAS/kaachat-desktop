import { NETWORK_ID, validatePrivateKeyHex } from "./utils.js";

export function getPrivateKeyHexFromKeypair(keypair) {
  const pk = keypair.privateKey || keypair.private_key || keypair.secretKey || keypair.secret_key;
  if (!pk) throw new Error("Could not read private key from generated Keypair. Check console object exports.");
  return pk.toString();
}

export function addressFromPrivateKey(privateKey) {
  if (typeof privateKey.toAddress === "function") return privateKey.toAddress(NETWORK_ID).toString();
  if (typeof privateKey.toKeypair === "function") return privateKey.toKeypair().toAddress(NETWORK_ID).toString();
  throw new Error("PrivateKey object does not expose toAddress() or toKeypair().toAddress().");
}

export function generateWallet(kaspa) {
  const keypair = kaspa.Keypair.random();
  return importPrivateKey(kaspa, getPrivateKeyHexFromKeypair(keypair));
}

// Generate a fresh BIP39 phrase WITHOUT deriving an account, so the creation
// flow can show it for backup before an (optional) passphrase is applied.
export function generateMnemonicPhrase(kaspa, wordCount = 24) {
  if (typeof kaspa.Mnemonic !== "function") {
    throw new Error("This Rusty Kaspa build does not expose mnemonic wallet support.");
  }
  return kaspa.Mnemonic.random(wordCount).phrase;
}

export function generateMnemonicWallet(kaspa, wordCount = 24, passphrase = "") {
  if (typeof kaspa.Mnemonic !== "function" || typeof kaspa.XPrv !== "function") {
    throw new Error("This Rusty Kaspa build does not expose mnemonic wallet support.");
  }
  const mnemonic = kaspa.Mnemonic.random(wordCount);
  return importMnemonic(kaspa, mnemonic.phrase, passphrase);
}

// `passphrase` is the optional BIP39 25th word — it changes the derived seed,
// so the same phrase with a different passphrase yields a different wallet.
export function importMnemonic(kaspa, phrase, passphrase = "") {
  if (typeof kaspa.Mnemonic !== "function" || typeof kaspa.XPrv !== "function") {
    throw new Error("This Rusty Kaspa build does not expose mnemonic wallet support.");
  }
  const cleanPhrase = String(phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!cleanPhrase) throw new Error("Enter a recovery phrase.");
  const pass = String(passphrase || "");
  const mnemonic = new kaspa.Mnemonic(cleanPhrase);
  const seed = mnemonic.toSeed(pass);
  const master = new kaspa.XPrv(seed);
  const accountKey = master.derivePath("m/44'/111111'/0'/0/0").toPrivateKey();
  const privateKeyHex = accountKey.toString();
  const wallet = importPrivateKey(kaspa, privateKeyHex);
  return { ...wallet, mnemonic: cleanPhrase, derivationPath: "m/44'/111111'/0'/0/0", hasPassphrase: pass.length > 0 };
}

// --- Identity derivation-path families (iOS WalletSourceFamily port) --------
//
// Seeds imported from other wallets may keep their identity (funds, KNS
// domains) on a different derivation branch:
//   - kaspaStandard: m/44'/111111'/0'/0/{i} — KaChat, KasWare, Kaspium,
//     Kastle, Core Golang CLI, OKX, Ledger.
//   - kaspaLegacy972: m/44'/972/0'/0'/{i}' — KDX / Kaspanet web wallet. 972 is
//     deliberately NOT hardened (KasWare's hdPath string "m/44'/972/0'" has no
//     apostrophe on 972), while the change level and final index ARE hardened.
//   - oneKey: the standard m/44'/111111'/0'/0/{i} key, then a BIP340
//     taproot-style tweak — negate the private key if its compressed public
//     key has an odd Y, then add taggedHash("TapTweak", xOnlyPubkey) mod n.
//
// The spending chain always stays on KaChat's own m/44'/111111'/1' branch
// regardless of this choice, matching iOS.

export const WALLET_SOURCE_FAMILIES = ["kaspaStandard", "kaspaLegacy972", "oneKey"];

export function normalizeSourceFamily(family) {
  return WALLET_SOURCE_FAMILIES.includes(family) ? family : "kaspaStandard";
}

export function identityDerivationPath(family, index = 0) {
  const i = Math.max(0, Math.floor(Number(index) || 0));
  if (normalizeSourceFamily(family) === "kaspaLegacy972") return `m/44'/972/0'/0'/${i}'`;
  return `m/44'/111111'/0'/0/${i}`;
}

export function sourceFamilyPathDescription(family) {
  switch (normalizeSourceFamily(family)) {
    case "kaspaLegacy972": return "m/44'/972/0'";
    case "oneKey": return "m/44'/111111'/0' (OneKey)";
    default: return "m/44'/111111'/0'";
  }
}

const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

function hexToBytesLocal(hex) {
  const clean = String(hex || "").replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHexLocal(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// BIP340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data).
async function taggedSha256Hex(tag, dataHex) {
  const tagHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tag)));
  const data = hexToBytesLocal(dataHex);
  const buf = new Uint8Array(tagHash.length * 2 + data.length);
  buf.set(tagHash, 0);
  buf.set(tagHash, tagHash.length);
  buf.set(data, tagHash.length * 2);
  return bytesToHexLocal(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
}

// OneKey's BIP340 taproot-style key tweak, replicated from KasWare's
// _onekeyPrivateKeyFromOriginPrivateKey (bip340.ts) / iOS's
// oneKeyTweakedPrivateKey: negate if the compressed pubkey has an odd Y
// (0x03 prefix), then add taggedHash("TapTweak", xOnly) mod n.
export async function oneKeyTweakPrivateKeyHex(kaspa, privateKeyHex) {
  const priv = new kaspa.PrivateKey(privateKeyHex);
  const compressed = String(priv.toPublicKey().toString()).trim();
  if (!/^0[23][0-9a-fA-F]{64}$/.test(compressed)) {
    // Guard: never derive a silently-wrong key if the wasm build encodes
    // public keys differently than expected.
    throw new Error("This Rusty Kaspa build does not expose compressed public keys — OneKey import is unavailable.");
  }
  let d = BigInt(`0x${privateKeyHex}`) % SECP256K1_N;
  if (compressed.startsWith("03")) d = (SECP256K1_N - d) % SECP256K1_N;
  const xOnly = compressed.slice(2);
  const t = BigInt(`0x${await taggedSha256Hex("TapTweak", xOnly)}`) % SECP256K1_N;
  const tweaked = (d + t) % SECP256K1_N;
  if (tweaked === 0n) throw new Error("Invalid OneKey key tweak result.");
  return tweaked.toString(16).padStart(64, "0");
}

// Family-aware identity derivation at an arbitrary index. Async because the
// OneKey tweak needs WebCrypto SHA-256; standard/legacy families resolve
// immediately. Returns the same wallet shape as importMnemonic plus
// { sourceFamily, chattingIndex }.
export async function importMnemonicWithFamily(kaspa, phrase, passphrase = "", { family = "kaspaStandard", index = 0 } = {}) {
  if (typeof kaspa.Mnemonic !== "function" || typeof kaspa.XPrv !== "function") {
    throw new Error("This Rusty Kaspa build does not expose mnemonic wallet support.");
  }
  const cleanPhrase = String(phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!cleanPhrase) throw new Error("Enter a recovery phrase.");
  const pass = String(passphrase || "");
  const cleanFamily = normalizeSourceFamily(family);
  const cleanIndex = Math.max(0, Math.floor(Number(index) || 0));
  const mnemonic = new kaspa.Mnemonic(cleanPhrase);
  const seed = mnemonic.toSeed(pass);
  const master = new kaspa.XPrv(seed);
  const path = identityDerivationPath(cleanFamily, cleanIndex);
  let privateKeyHex = master.derivePath(path).toPrivateKey().toString();
  if (cleanFamily === "oneKey") privateKeyHex = await oneKeyTweakPrivateKeyHex(kaspa, privateKeyHex);
  const wallet = importPrivateKey(kaspa, privateKeyHex);
  return {
    ...wallet,
    mnemonic: cleanPhrase,
    derivationPath: path,
    sourceFamily: cleanFamily,
    chattingIndex: cleanIndex,
    hasPassphrase: pass.length > 0,
  };
}

// Spending-address chain: a second BIP44 *account* branch (account index 1') off
// the same seed, so it's derivable from the recovery phrase and matches iOS
// (WalletManager+SpendingAddresses) and Android (WalletManager.deriveSpendingAddress)
// byte-for-byte — the identity/chatting address is m/44'/111111'/0'/0/0.
export const SPENDING_ACCOUNT_INDEX = 1;
export function spendingDerivationPath(index) {
  const i = Math.max(0, Math.floor(Number(index) || 0));
  return `m/44'/111111'/${SPENDING_ACCOUNT_INDEX}'/0/${i}`;
}
export function deriveSpendingWallet(kaspa, phrase, index, passphrase = "") {
  if (typeof kaspa.Mnemonic !== "function" || typeof kaspa.XPrv !== "function") {
    throw new Error("This Rusty Kaspa build does not expose mnemonic wallet support.");
  }
  const cleanPhrase = String(phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!cleanPhrase) throw new Error("A recovery phrase is required to derive spending addresses.");
  const path = spendingDerivationPath(index);
  const mnemonic = new kaspa.Mnemonic(cleanPhrase);
  const seed = mnemonic.toSeed(String(passphrase || ""));
  const master = new kaspa.XPrv(seed);
  const accountKey = master.derivePath(path).toPrivateKey();
  const wallet = importPrivateKey(kaspa, accountKey.toString());
  return { ...wallet, derivationPath: path, index: Math.max(0, Math.floor(Number(index) || 0)) };
}

export function importPrivateKey(kaspa, hex) {
  const clean = validatePrivateKeyHex(hex);
  const privateKey = new kaspa.PrivateKey(clean);
  const address = addressFromPrivateKey(privateKey);
  return { privateKey, privateKeyHex: clean, address };
}
