// KNS (Kaspa Name Service) write path — domain registration and profile field
// editing via real, on-chain commit/reveal inscription transactions. Mirrors
// iOS/Android's from-scratch Bitcoin-Ordinals-style envelope exactly, but
// built entirely on native rusty-kaspa WASM SDK primitives (ScriptBuilder,
// createPayToScriptHashScript, encodePayToScriptHashSignatureScript,
// createInputSignature, addressFromScriptPublicKey) instead of hand-rolled
// Blake2b hashing or canonical push-data encoding.
//
// Redeem script layout (byte-identical to iOS/Android):
//   <push 32-byte x-only pubkey> OP_CHECKSIG OP_FALSE OP_IF
//     <push "kns"> OP_0 <push payload JSON>
//   OP_ENDIF
// The commit output pays into Blake2b256(redeem script) as a P2SH-style
// ScriptPublicKey (Kaspa address version 8). The reveal transaction spends
// that output, providing <signature><redeem script> as its signature script.
//
// This module builds and signs transactions but never decides amounts on its
// own beyond what's passed in — economics (fee tiers, dust, priority fees)
// live in KNS_ECONOMICS below, matching the documented indexer behavior.

import { NETWORK_ID, sompiToKaspaDisplay } from "./utils.js";
import {
  KNS_DEFAULT_MAINNET_URL,
  KNS_PROFILE_FIELD_KEYS,
  normalizeDomainLabel,
  KNSProfileLinkBuilder,
  checkDomainAvailability,
  fetchInscribeFeeTiers,
  resolveDomain,
  fetchProfileByAssetId,
  clearKnsCache,
} from "./kns.js";
import { sendPayloadTransaction } from "./transactions.js";

const KNS_TITLE_BYTES = new TextEncoder().encode("kns");
const MAX_PAYLOAD_BYTES = 520;

const OP_CHECKSIG = 0xac;
const OP_FALSE = 0x00;
const OP_IF = 0x63;
const OP_0 = 0x00;
const OP_ENDIF = 0x68;

export const KNS_REVENUE_ADDRESS_MAINNET = "kaspa:qyp4nvaq3pdq7609z09fvdgwtc9c7rg07fuw5zgeee7xpr085de59eseqfcmynn";

export const KNS_ECONOMICS = Object.freeze({
  revealPriorityFeeSompi: 2_000_000n, // 0.02 KAS, added on top of computed mass fee
  dustThresholdSompi: 10_000n,
  profileEditCommitSompi: 200_000_000n, // 2 KAS
  profileEditRevealSompi: 100_000_000n, // 1 KAS
  minRegistrationBalanceKas: 50, // fixed UX gate, deliberately generous
});

const FIELD_MAX_LENGTHS = Object.freeze({
  bio: 300,
  contactEmail: 254,
  x: 64,
  telegram: 64,
  github: 64,
  discord: 128,
  website: 2048,
  redirectUrl: 2048,
  avatarUrl: 2048,
  bannerUrl: 2048,
});

// Fixed order for sequential per-field writes (never concurrent).
export const PROFILE_FIELD_EDIT_ORDER = Object.freeze([
  "avatarUrl", "bannerUrl", "bio", "x", "website", "telegram", "discord", "contactEmail", "github", "redirectUrl",
]);

// --- payload construction ---------------------------------------------------
// Field order matters: it's part of the exact bytes inscribed and must match
// what the indexer expects to parse.

export function buildDomainCreatePayload(label) {
  return JSON.stringify({ op: "create", p: "domain", v: label });
}

export function buildAddProfilePayload(assetId, key, value) {
  return JSON.stringify({ op: "addProfile", id: assetId, key, value });
}

export function buildTransferPayload(assetId, toAddress) {
  return JSON.stringify({ op: "transfer", p: "domain", id: assetId, to: toAddress });
}

export function payloadByteLength(payloadJson) {
  return new TextEncoder().encode(payloadJson).length;
}

export function assertPayloadFits(payloadJson) {
  const len = payloadByteLength(payloadJson);
  if (len > MAX_PAYLOAD_BYTES) {
    throw new Error(`This value is too long to inscribe (${len} bytes, limit is ${MAX_PAYLOAD_BYTES}).`);
  }
  return len;
}

// --- field validation --------------------------------------------------------

