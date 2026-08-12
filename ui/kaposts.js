// KaPosts tab UI — desktop port of iOS's KaPostsView. Self-contained: app.js calls
// initKaPosts(...) once with the shared helpers, and everything else lives here.
//
// State model mirrors iOS/Android: local session posts (optimistic composer output) overlay
// the indexer feed until their txids round-trip; post/quote/like/dislike submits are held
// behind a 5-second undo countdown — cancel and nothing ever touches the network.

import {
  KAPOSTS_POST_CHARACTER_LIMIT,
  fetchFollowingFeed,
  fetchGlobalFeed,
  fetchKaPostNotifications,
  fetchKaPostUserDetails,
  fetchPostEngagement,
  fetchReplies,
  fetchUserPosts,
  decodePostContent,
  stripKaChatMarker,
  kaspaAddressFromPubkey,
  requesterPubkeyFor,
  submitKaPost,
  submitKaPostFollow,
  submitKaPostQuote,
  submitKaPostReply,
  submitKaPostUnquote,
  submitKaPostVote,
} from "../engine/kaposts.js";

const UNDO_DELAY_MS = 5000;
const KAPOSTS_PREFS_KEY = "kachat-kaposts-prefs-v1"; // { following:[], muted:[], blocked:[] } — account-scoped

let deps = null; // { engine, escapeHtml, shortAddress, accountScopedKey, showToast, appendEngineLog }

// DOM
let feedEl, statusEl, tabsEl, threadEl, threadRootEl, threadRepliesEl, toastsEl;
let composerEl, composerInput, composerMeter, composerSubmit, composerTitle, composerQuote;
let replyInput, replyMeter, replySend;

// State
let activeFeedTab = "feed";
let panelEl, panelTitleEl, panelBodyEl, popoverEl;
// activePanel: null | {type:"profile", address, pubkey, tab, posts, replies, details, loading}
//            | {type:"notifications", items, loading}
//            | {type:"engagement", postId, postTxId, tab, lists, loading}
//            | {type:"list", kind}  (bookmarks | muted | blocked | menu)
let activePanel = null;
let myContentPosts = []; // own posts+replies fetched for share/notification resolution
let localPosts = [];      // newest first, optimistic
let remotePosts = [];
let feedLoading = false;
let feedError = null;
let prefs = { following: [], muted: [], blocked: [] };
let threadStack = [];     // post ids (local ids)
let replyTargetId = null; // in-thread: which comment the reply bar targets (null = the root post)
let composerQuoteTarget = null; // post being quoted, when the composer is a quote composer
let countdownTicker = null;
let savedFeedScroll = 0;

function kapostsScrollEl() {
  return document.querySelector(".kaposts-content");
}

function rememberFeedScroll() {
  // Only when actually LEAVING the feed (not when moving between thread levels/panels).
  if (threadStack.length === 0 && !activePanel) {
    savedFeedScroll = kapostsScrollEl()?.scrollTop || 0;
  }
}

function restoreFeedScroll() {
  requestAnimationFrame(() => {
    const el = kapostsScrollEl();
    if (el && threadStack.length === 0 && !activePanel) el.scrollTop = savedFeedScroll;
  });
}

// key -> { deadline, timer, undo() } — pending 5s-undo actions
const pendingActions = new Map();

function nowId() {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `id-${Date.now()}-${Math.random()}`;
}

// ---------------------------------------------------------------------------
// Persistence (per account)
// ---------------------------------------------------------------------------

function loadPrefs() {
  try {
    const raw = localStorage.getItem(deps.accountScopedKey(KAPOSTS_PREFS_KEY));
    const parsed = raw ? JSON.parse(raw) : null;
    prefs = {
      following: Array.isArray(parsed?.following) ? parsed.following : [],
      muted: Array.isArray(parsed?.muted) ? parsed.muted : [],
      blocked: Array.isArray(parsed?.blocked) ? parsed.blocked : [],
    };
  } catch {
    prefs = { following: [], muted: [], blocked: [] };
  }
}

function savePrefs() {
  localStorage.setItem(deps.accountScopedKey(KAPOSTS_PREFS_KEY), JSON.stringify(prefs));
}

function isHiddenAuthor(address) {
  return prefs.muted.includes(address) || prefs.blocked.includes(address);
}

// ---------------------------------------------------------------------------
// Identity (contact custom name > KNS primary > short address; .kas stripped)
// ---------------------------------------------------------------------------

function posterName(address) {
  if (!address) return "Unknown";
  const info = deps.engine.peekKnsAddressInfo?.(address);
  const domain = info?.explicitPrimaryDomain || info?.primaryDomain || "";
  if (domain) return domain.toLowerCase().endsWith(".kas") ? domain.slice(0, -4) : domain;
  return deps.shortAddress(address);
}

function posterAvatarHtml(address) {
  const avatarUrl = deps.engine.peekKnsAddressProfile?.(address)?.profile?.avatarUrl;
  if (avatarUrl) {
    return `<span class="kaposts-avatar"><img src="${deps.escapeHtml(avatarUrl)}" alt="" loading="lazy" /></span>`;
  }
  // Person glyph fallback (4.0 look — no initials).
  return `<span class="kaposts-avatar kaposts-avatar-fallback" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.118a7.5 7.5 0 0 1 15 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.5-1.632Z"/></svg></span>`;
}

