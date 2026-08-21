import { NETWORK_ID, validateMainnetAddress, sompiToKaspaDisplay } from "./utils.js";

// Every real send (messages, handshakes, self-stash, KAS payments, KNS
// commits) funnels through sendKaspa()'s UTXO-fetch-then-spend window below.
// Firing several of these concurrently — e.g. a user sending multiple chat
// messages in quick succession — lets two calls fetch the same unspent UTXOs
// before either has broadcast, so both try to spend them and one fails.
// Keyed per source address (not global) so unrelated addresses never wait on
// each other; queued per address since they share one UTXO pool.
const sendQueues = new Map();

function enqueueSend(sourceAddress, task) {
  const previous = sendQueues.get(sourceAddress) || Promise.resolve();
  const next = previous.then(task, task).finally(() => {
    if (sendQueues.get(sourceAddress) === next) sendQueues.delete(sourceAddress);
  });
  sendQueues.set(sourceAddress, next);
  return next;
}

export async function getBalance(kaspa, rpc, address) {
  const response = await rpc.getUtxosByAddresses([address]);
  const entries = response.entries || [];
  const totalSompi = entries.reduce((sum, u) => sum + BigInt(u.amount), 0n);
  return {
    entries,
    totalSompi,
    totalKas: sompiToKaspaDisplay(kaspa, totalSompi),
    utxoCount: entries.length,
  };
}

export async function sendKaspa({ kaspa, rpc, withRpc = null, privateKey, sourceAddress, destinationAddress, amountKas, feeKas = "0", payload = null, selectedOutpoints = null, log = () => {} }) {
  return enqueueSend(sourceAddress, () => sendKaspaWithUtxoRetry({ kaspa, rpc, withRpc, privateKey, sourceAddress, destinationAddress, amountKas, feeKas, payload, selectedOutpoints, log }));
}

// Consolidate ("compound") every UTXO at `sourceAddress` into a single self-output with NO change,
// matching iOS's Compound UTXOs. A plain self-send that leaves a tiny change output gets rejected
// by Kaspa's KIP-9 storage-mass rule (why the earlier attempt failed) - so this is a true sweep:
// two passes - probe the fee for a near-full self-send, then send exactly (total - fee) so the
// generator emits one output and folds any sub-dust remainder into the fee.
export async function sweepAllToSelf({ kaspa, rpc, withRpc = null, privateKey, sourceAddress, log = () => {} }) {
  return enqueueSend(sourceAddress, () => sweepAllToSelfNow({ kaspa, rpc, withRpc, privateKey, sourceAddress, log }));
}
async function sweepAllToSelfNow({ kaspa, rpc, withRpc, privateKey, sourceAddress, log }) {
  const fetchUtxos = (activeRpc) => activeRpc.getUtxosByAddresses([sourceAddress]);
  let { entries } = withRpc
    ? await withRpc(fetchUtxos, { retries: 1, label: "Compound UTXO fetch" })
    : await fetchUtxos(rpc);
  if (!entries || entries.length === 0) throw new Error("No UTXOs to compound.");
  entries.sort((a, b) => BigInt(a.amount) > BigInt(b.amount) ? 1 : -1);
  const total = entries.reduce((sum, e) => sum + BigInt(e.amount || 0), 0n);

  // Pass 1: fee for a self-send of ~95% of the balance (leaves ample headroom the generator covers).
  const probe = await kaspa.createTransactions({
    entries,
    outputs: [{ address: sourceAddress, amount: total - (total / 20n) }],
    priorityFee: 0n,
    changeAddress: sourceAddress,
    networkId: NETWORK_ID,
  });
  const feeSompi = BigInt(probe.summary?.fees ?? 0n);
  const amount = total - feeSompi;
  if (amount <= 0n) throw new Error("Balance too low to compound after network fees.");

  // Pass 2: send exactly (total - fee) to self -> single output, sub-dust remainder folded into fee.
  const result = await kaspa.createTransactions({
    entries,
    outputs: [{ address: sourceAddress, amount }],
    priorityFee: 0n,
    changeAddress: sourceAddress,
    networkId: NETWORK_ID,
  });
  const txids = [];
  for (const pending of result.transactions) {
    await pending.sign([privateKey]);
    const submitSigned = (activeRpc) => pending.submit(activeRpc);
    const txid = withRpc
      ? await withRpc(submitSigned, { retries: 1, label: "Compound broadcast" })
      : await submitSigned(rpc);
    txids.push(txid);
    log("Compound txid:", txid);
  }
  return { result, txids };
}