// Validates one field's raw input, returning its trimmed stored value. An
// empty value is always allowed (clears the field). Throws with a
// user-presentable message on the first violation.
export function validateProfileFieldValue(key, rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) return "";

  const maxLen = FIELD_MAX_LENGTHS[key];
  if (maxLen && value.length > maxLen) {
    throw new Error(`This field must be ${maxLen} characters or fewer.`);
  }
  if (key === "contactEmail") {
    const parts = value.split("@");
    if (parts.length !== 2 || !parts[0] || !parts[1] || !parts[1].includes(".")) {
      throw new Error("Enter a valid email address.");
    }
  }
  if (key === "discord" && !KNSProfileLinkBuilder.discordUrl(value)) {
    throw new Error("Discord must be a numeric user ID or a discord.com/users/<id> link.");
  }
  return value;
}

// Validates every changed field before any spend happens. Returns a map of
// key -> validated value (only for keys present in `fields`).
export function validateProfileFields(fields) {
  const validated = {};
  for (const key of Object.keys(fields || {})) {
    if (!KNS_PROFILE_FIELD_KEYS.includes(key)) continue;
    validated[key] = validateProfileFieldValue(key, fields[key]);
  }
  return validated;
}

// --- registration economics --------------------------------------------------

export function registrationTierForLabel(label) {
  return Math.min(Math.max(String(label || "").length, 1), 5);
}

// feeTiers: {1: kas, 2: kas, ..., 5: kas} from fetchInscribeFeeTiers().
export function registrationAmounts(label, feeTiers, { isReservedDomain = false } = {}) {
  const tier = registrationTierForLabel(label);
  const feeForTier = feeTiers[tier] ?? feeTiers[5];
  if (feeForTier == null) throw new Error("Missing fee tier data for this domain length.");
  const revealKas = isReservedDomain ? 0 : feeForTier;
  const commitKas = revealKas <= 1 ? 2 : Math.round(revealKas * 1.05 * 100) / 100;
  return { tier, revealAmountKas: revealKas, commitAmountKas: commitKas };
}

// --- redeem script + commit address -----------------------------------------

// Derives the identity address's 32-byte x-only public key as a hex string
// (what the redeem script embeds — never a separate funding key, since all
// KNS activity is funded and settled from the single chatting/identity
// address in this app).
export function xOnlyPublicKeyHexFromPrivateKey(privateKey) {
  return privateKey.toPublicKey().toXOnlyPublicKey().toString();
}

// Builds the KNS redeem script for a given payload JSON string, keeping the
// live ScriptBuilder instance around (needed later to encode the reveal
// transaction's signature script — see buildRevealSignatureScript).
export function buildKnsRedeemScript(kaspa, xOnlyPubkeyHex, payloadJson) {
  const builder = new kaspa.ScriptBuilder();
  builder.addData(xOnlyPubkeyHex); // hex string -> decoded as the raw 32 pubkey bytes
  builder.addOp(OP_CHECKSIG);
  builder.addOp(OP_FALSE);
  builder.addOp(OP_IF);
  builder.addData(KNS_TITLE_BYTES);
  builder.addOp(OP_0);
  builder.addData(new TextEncoder().encode(payloadJson));
  builder.addOp(OP_ENDIF);

  const commitScriptPublicKey = builder.createPayToScriptHashScript();
  const commitAddress = kaspa.addressFromScriptPublicKey(commitScriptPublicKey, NETWORK_ID);
  if (!commitAddress) throw new Error("Failed to derive a commit address from the KNS redeem script.");
  return {
    builder,
    redeemScriptHex: builder.toString(),
    commitScriptPublicKey,
    commitAddress,
    commitAddressString: commitAddress.toString(),
  };
}

// Builds the final signature script for the reveal transaction's single
// input, given the already-computed input signature (hex) and the SAME
// ScriptBuilder instance used to build the commit output.
export function buildRevealSignatureScript(builder, signatureHex) {
  return builder.encodePayToScriptHashSignatureScript(signatureHex);
}