let knsRefreshInFlight = false;
async function refreshVisiblePosterNames() {
  if (knsRefreshInFlight) return;
  knsRefreshInFlight = true;
  try {
    const addresses = [...new Set(visibleFeedPosts().slice(0, 30).map((p) => p.posterAddress))];
    let changed = false;
    for (const address of addresses) {
      const before = deps.engine.peekKnsAddressInfo?.(address)?.explicitPrimaryDomain || null;
      await deps.engine.fetchKnsAddressInfo?.(address).catch(() => null);
      await deps.engine.fetchKnsAddressProfile?.(address).catch(() => null);
      const after = deps.engine.peekKnsAddressInfo?.(address)?.explicitPrimaryDomain || null;
      if (before !== after) changed = true;
    }
    if (changed) renderFeed();
  } finally {
    knsRefreshInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Feed data
// ---------------------------------------------------------------------------

function mapRemotePost(post) {
  const content = decodePostContent(post);
  const address = kaspaAddressFromPubkey(deps.engine, post.userPublicKey);
  if (content === null || !address) return null;
  let quoted = null;
  if (post.quote?.referencedSenderPubkey) {
    const quotedText = post.quote.referencedMessage ? decodePostContent({ postContent: post.quote.referencedMessage }) : null;
    const quotedAddress = kaspaAddressFromPubkey(deps.engine, post.quote.referencedSenderPubkey);
    if (quotedText !== null && quotedAddress) {
      quoted = { remoteId: post.quote.referencedContentId || null, text: stripKaChatMarker(quotedText), posterAddress: quotedAddress };
    }
  }
  return {
    id: `remote-${post.id}`, // stable identity across refreshes
    remoteId: post.id,
    posterPubkey: post.userPublicKey,
    posterAddress: address,
    text: stripKaChatMarker(content),
    timestamp: Number(post.timestamp) || Date.now(),
    likes: post.upVotesCount || 0,
    dislikes: post.downVotesCount || 0,
    reposts: post.quotesCount || 0,
    likedByMe: post.isUpvoted === true,
    dislikedByMe: post.isDownvoted === true,
    repostedByMe: false,
    remoteReplyCount: post.repliesCount || 0,
    comments: [],
    quoted,
    parentRemoteId: post.parentPostId || null,
    delivery: "sent",
  };
}

async function loadFeed() {
  // The KaPosts tab can be clicked before initKaPosts has run (startup awaits storage/engine
  // first) — deps is still null then, and every deps.* access below would throw.
  if (!deps) return;
  if (feedLoading) return;
  feedLoading = true;
  feedError = null;
  renderStatus();
  try {
    const result = activeFeedTab === "following"
      ? await fetchFollowingFeed({ engine: deps.engine })
      : await fetchGlobalFeed({ engine: deps.engine });
    remotePosts = result.posts.map(mapRemotePost).filter(Boolean);
  } catch (error) {
    feedError = error?.message || "Could not load the feed.";
    deps.appendEngineLog?.(`KaPosts feed load failed: ${feedError}`);
  } finally {
    feedLoading = false;
    renderStatus();
    renderFeed();
    refreshVisiblePosterNames();
  }
}

function visibleFeedPosts() {
  const combined = [
    ...localPosts,
    ...remotePosts.filter((r) => !localPosts.some((l) => l.remoteId && l.remoteId === r.remoteId)),
  ].filter((p) => !isHiddenAuthor(p.posterAddress));
  if (activeFeedTab === "following") return combined.filter((p) => prefs.following.includes(p.posterAddress));
  if (activeFeedTab === "popular") {
    return [...combined].sort((a, b) => (b.likes + b.reposts + b.dislikes) - (a.likes + a.reposts + a.dislikes));
  }
  return combined;
}

// Tree helpers (posts + nested comments)
function allPostLists() {
  const extra = [];
  if (activePanel?.type === "profile") {
    extra.push(...(activePanel.posts || []), ...(activePanel.replies || []));
  }
  return [...localPosts, ...remotePosts, ...myContentPosts, ...extra];
}

function findPost(id, list = null) {
  for (const post of list || allPostLists()) {
    if (post.id === id) return post;
    const hit = findPost(id, post.comments);
    if (hit) return hit;
  }
  return null;
}

function mutatePost(id, transform) {
  const target = findPost(id);
  if (target) transform(target);
}

function findPostByRemoteId(remoteId) {
  const search = (list) => {
    for (const post of list) {
      if (post.remoteId === remoteId) return post;
      const hit = search(post.comments || []);
      if (hit) return hit;
    }
    return null;
  };
  return search(allPostLists());
}

/**
 * Shared-link/notification landing: resolve a txid to a loaded post — loaded lists first,
 * then a feed refresh, then OWN content from the indexer (notification targets are almost
 * always your posts, which live outside the feed window). Matches iOS's openSharedPost.
 */
async function resolveAndOpenPost(txId) {
  let post = findPostByRemoteId(txId);
  if (!post) {
    await loadFeed();
    post = findPostByRemoteId(txId);
  }
  if (!post) {
    try {
      const pubkey = safeRequesterPubkey();
      if (pubkey) {
        const result = await fetchUserPosts({ engine: deps.engine, pubkey, includeReplies: true });
        myContentPosts = result.posts.map(mapRemotePost).filter(Boolean);
        post = findPostByRemoteId(txId);
      }
    } catch (error) {
      deps.appendEngineLog?.(`KaPost own-content fetch failed: ${error.message}`);
    }
  }
  if (post) {
    closePanel();
    openThread(post);
  } else {
    deps.showToast?.("Post not found — it may be older than the feed window.");
  }
}

// ---------------------------------------------------------------------------
// 5-second undo scheduler
// ---------------------------------------------------------------------------

function scheduleUndoable(key, action, undo = null) {
  cancelUndoable(key);
  const timer = setTimeout(() => {
    pendingActions.delete(key);
    stopTickerIfIdle();
    action();
  }, UNDO_DELAY_MS);
  pendingActions.set(key, { deadline: Date.now() + UNDO_DELAY_MS, timer, undo });
  startTicker();
  renderAll();
}

function cancelUndoable(key) {
  const pending = pendingActions.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingActions.delete(key);
  pending.undo?.();
  stopTickerIfIdle();
  renderAll();
}

function startTicker() {
  if (countdownTicker) return;
  countdownTicker = setInterval(() => {
    document.querySelectorAll("[data-kaposts-countdown]").forEach((el) => {
      const key = el.dataset.kapostsCountdown;
      const pending = pendingActions.get(key);
      if (pending) el.textContent = String(Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000)));
    });
  }, 200);
}

