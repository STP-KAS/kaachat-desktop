import QRCode from "qrcode";

let kaspa = null;
let rpc = null;
let privateKey = null;
let sourceAddress = null;
let currentUtxos = [];

const NETWORK_ID = "mainnet";
const $ = (id) => document.getElementById(id);
const logEl = $("log");

function stringify(value) {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
  } catch {
    return String(value);
  }
}
function log(...args) {
  logEl.textContent += args.map(stringify).join(" ") + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}
function requireSdk() {
  if (!kaspa) throw new Error("Load Rusty Kaspa WASM first.");
}
function requireWallet() {
  requireSdk();
  if (!privateKey || !sourceAddress) throw new Error("Generate or import a private key first.");
}
function getPrivateKeyHexFromKeypair(keypair) {
  const pk = keypair.privateKey || keypair.private_key || keypair.secretKey || keypair.secret_key;
  if (!pk) throw new Error("Could not read private key from generated Keypair. Check console object exports.");
  return pk.toString();
}
function addressFromPrivateKey(pk) {
  if (typeof pk.toAddress === "function") return pk.toAddress(NETWORK_ID).toString();
  if (typeof pk.toKeypair === "function") return pk.toKeypair().toAddress(NETWORK_ID).toString();
  throw new Error("PrivateKey object does not expose toAddress() or toKeypair().toAddress().");
}
async function loadKaspaModule() {
  try {
    const mod = await import("./kaspa/kaspa.js");
    await mod.default("./kaspa/kaspa_bg.wasm");
    return mod;
  } catch (firstError) {
    try {
      const mod = await import("./kaspa/kaspa-wasm.js");
      await mod.default("./kaspa/kaspa-wasm_bg.wasm");
      return mod;
    } catch {
      throw firstError;
    }
  }
}
async function ensureRpc() {
  requireSdk();
  if (rpc) return rpc;
  const { RpcClient, Resolver, Encoding } = kaspa;
  rpc = new RpcClient({ resolver: new Resolver(), encoding: Encoding?.Borsh, networkId: NETWORK_ID });
  log("Resolving and connecting to mainnet RPC...");
  await rpc.connect();
  log("Connected:", rpc.url || "RPC connected");
  const info = await rpc.getServerInfo();
  log("Server:", info);
  if (info && info.isSynced === false) throw new Error("Connected node is not synced.");
  return rpc;
}
function setWalletFromPrivateKeyHex(hex) {
  requireSdk();
  const clean = String(hex || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error("Private key must be 64 hex characters.");
  privateKey = new kaspa.PrivateKey(clean);
  sourceAddress = addressFromPrivateKey(privateKey);
  $("address").textContent = sourceAddress;
  $("privateKeyInput").value = clean;
  currentUtxos = [];
  log("Wallet loaded:", sourceAddress);
}

function getQrPayload() {
  requireWallet();
  return sourceAddress;
}
async function drawQr(payload) {
  const canvas = $("qrCanvas");
  await QRCode.toCanvas(canvas, payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 512,
    color: {
      dark: "#f4fffb",
      light: "#0a1718"
    }
  });
}
function openQrOverlay() {
  document.body.classList.add("qr-open");
  $("qrOverlay").setAttribute("aria-hidden", "false");
}
function closeQrOverlay() {
  document.body.classList.remove("qr-open");
  $("qrOverlay").setAttribute("aria-hidden", "true");
}

function sompiToKaspaDisplay(totalSompi) {
  if (kaspa.sompiToKaspaString) return kaspa.sompiToKaspaString(totalSompi);
  const s = totalSompi.toString().padStart(9, "0");
  return `${s.slice(0, -8) || "0"}.${s.slice(-8).replace(/0+$/, "") || "0"}`;
}

$("loadSdk").onclick = async () => {
  try {
    kaspa = await loadKaspaModule();
    kaspa.initConsolePanicHook?.();
    $("sdkStatus").textContent = `Loaded Rusty Kaspa WASM ${kaspa.version ? kaspa.version() : ""}`;
    log("Rusty Kaspa WASM loaded.");
  } catch (e) {
    log("SDK load failed:", e.message || e);
    log("Expected ./kaspa/kaspa.js and ./kaspa/kaspa_bg.wasm. Run: npm run setup:wasm -- ~/Downloads/rusty-kaspa-master-2.zip");
  }
};

