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

async function waitForKasware(win, tries = 10) {
  if (win?.kasware) return win.kasware;
  for (let i = 0; i < tries; i += 1) {
    await sleep(100 * (i + 1));
    if (win?.kasware) return win.kasware;
  }
  return null;
}

async function kaswareAccountsQuiet(win) {
  const wallet = win?.kasware;
  if (!wallet?.getAccounts) return [];
  try {
    const accounts = await withTimeout(wallet.getAccounts(), 2500, "Kasware getAccounts timed out");
    return accounts?.length ? accounts : [];
  } catch {
    return [];
  }
}

export async function connectKasware(win = globalThis) {
  const wallet = await waitForKasware(win);
  if (!wallet) {
    win?.open?.("https://www.kasware.xyz", "_blank", "noopener");
    throw new Error("Kasware is not in this tab. Install the Chrome/Edge/Brave extension, unlock it, then link again.");
  }
  const quiet = await kaswareAccountsQuiet(win);
  let address = quiet[0] ? String(quiet[0]) : "";
  if (!address) {
    const accounts = await withTimeout(wallet.requestAccounts(), 45000, "Kasware connect timed out");
    if (!accounts?.[0]) throw new Error("Kasware returned no account.");
    address = String(accounts[0]);
  }
  let publicKey = "";
  try { publicKey = String(await wallet.getPublicKey?.() || ""); } catch { /* optional */ }
  return { id: "kasware", address, publicKey };
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
