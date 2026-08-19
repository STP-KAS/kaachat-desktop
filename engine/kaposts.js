// KaPosts — KaChat's on-chain social feed (the K protocol), desktop port of iOS's
// KaPostsAPIClient. Reads come from the KaChat-owned K indexer fork over REST; writes NEVER
// touch REST — every action (post, reply, vote, follow, quote) is a Kaspa SELF-SEND
// transaction whose `k:1:...` payload the indexer ingests from the chain. The transaction id
// IS the content id.
//
// Signing: Kaspa personal-message signing (schnorr over blake2b256 keyed
// "PersonalMessageSigningHash") — exactly what `kaspa.signMessage({ message, privateKey })`
// produces, so signatures verify server-side against the embedded compressed pubkey.

import { getEndpoint } from "./endpoints.js";
import { sendPayloadTransaction } from "./transactions.js";

// U+2060 WORD JOINER — the KaChat exclusivity marker. Invisible everywhere, survives base64
// round-trips, and comes back in postContent so feeds can filter on it (the read API never
// exposes raw payloads, which is why the marker must live inside the message itself).
export const KACHAT_MARKER = "\u2060";

export const KAPOSTS_POST_CHARACTER_LIMIT = 25000;

export function isKaChatContent(text) {
  return typeof text === "string" && text.startsWith(KACHAT_MARKER);
}

export function stripKaChatMarker(text) {
  const value = String(text || "");
  return value.startsWith(KACHAT_MARKER) ? value.slice(KACHAT_MARKER.length) : value;
}

