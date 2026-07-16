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

export function generateMnemonicWallet(kaspa, wordCount = 24) {
  if (typeof kaspa.Mnemonic !== "function" || typeof kaspa.XPrv !== "function") {
    throw new Error("This Rusty Kaspa build does not expose mnemonic wallet support.");
  }
  const mnemonic = kaspa.Mnemonic.random(wordCount);
  return importMnemonic(kaspa, mnemonic.phrase);
}

export function importMnemonic(kaspa, phrase) {
  if (typeof kaspa.Mnemonic !== "function" || typeof kaspa.XPrv !== "function") {
    throw new Error("This Rusty Kaspa build does not expose mnemonic wallet support.");
  }
  const cleanPhrase = String(phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!cleanPhrase) throw new Error("Enter a recovery phrase.");
  const mnemonic = new kaspa.Mnemonic(cleanPhrase);
  const seed = mnemonic.toSeed();
  const master = new kaspa.XPrv(seed);
  const accountKey = master.derivePath("m/44'/111111'/0'/0/0").toPrivateKey();
  const privateKeyHex = accountKey.toString();
  const wallet = importPrivateKey(kaspa, privateKeyHex);
  return { ...wallet, mnemonic: cleanPhrase, derivationPath: "m/44'/111111'/0'/0/0" };
}

export function importPrivateKey(kaspa, hex) {
  const clean = validatePrivateKeyHex(hex);
  const privateKey = new kaspa.PrivateKey(clean);
  const address = addressFromPrivateKey(privateKey);
  return { privateKey, privateKeyHex: clean, address };
}
