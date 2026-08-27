// Broadcasts — public, unencrypted, many-to-many channels riding on Kaspa self-send
// transactions (payload `ciph_msg:1:bcast:<channel>:<content>`), desktop port of the iOS/
// Android 4.0 feature. The curated rooms (#kaspa, #kachat-bugs and the eleven per-language
// rooms) are backed by the KaChat
// broadcast indexer (BROADCAST_INDEXER.md): it watches the chain 24/7 and serves history over
// REST, so clients backfill on room open and poll while the room stays visible. Messages are
// deduped by txid; there is no signature scheme — the sender authenticated the transaction.

import { getEndpoint } from "./endpoints.js";
import { sendPayloadTransaction } from "./transactions.js";

/// Curated rooms that are AUTO-JOINED for every account and pinned at the top of the Popular
/// section. Matches iOS `BroadcastService.featuredChannels`.
export const FEATURED_BROADCAST_CHANNELS = Object.freeze(["kaspa", "kachat-bugs"]);

/// Curated per-language rooms, listed behind the collapsible "Other Languages" row under
/// Popular. Indexer-tracked exactly like the featured rooms (30-day retention, indexer history,
/// no retention gear, no Leave) but deliberately NOT auto-joined: the room is joined on first
/// open or bell tap. Auto-joining eleven more rooms would multiply per-room work for every
/// user, including the vast majority who want none of them.
///
/// These names are the literal on-chain channel names and are deliberately inconsistent (native
/// romanizations for some, English for others, a country name for one). Do NOT "normalize" any
/// of them: a corrected name is a DIFFERENT, empty room. Copied verbatim from iOS
/// `BroadcastService.languageChannels`; order matches `BROADCAST_LANGUAGE_DISPLAY_NAMES`.
export const LANGUAGE_BROADCAST_CHANNELS = Object.freeze([
  "kaspa-indonesia",
  "kaspa-czech",
  "kaspa-german",
  "kaspa-espanol",
  "kaspa-francais",
  "kaspa-portugues",
  "kaspa-slovak",
  "kaspa-chinese",
  "kaspa-japanese",
  "kaspa-korean",
  "kaspa-hebrew",
]);

/// Every indexer-tracked room. EVERYTHING that follows from "the indexer serves this room's
/// history" keys off this set - the fixed 30-day retention, no per-room retention gear, no
/// Leave. Only auto-join and the pinned Popular list use `FEATURED_BROADCAST_CHANNELS` alone.
/// Mirrors iOS `BroadcastService.indexedChannels`.
export const INDEXED_BROADCAST_CHANNELS = Object.freeze([
  ...FEATURED_BROADCAST_CHANNELS,
  ...LANGUAGE_BROADCAST_CHANNELS,
]);

export const BROADCAST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // fixed 30 days (indexed rooms)

/// Native-language label for each curated language room, e.g. "kaspa-espanol" -> "Español".
/// Native names (not English ones) so a speaker scanning the list finds their own language.
/// Copied from iOS `BroadcastService.languageDisplayName`.
const BROADCAST_LANGUAGE_DISPLAY_NAMES = Object.freeze({
  "kaspa-indonesia": "Bahasa Indonesia",
  "kaspa-czech": "Čeština",
  "kaspa-german": "Deutsch",
  "kaspa-espanol": "Español",
  "kaspa-francais": "Français",
  "kaspa-portugues": "Português",
  "kaspa-slovak": "Slovenčina",
  "kaspa-chinese": "中文",
  "kaspa-japanese": "日本語",
  "kaspa-korean": "한국어",
  "kaspa-hebrew": "עברית",
});

