// Broadcasts — public, unencrypted, many-to-many channels riding on Kaspa self-send
// transactions (payload `ciph_msg:1:bcast:<channel>:<content>`), desktop port of the iOS/
// Android 4.0 feature. The curated #kaspa/#kachat-bugs rooms are backed by the KaChat
// broadcast indexer (BROADCAST_INDEXER.md): it watches the chain 24/7 and serves history over
// REST, so clients backfill on room open and poll while the room stays visible. Messages are
// deduped by txid; there is no signature scheme — the sender authenticated the transaction.

import { getEndpoint } from "./endpoints.js";
import { sendPayloadTransaction } from "./transactions.js";

export const FEATURED_BROADCAST_CHANNELS = Object.freeze(["kaspa", "kachat-bugs"]);
export const BROADCAST_RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // fixed 3 days (featured rooms)

export function normalizeBroadcastChannel(rawName) {
  return String(rawName || "").trim().toLowerCase().replace(/^#/, "");
}

export function isValidBroadcastChannel(name) {
  return name.length > 0 && name.length <= 36 && !/[\s:]/.test(name);
}

export function isFeaturedBroadcastChannel(name) {
  return FEATURED_BROADCAST_CHANNELS.includes(normalizeBroadcastChannel(name));
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
  const protocolString = `ciph_msg:1:bcast:${name}:${text}`;
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