// UTF-8-safe base64 (btoa alone corrupts non-Latin1 text — K content is arbitrary UTF-8).
export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToUtf8(encoded) {
  try {
    const binary = atob(String(encoded || ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// K protocol payloads (byte-for-byte the shapes the indexer's parser verifies)
// ---------------------------------------------------------------------------

// `kchat:` migration: KaPosts now writes the `kchat:1:<action>:` root (was `k:1:<action>:`).
// Reads come pre-parsed from the K indexer (which dual-reads server-side), so there is no
// on-device `k:1:` parse to update — only the write shape changes. The U+2060 marker stays.
export const KAPOSTS_PROTOCOL = Object.freeze({
  prefix: "kchat:1:",

  postSigningString: (b64Message, mentionsJson) => `${b64Message}:${mentionsJson}`,
  replySigningString: (postId, b64Message, mentionsJson) => `${postId}:${b64Message}:${mentionsJson}`,
  voteSigningString: (postId, vote, authorPubkey) => `${postId}:${vote}:${authorPubkey}`,
  followSigningString: (action, followedPubkey) => `${action}:${followedPubkey}`,
  quoteSigningString: (contentId, b64Message, quotedAuthorPubkey) => `${contentId}:${b64Message}:${quotedAuthorPubkey}`,
  unquoteSigningString: (contentId) => contentId,

  postPayload: (pubkey, signature, b64Message, mentionsJson) =>
    `kchat:1:post:${pubkey}:${signature}:${b64Message}:${mentionsJson}`,
  replyPayload: (pubkey, signature, postId, b64Message, mentionsJson) =>
    `kchat:1:reply:${pubkey}:${signature}:${postId}:${b64Message}:${mentionsJson}`,
  votePayload: (pubkey, signature, postId, vote, authorPubkey) =>
    `kchat:1:vote:${pubkey}:${signature}:${postId}:${vote}:${authorPubkey}`,
  followPayload: (pubkey, signature, action, followedPubkey) =>
    `kchat:1:follow:${pubkey}:${signature}:${action}:${followedPubkey}`,
  quotePayload: (pubkey, signature, contentId, b64Message, quotedAuthorPubkey) =>
    `kchat:1:quote:${pubkey}:${signature}:${contentId}:${b64Message}:${quotedAuthorPubkey}`,
  unquotePayload: (pubkey, signature, contentId) =>
    `kchat:1:unquote:${pubkey}:${signature}:${contentId}`,
});

// ---------------------------------------------------------------------------
// Identity bridge (K pubkey <-> Kaspa address; KNS owns ALL display identity)
// ---------------------------------------------------------------------------

/**
 * The requester's 66-hex COMPRESSED secp256k1 pubkey — how K identifies users.
 * `PrivateKey.toPublicKey().toString()` on the Rusty Kaspa WASM yields the compressed form.
 */
export function requesterPubkeyFor(engine) {
  if (!engine?.privateKey) throw new Error("Generate or import a private key first.");
  const hex = String(engine.privateKey.toPublicKey().toString()).toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Unexpected public key format from wallet SDK (${hex.length} chars).`);
  }
  return hex;
}

/** Compressed (02/03 + x) or raw x-only pubkey hex -> "kaspa:..." address, or null. */
export function kaspaAddressFromPubkey(engine, pubkeyHex) {
  const hex = String(pubkeyHex || "").toLowerCase();
  if (!/^(0[23])?[0-9a-f]{64}$/.test(hex)) return null;
  try {
    if (hex.length === 66) {
      return new engine.kaspa.PublicKey(hex).toAddress("mainnet").toString();
    }
    // x-only: assume even parity (02 prefix), the BIP-340 convention.
    return new engine.kaspa.PublicKey(`02${hex}`).toAddress("mainnet").toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Indexer reads (KaChat-marker-filtered)
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 20000;

function kapostBaseUrl() {
  return String(getEndpoint("kapostIndexer") || "").replace(/\/+$/, "");
}

async function kapostGet(path, query = {}) {
  const url = new URL(`${kapostBaseUrl()}/${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!response.ok) {
      const detail = json?.error ? `: ${json.error}` : "";
      throw new Error(`KaPost indexer request failed (${response.status})${detail}.`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The opaque cursor for the NEXT page, or null when the server says this was the last one.
 * The K indexer answers every list endpoint with `{hasMore, nextCursor, prevCursor}` where
 * nextCursor is "<timestampMs>_<rowid>" of the last row it returned — feed it back as
 * `before` to continue. Callers must treat it as opaque.
 */
export function nextPageCursor(pagination) {
  if (!pagination || pagination.hasMore !== true) return null;
  const cursor = pagination.nextCursor;
  return cursor ? String(cursor) : null;
}

/** Decoded post content (base64 -> UTF-8), or null when it can't decode. */
export function decodePostContent(post) {
  return base64ToUtf8(post?.postContent);
}

/** KaChat-only filter: keep marker-carrying posts, drop indexer-masked blocked content. */
function filterKaChatPosts(posts) {
  return (Array.isArray(posts) ? posts : []).filter((post) => {
    if (post?.blockedUser === true) return false;
    const content = decodePostContent(post);
    return content !== null && isKaChatContent(content);
  });
}

/** Global feed (K "watching" = all posts). */
export async function fetchGlobalFeed({ engine, limit = 50, before = null } = {}) {
  const json = await kapostGet("get-posts-watching", {
    requesterPubkey: requesterPubkeyFor(engine), limit, before,
  });
  return { posts: filterKaChatPosts(json?.posts), pagination: json?.pagination || null };
}

/** Content from accounts the requester follows — top-level content only (replies live in threads). */
export async function fetchFollowingFeed({ engine, limit = 50, before = null } = {}) {
  const json = await kapostGet("get-contents-following", {
    requesterPubkey: requesterPubkeyFor(engine), limit, before,
  });
  const posts = filterKaChatPosts(json?.posts).filter((post) => (post?.contentType || "post") !== "reply");
  return { posts, pagination: json?.pagination || null };
}

/** One user's posts; includeReplies also returns their replies (parentPostId set). */
export async function fetchUserPosts({ engine, pubkey, limit = 50, before = null } = {}) {
  // Note: the deployed indexer has no includeReplies param on get-posts (silently dropped;
  // its SQL is hard-filtered to content_type post/quote) — replies come from
  // fetchUserReplies' get-replies?user= instead.
  const json = await kapostGet("get-posts", {
    user: pubkey,
    requesterPubkey: requesterPubkeyFor(engine),
    limit,
    before,
  });
  return { posts: filterKaChatPosts(json?.posts), pagination: json?.pagination || null };
}

/** All replies MADE BY a user — get-replies' user= mode (post= gives replies TO a post). */
export async function fetchUserReplies({ engine, pubkey, limit = 50, before = null } = {}) {
  const json = await kapostGet("get-replies", {
    user: pubkey, requesterPubkey: requesterPubkeyFor(engine), limit, before,
  });
  return { posts: filterKaChatPosts(json?.replies), pagination: json?.pagination || null };
}

export async function fetchReplies({ engine, postId, limit = 100, before = null } = {}) {
  const json = await kapostGet("get-replies", {
    post: postId, requesterPubkey: requesterPubkeyFor(engine), limit, before,
  });
  return { posts: filterKaChatPosts(json?.replies), pagination: json?.pagination || null };
}

/** The requester's notification stream — actions on OUR content; ids are the ACTION's txids. */
export async function fetchKaPostNotifications({ engine, limit = 100, before = null } = {}) {
  const json = await kapostGet("get-notifications", {
    requesterPubkey: requesterPubkeyFor(engine), limit, before,
  });
  return {
    notifications: Array.isArray(json?.notifications) ? json.notifications : [],
    pagination: json?.pagination || null,
  };
}

/** Per-post actor lists (KaChat indexer fork) — works for ANY post. */
export async function fetchPostEngagement({ engine, postId, type = "all", limit = 100, before = null } = {}) {
  const json = await kapostGet("get-post-engagement", {
    postId, type, requesterPubkey: requesterPubkeyFor(engine), limit, before,
  });
  return {
    engagement: Array.isArray(json?.engagement) ? json.engagement : [],
    pagination: json?.pagination || null,
  };
}

/** Who `pubkey` follows (followers=false) or who follows them (followers=true). The list
 *  endpoints wrap items under "posts" (verified live) — tolerate the other plausible keys. */
export async function fetchFollowList({ engine, pubkey, followers = false, limit = 100 } = {}) {
  const path = followers ? "get-users-followers" : "get-users-following";
  const json = await kapostGet(path, {
    requesterPubkey: requesterPubkeyFor(engine), userPubkey: pubkey, limit,
  });
  return json?.posts || json?.users || json?.following || json?.followers || [];
}

export async function fetchKaPostUserDetails({ engine, pubkey } = {}) {
  return kapostGet("get-user-details", {
    user: pubkey, requesterPubkey: requesterPubkeyFor(engine),
  });
}

// ---------------------------------------------------------------------------
// On-chain writes (txid = content id). All are 0.2 KAS self-sends carrying the payload,
// exactly like Kasia chat messages — only the network fee is actually spent.
// ---------------------------------------------------------------------------

const KAPOST_ACTION_AMOUNT_KAS = "0.2";

function signKaPostString(engine, message) {
  const signature = engine.kaspa.signMessage({ message, privateKey: engine.privateKey });
  return String(signature).toLowerCase();
}

async function submitKaPostPayload(engine, protocolString) {
  if (!engine?.kaspa || !engine?.privateKey || !engine?.address) {
    throw new Error("Load WASM and generate/import a wallet first.");
  }
  await engine.connect();
  const sendResult = await sendPayloadTransaction({
    kaspa: engine.kaspa,
    rpc: engine.rpc,
    withRpc: engine.withRpc.bind(engine),
    privateKey: engine.privateKey,
    sourceAddress: engine.address,
    destinationAddress: engine.address, // SELF-SEND — the indexer ingests the payload
    amountKas: KAPOST_ACTION_AMOUNT_KAS,
    feeKas: "0",
    payload: new TextEncoder().encode(protocolString),
    log: engine.log,
  });
  const txid = sendResult.txids?.[0] || "";
  if (!txid) throw new Error("KaPost transaction broadcast returned no txid.");
  engine.log?.(`KaPost action on-chain: ${protocolString.slice(0, 12)}… tx ${txid.slice(0, 12)}…`);
  return txid;
}

/**
 * Publishes a post. The exclusivity marker is prepended INSIDE the message. Returns txid = post id.
 * `mentionedPubkeys` (compressed hex) are written to the payload's mentioned_pubkeys array; the
 * indexer turns each into a `contentType: "mention"` notification for that user (client-resolved
 * mentions — the server does not parse @text). Deduped; the author's own pubkey is dropped.
 */
export async function submitKaPost({ engine, text, mentionedPubkeys = [] }) {
  const b64 = utf8ToBase64(KACHAT_MARKER + String(text || ""));
  const me = requesterPubkeyFor(engine);
  const clean = [...new Set((Array.isArray(mentionedPubkeys) ? mentionedPubkeys : [])
    .map((p) => String(p || "").toLowerCase())
    .filter((p) => /^0[23][0-9a-f]{64}$/.test(p) && p !== me))];
  const mentions = JSON.stringify(clean);
  const signature = signKaPostString(engine, KAPOSTS_PROTOCOL.postSigningString(b64, mentions));
  return submitKaPostPayload(engine, KAPOSTS_PROTOCOL.postPayload(me, signature, b64, mentions));
}

/** Replies to a post (its K txid). Mention rule per spec: the parent author. */
export async function submitKaPostReply({ engine, text, postId, parentAuthorPubkey = null }) {
  const b64 = utf8ToBase64(KACHAT_MARKER + String(text || ""));
  const mentions = parentAuthorPubkey ? `["${parentAuthorPubkey}"]` : "[]";
  const pubkey = requesterPubkeyFor(engine);
  const signature = signKaPostString(engine, KAPOSTS_PROTOCOL.replySigningString(postId, b64, mentions));
  return submitKaPostPayload(engine, KAPOSTS_PROTOCOL.replyPayload(pubkey, signature, postId, b64, mentions));
}

/** vote ∈ upvote | downvote | unvote (unvote = the fork's removal counter-action). */
export async function submitKaPostVote({ engine, postId, vote, authorPubkey }) {
  const pubkey = requesterPubkeyFor(engine);
  const signature = signKaPostString(engine, KAPOSTS_PROTOCOL.voteSigningString(postId, vote, authorPubkey));
  return submitKaPostPayload(engine, KAPOSTS_PROTOCOL.votePayload(pubkey, signature, postId, vote, authorPubkey));
}

export async function submitKaPostFollow({ engine, follow, followedPubkey }) {
  const action = follow ? "follow" : "unfollow";
  const pubkey = requesterPubkeyFor(engine);
  const signature = signKaPostString(engine, KAPOSTS_PROTOCOL.followSigningString(action, followedPubkey));
  return submitKaPostPayload(engine, KAPOSTS_PROTOCOL.followPayload(pubkey, signature, action, followedPubkey));
}

/** K's repost mechanism IS the quote action: empty text = plain repost (marker-only message). */
export async function submitKaPostQuote({ engine, text = "", contentId, quotedAuthorPubkey }) {
  const b64 = utf8ToBase64(KACHAT_MARKER + String(text || ""));
  const pubkey = requesterPubkeyFor(engine);
  const signature = signKaPostString(engine, KAPOSTS_PROTOCOL.quoteSigningString(contentId, b64, quotedAuthorPubkey));
  return submitKaPostPayload(engine, KAPOSTS_PROTOCOL.quotePayload(pubkey, signature, contentId, b64, quotedAuthorPubkey));
}

/** Removal counter-action: withdraws our quote/repost of `contentId`. */
export async function submitKaPostUnquote({ engine, contentId }) {
  const pubkey = requesterPubkeyFor(engine);
  const signature = signKaPostString(engine, KAPOSTS_PROTOCOL.unquoteSigningString(contentId));
  return submitKaPostPayload(engine, KAPOSTS_PROTOCOL.unquotePayload(pubkey, signature, contentId));
}
