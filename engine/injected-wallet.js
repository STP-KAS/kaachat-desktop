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
  if (typeof value === "string") return value.replace(/^0x/i, "").trim();
  if (typeof value === "object") {
    return String(value.txid || value.transactionId || value.txId || value.id || "").replace(/^0x/i, "").trim();
  }
  return String(value).replace(/^0x/i, "").trim();
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

export async function connectKasware(win = globalThis) {
  const wallet = win?.kasware;
  if (!wallet?.requestAccounts) {
    win?.open?.("https://www.kasware.xyz", "_blank", "noopener");
    throw new Error("Kasware is not in this tab. Install the Chrome/Edge/Brave extension, unlock it, then link again.");
  }
  // Drop a silent cached session so requestAccounts always opens the Kasware
  // approval popup. That is where the user unlocks and picks which account.
  try {
    if (typeof wallet.disconnect === "function") {
      await Promise.race([
        wallet.disconnect(win.location?.origin || ""),
        sleep(400),
      ]);
    }
  } catch { /* not connected yet */ }
  const accounts = await withTimeout(wallet.requestAccounts(), 120000, "Kasware approval timed out. Open Kasware, unlock it, pick an account, and approve.");
  const list = (Array.isArray(accounts) ? accounts : [accounts]).map((value) => String(value || "").trim()).filter(Boolean);
  if (!list.length) throw new Error("Kasware returned no account. Approve the request in the Kasware popup.");
  let publicKey = "";
  try { publicKey = String(await wallet.getPublicKey?.() || ""); } catch { /* optional */ }
  return { id: "kasware", address: list[0], publicKey, accounts: list };
}

export async function connectKastle(win = globalThis) {
  const wallet = win?.kastle;
  if (!wallet?.connect) {
    win?.open?.("https://kastle.cc", "_blank", "noopener");
    throw new Error("Kastle is not in this tab. Install it, unlock it, then link again.");
  }
  const ok = await withTimeout(wallet.connect(), 45000, "Kastle connect timed out");
  if (!ok) throw new Error("Kastle connect was declined.");
  const account = await wallet.getAccount();
  const address = String(account?.address || account || "");
  if (!address) throw new Error("Kastle returned no account.");
  return { id: "kastle", address, publicKey: String(account?.publicKey || "") };
}

export async function connectInjected(id, win = globalThis) {
  return id === "kastle" ? connectKastle(win) : connectKasware(win);
}

export async function sendInjectedPayload({
  id,
  toAddress,
  amountKas,
  payload = null,
  win = globalThis,
} = {}) {
  const wallet = id === "kastle" ? win?.kastle : win?.kasware;
  if (!wallet || typeof wallet.sendKaspa !== "function") {
    throw new Error(`${id === "kastle" ? "Kastle" : "Kasware"} is not in this tab to sign the transaction.`);
  }
  const sompi = kasToSompi(amountKas);
  const hex = payload == null ? "" : bytesToHex(payload);
  const attempts = hex
    ? [{ priorityFee: 10000, payload: hex }, { priorityFee: 10000, payload: hex }]
    : [{ priorityFee: 10000 }];
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