// --- commit transaction (funds the P2SH output) -----------------------------
// Reuses the same proven, tested UTXO-selection/fee/mass path as every other
// send in this app — the commit output is just a normal payment to the
// derived P2SH address, since Kaspa's Version::ScriptHash address encoding
// produces byte-identical scriptPublicKey bytes to
// ScriptBuilder.createPayToScriptHashScript().
export async function sendKnsCommitTransaction({ engine, commitAddressString, commitAmountKas, log = () => {} }) {
  if (!engine?.kaspa || !engine?.privateKey || !engine?.address) throw new Error("Load a wallet before starting a KNS transaction.");
  await engine.connect();
  const sendResult = await sendPayloadTransaction({
    kaspa: engine.kaspa,
    rpc: engine.rpc,
    withRpc: engine.withRpc.bind(engine),
    privateKey: engine.privateKey,
    sourceAddress: engine.address,
    destinationAddress: commitAddressString,
    amountKas: String(commitAmountKas),
    feeKas: "0",
    log,
  });
  const txid = sendResult.txids?.[0];
  if (!txid) throw new Error("Commit transaction did not return a transaction id.");
  return { txid, sendResult };
}

// --- reveal transaction (manually constructed, spends the commit output) ---
//
// Sighash for a Kaspa input is a function of (previous outpoint, the SPENT
// output's scriptPublicKey + amount, sequence) plus tx-wide fields — it does
// NOT depend on the spending/redeem script's content, so createInputSignature
// works here exactly as it would for a standard P2PK input, as long as the
// Transaction's input carries a `utxo` entry describing the real commit
// output. The redeem script is only needed afterward, to build the actual
// signature script the VM will execute.
const NATIVE_SUBNETWORK_ID_HEX = "00".repeat(20);
const SIGHASH_ALL = 0;

// revealAmountSompi is the documented *target* amount (tiered registration fee,
// or the fixed 1 KAS profile-edit reveal) — it's only used as a stand-in for
// the first, pre-fee mass-estimation pass. The real output value is always
// commitAmountSompi minus the transaction's actual computed fee: a Kaspa
// input/output balance leaves no room for both an exact preset output value
// and a real, market-accurate fee, so the commit amount is deliberately
// funded ~5% above the target (see registrationAmounts) specifically to
// leave this fee-derived remainder landing close to the intended amount.
export async function buildAndSubmitKnsReveal({
  engine,
  commitTxId,
  commitAmountSompi,
  commitScriptPublicKey,
  builder,
  revealTargetAddress,
  revealAmountSompi,
  signer = null,
  log = () => {},
}) {
  const kaspa = engine?.kaspa;
  // Optional signer ({ privateKey, address }) — the reveal input's signature
  // must come from the same key whose x-only pubkey the redeem script embeds,
  // which for spending-address KNS activity is NOT the chatting identity key.
  const privateKey = signer?.privateKey || engine?.privateKey;
  if (!kaspa || !privateKey) throw new Error("Load a wallet before revealing a KNS inscription.");

  const utxoEntry = {
    address: undefined,
    outpoint: { transactionId: commitTxId, index: 0 },
    amount: commitAmountSompi,
    scriptPublicKey: commitScriptPublicKey,
    blockDaaScore: 0n,
    isCoinbase: false,
  };
  const revealTargetScriptPublicKey = kaspa.payToAddressScript(revealTargetAddress);

  // Placeholder-sized signature script for mass estimation — a Schnorr
  // signature is always exactly 64 bytes (+1 sighash-type byte), so a dummy
  // signature of that size yields the exact same script length as the real one.
  const dummySignature = "00".repeat(65);
  const placeholderSigScript = buildRevealSignatureScript(builder, dummySignature);

  const draftTx = new kaspa.Transaction({
    version: 0,
    inputs: [{
      previousOutpoint: { transactionId: commitTxId, index: 0 },
      signatureScript: placeholderSigScript,
      sequence: 0n,
      sigOpCount: 1,
      utxo: utxoEntry,
    }],
    outputs: [{
      value: revealAmountSompi,
      scriptPublicKey: revealTargetScriptPublicKey,
    }],
    lockTime: 0n,
    subnetworkId: NATIVE_SUBNETWORK_ID_HEX,
    gas: 0n,
    payload: "",
  });

  log("Estimating KNS reveal transaction fee...");
  const massFee = kaspa.calculateTransactionFee(NETWORK_ID, draftTx, 1);
  if (massFee == null) throw new Error("Could not calculate the reveal transaction's network fee.");
  const totalFee = massFee + KNS_ECONOMICS.revealPriorityFeeSompi;
  const finalOutputValue = commitAmountSompi - totalFee;
  if (finalOutputValue < KNS_ECONOMICS.dustThresholdSompi) {
    throw new Error("Commit amount is too small to cover the reveal transaction's fee.");
  }

  draftTx.outputs = [{
    value: finalOutputValue,
    scriptPublicKey: revealTargetScriptPublicKey,
  }];

  log("Signing KNS reveal transaction...");
  const signatureHex = kaspa.createInputSignature(draftTx, 0, privateKey, SIGHASH_ALL);
  const finalSigScript = buildRevealSignatureScript(builder, signatureHex);
  draftTx.inputs = [{
    previousOutpoint: { transactionId: commitTxId, index: 0 },
    signatureScript: finalSigScript,
    sequence: 0n,
    sigOpCount: 1,
    utxo: utxoEntry,
  }];
  draftTx.finalize();

  log("Broadcasting KNS reveal transaction...");
  const submit = (rpc) => rpc.submitTransaction({ transaction: draftTx, allowOrphan: false });
  const response = await engine.withRpc(submit, { retries: 1, label: "KNS reveal broadcast" });
  const revealTxId = response?.transactionId || draftTx.id;
  return { txid: revealTxId, actualRevealAmountSompi: finalOutputValue, fee: totalFee };
}