// True "Max" send to a recipient: probe the exact fee for spending every input, then send
// exactly (total - totalFee) with the difference over the base fee paid as priority — so the
// generator emits a SINGLE output and folds any sub-dust remainder into the fee. A near-max
// amount sent through the normal path can't work: whatever tiny remainder is left becomes a
// dust change output, and Kaspa's KIP-9 storage-mass rule rejects the transaction (the same
// reason sweepAllToSelf above is a two-pass exact sweep). `totalFeeSompi` is the UI's
// displayed policy fee; it is clamped up to the generator's own base fee if too low.
export async function sendMaxKaspa(args) {
  return enqueueSend(args.sourceAddress, () => sendMaxKaspaNow(args));
}
async function sendMaxKaspaNow({ kaspa, rpc, withRpc = null, privateKey, sourceAddress, destinationAddress, totalFeeSompi = null, selectedOutpoints = null, log = () => {} }) {
  const fetchUtxos = (activeRpc) => activeRpc.getUtxosByAddresses([sourceAddress]);
  let { entries } = withRpc
    ? await withRpc(fetchUtxos, { retries: 1, label: "Max send UTXO fetch" })
    : await fetchUtxos(rpc);
  if (!entries || entries.length === 0) throw new Error("No UTXOs to send.");
  if (selectedOutpoints && selectedOutpoints.length) {
    const wanted = new Set(selectedOutpoints);
    entries = entries.filter((entry) => {
      const outpoint = entry.outpoint || {};
      return wanted.has(`${outpoint.transactionId}:${outpoint.index}`);
    });
    if (entries.length === 0) throw new Error("The selected coins are no longer available.");
  }
  entries.sort((a, b) => BigInt(a.amount) > BigInt(b.amount) ? 1 : -1);
  // One all-schnorr-input transaction tops out near the standard mass ceiling around ~85
  // inputs — the generator would split into a chain, but a max send must be a single tx.
  if (entries.length > 80) {
    throw new Error("Too many coins for one transaction — run Compound UTXOs first, then send Max.");
  }
  const total = entries.reduce((sum, e) => sum + BigInt(e.amount || 0), 0n);

  // Measure the exact network-floor fee for this transaction shape (all inputs, ONE output)
  // on a draft, then build the real thing manually: outputs are exactly (total - fee), so no
  // change output can ever exist — the generator's own change/dust handling is what kept
  // tripping KIP-9 on near-max amounts. Mirrors the KNS reveal's manual-build approach.
  const draft = kaspa.createTransaction(entries, [{ address: destinationAddress, amount: total - (total / 20n) }], 0n);
  const floorFeeSompi = BigInt(kaspa.calculateTransactionFee(NETWORK_ID, draft, 1) ?? 0n);
  let totalFee = totalFeeSompi != null ? BigInt(totalFeeSompi) : floorFeeSompi;
  if (totalFee < floorFeeSompi) totalFee = floorFeeSompi;
  const amount = total - totalFee;
  if (amount <= 0n) throw new Error("Balance too low after network fees.");

  const tx = kaspa.createTransaction(entries, [{ address: destinationAddress, amount }], 0n);
  const signed = kaspa.signTransaction(tx, [privateKey], true);
  const submit = (activeRpc) => activeRpc.submitTransaction({ transaction: signed, allowOrphan: false });
  const response = withRpc
    ? await withRpc(submit, { retries: 1, label: "Max send broadcast" })
    : await submit(rpc);
  const txid = response?.transactionId || signed.id;
  log("Max send txid:", txid);
  return { txids: [txid], amountSompi: amount };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Back-to-back self-sends (spamming chat/group messages) each spend the wallet's UTXO and
// create a change UTXO that the node's confirmed UTXO set doesn't reflect for a moment. The
// next queued send then finds no spendable UTXO (or tries to spend the just-spent one and the
// mempool rejects it as already-spent/orphan) until the change lands. These are TRANSIENT: a
// short wait + refetch succeeds. We retry ONLY on those UTXO-availability symptoms - never on a
// generic network error (withRpc already handles node failover) or a real "insufficient funds",
// and never after a tx was actually accepted (a returned result never reaches the retry). This
// makes rapid message sending reliable without needing full UTXO-chaining.
function isTransientUtxoError(error) {
  const m = String(error?.message || error || "").toLowerCase();
  return m.includes("no utxos") ||
    m.includes("insufficient") ||
    m.includes("already spent") ||
    m.includes("orphan") ||
    m.includes("outpoint") ||
    (m.includes("utxo") && m.includes("not found"));
}

async function sendKaspaWithUtxoRetry(params) {
  const maxAttempts = 5;
  const retryDelayMs = 1200;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await sendKaspaNow(params);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientUtxoError(error)) throw error;
      params.log?.(`Send attempt ${attempt} hit a transient UTXO state (${error.message}); retrying in ${retryDelayMs}ms.`);
      await sleep(retryDelayMs);
    }
  }
  throw lastError;
}

