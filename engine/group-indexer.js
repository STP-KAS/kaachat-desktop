// Group-chat indexer queries against the Kasia indexer's group endpoints
// (indexer.kasia.wtf). Mirrors iOS KaChatAPIClient's group query methods +
// cursor pagination, and reconstructs the on-chain payload string from the
// indexer's hex-encoded `message_payload`.
//
// Discovery model (see the group protocol): group messages are self-stash txs,
// so there's no per-recipient addressing — each member queries
// /group-messages/by-blinded-group-id once PER member (every member sends under
// their own blinded group id). Control messages (gctl) are recipient-addressed:
// /group-control/by-recipient discovers "you were added" before you know any
// admin; /group-control/by-sender fetches an already-known admin's controls.
import { getEndpoint } from "./endpoints.js";
import { hexToBytes, GROUP_PAYLOAD_PREFIXES } from "./group.js";

const DECODER = new TextDecoder();

function trimBase(url) { return String(url || "").replace(/\/+$/, ""); }

// The indexer stores `message_payload` as the hex of the ASCII text that follows
// the known prefix (iOS reconstructPayloadString). Decode and re-prepend the
// prefix. Robust to an indexer that stores the whole prefixed string instead.
function reconstructPayload(messagePayloadHex, prefix) {
  try {
    const decoded = DECODER.decode(hexToBytes(messagePayloadHex));
    // Already-rooted (new kchat: or legacy ciph_msg:) → leave as-is; else re-prepend the prefix.
    const rooted = decoded.startsWith("kchat:") || decoded.startsWith("ciph_msg:");
    return rooted ? decoded : prefix + decoded;
  } catch { return null; }
}

async function fetchRows(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) {
    let detail = "";
    try { const body = await response.json(); detail = body?.error ? ` ${body.error}` : ""; } catch {}
    throw new Error(`Group indexer request failed (${response.status}).${detail}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Group indexer returned an unexpected response.");
  return rows;
}

// Cursor pagination matching iOS getPaginatedByCursor: keep fetching while a full
// page comes back and the cursor advances; stop on a short page, a missing/stuck
// cursor, or the maxPages safety cap.
async function paginate(buildUrl, limit, startCursor, maxPages = 20) {
  const all = [];
  let cursor = startCursor || null;
  for (let page = 0; page < maxPages; page++) {
    const rows = await fetchRows(buildUrl(cursor, limit));
    all.push(...rows);
    if (rows.length < limit) break;
    const next = rows[rows.length - 1]?.cursor;
    if (next == null || String(next) === String(cursor)) break;
    cursor = String(next);
  }
  return all;
}

function baseUrl(indexerUrl) {
  return trimBase(indexerUrl || getEndpoint("kasiaIndexer"));
}

// One member's slice of a group's messages. Call once per group member, each with
// that member's blinded group id (deriveBlindedGroupId(blindingKey, memberPubKey)).
export async function queryGroupMessages({ indexerUrl, blindedGroupIdHex, cursor = null, limit = 50 } = {}) {
  if (!blindedGroupIdHex) throw new Error("blindedGroupIdHex is required.");
  const base = baseUrl(indexerUrl);
  const rows = await paginate((cur, lim) => {
    const q = new URLSearchParams({ blinded_group_id: blindedGroupIdHex, limit: String(lim) });
    if (cur) q.set("cursor", cur);
    return `${base}/group-messages/by-blinded-group-id?${q.toString()}`;
  }, limit, cursor);
  return rows
    .map((r) => ({
      txId: String(r.tx_id || ""),
      sender: r.sender ? String(r.sender) : null,
      blindedGroupId: String(r.blinded_group_id || blindedGroupIdHex),
      blockTime: Number(r.block_time || 0),
      cursor: r.cursor != null ? String(r.cursor) : null,
      payloadString: reconstructPayload(r.message_payload, GROUP_PAYLOAD_PREFIXES.gcomm),
    }))
    .filter((m) => m.payloadString);
}

function mapControlRow(r) {
  return {
    txId: String(r.tx_id || ""),
    sender: r.sender ? String(r.sender) : null,
    recipient: r.recipient ? String(r.recipient) : null,
    blockTime: Number(r.block_time || 0),
    cursor: r.cursor != null ? String(r.cursor) : null,
    payloadString: reconstructPayload(r.message_payload, GROUP_PAYLOAD_PREFIXES.gctl),
  };
}

// Recipient-addressed control messages for our own wallet address — discovers
// group invites (gctl_root) before we know the admin. Safe to call with zero
// local groups.
export async function queryGroupControlByRecipient({ indexerUrl, recipient, cursor = null, limit = 50 } = {}) {
  if (!recipient) throw new Error("recipient address is required.");
  const base = baseUrl(indexerUrl);
  const rows = await paginate((cur, lim) => {
    const q = new URLSearchParams({ recipient, limit: String(lim) });
    if (cur) q.set("cursor", cur);
    return `${base}/group-control/by-recipient?${q.toString()}`;
  }, limit, cursor);
  return rows.map(mapControlRow).filter((m) => m.payloadString);
}

// Control messages from a known admin's address (epoch rotations, renames).
export async function queryGroupControlBySender({ indexerUrl, sender, cursor = null, limit = 50 } = {}) {
  if (!sender) throw new Error("sender address is required.");
  const base = baseUrl(indexerUrl);
  const rows = await paginate((cur, lim) => {
    const q = new URLSearchParams({ sender, limit: String(lim) });
    if (cur) q.set("cursor", cur);
    return `${base}/group-control/by-sender?${q.toString()}`;
  }, limit, cursor);
  return rows.map(mapControlRow).filter((m) => m.payloadString);
}