export function normalizeBroadcastChannel(rawName) {
  return String(rawName || "").trim().toLowerCase().replace(/^#/, "");
}

export function isValidBroadcastChannel(name) {
  return name.length > 0 && name.length <= 36 && !/[\s:]/.test(name);
}

export function isFeaturedBroadcastChannel(name) {
  return FEATURED_BROADCAST_CHANNELS.includes(normalizeBroadcastChannel(name));
}

export function isLanguageBroadcastChannel(name) {
  return LANGUAGE_BROADCAST_CHANNELS.includes(normalizeBroadcastChannel(name));
}

/** True for every indexer-backed room (featured + curated language rooms). */
export function isIndexedBroadcastChannel(name) {
  return INDEXED_BROADCAST_CHANNELS.includes(normalizeBroadcastChannel(name));
}

/** Native display name for a curated language room, or "" for any other channel. */
export function broadcastLanguageDisplayName(name) {
  return BROADCAST_LANGUAGE_DISPLAY_NAMES[normalizeBroadcastChannel(name)] || "";
}

// ---------------------------------------------------------------------------
// On-chain payload parsing + live block scanning
//
// The broadcast indexer only tracks the curated rooms, so a user-created room has NO
// history service anywhere. Its only possible delivery path is watching the chain
// directly: subscribe to the node's block-added notifications and pick the broadcast
// payloads out of every block. That is exactly what iOS does (BroadcastService's
// `startScanning` / `extractBroadcastHits`), and it is LIVE ONLY by construction - a
// block stream carries what is being mined now, never what was mined yesterday.
// ---------------------------------------------------------------------------

/** Payload root written by every current client. */
export const BROADCAST_PAYLOAD_PREFIX = "kchat:1:bcast:";
/** Legacy payload root, read-only (still on chain from pre-rename clients). */
export const LEGACY_BROADCAST_PAYLOAD_PREFIX = "ciph_msg:1:bcast:";

const TEXT_DECODER = new TextDecoder();

function asciiToHex(text) {
  let hex = "";
  for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

// Prefix-match on the HEX before decoding anything: at Kaspa's block rate almost every
// transaction in almost every block is not a broadcast, and a string compare on the first
// 28/34 characters is far cheaper than decoding the whole payload to find that out.
const BROADCAST_PREFIX_HEX = asciiToHex(BROADCAST_PAYLOAD_PREFIX);
const LEGACY_BROADCAST_PREFIX_HEX = asciiToHex(LEGACY_BROADCAST_PAYLOAD_PREFIX);

function bytesToHex(bytes) {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex) {
  const clean = hex.length % 2 === 0 ? hex : hex.slice(0, hex.length - 1);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Transaction payloads arrive as a hex string from wRPC, but a caller may hand us bytes. */
function normalizedPayloadHex(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload.trim().toLowerCase();
  if (payload instanceof Uint8Array) return bytesToHex(payload);
  if (Array.isArray(payload)) return bytesToHex(Uint8Array.from(payload));
  if (ArrayBuffer.isView(payload)) return bytesToHex(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  return "";
}

/**
 * Splits a decoded payload string into `{ channel, content }`, or returns null when it is
 * not a broadcast. Dual-root (new `kchat:` + legacy `ciph_msg:`), matching iOS
 * `KasiaTransactionBuilder.parseBroadcastPayload`.
 */
export function parseBroadcastPayload(payloadString) {
  const text = String(payloadString || "");
  let prefix = "";
  if (text.startsWith(BROADCAST_PAYLOAD_PREFIX)) prefix = BROADCAST_PAYLOAD_PREFIX;
  else if (text.startsWith(LEGACY_BROADCAST_PAYLOAD_PREFIX)) prefix = LEGACY_BROADCAST_PAYLOAD_PREFIX;
  else return null;
  const rest = text.slice(prefix.length);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const channel = normalizeBroadcastChannel(rest.slice(0, colon));
  if (!channel) return null;
  return { channel, content: rest.slice(colon + 1) };
}

/** u64 fields cross the WASM boundary as BigInt; everything else may be a number or string. */
function toNumber(value) {
  if (typeof value === "bigint") return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Sender address for a broadcast: broadcasts are self-sends, so the first output pays the
 * sender (iOS reads `tx.outputs.first` the same way). Prefer the node's own verbose data,
 * fall back to deriving it from the script public key with the WASM SDK.
 */
function outputSenderAddress(kaspa, output, networkId) {
  const verbose = output?.verboseData || output?.verbose_data || null;
  const direct = verbose?.scriptPublicKeyAddress || verbose?.script_public_key_address || "";
  if (direct) return String(direct);
  const scriptPublicKey = output?.scriptPublicKey ?? output?.script_public_key ?? null;
  if (scriptPublicKey == null || typeof kaspa?.addressFromScriptPublicKey !== "function") return "";
  const attempts = [scriptPublicKey];
  // A plain `{ version, script }` object (how wRPC serialises it) may not cast directly —
  // rebuild it as a real SDK ScriptPublicKey before giving up.
  if (typeof scriptPublicKey === "object" && scriptPublicKey?.script != null && kaspa?.ScriptPublicKey) {
    try { attempts.push(new kaspa.ScriptPublicKey(Number(scriptPublicKey.version || 0), scriptPublicKey.script)); }
    catch { /* fall through to the direct attempt only */ }
  }
  for (const candidate of attempts) {
    try {
      const address = kaspa.addressFromScriptPublicKey(candidate, networkId);
      const text = address == null ? "" : String(address.toString ? address.toString() : address);
      if (text.startsWith("kaspa:") || text.startsWith("kaspatest:")) return text;
    } catch { /* try the next shape */ }
  }
  return "";
}

/**
 * Pulls the block out of a `block-added` RPC event. The WASM client hands over
 * `{ type: "block-added", data: { block } }`; tolerate being given the notification or the
 * block itself so a future shape change degrades to "no hits" rather than a thrown error.
 */
export function blockFromBlockAddedEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (Array.isArray(event.transactions)) return event;
  const data = event.data ?? event;
  if (data?.block && Array.isArray(data.block.transactions)) return data.block;
  if (Array.isArray(data?.transactions)) return data;
  if (data?.data?.block && Array.isArray(data.data.block.transactions)) return data.data.block;
  return null;
}

/**
 * Every broadcast payload carried by one block, as
 * `{ txId, channel, senderAddress, content, blockTime }` rows — the SAME row shape
 * `fetchBroadcastHistory` returns, so both paths feed one merge/dedupe function upstream.
 * Pure and allocation-light: the common case is a block with zero broadcast payloads, which
 * costs one string comparison per transaction.
 */
export function extractBroadcastHitsFromBlock(kaspa, eventOrBlock, { networkId = "mainnet", onUnusable = null } = {}) {
  const block = blockFromBlockAddedEvent(eventOrBlock);
  if (!block) return [];
  const transactions = Array.isArray(block.transactions) ? block.transactions : [];
  if (transactions.length === 0) return [];
  const headerTime = toNumber(block.header?.timestamp);
  // Per-transaction verbose data is the primary source of the txid, but a node/build that
  // omits it still lists the ids on the block, in transaction order.
  const blockVerbose = block.verboseData || block.verbose_data || null;
  const blockTxIds = Array.isArray(blockVerbose?.transactionIds) ? blockVerbose.transactionIds
    : Array.isArray(blockVerbose?.transaction_ids) ? blockVerbose.transaction_ids
    : null;
  const hits = [];
  for (let index = 0; index < transactions.length; index += 1) {
    const tx = transactions[index];
    const hex = normalizedPayloadHex(tx?.payload);
    if (!hex.startsWith(BROADCAST_PREFIX_HEX) && !hex.startsWith(LEGACY_BROADCAST_PREFIX_HEX)) continue;
    let parsed = null;
    try { parsed = parseBroadcastPayload(TEXT_DECODER.decode(hexToBytes(hex))); } catch { parsed = null; }
    if (!parsed) continue;
    const verbose = tx?.verboseData || tx?.verbose_data || null;
    const txId = String(
      verbose?.transactionId || verbose?.transaction_id || tx?.id || blockTxIds?.[index] || "");
    // A recognised broadcast payload we cannot turn into a row is a real (and otherwise
    // invisible) failure - the caller logs it rather than dropping the message in silence.
    if (!txId) { onUnusable?.("the node sent no transaction id with the block"); continue; }
    const outputs = Array.isArray(tx?.outputs) ? tx.outputs : [];
    const senderAddress = outputSenderAddress(kaspa, outputs[0], networkId);
    if (!senderAddress) { onUnusable?.("the sender address could not be read from the first output"); continue; }
    hits.push({
      txId,
      channel: parsed.channel,
      senderAddress,
      content: parsed.content,
      blockTime: toNumber(verbose?.blockTime || verbose?.block_time) || headerTime || Date.now(),
    });
  }
  return hits;
}

/** Publishes a broadcast into `channel`. Returns the txid (= the message id). */
export async function sendBroadcastMessage({ engine, channel, content }) {
  const name = normalizeBroadcastChannel(channel);
  if (!isValidBroadcastChannel(name)) throw new Error("Invalid channel name.");
  const text = String(content || "").trim();
  if (!text) throw new Error("Message is empty.");
  if (!engine?.kaspa || !engine?.privateKey || !engine?.address) {
    throw new Error("Load WASM and generate/import a wallet first.");
  }
  await engine.connect();
  const protocolString = `kchat:1:bcast:${name}:${text}`;
  const sendResult = await sendPayloadTransaction({
    kaspa: engine.kaspa,
    rpc: engine.rpc,
    withRpc: engine.withRpc.bind(engine),
    privateKey: engine.privateKey,
    sourceAddress: engine.address,
    destinationAddress: engine.address, // self-send; the payload IS the message
    amountKas: "0.2",
    feeKas: "0",
    payload: new TextEncoder().encode(protocolString),
    log: engine.log,
  });
  const txid = sendResult.txids?.[0] || "";
  if (!txid) throw new Error("Broadcast transaction returned no txid.");
  return txid;
}

/** True when a broadcast indexer is configured, i.e. the curated rooms have a history
 *  service. Custom rooms never have one - the indexer only tracks the curated set. */
export function hasBroadcastIndexer() {
  return String(getEndpoint("broadcastIndexer") || "").trim().length > 0;
}

/**
 * History page from the broadcast indexer. Returns `{ messages, hasMore }` with rows shaped
 * `{ txId, channel, senderAddress, content, blockTime }` — or throws; callers treat failures
 * as "no backfill" (nothing user-facing breaks, live sends still work).
 */
export async function fetchBroadcastHistory({ channel, limit = 200, before = null } = {}) {
  const base = String(getEndpoint("broadcastIndexer") || "").replace(/\/+$/, "");
  const url = new URL(`${base}/get-broadcasts`);
  url.searchParams.set("channel", normalizeBroadcastChannel(channel));
  url.searchParams.set("limit", String(Math.max(1, Math.min(500, Number(limit) || 200))));
  if (before) url.searchParams.set("before", String(before));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Broadcast indexer request failed (${response.status}).`);
    const json = await response.json();
    return {
      messages: Array.isArray(json?.messages) ? json.messages : [],
      hasMore: json?.hasMore === true,
    };
  } finally {
    clearTimeout(timer);
  }
}