function stopTickerIfIdle() {
  if (pendingActions.size === 0 && countdownTicker) {
    clearInterval(countdownTicker);
    countdownTicker = null;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  renderFeed();
  renderThread();
  renderToasts();
}

function renderStatus() {
  if (!statusEl) return;
  if (feedLoading && remotePosts.length === 0) {
    statusEl.hidden = false;
    statusEl.textContent = "Loading the feed…";
  } else if (feedError && remotePosts.length === 0) {
    statusEl.hidden = false;
    statusEl.textContent = feedError;
  } else {
    statusEl.hidden = true;
  }
}

function countdownOrIconHtml(key, iconHtml) {
  if (pendingActions.has(key)) {
    return `<span class="kaposts-countdown" data-kaposts-countdown="${deps.escapeHtml(key)}">5</span>`;
  }
  return iconHtml;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/** Escapes text and wraps URLs in clickable spans (confirmation popover on click). */
function linkifyPostText(text) {
  const value = String(text || "");
  let result = "";
  let last = 0;
  for (const match of value.matchAll(URL_PATTERN)) {
    result += deps.escapeHtml(value.slice(last, match.index));
    const url = match[0];
    result += `<span class="kaposts-link" data-kaposts-link="${deps.escapeHtml(url)}">${deps.escapeHtml(url)}</span>`;
    last = match.index + url.length;
  }
  result += deps.escapeHtml(value.slice(last));
  return result;
}

const ICONS = {
  comment: `<svg viewBox="0 0 24 24"><path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm3.75 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm3.75 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM21 12c0 4.556-4.03 8.25-9 8.25a9.76 9.76 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"/></svg>`,
  repost: `<svg viewBox="0 0 24 24"><path d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3"/></svg>`,
  like: `<svg viewBox="0 0 24 24"><path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"/></svg>`,
  dislike: `<svg viewBox="0 0 24 24"><path d="M7.498 15.25H4.372c-1.026 0-1.945-.694-2.054-1.715a12.137 12.137 0 0 1-.068-1.285c0-2.848.992-5.464 2.649-7.521C5.287 4.247 5.886 4 6.504 4h4.016a4.5 4.5 0 0 1 1.423.23l3.114 1.04a4.5 4.5 0 0 0 1.423.23h1.294M7.498 15.25c.618 0 .991.724.725 1.282A7.471 7.471 0 0 0 7.5 19.75 2.25 2.25 0 0 0 9.75 22a.75.75 0 0 0 .75-.75v-.633c0-.573.11-1.14.322-1.672.304-.76.93-1.33 1.653-1.715a9.04 9.04 0 0 0 2.86-2.4c.498-.634 1.226-1.08 2.032-1.08h.384m-10.253 1.5H9.7m8.075-9.75c.01.05.027.1.05.148.593 1.2.925 2.55.925 3.977 0 1.487-.36 2.89-.999 4.125m.023-8.25c-.076-.365.183-.75.575-.75h.908c.889 0 1.713.518 1.972 1.368.339 1.11.521 2.287.521 3.507 0 1.553-.295 3.036-.831 4.398-.306.774-1.086 1.227-1.918 1.227h-1.053c-.472 0-.745-.556-.5-.96a8.95 8.95 0 0 0 .303-.54"/></svg>`,
  share: `<svg viewBox="0 0 24 24"><path d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"/></svg>`,
};

function postCellHtml(post, { inThread = false, isRoot = false, replyInline = false } = {}) {
  const name = posterName(post.posterAddress);
  const time = formatRelativeTime(post.timestamp);
  const isMine = post.posterAddress === deps.engine.address;
  const isFollowing = prefs.following.includes(post.posterAddress);
  const isLong = post.text.length > 280 || (post.text.match(/\n/g) || []).length >= 8;
  const foldText = !inThread && isLong;
  const commentCount = Math.max(post.remoteReplyCount || 0, post.comments.filter((c) => !isHiddenAuthor(c.posterAddress)).length);

  const deliveryHtml = post.delivery === "pending"
    ? `<div class="kaposts-delivery">Posting…</div>`
    : post.delivery === "failed"
      ? `<div class="kaposts-delivery failed">Failed to post. <button type="button" data-kaposts-retry="${post.id}">Retry</button></div>`
      : "";

  const quotedHtml = post.quoted
    ? `<div class="kaposts-quote-embed" ${post.quoted.remoteId ? `data-kaposts-open-remote="${deps.escapeHtml(post.quoted.remoteId)}"` : ""}>
         <strong>${deps.escapeHtml(posterName(post.quoted.posterAddress))}</strong>
         <span>${deps.escapeHtml(post.quoted.text || "Reposted")}</span>
       </div>`
    : "";

  return `
    <article class="kaposts-cell${isRoot ? " root" : ""}${!isRoot ? " openable" : ""}" data-kaposts-post="${post.id}"${!isRoot ? ` data-kaposts-open="${post.id}"` : ""}>
      <span data-kaposts-profile="${post.id}" class="kaposts-avatar-tap">${posterAvatarHtml(post.posterAddress)}</span>
      <div class="kaposts-cell-main">
        <div class="kaposts-cell-head">
          <strong class="kaposts-cell-name" data-kaposts-profile="${post.id}">${deps.escapeHtml(name)}</strong>
          <span class="kaposts-cell-time">${deps.escapeHtml(time)}</span>
          ${!isMine ? `<button class="kaposts-follow${isFollowing ? " following" : ""}" type="button" data-kaposts-follow="${post.id}">${isFollowing ? "Following" : "Follow"}</button>` : ""}
          <button class="kaposts-action kaposts-more" type="button" data-kaposts-more="${post.id}" aria-label="More">
            <svg viewBox="0 0 24 24"><path d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"/></svg>
          </button>
        </div>
        <div class="kaposts-cell-text${foldText ? " folded" : ""}">${linkifyPostText(post.text)}</div>
        ${foldText ? `<button class="kaposts-show-more" type="button" data-kaposts-open="${post.id}">Show more</button>` : ""}
        ${quotedHtml}
        ${deliveryHtml}
        <div class="kaposts-actions">
          <button class="kaposts-action" type="button" ${replyInline ? `data-kaposts-reply-to="${post.id}"` : `data-kaposts-open="${post.id}"`} title="${replyInline ? "Reply" : "Replies"}">
            ${ICONS.comment}${commentCount > 0 ? `<span>${commentCount}</span>` : ""}
          </button>
          <button class="kaposts-action${post.repostedByMe ? " active-repost" : ""}" type="button" data-kaposts-repost="${post.id}" title="Repost">
            ${countdownOrIconHtml(`repost:${post.id}`, ICONS.repost)}${post.reposts > 0 ? `<span>${post.reposts}</span>` : ""}
          </button>
          <button class="kaposts-action${post.likedByMe ? " active-like" : ""}" type="button" data-kaposts-like="${post.id}" title="Like">
            ${countdownOrIconHtml(`like:${post.id}`, ICONS.like)}${post.likes > 0 ? `<span>${post.likes}</span>` : ""}
          </button>
          <button class="kaposts-action${post.dislikedByMe ? " active-dislike" : ""}" type="button" data-kaposts-dislike="${post.id}" title="Dislike">
            ${countdownOrIconHtml(`dislike:${post.id}`, ICONS.dislike)}${post.dislikes > 0 ? `<span>${post.dislikes}</span>` : ""}
          </button>
          ${post.remoteId ? `<button class="kaposts-action" type="button" data-kaposts-share="${post.id}" title="Copy share link">${ICONS.share}</button>` : ""}
        </div>
      </div>
    </article>`;
}

function renderFeed() {
  if (!feedEl) return;
  const posts = visibleFeedPosts();
  if (posts.length === 0 && !feedLoading && !feedError) {
    feedEl.innerHTML = `
      <div class="no-results-card">
        <strong>${activeFeedTab === "following" ? "Nothing here yet" : "No posts yet"}</strong>
        <span>${activeFeedTab === "following"
          ? "Follow people from their posts and their content shows up here."
          : "Be the first to post something on the Kaspa network."}</span>
      </div>`;
    return;
  }
  feedEl.innerHTML = posts.map((post) => postCellHtml(post)).join("");
}

function updateReplyContext() {
  const chip = document.querySelector("[data-kaposts-reply-context]");
  const label = document.querySelector("[data-kaposts-reply-context-label]");
  if (!chip) return;
  const target = replyTargetId ? findPost(replyTargetId) : null;
  const topId = threadStack[threadStack.length - 1];
  const isNested = target && target.id !== topId;
  chip.hidden = !isNested;
  if (isNested && label) label.textContent = `Replying to ${posterName(target.posterAddress)}`;
}

function renderThread() {
  const topId = threadStack[threadStack.length - 1];
  const post = topId ? findPost(topId) : null;
  const showThread = Boolean(post);
  if (threadEl) threadEl.hidden = !showThread;
  if (feedEl) feedEl.hidden = showThread || Boolean(activePanel);
  if (tabsEl) tabsEl.hidden = showThread || Boolean(activePanel);
  if (!post || !threadRootEl) return;
  if (replyTargetId && !findPost(replyTargetId)) replyTargetId = null;
  const comments = post.comments.filter((c) => !isHiddenAuthor(c.posterAddress));
  updateReplyContext();
  if (threadRootEl) {
    threadRootEl.innerHTML = postCellHtml(post, { inThread: true, isRoot: true, replyInline: true });
  }
  if (threadRepliesEl) {
    threadRepliesEl.innerHTML = `
      <div class="kaposts-thread-replies">
        ${comments.map((comment) => `
          <div class="kaposts-thread-reply">
            ${postCellHtml(comment, { inThread: true, replyInline: true })}
            ${comment.remoteReplyCount > 0 || comment.comments.length > 0
              ? `<button class="kaposts-show-more" type="button" data-kaposts-open="${comment.id}">View replies</button>`
              : ""}
          </div>`).join("")}
      </div>`;
  }
}

function renderToasts() {
  if (!toastsEl) return;
  const parts = [];
  for (const [key, pending] of pendingActions) {
    if (!key.startsWith("post:")) continue;
    const seconds = Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000));
    parts.push(`
      <div class="kaposts-toast">
        <span class="kaposts-countdown" data-kaposts-countdown="${deps.escapeHtml(key)}">${seconds}</span>
        <span>${key.startsWith("post:quote") ? "Posting quote" : "Posting"}</span>
        <button type="button" data-kaposts-undo="${deps.escapeHtml(key)}">Undo</button>
      </div>`);
  }
  toastsEl.innerHTML = parts.join("");
}

