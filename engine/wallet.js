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
