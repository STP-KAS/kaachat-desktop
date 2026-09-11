// Kasware and Kastle inject into Chrome/Edge/Brave tabs, including this
// desktop client when it is served from localhost or the STP Chat origin.
// They never give KaChat a recovery phrase. Connect is click-only.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function bytesToHex(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : new TextEncoder().encode(String(value || ""));
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

export function kasToSompi(amountKas) {
  const amount = Number(String(amountKas || "").trim());
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be greater than 0.");
  return Math.round(amount * 100_000_000);
}

export function parseTxid(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.replace(/^0x/i, "").trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { return parseTxid(JSON.parse(trimmed)); } catch { /* not JSON */ }
    }
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
    return trimmed;
  }
  if (typeof value === "object") {
    const nested = value.txid || value.transactionId || value.txId || value.id || value.result;
    return nested && nested !== value ? parseTxid(nested) : "";
  }
  return String(value).replace(/^0x/i, "").trim();
}

function payloadToBytes(payload) {
  if (payload == null || payload === "") return null;
  if (payload instanceof Uint8Array) return payload;
  const text = String(payload);
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
    const out = new Uint8Array(text.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  return new TextEncoder().encode(text);
}

async function signWithKasware(wallet, unsignedJson) {
  let signed = null;
  if (typeof wallet.signPskt === "function") {
    try { signed = await wallet.signPskt({ txJsonString: unsignedJson }); } catch {
      signed = await wallet.signPskt(unsignedJson);
    }
  }
  if (!signed) throw new Error("Kasware did not return a signed handshake transaction.");
  if (typeof wallet.pushTx === "function") {
    const pushed = await wallet.pushTx(typeof signed === "string" ? signed : JSON.stringify(signed));
    return parseTxid(pushed) || parseTxid(signed);
  }
  return parseTxid(signed);
}

async function signWithKastle(wallet, unsignedJson) {
  const parsed = typeof unsignedJson === "string" ? JSON.parse(unsignedJson) : unsignedJson;
  const attempts = [
    () => wallet.signAndBroadcastTx?.("mainnet", unsignedJson),
    () => wallet.signAndBroadcastTx?.("kaspa_mainnet", unsignedJson),
    () => wallet.signAndBroadcastTx?.("mainnet", parsed),
    () => wallet.signTx?.("mainnet", unsignedJson),
  ];
  let last = null;
  for (const run of attempts) {
    if (typeof run !== "function") continue;
    try {
      const txid = parseTxid(await run());
      if (txid) return txid;
    } catch (error) { last = error; }
  }
  throw last || new Error("Kastle did not sign the handshake transaction.");
}

async function sendViaWalletSign({
  id, wallet, kaspa, rpc, sourceAddress, toAddress, amountKas, payloadBytes,
}) {
  if (!kaspa?.createTransactions || !rpc?.getUtxosByAddresses) {
    throw new Error("Kaspa runtime is not ready to build the handshake transaction.");
  }
  const response = await rpc.getUtxosByAddresses([sourceAddress]);
  const entries = response.entries || response || [];
  if (!entries.length) throw new Error("This wallet has no KAS to send a handshake. It needs at least 0.2 KAS.");
  const result = await kaspa.createTransactions({
    entries,
    outputs: [{ address: toAddress, amount: kaspa.kaspaToSompi(String(amountKas)) }],
    priorityFee: 0n,
    changeAddress: sourceAddress,
    networkId: "mainnet",
    ...(payloadBytes ? { payload: payloadBytes } : {}),
  });
  const pendingList = result.transactions || [];
  if (!pendingList.length) throw new Error("Could not build the handshake transaction.");
  const txids = [];
  for (const pending of pendingList) {
    const unsigned = pending.serializeToSafeJSON();
    const txid = id === "kastle"
      ? await signWithKastle(wallet, unsigned)
      : await signWithKasware(wallet, unsigned);
    if (!txid) throw new Error("Wallet signed the handshake but returned no transaction id.");
    txids.push(txid);
  }
  return { txids };
}

export function detected(win = globalThis) {
  if (!win) return [];
  const found = [];
  if (typeof win.kasware !== "undefined") found.push("kasware");
  if (typeof win.kastle !== "undefined") found.push("kastle");
  return found;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function isKaspaAddress(value) {
  const address = String(value || "").trim();
  return address.startsWith("kaspa:") || address.startsWith("kaspatest:");
}

function accountFromValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    return String(value.address || value.account || value.value || "").trim();
  }
  return String(value).trim();
}

function normalizeAccountList(accounts) {
  return (Array.isArray(accounts) ? accounts : [accounts])
    .map(accountFromValue)
    .filter((address) => address.startsWith("kaspa:") || address.startsWith("kaspatest:"));
}