function formatRelativeTime(timestampMs) {
  const delta = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 7 * 86400) return `${Math.floor(delta / 86400)}d`;
  return new Date(timestampMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function makeLocalPost(text, { quotedOf = null } = {}) {
  return {
    id: nowId(),
    remoteId: null,
    posterPubkey: safeRequesterPubkey(),
    posterAddress: deps.engine.address || "",
    text,
    timestamp: Date.now(),
    likes: 0, dislikes: 0, reposts: 0,
    likedByMe: false, dislikedByMe: false, repostedByMe: false,
    remoteReplyCount: 0,
    comments: [],
    quoted: quotedOf
      ? { remoteId: quotedOf.remoteId, text: quotedOf.text, posterAddress: quotedOf.posterAddress, posterPubkey: quotedOf.posterPubkey || null }
      : null,
    parentRemoteId: null,
    delivery: "pending",
  };
}

function safeRequesterPubkey() {
  try { return requesterPubkeyFor(deps.engine); } catch { return null; }
}

function schedulePost(text) {
  const post = makeLocalPost(text);
  localPosts.unshift(post);
  const key = `post:${post.id}`;
  scheduleUndoable(key, async () => {
    renderToasts();
    try {
      const txid = await submitKaPost({ engine: deps.engine, text });
      mutatePost(post.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
    } catch (error) {
      mutatePost(post.id, (p) => { p.delivery = "failed"; });
      deps.appendEngineLog?.(`KaPost submit failed: ${error.message}`);
    }
    renderAll();
  }, () => {
    localPosts = localPosts.filter((p) => p.id !== post.id);
  });
}

function scheduleQuote(target, text) {
  const post = makeLocalPost(text, { quotedOf: target });
  localPosts.unshift(post);
  const key = `post:quote-${post.id}`;
  scheduleUndoable(key, async () => {
    renderToasts();
    mutatePost(target.id, (p) => { if (!p.repostedByMe) { p.repostedByMe = true; p.reposts += 1; } });
    try {
      const txid = await submitKaPostQuote({
        engine: deps.engine, text, contentId: target.remoteId, quotedAuthorPubkey: target.posterPubkey,
      });
      mutatePost(post.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
      deps.showToast?.("Quote posted to the network");
    } catch (error) {
      mutatePost(post.id, (p) => { p.delivery = "failed"; });
      deps.appendEngineLog?.(`KaPost quote failed: ${error.message}`);
    }
    renderAll();
  }, () => {
    localPosts = localPosts.filter((p) => p.id !== post.id);
  });
}

function scheduleRepost(target) {
  scheduleUndoable(`repost:${target.id}`, async () => {
    mutatePost(target.id, (p) => { if (!p.repostedByMe) { p.repostedByMe = true; p.reposts += 1; } });
    renderAll();
    try {
      await submitKaPostQuote({ engine: deps.engine, text: "", contentId: target.remoteId, quotedAuthorPubkey: target.posterPubkey });
      deps.showToast?.("Repost posted to the network");
    } catch (error) {
      deps.appendEngineLog?.(`KaPost repost failed: ${error.message}`);
    }
  });
}

function playVoteBurst(postId, kind) {
  const selector = kind === "like" ? `[data-kaposts-like="${postId}"]` : `[data-kaposts-dislike="${postId}"]`;
  document.querySelectorAll(selector).forEach((button) => {
    button.classList.remove("kaposts-burst");
    void button.offsetWidth; // restart the animation
    button.classList.add("kaposts-burst");
    if (kind === "like") spawnKaspaLogoBurst(button);
  });
}

/** iOS-style like celebration: a burst of little Kaspa logos flying out of the heart. */
function spawnKaspaLogoBurst(anchor) {
  const rect = anchor.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  const count = 7;
  for (let i = 0; i < count; i += 1) {
    const particle = document.createElement("img");
    particle.src = "./ui/assets/kaspa-logo.png";
    particle.alt = "";
    particle.className = "kaposts-logo-particle";
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const distance = 34 + Math.random() * 26;
    particle.style.left = `${originX}px`;
    particle.style.top = `${originY}px`;
    particle.style.setProperty("--burst-x", `${Math.cos(angle) * distance}px`);
    particle.style.setProperty("--burst-y", `${Math.sin(angle) * distance - 14}px`);
    particle.style.setProperty("--burst-rot", `${(Math.random() - 0.5) * 240}deg`);
    document.body.appendChild(particle);
    particle.addEventListener("animationend", () => particle.remove());
    // Safety net in case animationend never fires (tab hidden etc.).
    setTimeout(() => particle.remove(), 1200);
  }
}

function toggleVote(post, kind) {
  const flag = kind === "like" ? "likedByMe" : "dislikedByMe";
  const other = kind === "like" ? "dislikedByMe" : "likedByMe";
  const count = kind === "like" ? "likes" : "dislikes";
  const otherCount = kind === "like" ? "dislikes" : "likes";
  scheduleUndoable(`${kind}:${post.id}`, async () => {
    const wasSet = findPost(post.id)?.[flag] === true;
    mutatePost(post.id, (p) => {
      if (p[flag]) { p[flag] = false; p[count] -= 1; }
      else {
        p[flag] = true; p[count] += 1;
        if (p[other]) { p[other] = false; p[otherCount] -= 1; }
      }
    });
    renderAll();
    if (!wasSet) playVoteBurst(post.id, kind);
    if (!post.remoteId || !post.posterPubkey) return;
    try {
      const vote = wasSet ? "unvote" : (kind === "like" ? "upvote" : "downvote");
      await submitKaPostVote({ engine: deps.engine, postId: post.remoteId, vote, authorPubkey: post.posterPubkey });
      deps.showToast?.(wasSet ? "Vote removed on the network" : `${kind === "like" ? "Like" : "Dislike"} posted to the network`);
    } catch (error) {
      deps.appendEngineLog?.(`KaPost vote failed: ${error.message}`);
    }
  });
}

function toggleFollow(post) {
  const address = post.posterAddress;
  if (!address || address === deps.engine.address) return;
  const willFollow = !prefs.following.includes(address);
  prefs.following = willFollow ? [...prefs.following, address] : prefs.following.filter((a) => a !== address);
  savePrefs();
  renderAll();
  if (!post.posterPubkey) return;
  submitKaPostFollow({ engine: deps.engine, follow: willFollow, followedPubkey: post.posterPubkey })
    .then(() => deps.showToast?.(willFollow ? "Follow posted to the network" : "Unfollow posted to the network"))
    .catch((error) => deps.appendEngineLog?.(`KaPost follow failed: ${error.message}`));
}

async function openThread(post) {
  rememberFeedScroll();
  threadStack.push(post.id);
  renderThread();
  if (!post.remoteId) return;
  try {
    const result = await fetchReplies({ engine: deps.engine, postId: post.remoteId });
    const replies = result.posts.map(mapRemotePost).filter(Boolean);
    mutatePost(post.id, (p) => {
      const localOnly = p.comments.filter((c) => !c.remoteId || !replies.some((r) => r.remoteId === c.remoteId));
      p.comments = [...replies, ...localOnly];
    });
    renderThread();
  } catch (error) {
    deps.appendEngineLog?.(`KaPost replies load failed: ${error.message}`);
  }
}

async function submitReply(parent, text) {
  const comment = makeLocalPost(text);
  mutatePost(parent.id, (p) => { p.comments = [...p.comments, comment]; });
  renderThread();
  try {
    const txid = await submitKaPostReply({
      engine: deps.engine, text, postId: parent.remoteId, parentAuthorPubkey: parent.posterPubkey,
    });
    mutatePost(comment.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
  } catch (error) {
    mutatePost(comment.id, (p) => { p.delivery = "failed"; });
    deps.appendEngineLog?.(`KaPost reply failed: ${error.message}`);
  }
  renderThread();
}

function retryPost(post) {
  mutatePost(post.id, (p) => { p.delivery = "pending"; });
  renderAll();
  const submit = post.quoted?.remoteId && post.quoted?.posterPubkey
    ? submitKaPostQuote({ engine: deps.engine, text: post.text, contentId: post.quoted.remoteId, quotedAuthorPubkey: post.quoted.posterPubkey })
    : submitKaPost({ engine: deps.engine, text: post.text });
  submit
    .then((txid) => { mutatePost(post.id, (p) => { p.remoteId = txid; p.delivery = "sent"; }); renderAll(); })
    .catch(() => { mutatePost(post.id, (p) => { p.delivery = "failed"; }); renderAll(); });
}

// ---------------------------------------------------------------------------
// Composer + meter
// ---------------------------------------------------------------------------

function updateMeter(input, meter, submit = null) {
  const count = input.value.length;
  const limit = KAPOSTS_POST_CHARACTER_LIMIT;
  const remaining = limit - count;
  const nearLimit = count / limit >= 0.9;
  meter.hidden = count === 0 || !nearLimit;
  if (nearLimit) {
    meter.textContent = String(remaining);
    meter.classList.toggle("over", remaining <= 0);
  }
  if (count > limit) input.value = input.value.slice(0, limit);
  if (submit) submit.disabled = input.value.trim().length === 0;
}

function openComposer(quoteTarget = null) {
  // Posting costs KAS — with a confirmed-zero chatting balance, show the funding
  // popup (QR + address + copy) instead of a composer that could never submit.
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  composerQuoteTarget = quoteTarget;
  composerTitle.textContent = quoteTarget ? "Quote Post" : "New Post";
  composerInput.value = "";
  composerSubmit.disabled = true;
  composerMeter.hidden = true;
  if (quoteTarget) {
    composerQuote.hidden = false;
    composerQuote.innerHTML = `
      <strong>${deps.escapeHtml(posterName(quoteTarget.posterAddress))}</strong>
      <span>${deps.escapeHtml(quoteTarget.text)}</span>`;
  } else {
    composerQuote.hidden = true;
    composerQuote.innerHTML = "";
  }
  composerEl.hidden = false;
  composerInput.focus();
}

function closeComposer() {
  composerEl.hidden = true;
  composerQuoteTarget = null;
}

// ---------------------------------------------------------------------------
// Panels (profile / notifications / engagement / bookmarks / muted / blocked / menu)
// ---------------------------------------------------------------------------

function syncRailActive() {
  const current = !activePanel
    ? "feed"
    : activePanel.type === "list"
      ? activePanel.kind
      : activePanel.type === "profile" && activePanel.address === deps.engine.address
        ? "profile"
        : activePanel.type === "notifications"
          ? "notifications"
          : null;
  document.querySelectorAll("[data-kaposts-rail]").forEach((button) => {
    button.classList.toggle("active", button.dataset.kapostsRail === current);
  });
}

function closePanel() {
  activePanel = null;
  renderPanel();
  syncRailActive();
  restoreFeedScroll();
}

function renderPanel() {
  const show = Boolean(activePanel);
  if (panelEl) panelEl.hidden = !show;
  if (feedEl) feedEl.hidden = show || threadStack.length > 0;
  if (tabsEl) tabsEl.hidden = show || threadStack.length > 0;
  if (!show || !panelBodyEl) return;
  const panel = activePanel;
  const titles = {
    profile: "Profile", notifications: "Notifications", engagement: "Post Activity",
    bookmarks: "Bookmarks", muted: "Muted", blocked: "Blocked", menu: "KaPosts",
  };
  panelTitleEl.textContent = titles[panel.type === "list" ? panel.kind : panel.type] || "Panel";

  if (panel.type === "profile") {
    const address = panel.address;
    const profile = deps.engine.peekKnsAddressProfile?.(address)?.profile || null;
    const isMine = address === deps.engine.address;
    const isFollowing = prefs.following.includes(address);
    const feedItems = panel.tab === "replies" ? (panel.replies || []) : (panel.posts || []);
    panelBodyEl.innerHTML = `
      <div class="kaposts-profile-hero">
        <div class="kaposts-profile-banner"${profile?.bannerUrl ? ` style="background-image:url('${deps.escapeHtml(profile.bannerUrl)}')"` : ""}></div>
        <div class="kaposts-profile-row">
          ${posterAvatarHtml(address)}
          <div class="kaposts-profile-meta">
            <strong>${deps.escapeHtml(posterName(address))}</strong>
            ${profile?.bio ? `<span class="kaposts-profile-bio">${deps.escapeHtml(profile.bio)}</span>` : ""}
            <span class="kaposts-profile-counts">
              <b>${panel.details?.followingCount ?? "–"}</b> Following&nbsp;&nbsp;
              <b>${panel.details?.followersCount ?? "–"}</b> Followers
            </span>
          </div>
          ${!isMine ? `<button class="kaposts-follow${isFollowing ? " following" : ""}" type="button" data-kaposts-profile-follow>${isFollowing ? "Following" : "Follow"}</button>` : ""}
        </div>
      </div>
      <div class="kaposts-feed-tabs kaposts-profile-tabs">
        <button class="kaposts-feed-tab${panel.tab !== "replies" ? " active" : ""}" type="button" data-kaposts-profile-tab="posts">Posts</button>
        <button class="kaposts-feed-tab${panel.tab === "replies" ? " active" : ""}" type="button" data-kaposts-profile-tab="replies">Replies</button>
      </div>
      ${panel.loading && feedItems.length === 0
        ? `<div class="kaposts-feed-status">Loading…</div>`
        : feedItems.length === 0
          ? `<div class="no-results-card"><strong>${panel.tab === "replies" ? "No replies yet" : "No posts yet"}</strong></div>`
          : feedItems.map((post) => postCellHtml(post, { inThread: true })).join("")}`;
    return;
  }

  if (panel.type === "notifications") {
    const items = panel.items || [];
    panelBodyEl.innerHTML = panel.loading && items.length === 0
      ? `<div class="kaposts-feed-status">Loading…</div>`
      : items.length === 0
        ? `<div class="no-results-card"><strong>Nothing yet</strong><span>When someone likes, replies to or shares your posts, it shows up here.</span></div>`
        : items.map((item) => `
            <div class="kaposts-notification-row${item.targetTxId ? " openable" : ""}" ${item.targetTxId ? `data-kaposts-open-remote="${deps.escapeHtml(item.targetTxId)}"` : ""}>
              ${posterAvatarHtml(item.actorAddress)}
              <div class="kaposts-notification-main">
                <span><strong>${deps.escapeHtml(posterName(item.actorAddress))}</strong> ${deps.escapeHtml(item.action)}</span>
                ${item.snippet ? `<span class="kaposts-notification-snippet">${deps.escapeHtml(item.snippet)}</span>` : ""}
                <span class="kaposts-cell-time">${deps.escapeHtml(formatRelativeTime(item.timestamp))}</span>
              </div>
              <a class="kaposts-view-link" href="${deps.escapeHtml(deps.explorerTxUrl(item.id))}" target="_blank" rel="noopener">View</a>
            </div>`).join("");
    return;
  }

  if (panel.type === "engagement") {
    const lists = panel.lists || { likes: [], dislikes: [], reposts: [], quotes: [] };
    const tab = panel.tab || "likes";
    const rows = lists[tab] || [];
    const tabLabel = (key, label) => {
      const count = (lists[key] || []).length;
      return count > 0 ? `${label} (${count})` : label;
    };
    panelBodyEl.innerHTML = `
      <div class="kaposts-feed-tabs kaposts-profile-tabs">
        ${["likes:Likes", "dislikes:Dislikes", "reposts:Reposts", "quotes:Quotes"].map((entry) => {
          const [key, label] = entry.split(":");
          return `<button class="kaposts-feed-tab${tab === key ? " active" : ""}" type="button" data-kaposts-engagement-tab="${key}">${tabLabel(key, label)}</button>`;
        }).join("")}
      </div>
      ${panel.loading
        ? `<div class="kaposts-feed-status">Loading…</div>`
        : rows.length === 0
          ? `<div class="no-results-card"><strong>Nothing here yet</strong><span>When someone engages with this post, they'll show up here.</span></div>`
          : rows.map((entry) => `
              <div class="kaposts-notification-row">
                ${posterAvatarHtml(entry.actorAddress)}
                <div class="kaposts-notification-main">
                  <span><strong>${deps.escapeHtml(posterName(entry.actorAddress))}</strong></span>
                  <span class="kaposts-cell-time">${deps.escapeHtml(formatRelativeTime(entry.timestamp))}</span>
                </div>
                <a class="kaposts-view-link" href="${deps.escapeHtml(deps.explorerTxUrl(entry.actionTxId))}" target="_blank" rel="noopener">View</a>
              </div>`).join("")}
      ${panel.postTxId ? `<a class="kaposts-view-link kaposts-post-tx-link" href="${deps.escapeHtml(deps.explorerTxUrl(panel.postTxId))}" target="_blank" rel="noopener">View Post Transaction in Explorer</a>` : ""}`;
    return;
  }

  if (panel.type === "list") {
    if (panel.kind === "bookmarks") {
      const bookmarks = allPostLists().filter((p) => p.bookmarkedByMe && !isHiddenAuthor(p.posterAddress));
      panelBodyEl.innerHTML = bookmarks.length === 0
        ? `<div class="no-results-card"><strong>No bookmarks yet</strong><span>Bookmark posts from their ⋯ menu to find them here.</span></div>`
        : bookmarks.map((post) => postCellHtml(post, { inThread: true })).join("");
      return;
    }
    const addresses = panel.kind === "muted" ? prefs.muted : prefs.blocked;
    panelBodyEl.innerHTML = addresses.length === 0
      ? `<div class="no-results-card"><strong>No ${panel.kind} users</strong><span>Their posts hide everywhere in KaPosts.</span></div>`
      : addresses.map((address) => `
          <div class="kaposts-notification-row">
            ${posterAvatarHtml(address)}
            <div class="kaposts-notification-main"><span><strong>${deps.escapeHtml(posterName(address))}</strong></span></div>
            <button class="kaposts-view-link" type="button" data-kaposts-unhide="${deps.escapeHtml(address)}" data-kaposts-unhide-kind="${panel.kind}">
              ${panel.kind === "muted" ? "Unmute" : "Unblock"}
            </button>
          </div>`).join("");
  }
}

async function openPosterProfile(address, pubkey) {
  rememberFeedScroll();
  activePanel = { type: "profile", address, pubkey, tab: "posts", posts: [], replies: [], details: null, loading: true };
  renderPanel();
  syncRailActive();
  deps.engine.fetchKnsAddressInfo?.(address).catch(() => null)
    .then(() => deps.engine.fetchKnsAddressProfile?.(address).catch(() => null))
    .then(() => { if (activePanel?.type === "profile" && activePanel.address === address) renderPanel(); });
  if (!pubkey) { activePanel.loading = false; renderPanel(); return; }
  try {
    const [details, content] = await Promise.all([
      fetchKaPostUserDetails({ engine: deps.engine, pubkey }).catch(() => null),
      fetchUserPosts({ engine: deps.engine, pubkey, includeReplies: true }),
    ]);
    if (activePanel?.type !== "profile" || activePanel.address !== address) return;
    const mapped = content.posts.map(mapRemotePost).filter(Boolean);
    activePanel.posts = mapped.filter((p) => !p.parentRemoteId);
    activePanel.replies = mapped.filter((p) => p.parentRemoteId);
    activePanel.details = details;
    activePanel.loading = false;
    renderPanel();
  } catch (error) {
    deps.appendEngineLog?.(`KaPost profile load failed: ${error.message}`);
    if (activePanel?.type === "profile") { activePanel.loading = false; renderPanel(); }
  }
}

async function openNotificationsPanel() {
  rememberFeedScroll();
  activePanel = { type: "notifications", items: [], loading: true };
  renderPanel();
  syncRailActive();
  try {
    const raw = await fetchKaPostNotifications({ engine: deps.engine });
    if (activePanel?.type !== "notifications") return;
    const my = deps.engine.address;
    activePanel.items = raw.map((n) => {
      const actorAddress = kaspaAddressFromPubkey(deps.engine, n.userPublicKey);
      if (!actorAddress || actorAddress === my || isHiddenAuthor(actorAddress)) return null;
      const text = stripKaChatMarker(n.postContent ? (decodePostContent({ postContent: n.postContent }) || "") : "").trim();
      let action = "interacted with your post";
      let targetTxId = n.contentId || null;
      if (n.contentType === "vote") action = n.voteType === "downvote" ? "disliked your post" : "liked your post";
      else if (n.contentType === "reply") { action = "replied to your post"; targetTxId = n.id; }
      else if (n.contentType === "quote") {
        action = text ? "quoted your post" : "reposted your post";
        targetTxId = text ? n.id : n.contentId;
      } else if (n.contentType === "follow") { action = "followed you"; targetTxId = null; }
      return { id: n.id, actorAddress, action, snippet: text || null, timestamp: Number(n.timestamp) || Date.now(), targetTxId };
    }).filter(Boolean);
    activePanel.loading = false;
    renderPanel();
    const addresses = [...new Set(activePanel.items.map((i) => i.actorAddress))].slice(0, 20);
    for (const address of addresses) {
      await deps.engine.fetchKnsAddressInfo?.(address).catch(() => null);
      await deps.engine.fetchKnsAddressProfile?.(address).catch(() => null);
    }
    if (activePanel?.type === "notifications") renderPanel();
  } catch (error) {
    deps.appendEngineLog?.(`KaPost notifications load failed: ${error.message}`);
    if (activePanel?.type === "notifications") { activePanel.loading = false; renderPanel(); }
  }
}

async function openEngagementPanel(post) {
  activePanel = { type: "engagement", postId: post.id, postTxId: post.remoteId, tab: "likes", lists: null, loading: true };
  renderPanel();
  const lists = { likes: [], dislikes: [], reposts: [], quotes: [] };
  try {
    const rows = await fetchPostEngagement({ engine: deps.engine, postId: post.remoteId });
    for (const row of rows) {
      const actorAddress = kaspaAddressFromPubkey(deps.engine, row.actorPubkey);
      if (!actorAddress) continue;
      const entry = { actionTxId: row.actionTxId, actorAddress, timestamp: Number(row.timestamp) || Date.now() };
      if (row.kind === "upvote") lists.likes.push(entry);
      else if (row.kind === "downvote") lists.dislikes.push(entry);
      else if (row.kind === "repost") lists.reposts.push(entry);
      else if (row.kind === "quote") lists.quotes.push(entry);
    }
  } catch (error) {
    // Older deployments: derive from the notification stream (own posts only).
    if (post.posterAddress === deps.engine.address) {
      try {
        const raw = await fetchKaPostNotifications({ engine: deps.engine });
        for (const n of raw) {
          if (n.contentId !== post.remoteId) continue;
          const actorAddress = kaspaAddressFromPubkey(deps.engine, n.userPublicKey);
          if (!actorAddress) continue;
          const entry = { actionTxId: n.id, actorAddress, timestamp: Number(n.timestamp) || Date.now() };
          if (n.contentType === "vote") {
            if (n.voteType === "upvote") lists.likes.push(entry);
            else if (n.voteType === "downvote") lists.dislikes.push(entry);
          } else if (n.contentType === "quote") {
            const text = stripKaChatMarker(decodePostContent({ postContent: n.postContent }) || "").trim();
            (text ? lists.quotes : lists.reposts).push(entry);
          }
        }
      } catch { /* leave empty */ }
    }
  }
  if (activePanel?.type !== "engagement" || activePanel.postId !== post.id) return;
  activePanel.lists = lists;
  activePanel.loading = false;
  renderPanel();
}

// ---------------------------------------------------------------------------
// Popovers (repost/quote chooser + per-post ⋯ menu)
// ---------------------------------------------------------------------------

function setKaPostsScrollLock(locked) {
  document.querySelector('[data-app-tab-screen="kaposts"]')?.classList.toggle("scroll-locked", locked);
}

function closePopover() {
  if (popoverEl) { popoverEl.hidden = true; popoverEl.innerHTML = ""; }
  setKaPostsScrollLock(false);
}

function openPopover(anchor, itemsHtml) {
  if (!popoverEl || !anchor) return;
  popoverEl.innerHTML = itemsHtml;
  popoverEl.hidden = false;
  const screenRect = popoverEl.offsetParent?.getBoundingClientRect?.() || { left: 0, top: 0 };
  const rect = anchor.getBoundingClientRect();
  popoverEl.style.left = `${Math.max(8, rect.left - screenRect.left - 120)}px`;
  popoverEl.style.top = `${rect.bottom - screenRect.top + 6}px`;
}

function openRepostPopover(anchor, post) {
  openPopover(anchor, `
    <button type="button" data-kaposts-pop="repost" data-kaposts-pop-id="${post.id}">Repost</button>
    <button type="button" data-kaposts-pop="quote" data-kaposts-pop-id="${post.id}">Quote</button>`);
}

function openMorePopover(anchor, post) {
  const isMine = post.posterAddress === deps.engine.address;
  openPopover(anchor, `
    ${post.remoteId ? `<button type="button" data-kaposts-pop="share" data-kaposts-pop-id="${post.id}">Share</button>` : ""}
    ${post.remoteId ? `<button type="button" data-kaposts-pop="activity" data-kaposts-pop-id="${post.id}">Post Activity</button>` : ""}
    <button type="button" data-kaposts-pop="bookmark" data-kaposts-pop-id="${post.id}">${post.bookmarkedByMe ? "Remove Bookmark" : "Bookmark"}</button>
    ${!isMine ? `<button type="button" data-kaposts-pop="mute" data-kaposts-pop-id="${post.id}">Mute</button>` : ""}
    ${!isMine ? `<button type="button" data-kaposts-pop="block" data-kaposts-pop-id="${post.id}" class="danger">Block</button>` : ""}`);
}

function handlePopoverAction(action, post) {
  closePopover();
  if (!post) return;
  if (action === "repost") scheduleRepost(post);
  else if (action === "quote") openComposer(post);
  else if (action === "share") {
    const snippet = post.text.slice(0, 60).trim();
    const ellipsis = post.text.length > 60 ? "..." : "";
    navigator.clipboard?.writeText(`"${snippet}${ellipsis}"\n\nOpen in KaChat: kachat://kapost/${post.remoteId}`);
    deps.showToast?.("Share link copied");
  } else if (action === "activity") openEngagementPanel(post);
  else if (action === "bookmark") { mutatePost(post.id, (p) => { p.bookmarkedByMe = !p.bookmarkedByMe; }); renderAll(); }
  else if (action === "mute") { prefs.muted = [...new Set([...prefs.muted, post.posterAddress])]; savePrefs(); renderAll(); }
  else if (action === "block") {
    prefs.blocked = [...new Set([...prefs.blocked, post.posterAddress])];
    prefs.muted = prefs.muted.filter((a) => a !== post.posterAddress);
    savePrefs(); renderAll();
  }
}

// ---------------------------------------------------------------------------
// Init + events
// ---------------------------------------------------------------------------

export function refreshKaPostsFeed() {
  loadFeed();
}

export function resetKaPostsForAccount() {
  loadPrefs();
  localPosts = [];
  remotePosts = [];
  myContentPosts = [];
  threadStack = [];
  activePanel = null;
  renderAll();
  renderPanel();
}

export function initKaPosts(dependencies) {
  deps = dependencies;

  feedEl = document.querySelector("[data-kaposts-feed]");
  statusEl = document.querySelector("[data-kaposts-status]");
  tabsEl = document.querySelector("[data-kaposts-feed-tabs]");
  threadEl = document.querySelector("[data-kaposts-thread]");
  threadRootEl = document.querySelector("[data-kaposts-thread-root]");
  threadRepliesEl = document.querySelector("[data-kaposts-thread-replies]");
  toastsEl = document.querySelector("[data-kaposts-toasts]");
  composerEl = document.querySelector("[data-kaposts-composer]");
  composerInput = document.querySelector("[data-kaposts-composer-input]");
  composerMeter = document.querySelector("[data-kaposts-composer-meter]");
  composerSubmit = document.querySelector("[data-kaposts-composer-submit]");
  composerTitle = document.querySelector("[data-kaposts-composer-title]");
  composerQuote = document.querySelector("[data-kaposts-composer-quote]");
  replyInput = document.querySelector("[data-kaposts-reply-input]");
  replyMeter = document.querySelector("[data-kaposts-reply-meter]");
  replySend = document.querySelector("[data-kaposts-reply-send]");
  panelEl = document.querySelector("[data-kaposts-panel]");
  panelTitleEl = document.querySelector("[data-kaposts-panel-title]");
  panelBodyEl = document.querySelector("[data-kaposts-panel-body]");
  popoverEl = document.querySelector("[data-kaposts-popover]");

  loadPrefs();

  // Feed tab switching
  tabsEl?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-kaposts-feed-tab]");
    if (!button) return;
    activeFeedTab = button.dataset.kapostsFeedTab;
    tabsEl.querySelectorAll("[data-kaposts-feed-tab]").forEach((b) => b.classList.toggle("active", b === button));
    renderFeed();
    loadFeed();
  });

  document.querySelector("[data-kaposts-refresh]")?.addEventListener("click", () => loadFeed());
  document.querySelector("[data-kaposts-compose]")?.addEventListener("click", () => openComposer());
  // X-style persistent rail: the sections are always visible on the left.
  document.querySelectorAll("[data-kaposts-rail]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.kapostsRail;
      threadStack = [];
      if (key === "feed") closePanel();
      else if (key === "notifications") openNotificationsPanel();
      else if (key === "profile") openPosterProfile(deps.engine.address, safeRequesterPubkey());
      else { rememberFeedScroll(); activePanel = { type: "list", kind: key }; renderPanel(); }
      renderThread();
      renderFeed();
      syncRailActive();
    });
  });
  document.querySelector("[data-kaposts-panel-back]")?.addEventListener("click", () => { closePanel(); syncRailActive(); });
  document.addEventListener("click", (event) => {
    if (!popoverEl || popoverEl.hidden) return;
    if (!popoverEl.contains(event.target) && !event.target.closest("[data-kaposts-more], [data-kaposts-repost], [data-kaposts-link]")) {
      closePopover();
    }
  });
  document.querySelector("[data-kaposts-composer-cancel]")?.addEventListener("click", closeComposer);
  document.querySelector("[data-kaposts-thread-back]")?.addEventListener("click", () => {
    threadStack.pop();
    replyTargetId = null;
    renderThread();
    renderFeed();
    restoreFeedScroll();
  });

  composerInput?.addEventListener("input", () => updateMeter(composerInput, composerMeter, composerSubmit));
  composerSubmit?.addEventListener("click", () => {
    const text = composerInput.value.trim();
    if (!text) return;
    const quoteTarget = composerQuoteTarget;
    closeComposer();
    if (quoteTarget) scheduleQuote(quoteTarget, text);
    else schedulePost(text);
  });

  replyInput?.addEventListener("input", () => updateMeter(replyInput, replyMeter));
  replySend?.addEventListener("click", () => {
    if (deps.isChattingBalanceZero?.()) {
      deps.showFundingGate?.();
      return;
    }
    const text = replyInput.value.trim();
    const topId = threadStack[threadStack.length - 1];
    const target = (replyTargetId ? findPost(replyTargetId) : null) || (topId ? findPost(topId) : null);
    if (!text || !target || !target.remoteId) return;
    replyInput.value = "";
    updateMeter(replyInput, replyMeter);
    replyTargetId = null;
    updateReplyContext();
    submitReply(target, text);
  });

  // Delegated feed/thread/toast interactions
  const screen = document.querySelector('[data-app-tab-screen="kaposts"]');
  screen?.addEventListener("click", (event) => {
    const link = event.target.closest("[data-kaposts-link]");
    if (link) {
      event.stopPropagation();
      openPopover(link, `
        <button type="button" data-kaposts-link-open="${deps.escapeHtml(link.dataset.kapostsLink)}">Open Link</button>
        <button type="button" data-kaposts-link-copy="${deps.escapeHtml(link.dataset.kapostsLink)}">Copy Link</button>`);
      // Scrolling locks while the link menu is up - click away (or pick an option) to release.
      setKaPostsScrollLock(true);
      return;
    }
    const linkOpen = event.target.closest("[data-kaposts-link-open]");
    if (linkOpen) {
      closePopover();
      window.open(linkOpen.dataset.kapostsLinkOpen, "_blank", "noopener");
      return;
    }
    const linkCopy = event.target.closest("[data-kaposts-link-copy]");
    if (linkCopy) {
      closePopover();
      navigator.clipboard?.writeText(linkCopy.dataset.kapostsLinkCopy);
      deps.showToast?.("Link copied");
      return;
    }

    const replyTo = event.target.closest("[data-kaposts-reply-to]");
    if (replyTo) {
      // Reply to a comment right here - no need to drill into its own thread first.
      replyTargetId = replyTo.dataset.kapostsReplyTo;
      updateReplyContext();
      replyInput?.focus();
      return;
    }
    if (event.target.closest("[data-kaposts-reply-context-clear]")) {
      replyTargetId = null;
      updateReplyContext();
      replyInput?.focus();
      return;
    }

    const undo = event.target.closest("[data-kaposts-undo]");
    if (undo) { cancelUndoable(undo.dataset.kapostsUndo); return; }

    const countdown = event.target.closest("[data-kaposts-countdown]");
    if (countdown) { cancelUndoable(countdown.dataset.kapostsCountdown); return; }

    const like = event.target.closest("[data-kaposts-like]");
    if (like) { const p = findPost(like.dataset.kapostsLike); if (p) toggleVote(p, "like"); return; }

    const dislike = event.target.closest("[data-kaposts-dislike]");
    if (dislike) { const p = findPost(dislike.dataset.kapostsDislike); if (p) toggleVote(p, "dislike"); return; }

    const repost = event.target.closest("[data-kaposts-repost]");
    if (repost) {
      const p = findPost(repost.dataset.kapostsRepost);
      if (!p || !p.remoteId || !p.posterPubkey) return;
      openRepostPopover(repost, p);
      return;
    }

    const pop = event.target.closest("[data-kaposts-pop]");
    if (pop) {
      handlePopoverAction(pop.dataset.kapostsPop, findPost(pop.dataset.kapostsPopId));
      return;
    }

    const more = event.target.closest("[data-kaposts-more]");
    if (more) {
      const p = findPost(more.dataset.kapostsMore);
      if (p) openMorePopover(more, p);
      return;
    }

    const profileTap = event.target.closest("[data-kaposts-profile]");
    if (profileTap) {
      const p = findPost(profileTap.dataset.kapostsProfile);
      if (p) openPosterProfile(p.posterAddress, p.posterPubkey);
      return;
    }

    const profileTab = event.target.closest("[data-kaposts-profile-tab]");
    if (profileTab && activePanel?.type === "profile") {
      activePanel.tab = profileTab.dataset.kapostsProfileTab;
      renderPanel();
      return;
    }

    const profileFollow = event.target.closest("[data-kaposts-profile-follow]");
    if (profileFollow && activePanel?.type === "profile") {
      toggleFollow({ posterAddress: activePanel.address, posterPubkey: activePanel.pubkey });
      renderPanel();
      return;
    }

    const engagementTab = event.target.closest("[data-kaposts-engagement-tab]");
    if (engagementTab && activePanel?.type === "engagement") {
      activePanel.tab = engagementTab.dataset.kapostsEngagementTab;
      renderPanel();
      return;
    }

    const unhide = event.target.closest("[data-kaposts-unhide]");
    if (unhide) {
      const address = unhide.dataset.kapostsUnhide;
      if (unhide.dataset.kapostsUnhideKind === "muted") prefs.muted = prefs.muted.filter((a) => a !== address);
      else prefs.blocked = prefs.blocked.filter((a) => a !== address);
      savePrefs();
      renderPanel();
      renderFeed();
      return;
    }

    const follow = event.target.closest("[data-kaposts-follow]");
    if (follow) { const p = findPost(follow.dataset.kapostsFollow); if (p) toggleFollow(p); return; }

    const share = event.target.closest("[data-kaposts-share]");
    if (share) {
      const p = findPost(share.dataset.kapostsShare);
      if (p?.remoteId) {
        const snippet = p.text.slice(0, 60).trim();
        const ellipsis = p.text.length > 60 ? "..." : "";
        navigator.clipboard?.writeText(`"${snippet}${ellipsis}"\n\nOpen in KaChat: kachat://kapost/${p.remoteId}`);
        deps.showToast?.("Share link copied");
      }
      return;
    }

    const retry = event.target.closest("[data-kaposts-retry]");
    if (retry) { const p = findPost(retry.dataset.kapostsRetry); if (p) retryPost(p); return; }

    const openRemote = event.target.closest("[data-kaposts-open-remote]");
    if (openRemote) {
      if (event.target.closest("a")) return; // let the explorer link win its own clicks
      resolveAndOpenPost(openRemote.dataset.kapostsOpenRemote);
      return;
    }

    const open = event.target.closest("[data-kaposts-open]");
    if (open) { const p = findPost(open.dataset.kapostsOpen); if (p) openThread(p); return; }
  });
}