// --- crash recovery ----------------------------------------------------------
// Persists just enough to retry a reveal if the browser/tab dies between the
// commit broadcast and the reveal broadcast, so a successfully-committed
// output is never silently stranded. Cleared as soon as the reveal succeeds.

const PENDING_COMMIT_KEY = "kachat-kns-pending-commit-v1";

function savePendingCommit(record) {
  try { localStorage.setItem(PENDING_COMMIT_KEY, JSON.stringify(record, (_, v) => typeof v === "bigint" ? v.toString() : v)); } catch {}
}

export function peekPendingKnsCommit() {
  try {
    const raw = localStorage.getItem(PENDING_COMMIT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearPendingKnsCommit() {
  try { localStorage.removeItem(PENDING_COMMIT_KEY); } catch {}
}

// --- verification polling ---------------------------------------------------

async function pollUntil(checkFn, { timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await checkFn().catch(() => null);
    if (result) return result;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// --- domain registration orchestration ---------------------------------------

// Registers a new KNS domain end to end: availability check, fee lookup,
// commit, reveal, and ownership-verification polling. Throws on any step
// that can't proceed; commit/reveal broadcast results are still returned via
// onStatus even if the final verification poll times out (the registration
// may still land — the indexer can lag behind the chain).
export async function inscribeDomain({ engine, label, onStatus = () => {}, log = () => {} }) {
  if (!engine?.kaspa || !engine?.privateKey || !engine?.address) throw new Error("Load a wallet before registering a domain.");
  const normalizedLabel = normalizeDomainLabel(label);
  if (!normalizedLabel) throw new Error("Enter a valid domain name (letters, numbers, and hyphens only).");
  const fullDomain = `${normalizedLabel}.kas`;

  onStatus({ status: "checking-availability" });
  const availability = await checkDomainAvailability(engine.address, fullDomain, { baseUrl: KNS_DEFAULT_MAINNET_URL });
  if (!availability.available) throw new Error(`${fullDomain} is already taken.`);

  onStatus({ status: "fetching-fees" });
  const feeTiers = await fetchInscribeFeeTiers({ baseUrl: KNS_DEFAULT_MAINNET_URL });
  const { commitAmountKas, revealAmountKas } = registrationAmounts(normalizedLabel, feeTiers, { isReservedDomain: availability.isReservedDomain });

  const payloadJson = buildDomainCreatePayload(normalizedLabel);
  assertPayloadFits(payloadJson);

  const xOnlyPubkeyHex = xOnlyPublicKeyHexFromPrivateKey(engine.privateKey);
  const { builder, redeemScriptHex, commitScriptPublicKey, commitAddressString } = buildKnsRedeemScript(engine.kaspa, xOnlyPubkeyHex, payloadJson);

  const revealTargetAddress = availability.isReservedDomain ? engine.address : KNS_REVENUE_ADDRESS_MAINNET;
  const commitAmountSompi = engine.kaspa.kaspaToSompi(String(commitAmountKas));
  const revealAmountSompi = engine.kaspa.kaspaToSompi(String(revealAmountKas));

  onStatus({ status: "committing", commitAmountKas, redeemScriptHex });
  const commit = await sendKnsCommitTransaction({ engine, commitAddressString, commitAmountKas, log });
  savePendingCommit({
    kind: "domain",
    label: normalizedLabel,
    commitTxId: commit.txid,
    commitAmountSompi,
    commitScriptPublicKeyHex: commitScriptPublicKey.script,
    redeemScriptHex,
    revealTargetAddress,
    revealAmountSompi,
    createdAt: Date.now(),
  });
  onStatus({ status: "committed", commitTxid: commit.txid });

  onStatus({ status: "revealing" });
  const reveal = await buildAndSubmitKnsReveal({
    engine,
    commitTxId: commit.txid,
    commitAmountSompi,
    commitScriptPublicKey,
    builder,
    revealTargetAddress,
    revealAmountSompi,
    log,
  });
  clearPendingKnsCommit();
  onStatus({ status: "revealed", revealTxid: reveal.txid });

  onStatus({ status: "verifying" });
  clearKnsCache(engine.address);
  const verified = await pollUntil(
    async () => {
      const resolution = await resolveDomain(fullDomain, { baseUrl: KNS_DEFAULT_MAINNET_URL });
      return resolution && resolution.ownerAddress === engine.address ? resolution : null;
    },
    { timeoutMs: 90_000 },
  );
  onStatus({ status: verified ? "confirmed" : "pending-confirmation", domain: fullDomain });

  return {
    domain: fullDomain,
    commitTxid: commit.txid,
    revealTxid: reveal.txid,
    verified: Boolean(verified),
    assetId: verified?.inscriptionId || null,
  };
}

// --- domain transfer orchestration -------------------------------------------

// Transfers a KNS domain to another address end to end (iOS
// KNSDomainTransferService port): ownership pre-check, transfer-payload
// commit/reveal pair, recipient-ownership verification polling.
//
// `signer` ({ privateKey, address }) selects the OWNER of the domain — it
// funds the commit, its x-only pubkey goes into the redeem script, its key
// signs both transactions, and it receives the reveal remainder (transfers
// return funds to the owner; only the inscription moves ownership). Defaults
// to the engine's chatting identity; pass a derived spending wallet's keypair
// to transfer a domain held by a spending address (iOS's
// fromSpendingAddressIndex analog).
//
// Amounts match the KNS web app's transfer submission: tx.amount=0 maps to a
// fixed 2 KAS commit; the reveal output is commit minus the actual fee.
export async function transferDomain({ engine, domain, assetId, toAddress, signer = null, onStatus = () => {}, log = () => {} }) {
  const privateKey = signer?.privateKey || engine?.privateKey;
  const sourceAddress = signer?.address || engine?.address;
  if (!engine?.kaspa || !privateKey || !sourceAddress) throw new Error("Load a wallet before transferring a domain.");

  const cleanAssetId = String(assetId || "").trim();
  if (!cleanAssetId) throw new Error("Missing domain asset id.");
  const fullDomain = String(domain || "").trim().toLowerCase();
  if (!fullDomain) throw new Error("Missing domain name.");

  // Recipient may be a .kas domain — resolve it to its owner address.
  let recipient = String(toAddress || "").trim();
  if (recipient.toLowerCase().endsWith(".kas")) {
    onStatus({ status: "resolving-recipient" });
    const resolution = await resolveDomain(recipient, { baseUrl: KNS_DEFAULT_MAINNET_URL });
    if (!resolution?.ownerAddress) throw new Error("Could not resolve the recipient KNS domain.");
    recipient = resolution.ownerAddress;
  }
  if (!recipient.startsWith("kaspa:")) throw new Error("Recipient must be a kaspa: address or a .kas domain.");
  try {
    if (engine.kaspa.Address?.validate && engine.kaspa.Address.validate(recipient) !== true) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("Recipient address is invalid.");
  }
  if (recipient.toLowerCase() === sourceAddress.toLowerCase()) {
    throw new Error("Recipient must be different from the sending address.");
  }

  // Ownership pre-check (best-effort — a resolver miss doesn't block; the
  // chain-side inscription rules are authoritative).
  onStatus({ status: "verifying-ownership" });
  const owned = await resolveDomain(fullDomain, { baseUrl: KNS_DEFAULT_MAINNET_URL }).catch(() => null);
  if (owned && owned.ownerAddress !== sourceAddress) {
    throw new Error("This domain is not owned by the sending address.");
  }

  const payloadJson = buildTransferPayload(cleanAssetId, recipient);
  assertPayloadFits(payloadJson);

  const xOnlyPubkeyHex = xOnlyPublicKeyHexFromPrivateKey(privateKey);
  const { builder, commitScriptPublicKey, commitAddressString } = buildKnsRedeemScript(engine.kaspa, xOnlyPubkeyHex, payloadJson);

  const commitAmountKas = 2;
  const commitAmountSompi = engine.kaspa.kaspaToSompi(String(commitAmountKas));

  onStatus({ status: "committing", commitAmountKas });
  await engine.connect();
  const commitSend = await sendPayloadTransaction({
    kaspa: engine.kaspa,
    rpc: engine.rpc,
    withRpc: engine.withRpc.bind(engine),
    privateKey,
    sourceAddress,
    destinationAddress: commitAddressString,
    amountKas: String(commitAmountKas),
    feeKas: "0",
    log,
  });
  const commitTxId = commitSend.txids?.[0];
  if (!commitTxId) throw new Error("Commit transaction did not return a transaction id.");
  onStatus({ status: "committed", commitTxid: commitTxId });

  onStatus({ status: "revealing" });
  const reveal = await buildAndSubmitKnsReveal({
    engine,
    commitTxId,
    commitAmountSompi,
    commitScriptPublicKey,
    builder,
    revealTargetAddress: sourceAddress,
    revealAmountSompi: commitAmountSompi, // pre-fee placeholder; real value = commit - fee
    signer: { privateKey, address: sourceAddress },
    log,
  });
  onStatus({ status: "revealed", revealTxid: reveal.txid });

  onStatus({ status: "verifying" });
  clearKnsCache(sourceAddress);
  clearKnsCache(recipient);
  const verified = await pollUntil(
    async () => {
      const resolution = await resolveDomain(fullDomain, { baseUrl: KNS_DEFAULT_MAINNET_URL });
      return resolution && resolution.ownerAddress === recipient ? resolution : null;
    },
    { timeoutMs: 90_000 },
  );
  onStatus({ status: verified ? "confirmed" : "pending-confirmation", domain: fullDomain });

  return {
    domain: fullDomain,
    recipientAddress: recipient,
    commitTxid: commitTxId,
    revealTxid: reveal.txid,
    verified: Boolean(verified),
  };
}

// --- profile field editing orchestration -------------------------------------

// Submits a single profile field edit end to end (commit + reveal). Does not
// validate — callers should validate all changed fields up front via
// validateProfileFields before starting any spend.
export async function submitProfileField({ engine, assetId, key, value, onStatus = () => {}, log = () => {} }) {
  if (!engine?.kaspa || !engine?.privateKey || !engine?.address) throw new Error("Load a wallet before editing your KNS profile.");
  if (!KNS_PROFILE_FIELD_KEYS.includes(key)) throw new Error(`Unknown profile field: ${key}`);

  const payloadJson = buildAddProfilePayload(assetId, key, value);
  assertPayloadFits(payloadJson);

  const xOnlyPubkeyHex = xOnlyPublicKeyHexFromPrivateKey(engine.privateKey);
  const { builder, redeemScriptHex, commitScriptPublicKey, commitAddressString } = buildKnsRedeemScript(engine.kaspa, xOnlyPubkeyHex, payloadJson);

  const commitAmountSompi = KNS_ECONOMICS.profileEditCommitSompi;
  const revealAmountSompi = KNS_ECONOMICS.profileEditRevealSompi;
  const commitAmountKas = sompiToKaspaDisplay(engine.kaspa, commitAmountSompi);
  const revealTargetAddress = engine.address;

  onStatus({ status: "committing", key });
  const commit = await sendKnsCommitTransaction({ engine, commitAddressString, commitAmountKas, log });
  savePendingCommit({
    kind: "profile",
    assetId,
    key,
    commitTxId: commit.txid,
    commitAmountSompi,
    commitScriptPublicKeyHex: commitScriptPublicKey.script,
    redeemScriptHex,
    revealTargetAddress,
    revealAmountSompi,
    createdAt: Date.now(),
  });
  onStatus({ status: "committed", key, commitTxid: commit.txid });

  onStatus({ status: "revealing", key });
  const reveal = await buildAndSubmitKnsReveal({
    engine,
    commitTxId: commit.txid,
    commitAmountSompi,
    commitScriptPublicKey,
    builder,
    revealTargetAddress,
    revealAmountSompi,
    log,
  });
  clearPendingKnsCommit();
  onStatus({ status: "revealed", key, revealTxid: reveal.txid });

  onStatus({ status: "verifying", key });
  const verified = await pollUntil(
    async () => {
      const profile = await fetchProfileByAssetId(assetId, { baseUrl: KNS_DEFAULT_MAINNET_URL, keys: [key] });
      const expectEmpty = value === "";
      const actual = profile?.[key] ?? null;
      if (expectEmpty) return actual == null ? { profile } : null;
      return actual === value ? { profile } : null;
    },
    { timeoutMs: 60_000 },
  );
  onStatus({ status: verified ? "confirmed" : "pending-confirmation", key });

  return { key, commitTxid: commit.txid, revealTxid: reveal.txid, verified: Boolean(verified) };
}

// Submits every changed field sequentially, in the fixed documented order,
// tolerating per-field failure (a failure on one field does not roll back or
// block the others — matches iOS/Android's partial-success behavior).
export async function submitProfileFields({ engine, assetId, fields, onStatus = () => {}, log = () => {} }) {
  const validated = validateProfileFields(fields);
  const results = [];
  for (const key of PROFILE_FIELD_EDIT_ORDER) {
    if (!(key in validated)) continue;
    try {
      const result = await submitProfileField({ engine, assetId, key, value: validated[key], onStatus, log });
      results.push({ key, ok: true, ...result });
    } catch (error) {
      results.push({ key, ok: false, error: error?.message || String(error) });
      onStatus({ status: "field-failed", key, error: error?.message || String(error) });
    }
  }
  return results;
}

// --- image upload (avatar/banner) --------------------------------------------
// Off-chain, wallet-signed REST upload — the returned URL is what actually
// gets written on-chain afterward via submitProfileField("avatarUrl"/"bannerUrl").

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Strips the script-push envelope signScriptHash() adds ([0x41][64-byte sig]
// [sighash-type byte]) to recover a plain 64-byte Schnorr signature, for use
// in contexts (like this REST API) that expect a bare signature, not a
// script-ready push.
async function rawSchnorrSignDigest(kaspa, privateKey, digestBytes) {
  const hex = bytesToHex(digestBytes);
  const scriptPush = kaspa.signScriptHash(hex, privateKey);
  return scriptPush.slice(2, 130);
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

// Retries the whole request once with the next signing mode if the server
// reports a signature-verification failure — the response body text (not
// just the HTTP status) must be inspected, since that's the only place the
// rejection reason appears.
export async function uploadKnsProfileImage({ engine, assetId, uploadType, blob, baseUrl = KNS_DEFAULT_MAINNET_URL }) {
  if (!engine?.kaspa || !engine?.privateKey) throw new Error("Load a wallet before uploading a KNS image.");
  if (uploadType !== "avatar" && uploadType !== "banner") throw new Error("uploadType must be 'avatar' or 'banner'.");

  const message = JSON.stringify({ assetId, uploadType });
  const utf8Bytes = new TextEncoder().encode(message);
  const modes = [
    () => engine.kaspa.signMessage({ message, privateKey: engine.privateKey }),
    async () => {
      if (utf8Bytes.length !== 32) throw new Error("message is not 32 bytes");
      return rawSchnorrSignDigest(engine.kaspa, engine.privateKey, utf8Bytes);
    },
    async () => rawSchnorrSignDigest(engine.kaspa, engine.privateKey, await sha256Bytes(utf8Bytes)),
  ];

  const base = String(baseUrl || KNS_DEFAULT_MAINNET_URL).replace(/\/+$/, "");
  const url = `${base}/upload/image`;
  const ext = blob.type === "image/png" ? "png" : "jpg";
  const filename = `${uploadType}-${assetId}.${ext}`;

  let lastErrorText = "";
  for (const mode of modes) {
    let signature;
    try {
      signature = await mode();
    } catch {
      continue;
    }

    const form = new FormData();
    form.append("signMessage", message);
    form.append("signature", signature);
    form.append("image", blob, filename);

    const response = await fetch(url, { method: "POST", body: form });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    if (response.ok && json?.success && json.data?.success) {
      const imageUrl = json.data.data?.imageUrl || json.data.imageUrl;
      if (!imageUrl) throw new Error("KNS image upload response did not include an image URL.");
      return { imageUrl };
    }

    lastErrorText = text || json?.message || json?.error || `HTTP ${response.status}`;
    const retryable = /signature verification failed|unauthorized/i.test(lastErrorText);
    if (!retryable) throw new Error(lastErrorText || "KNS image upload failed.");
  }
  throw new Error(lastErrorText || "KNS image upload failed.");
}