async function sendKaspaNow({ kaspa, rpc, withRpc = null, privateKey, sourceAddress, destinationAddress, amountKas, feeKas = "0", payload = null, selectedOutpoints = null, log = () => {} }) {
  const to = validateMainnetAddress(destinationAddress);
  const amount = String(amountKas || "").trim();
  const fee = String(feeKas || "0").trim();
  if (!amount || Number(amount) <= 0) throw new Error("Amount must be greater than 0.");

  const fetchUtxos = (activeRpc) => activeRpc.getUtxosByAddresses([sourceAddress]);
  let { entries } = withRpc
    ? await withRpc(fetchUtxos, { retries: 1, label: "UTXO refresh" })
    : await fetchUtxos(rpc);
  if (!entries || entries.length === 0) throw new Error("No UTXOs found. Fund the receive address first.");

  // Coin control: if the caller picked specific UTXOs, spend only those (mirrors
  // iOS's manualUtxos). An outpoint is keyed as "transactionId:index".
  if (selectedOutpoints && selectedOutpoints.length) {
    const wanted = new Set(selectedOutpoints);
    entries = entries.filter((entry) => {
      const outpoint = entry.outpoint || {};
      return wanted.has(`${outpoint.transactionId}:${outpoint.index}`);
    });
    if (entries.length === 0) throw new Error("None of the selected UTXOs are still available. Refresh and try again.");
  }
  entries.sort((a, b) => BigInt(a.amount) > BigInt(b.amount) ? 1 : -1);

  if (payload) {
    const payloadKind = payload instanceof Uint8Array ? "Uint8Array" : typeof payload;
    const payloadLength = payload instanceof Uint8Array ? payload.length : String(payload).length;
    log("Payload:", payloadKind, payloadLength, "bytes/chars");
  }
  log("Creating transaction from", sourceAddress, "to", to, "amount", amount, "KAS");
  const result = await kaspa.createTransactions({
    entries,
    outputs: [{ address: to, amount: kaspa.kaspaToSompi(amount) }],
    priorityFee: kaspa.kaspaToSompi(fee),
    changeAddress: sourceAddress,
    networkId: NETWORK_ID,
    ...(payload ? { payload } : {}),
  });
  log("Transaction summary:", result.summary);

  const txids = [];
  for (const pending of result.transactions) {
    await pending.sign([privateKey]);
    const submitSignedTransaction = (activeRpc) => pending.submit(activeRpc);
    const txid = withRpc
      ? await withRpc(submitSignedTransaction, { retries: 1, label: "Transaction broadcast" })
      : await submitSignedTransaction(rpc);
    txids.push(txid);
    log("Broadcast txid:", txid);
  }
  return { result, txids };
}


