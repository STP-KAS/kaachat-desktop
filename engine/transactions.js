import { NETWORK_ID, validateMainnetAddress, sompiToKaspaDisplay } from "./utils.js";

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

export async function sendKaspa({ kaspa, rpc, withRpc = null, privateKey, sourceAddress, destinationAddress, amountKas, feeKas = "0", payload = null, log = () => {} }) {
  const to = validateMainnetAddress(destinationAddress);
  const amount = String(amountKas || "").trim();
  const fee = String(feeKas || "0").trim();
  if (!amount || Number(amount) <= 0) throw new Error("Amount must be greater than 0.");

  const fetchUtxos = (activeRpc) => activeRpc.getUtxosByAddresses([sourceAddress]);
  const { entries } = withRpc
    ? await withRpc(fetchUtxos, { retries: 1, label: "UTXO refresh" })
    : await fetchUtxos(rpc);
  if (!entries || entries.length === 0) throw new Error("No UTXOs found. Fund the receive address first.");
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
