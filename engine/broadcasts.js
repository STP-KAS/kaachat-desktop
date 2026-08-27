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