// Builds (but never signs or submits) a representative transaction to read
// its real, SDK-calculated network fee back out of the generator summary —
// used for the composer's "Show Fee Estimate" preference. payloadBytes is an
// estimate of the real Kasia COMM payload's byte length for the draft text,
// since mass (and therefore fee) scales with payload size.
// Builds the representative tx and returns { feeSompi, massGrams } from the generator summary.
async function estimateOnchainFeeDetail({ kaspa, rpc, withRpc = null, sourceAddress, amountKas = "0.2", payloadBytes = 0, selectedOutpoints = null }) {
  const fetchUtxos = (activeRpc) => activeRpc.getUtxosByAddresses([sourceAddress]);
  let { entries } = withRpc
    ? await withRpc(fetchUtxos, { retries: 1, label: "Fee estimate UTXO refresh" })
    : await fetchUtxos(rpc);
  if (!entries || entries.length === 0) return null;
  // Coin control: estimate against exactly the chosen UTXOs (matches iOS passing manualUtxos to
  // its fee estimate) so the fee reflects those inputs' mass, not an automatic selection.
  if (selectedOutpoints && selectedOutpoints.length) {
    const wanted = new Set(selectedOutpoints);
    entries = entries.filter((entry) => {
      const outpoint = entry.outpoint || {};
      return wanted.has(`${outpoint.transactionId}:${outpoint.index}`);
    });
    if (entries.length === 0) return null;
  }
  entries.sort((a, b) => BigInt(a.amount) > BigInt(b.amount) ? 1 : -1);

  const result = await kaspa.createTransactions({
    entries,
    outputs: [{ address: sourceAddress, amount: kaspa.kaspaToSompi(amountKas) }],
    priorityFee: kaspa.kaspaToSompi("0"),
    changeAddress: sourceAddress,
    networkId: NETWORK_ID,
    payload: new Uint8Array(Math.max(0, payloadBytes)),
  });
  const feesSompi = result.summary?.fees;
  if (feesSompi == null) return null;
  const massGrams = result.summary?.mass;
  return { feeSompi: BigInt(feesSompi), massGrams: massGrams != null ? BigInt(massGrams) : 0n };
}

export async function estimateOnchainFee(opts) {
  const detail = await estimateOnchainFeeDetail(opts);
  return detail ? sompiToKaspaDisplay(opts.kaspa, detail.feeSompi) : null;
}

// Fee-rate policy matching iOS's KaspaFeePolicy.minimumRelayFeePerGramSompi (100 sompi per gram).
// The WASM SDK's own `summary.fees` uses the ~1 sompi/gram network floor, which is ~100x lower
// than what iOS/kassigner charge, so a fee estimate needs to apply this policy explicitly.
const POLICY_SOMPI_PER_GRAM = 100n;

// Estimate for the Send screen: returns the SDK's own base fee AND the policy fee (mass * 100),
// both as KAS strings. The UI shows the policy fee (like iOS) and pays the difference as a
// priority tip on top of the SDK's automatic base.
export async function estimateSendFeeDetail(opts) {
  const detail = await estimateOnchainFeeDetail(opts);
  if (!detail) return null;
  const policySompi = detail.massGrams * POLICY_SOMPI_PER_GRAM;
  const effectiveSompi = policySompi > detail.feeSompi ? policySompi : detail.feeSompi;
  return {
    sdkFeeKas: sompiToKaspaDisplay(opts.kaspa, detail.feeSompi),
    policyFeeKas: sompiToKaspaDisplay(opts.kaspa, effectiveSompi),
  };
}

export async function sendPayloadTransaction({
  kaspa,
  rpc,
  withRpc = null,
  privateKey,
  sourceAddress,
  destinationAddress,
  amountKas = "0.0001",
  feeKas = "0",
  payload,
  log = () => {},
}) {
  if (!payload) throw new Error("Payload is required for a message transaction.");
  return sendKaspa({
    kaspa,
    rpc,
    withRpc,
    privateKey,
    sourceAddress,
    destinationAddress,
    amountKas,
    feeKas,
    payload,
    log,
  });
}