$("connect").onclick = async () => {
  try { await ensureRpc(); } catch (e) { log("Connect failed:", e.message || e); }
};
$("disconnect").onclick = async () => {
  try {
    if (rpc) await rpc.disconnect();
    rpc = null;
    log("Disconnected.");
  } catch (e) { log("Disconnect error:", e.message || e); }
};
$("generate").onclick = async () => {
  try {
    requireSdk();
    const keypair = kaspa.Keypair.random();
    setWalletFromPrivateKeyHex(getPrivateKeyHexFromKeypair(keypair));
    log("New mainnet wallet generated. Fund the receive address, then refresh balance.");
  } catch (e) { log("Generate failed:", e.message || e); }
};
$("importKey").onclick = async () => {
  try { setWalletFromPrivateKeyHex($("privateKeyInput").value); } catch (e) { log("Import failed:", e.message || e); }
};
$("clear").onclick = async () => {
  privateKey = null; sourceAddress = null; currentUtxos = [];
  $("privateKeyInput").value = "";
  $("address").textContent = "—";
  $("balanceOut").textContent = "—";
  log("Session cleared.");
};
$("copyAddress").onclick = async () => {
  if (!sourceAddress) return log("No address yet.");
  await navigator.clipboard.writeText(sourceAddress);
  log("Address copied.");
};
$("copyPrivateKey").onclick = async () => {
  if (!privateKey) return log("No private key yet.");
  await navigator.clipboard.writeText(privateKey.toString());
  log("Private key copied.");
};

$("showQr").onclick = async () => {
  try {
    const payload = getQrPayload();
    await drawQr(payload);
    openQrOverlay();
    log("QR code generated for receive address.");
  } catch (e) { log("QR failed:", e.message || e); }
};
$("qrOverlay").onclick = (event) => {
  if (event.target === $("qrOverlay")) closeQrOverlay();
};
$("qrShell").onclick = async (event) => {
  event.stopPropagation();
  try {
    const payload = getQrPayload();
    await navigator.clipboard.writeText(payload);
    log("QR address copied.");
  } catch (e) { log("QR copy failed:", e.message || e); }
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeQrOverlay();
});

$("balance").onclick = async () => {
  try {
    requireWallet();
    const client = await ensureRpc();
    const response = await client.getUtxosByAddresses([sourceAddress]);
    currentUtxos = response.entries || [];
    const totalSompi = currentUtxos.reduce((sum, u) => sum + BigInt(u.amount), 0n);
    const totalKas = sompiToKaspaDisplay(totalSompi);
    $("balanceOut").textContent = `${totalKas} KAS | UTXOs: ${currentUtxos.length}`;
    log("Balance:", `${totalKas} KAS`, "UTXOs:", currentUtxos.length);
  } catch (e) { log("Balance failed:", e.message || e); }
};
$("send").onclick = async () => {
  try {
    requireWallet();
    const destinationAddress = $("to").value.trim();
    const amountKas = $("amount").value.trim();
    const feeKas = $("fee").value.trim() || "0";
    if (!destinationAddress.startsWith("kaspa:")) throw new Error("Destination must be a mainnet kaspa: address.");
    if (!amountKas || Number(amountKas) <= 0) throw new Error("Amount must be greater than 0.");

    const client = await ensureRpc();
    const { entries } = await client.getUtxosByAddresses([sourceAddress]);
    if (!entries || entries.length === 0) throw new Error("No UTXOs found. Fund the receive address first.");
    entries.sort((a, b) => BigInt(a.amount) > BigInt(b.amount) ? 1 : -1);

    log("Creating transaction from", sourceAddress, "to", destinationAddress, "amount", amountKas, "KAS");
    const result = await kaspa.createTransactions({
      entries,
      outputs: [{ address: destinationAddress, amount: kaspa.kaspaToSompi(amountKas) }],
      priorityFee: kaspa.kaspaToSompi(feeKas),
      changeAddress: sourceAddress,
      networkId: NETWORK_ID,
    });
    log("Transaction summary:", result.summary);

    for (const pending of result.transactions) {
      await pending.sign([privateKey]);
      const txid = await pending.submit(client);
      log("Broadcast txid:", txid);
    }
    await $("balance").onclick();
  } catch (e) { log("Send failed:", e.message || e); }
};