export function beginKaswareApproval(win = globalThis) {
  const wallet = win?.kasware;
  if (!wallet?.requestAccounts) return null;
  // PegLab/Kasware docs: only requestAccounts on the click. Do not disconnect
  // first. disconnect races the popup and the approve click then does nothing.
  return wallet.requestAccounts();
}

async function kaswareRequestAccounts(wallet, approvalPromise, win) {
  const pending = approvalPromise || beginKaswareApproval(win) || wallet.requestAccounts();
  const accounts = await withTimeout(
    pending,
    120000,
    "Kasware approval timed out. Open Kasware, unlock it, pick an account, and approve.",
  );
  return normalizeAccountList(accounts);
}

export async function connectKasware(win = globalThis, approvalPromise = null) {
  const wallet = win?.kasware;
  if (!wallet?.requestAccounts) {
    win?.open?.("https://www.kasware.xyz", "_blank", "noopener");
    throw new Error("Kasware is not in this tab. Install the Chrome/Edge/Brave extension, unlock it, then log in again.");
  }
  let list = [];
  try {
    list = await kaswareRequestAccounts(wallet, approvalPromise, win);
  } catch (error) {
    try { list = normalizeAccountList(await wallet.getAccounts?.()); } catch { /* fall through */ }
    if (!list.length) throw error;
  }
  if (!list.length) {
    try { list = normalizeAccountList(await wallet.getAccounts?.()); } catch { /* empty */ }
  }
  if (!list.length) throw new Error("Kasware returned no account. Approve Log in in the Kasware popup.");
  let publicKey = "";
  try { publicKey = String(await wallet.getPublicKey?.() || ""); } catch { /* optional */ }
  return { id: "kasware", address: list[0], publicKey, accounts: list };
}

export async function connectKastle(win = globalThis) {
  const wallet = win?.kastle;
  if (!wallet?.connect) {
    win?.open?.("https://kastle.cc", "_blank", "noopener");
    throw new Error("Kastle is not in this tab. Install it, unlock it, then log in again.");
  }
  let ok = false;
  try {
    ok = await withTimeout(wallet.connect("mainnet"), 120000, "Kastle approval timed out. Open Kastle, unlock it, and approve.");
  } catch {
    ok = await withTimeout(wallet.connect(), 120000, "Kastle approval timed out. Open Kastle, unlock it, and approve.");
  }
  if (!ok) throw new Error("Kastle connect was declined.");
  const account = await wallet.getAccount();
  const address = String(account?.address || account || "");
  if (!address) throw new Error("Kastle returned no account.");
  return { id: "kastle", address, publicKey: String(account?.publicKey || "") };
}

export async function connectInjected(id, win = globalThis, approvalPromise = null) {
  return id === "kastle" ? connectKastle(win) : connectKasware(win, approvalPromise);
}

export async function sendInjectedPayload({
  id,
  toAddress,
  amountKas,
  payload = null,
  kaspa = null,
  rpc = null,
  sourceAddress = "",
  win = globalThis,
} = {}) {
  const wallet = id === "kastle" ? win?.kastle : win?.kasware;
  if (!wallet) {
    throw new Error(`${id === "kastle" ? "Kastle" : "Kasware"} is not in this tab to sign the transaction.`);
  }
  const payloadBytes = payloadToBytes(payload);
  // Handshake (and other Kasia) payloads are raw bytes. Kasware's sendKaspa()
  // UTF-8-encodes then hex-encodes a string, which corrupts binary. Build the
  // tx here and let the wallet sign it.
  if (payloadBytes && kaspa && rpc && sourceAddress) {
    try {
      return await sendViaWalletSign({
        id, wallet, kaspa, rpc, sourceAddress, toAddress, amountKas, payloadBytes,
      });
    } catch (error) {
      const message = String(error?.message || error || "");
      if (/declin|reject|denied|cancel/i.test(message)) throw error;
      if (!payloadBytes.every((b) => b < 128)) throw error;
    }
  }
  if (typeof wallet.sendKaspa !== "function") {
    throw new Error(`${id === "kastle" ? "Kastle" : "Kasware"} cannot send from this tab.`);
  }
  const sompi = kasToSompi(amountKas);
  const ascii = payloadBytes && payloadBytes.every((b) => b < 128)
    ? new TextDecoder().decode(payloadBytes)
    : "";
  const hex = payloadBytes ? bytesToHex(payloadBytes) : "";
  const attempts = [];
  if (ascii) attempts.push({ priorityFee: 10000, payload: ascii });
  if (hex) attempts.push({ priorityFee: 10000, payload: hex });
  if (!attempts.length) attempts.push({ priorityFee: 10000 });
  let last = null;
  for (const options of attempts) {
    try {
      const txid = parseTxid(await wallet.sendKaspa(toAddress, sompi, options));
      if (!txid) throw new Error("Wallet returned no transaction id.");
      return { txids: [txid] };
    } catch (error) {
      last = error;
    }
  }
  throw last || new Error("Wallet send was declined or failed.");
}
