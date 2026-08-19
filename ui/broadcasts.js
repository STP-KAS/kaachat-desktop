// Broadcasts tab UI — desktop port of the iOS/Android 4.0 broadcast rooms. Channel list
// (featured rooms pinned + joinable customs), room view with indexer backfill (once on open +
// 8s polling while open), per-room hidden users, the permanent public/3-day banner on the
// featured rooms, and a live connection dot in the room header. Feature parity with mobile:
// link previews in bubbles (same progressive Nextcloud probe as 1:1), reactions (same
// cross-platform JSON payload as 1:1, sent as normal broadcast messages), and voice notes
// via Nextcloud media upload.

import {
  BROADCAST_RETENTION_MS,
  FEATURED_BROADCAST_CHANNELS,
  fetchBroadcastHistory,
  isFeaturedBroadcastChannel,
  isValidBroadcastChannel,
  normalizeBroadcastChannel,
  sendBroadcastMessage,
} from "../engine/broadcasts.js";

const CHANNELS_KEY = "kachat-broadcast-channels-v1";        // account-scoped: ["name", ...]
const HIDDEN_KEY = "kachat-broadcast-hidden-v1";            // account-scoped: { [channel]: [address, ...] }
const CACHE_KEY = "kachat-broadcast-messages-cache-v1";     // GLOBAL: public chain data, account-agnostic
const REACTIONS_KEY = "kachat-broadcast-reactions-cache-v1"; // GLOBAL: public chain data, account-agnostic
const POLL_MS = 8000;
// Nextcloud carries the audio bytes — same 600s cap as the 1:1 Nextcloud voice notes.
const VOICE_MAX_DURATION_SECONDS = 600;

let deps = null;

let listEl, roomEl, roomTitleEl, roomDotEl, roomBodyEl, roomBannerEl, composerInput, sendBtn, joinInput;
let voicePanelEl, voiceTimeEl, voiceBtn;
let joinedChannels = [];
let hiddenByRoom = {};
let messageCache = {}; // { [channel]: [{ txId, senderAddress, content, blockTime, status? }] }
// { [channel]: { byTarget: { [targetTxId]: { [reactorAddress]: { emoji, blockTime, removed? } } },
//                txIds: [processed reaction txids], lastEvent: { senderAddress, emoji, blockTime } | null } }
let reactionsCache = {};
let activeChannel = null;
let pollTimer = null;
let sendInFlight = false;
let voiceRecorder = null;
let voiceRecordingChannel = null;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadState() {
  try {
    joinedChannels = JSON.parse(localStorage.getItem(deps.accountScopedKey(CHANNELS_KEY)) || "[]") || [];
  } catch { joinedChannels = []; }
  try {
    hiddenByRoom = JSON.parse(localStorage.getItem(deps.accountScopedKey(HIDDEN_KEY)) || "{}") || {};
  } catch { hiddenByRoom = {}; }
  try {
    messageCache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") || {};
  } catch { messageCache = {}; }
  try {
    reactionsCache = JSON.parse(localStorage.getItem(REACTIONS_KEY) || "{}") || {};
  } catch { reactionsCache = {}; }
  // The curated rooms are always present for every account (matches iOS/Android).
  for (const name of FEATURED_BROADCAST_CHANNELS) {
    if (!joinedChannels.includes(name)) joinedChannels.push(name);
  }
  migrateCachedReactionRows();
  pruneCache();
}

/** Older caches stored reaction payload rows as normal messages — lift them into the
 *  reactions store so they never render as raw-JSON rows. */
function migrateCachedReactionRows() {
  let migrated = false;
  for (const channel of Object.keys(messageCache)) {
    const kept = [];
    for (const row of messageCache[channel] || []) {
      const reaction = deps.parseReactionEnvelope?.(row.content);
      if (reaction) {
        recordReaction(channel, row.txId, reaction, row.senderAddress || "", Number(row.blockTime) || 0);
        migrated = true;
      } else {
        kept.push(row);
      }
    }
    messageCache[channel] = kept;
  }
  if (migrated) { saveCache(); saveReactions(); }
}

function saveChannels() {
  localStorage.setItem(deps.accountScopedKey(CHANNELS_KEY), JSON.stringify(joinedChannels));
}

function saveHidden() {
  localStorage.setItem(deps.accountScopedKey(HIDDEN_KEY), JSON.stringify(hiddenByRoom));
}

function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(messageCache)); }
  catch { /* quota — drop oldest channels rather than crash */
    messageCache = {};
  }
}

function saveReactions() {
  try { localStorage.setItem(REACTIONS_KEY, JSON.stringify(reactionsCache)); }
  catch { reactionsCache = {}; }
}

/** Fixed 3-day rolling retention, matching the featured rooms' product rule. */
function pruneCache() {
  const cutoff = Date.now() - BROADCAST_RETENTION_MS;
  for (const channel of Object.keys(messageCache)) {
    messageCache[channel] = (messageCache[channel] || []).filter((m) => (m.blockTime || 0) >= cutoff);
    if (messageCache[channel].length === 0) delete messageCache[channel];
  }
  for (const channel of Object.keys(reactionsCache)) {
    const entry = reactionsCache[channel] || {};
    for (const targetTxId of Object.keys(entry.byTarget || {})) {
      const perReactor = entry.byTarget[targetTxId];
      for (const reactor of Object.keys(perReactor)) {
        if (Number(perReactor[reactor]?.blockTime || 0) < cutoff) delete perReactor[reactor];
      }
      if (Object.keys(perReactor).length === 0) delete entry.byTarget[targetTxId];
    }
    if (entry.lastEvent && Number(entry.lastEvent.blockTime || 0) < cutoff) entry.lastEvent = null;
    if (Array.isArray(entry.txIds) && entry.txIds.length > 500) entry.txIds = entry.txIds.slice(-500);
    if (Object.keys(entry.byTarget || {}).length === 0 && !entry.lastEvent) delete reactionsCache[channel];
  }
}

function hiddenIn(channel) {
  return new Set(hiddenByRoom[channel] || []);
}

// ---------------------------------------------------------------------------
// Reactions store (mirrors app.js's reactionsByTxId semantics, per channel)
// ---------------------------------------------------------------------------

function reactionsFor(channel) {
  return reactionsCache[channel]?.byTarget || {};
}

/** Applies one reaction event. Newest-wins per (targetTxId, reactor); a "remove" is kept as
 *  a tombstone so an older "add" seen again on a later poll can't resurrect the reaction.
 *  Dedupes by reaction txId (pass null for optimistic local applies). Returns true if the
 *  store changed. */
function recordReaction(channel, txId, reaction, reactorAddress, blockTime) {
  if (!reactorAddress) return false;
  const entry = (reactionsCache[channel] ||= { byTarget: {}, txIds: [], lastEvent: null });
  entry.txIds ||= [];
  entry.byTarget ||= {};
  if (txId && entry.txIds.includes(txId)) return false;
  if (txId) entry.txIds.push(txId);
  const perReactor = (entry.byTarget[reaction.targetTxId] ||= {});
  const existing = perReactor[reactorAddress];
  if (!existing || Number(existing.blockTime || 0) <= blockTime) {
    perReactor[reactorAddress] = {
      emoji: reaction.emoji,
      blockTime,
      ...(reaction.action === "remove" ? { removed: true } : {}),
    };
  }
  // Drives the channel list's "Reacted <emoji>" preview line. A remove clears the
  // event rather than advertising an undone reaction (same idea as 1:1's
  // lastReactionEvent handling).
  if (reaction.action === "remove") {
    if (entry.lastEvent && entry.lastEvent.senderAddress === reactorAddress && entry.lastEvent.emoji === reaction.emoji) {
      entry.lastEvent = null;
    }
  } else if (!entry.lastEvent || blockTime >= Number(entry.lastEvent.blockTime || 0)) {
    entry.lastEvent = { senderAddress: reactorAddress, emoji: reaction.emoji, blockTime };
  }
  return true;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function mergeMessages(channel, rows) {
  const existing = messageCache[channel] || [];
  const seen = new Set(existing.map((m) => m.txId));
  let added = 0;
  let reactionsChanged = false;
  const freshIncoming = [];
  for (const row of rows) {
    if (!row?.txId || seen.has(row.txId)) continue;
    seen.add(row.txId);
    const blockTime = Number(row.blockTime) || Date.now();
    // Reactions ride the same wire as normal messages but never become message
    // rows — they only update the per-channel reactions store (same as 1:1).
    const reaction = deps.parseReactionEnvelope?.(row.content);
    if (reaction) {
      if (recordReaction(channel, row.txId, reaction, row.senderAddress || "", blockTime)) reactionsChanged = true;
      continue;
    }
    existing.push({
      txId: row.txId,
      senderAddress: row.senderAddress || "",
      content: row.content ?? "",
      blockTime,
    });
    added += 1;
    if ((row.senderAddress || "") !== deps.engine.address) {
      freshIncoming.push({ channel, senderAddress: row.senderAddress || "", content: row.content ?? "", txId: row.txId, blockTime });
    }
  }
  existing.sort((a, b) => a.blockTime - b.blockTime);
  messageCache[channel] = existing;
  if (added > 0) saveCache();
  if (reactionsChanged) saveReactions();
  // The global notification center gates these by arrival time (only live messages ping, not the
  // backfilled history), so it's safe to hand it every fresh incoming row.
  if (freshIncoming.length) deps.onIncomingBroadcast?.(freshIncoming);
  return added + (reactionsChanged ? 1 : 0);
}

async function backfillChannel(channel, { quiet = true } = {}) {
  try {
    const result = await fetchBroadcastHistory({ channel });
    const added = mergeMessages(channel, result.messages);
    if (added > 0) {
      if (activeChannel === channel) renderRoom();
      renderChannelList();
    }
    return added;
  } catch (error) {
    if (!quiet) deps.showToast?.(error.message);
    deps.appendEngineLog?.(`Broadcast backfill failed for #${channel}: ${error.message}`);
    return -1;
  }
}

function startPolling(channel) {
  stopPolling();
  pollTimer = window.setInterval(() => backfillChannel(channel), POLL_MS);
}

function stopPolling() {
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
}

// ---------------------------------------------------------------------------
// Sending (single serialized queue so concurrent tx builds can't race UTXOs)
// ---------------------------------------------------------------------------

let sendQueue = Promise.resolve();
function enqueueBroadcastSend(task) {
  const run = sendQueue.then(task, task);
  sendQueue = run.then(() => {}, () => {});
  return run;
}

/** Shared send pipeline used by the composer, voice-note share links, and reactions
 *  (reactions pass showBubble:false — they never get a message row). */
async function sendBroadcastText(channel, text, { showBubble = true } = {}) {
  const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (showBubble) {
    (messageCache[channel] ||= []).push({
      txId: pendingId,
      senderAddress: deps.engine.address || "",
      content: text,
      blockTime: Date.now(),
      status: "pending",
    });
    if (activeChannel === channel) renderRoom();
  }
  try {
    const txid = await enqueueBroadcastSend(() => sendBroadcastMessage({ engine: deps.engine, channel, content: text }));
    if (showBubble) {
      messageCache[channel] = (messageCache[channel] || []).map((m) =>
        m.txId === pendingId ? { ...m, txId: txid, status: undefined } : m);
      saveCache();
    }
    return txid;
  } catch (error) {
    if (showBubble) {
      messageCache[channel] = (messageCache[channel] || []).map((m) =>
        m.txId === pendingId ? { ...m, status: "failed" } : m);
    }
    throw error;
  } finally {
    if (showBubble && activeChannel === channel) renderRoom();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function senderName(address) {
  if (!address) return "unknown";
  if (address === deps.engine.address) return "You";
  const info = deps.engine.peekKnsAddressInfo?.(address);
  const domain = info?.explicitPrimaryDomain || info?.primaryDomain || "";
  if (domain) return domain.toLowerCase().endsWith(".kas") ? domain.slice(0, -4) : domain;
  return deps.shortAddress(address);
}

/** Last-activity preview for the channel list. Reaction payloads are humanized as
 *  "Reacted <emoji>" instead of showing raw JSON. */
function channelPreviewText(channel) {
  const last = (messageCache[channel] || []).at(-1) || null;
  const lastReaction = reactionsCache[channel]?.lastEvent || null;
  if (!last && !lastReaction) return "";
  if (Number(lastReaction?.blockTime || 0) > Number(last?.blockTime || 0)) {
    return `Reacted ${lastReaction.emoji}`;
  }
  if (!last) return "";
  const reaction = deps.parseReactionEnvelope?.(last.content); // defensive: shouldn't survive migration
  if (reaction) return `Reacted ${reaction.emoji}`;
  return String(last.content || "").replace(/\s+/g, " ").slice(0, 64);
}

function renderChannelList() {
  if (!listEl) return;
  const rows = [...joinedChannels].sort((a, b) => {
    const fa = isFeaturedBroadcastChannel(a) ? 0 : 1;
    const fb = isFeaturedBroadcastChannel(b) ? 0 : 1;
    return fa - fb || a.localeCompare(b);
  });
  listEl.innerHTML = rows.map((name) => {
    const featured = isFeaturedBroadcastChannel(name);
    const preview = channelPreviewText(name);
    const subtitle = preview || (featured ? "Featured — public, 3-day history" : "Custom room");
    return `
      <button class="chat-row broadcast-row" type="button" data-broadcast-open="${deps.escapeHtml(name)}">
        <span class="chat-meta">
          <strong>#${deps.escapeHtml(name)}</strong>
          <span>${deps.escapeHtml(subtitle)}</span>
        </span>
        ${featured
          ? `<span class="architecture-badge">Featured</span>`
          : `<span class="kaposts-view-link" data-broadcast-leave="${deps.escapeHtml(name)}">Leave</span>`}
      </button>`;
  }).join("");
}

/** One broadcast bubble: header, linkified body (+ the same preview card treatment as 1:1
 *  bubbles — Nextcloud shares get the progressive video→audio→img→attachment probe), hover
 *  reaction bar, and aggregated reaction chips. */
function buildMessageElement(m) {
  const mine = m.senderAddress === deps.engine.address;
  const el = document.createElement("div");
  el.className = `broadcast-message${mine ? " mine" : ""}`;

  const head = document.createElement("div");
  head.className = "broadcast-message-head";
  const sender = document.createElement("strong");
  sender.dataset.broadcastSender = m.senderAddress;
  sender.textContent = senderName(m.senderAddress);
  const time = document.createElement("span");
  time.textContent = new Date(m.blockTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  head.append(sender, time);
  if (m.status === "pending") {
    const badge = document.createElement("span");
    badge.className = "broadcast-pending";
    badge.textContent = "sending…";
    head.append(badge);
  }
  if (m.status === "failed") {
    const badge = document.createElement("span");
    badge.className = "broadcast-failed";
    badge.textContent = "failed";
    head.append(badge);
  }
  el.append(head);

  const body = document.createElement("div");
  body.className = "broadcast-message-body";
  const urls = deps.renderTextWithLinks?.(body, m.content) ?? [];
  if (!deps.renderTextWithLinks) body.textContent = m.content;
  el.append(body);
  const previewable = urls.find((url) => deps.isPreviewableUrl?.(url));
  if (previewable) {
    const card = deps.buildLinkPreviewCard?.(previewable);
    if (card) el.append(card);
  }

  appendReactionUi(el, m);
  return el;
}

function appendReactionUi(el, m) {
  if (m.status) return; // pending/failed rows have no on-chain txid to react to
  const myAddress = deps.engine.address || "";
  const perReactor = reactionsFor(activeChannel)[m.txId] || {};
  const myEntry = perReactor[myAddress];
  const myCurrentEmoji = myEntry && !myEntry.removed ? myEntry.emoji : null;

  // Hover quick-reaction bar — same fixed emoji set as 1:1/iOS/Android.
  const bar = document.createElement("div");
  bar.className = "message-reaction-bar";
  const barPill = document.createElement("div");
  barPill.className = "message-reaction-bar-pill";
  for (const emoji of deps.quickReactionEmojis || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emoji;
    button.dataset.broadcastReact = m.txId;
    button.dataset.emoji = emoji;
    if (emoji === myCurrentEmoji) button.classList.add("active");
    barPill.append(button);
  }
  bar.append(barPill);
  el.append(bar);

  // Aggregated chips under the bubble; clicking your own active emoji removes it.
  const entries = Object.values(perReactor).filter((entry) => !entry.removed);
  if (entries.length) {
    const chips = document.createElement("div");
    chips.className = "message-reaction-pill";
    const counts = new Map();
    for (const entry of entries) counts.set(entry.emoji, (counts.get(entry.emoji) || 0) + 1);
    for (const [emoji, count] of counts) {
      const chip = document.createElement("span");
      chip.className = "message-reaction-pill-entry";
      chip.textContent = emoji;
      if (emoji === myCurrentEmoji) {
        chip.classList.add("active");
        chip.dataset.broadcastReact = m.txId;
        chip.dataset.emoji = emoji;
        chip.title = "Remove your reaction";
      }
      if (count > 1) {
        const countEl = document.createElement("span");
        countEl.className = "message-reaction-pill-count";
        countEl.textContent = String(count);
        chip.append(countEl);
      }
      chips.append(chip);
    }
    el.append(chips);
    el.classList.add("has-reactions");
  }
}

function renderRoom() {
  const inRoom = Boolean(activeChannel);
  if (roomEl) roomEl.hidden = !inRoom;
  const listWrap = document.querySelector("[data-broadcast-list-wrap]");
  if (listWrap) listWrap.hidden = inRoom;
  if (!inRoom) return;

  if (roomTitleEl) roomTitleEl.textContent = `#${activeChannel}`;
  if (roomBannerEl) roomBannerEl.hidden = !isFeaturedBroadcastChannel(activeChannel);
  updateVoiceButtonVisibility();

  const hidden = hiddenIn(activeChannel);
  const messages = (messageCache[activeChannel] || []).filter((m) =>
    !hidden.has(m.senderAddress) && !deps.parseReactionEnvelope?.(m.content));
  if (roomBodyEl) {
    roomBodyEl.replaceChildren();
    if (messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "no-results-card";
      empty.innerHTML = `<strong>No messages yet</strong><span>Be the first to post in #${deps.escapeHtml(activeChannel)}.</span>`;
      roomBodyEl.append(empty);
    } else {
      // "Today"/"Yesterday"/date pill whenever the calendar day changes (iOS parity;
      // same pill class + label formatter as 1:1 and group chats).
      let lastDayKey = "";
      for (const m of messages) {
        const ts = Number(m.blockTime) || Date.now();
        const dayKey = new Date(ts).toDateString();
        if (dayKey !== lastDayKey && deps.daySeparatorLabel) {
          lastDayKey = dayKey;
          const sep = document.createElement("div");
          sep.className = "message-day-separator";
          const pill = document.createElement("span");
          pill.textContent = deps.daySeparatorLabel(ts);
          sep.append(pill);
          roomBodyEl.append(sep);
        }
        roomBodyEl.append(buildMessageElement(m));
      }
    }
    roomBodyEl.scrollTop = roomBodyEl.scrollHeight;
  }
  refreshVisibleSenderNames(messages);
}

let knsInFlight = false;
async function refreshVisibleSenderNames(messages) {
  if (knsInFlight) return;
  knsInFlight = true;
  try {
    const addresses = [...new Set(messages.slice(-30).map((m) => m.senderAddress))]
      .filter((a) => a && a !== deps.engine.address);
    let changed = false;
    for (const address of addresses) {
      const before = deps.engine.peekKnsAddressInfo?.(address)?.explicitPrimaryDomain || null;
      await deps.engine.fetchKnsAddressInfo?.(address).catch(() => null);
      const after = deps.engine.peekKnsAddressInfo?.(address)?.explicitPrimaryDomain || null;
      if (before !== after) changed = true;
    }
    if (changed && activeChannel) renderRoom();
  } finally {
    knsInFlight = false;
  }
}

function updateConnectionDot() {
  if (!roomDotEl) return;
  const status = deps.engine.connectionState?.status || deps.engine.connectionState?.state || "";
  const healthy = String(status).toLowerCase().includes("connect") || deps.engine.rpc != null;
  roomDotEl.classList.toggle("ok", healthy);
}

// ---------------------------------------------------------------------------
// Voice notes (Nextcloud only — desktop has no on-chain broadcast audio)
// ---------------------------------------------------------------------------

function updateVoiceButtonVisibility() {
  if (voiceBtn) voiceBtn.hidden = !deps.isNextcloudMediaSendActive?.();
}

function ensureVoiceRecorder() {
  if (voiceRecorder || !deps.createVoiceRecorder) return voiceRecorder;
  voiceRecorder = deps.createVoiceRecorder({
    maxDurationSeconds: () => VOICE_MAX_DURATION_SECONDS,
    onElapsed: (elapsed) => {
      if (voiceTimeEl) voiceTimeEl.textContent = deps.formatRecordingTime?.(elapsed) ?? String(Math.floor(elapsed));
    },
    onFinish: handleVoiceRecordingFinished,
  });
  return voiceRecorder;
}

async function startVoiceRecording() {
  if (!activeChannel) return;
  if (!deps.isNextcloudMediaSendActive?.()) return; // button only shows when active anyway
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const recorder = ensureVoiceRecorder();
  if (!recorder || recorder.isRecording()) return;
  voiceRecordingChannel = activeChannel;
  const error = await recorder.start();
  if (error) {
    deps.showToast?.(error);
    voiceRecordingChannel = null;
    return;
  }
  if (voiceTimeEl) voiceTimeEl.textContent = "0:00";
  if (voicePanelEl) voicePanelEl.hidden = false;
}

async function handleVoiceRecordingFinished({ blob, mimeType, cancelled }) {
  if (voicePanelEl) voicePanelEl.hidden = true;
  const channel = voiceRecordingChannel;
  voiceRecordingChannel = null;
  if (cancelled || !blob || !channel) return;
  // Upload to Nextcloud and send the share link as a plain broadcast message — recipients
  // render it as an audio card via the same link-preview probe as 1:1. No on-chain
  // fallback: on failure nothing stays staged.
  try {
    const url = await deps.uploadNextcloudMedia(blob, `voice_${Date.now()}.webm`, mimeType);
    await sendBroadcastText(channel, url);
    renderChannelList();
  } catch (error) {
    deps.showToast?.(`Voice note failed: ${error.message}`);
    deps.appendEngineLog?.(`Broadcast voice note failed: ${error.message}`);
  }
}

function cancelVoiceRecordingIfActive() {
  if (voiceRecorder?.isRecording()) voiceRecorder.stop(true);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function openRoom(channel) {
  activeChannel = normalizeBroadcastChannel(channel);
  renderRoom();
  updateConnectionDot();
  backfillChannel(activeChannel, { quiet: true });
  startPolling(activeChannel);
}

function closeRoom() {
  cancelVoiceRecordingIfActive();
  activeChannel = null;
  stopPolling();
  renderRoom();
  renderChannelList();
}

function joinChannel(rawName) {
  const name = normalizeBroadcastChannel(rawName);
  if (!isValidBroadcastChannel(name)) {
    deps.showToast?.("Channel names are up to 36 characters, no spaces or colons.");
    return;
  }
  if (!joinedChannels.includes(name)) {
    joinedChannels.push(name);
    saveChannels();
  }
  renderChannelList();
  openRoom(name);
}

function leaveChannel(name) {
  if (isFeaturedBroadcastChannel(name)) return; // featured rooms can't be left
  joinedChannels = joinedChannels.filter((c) => c !== name);
  saveChannels();
  delete messageCache[name];
  saveCache();
  delete reactionsCache[name];
  saveReactions();
  if (activeChannel === name) closeRoom();
  renderChannelList();
}

async function sendCurrentMessage() {
  if (sendInFlight || !activeChannel || !composerInput) return;
  // Broadcast messages cost KAS too — same funding popup as chats when the
  // chatting balance is a confirmed zero.
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const text = composerInput.value.trim();
  if (!text) return;
  sendInFlight = true;
  composerInput.value = "";
  const channel = activeChannel;
  try {
    await sendBroadcastText(channel, text);
    renderChannelList();
  } catch (error) {
    deps.showToast?.(error.message);
    deps.appendEngineLog?.(`Broadcast send failed: ${error.message}`);
  } finally {
    sendInFlight = false;
  }
}

/** Toggle-sends a reaction. EXACT cross-platform wire format (iOS/Android/desktop 1:1):
 *  {"type":"reaction","targetTxId":"<txid>","emoji":"<emoji>","action":"add"|"remove"} —
 *  a normal broadcast message whose content is that JSON. Applied optimistically; the
 *  send failure is non-fatal (local state stays), matching the 1:1 behavior. */
async function sendBroadcastReaction(targetTxId, emoji) {
  if (!activeChannel || !targetTxId || !emoji) return;
  const myAddress = deps.engine.address || "";
  if (!myAddress) return;
  if (deps.isChattingBalanceZero?.()) {
    deps.showFundingGate?.();
    return;
  }
  const channel = activeChannel;
  const existing = reactionsFor(channel)[targetTxId]?.[myAddress];
  const action = existing && !existing.removed && existing.emoji === emoji ? "remove" : "add";

  recordReaction(channel, null, { targetTxId, emoji, action }, myAddress, Date.now());
  saveReactions();
  renderRoom();
  renderChannelList();

  const payload = JSON.stringify({ type: "reaction", targetTxId, emoji, action });
  try {
    const txid = await enqueueBroadcastSend(() => sendBroadcastMessage({ engine: deps.engine, channel, content: payload }));
    // Remember our own reaction tx so the next poll doesn't re-process it.
    const entry = reactionsCache[channel];
    if (entry && txid) {
      (entry.txIds ||= []).push(txid);
      saveReactions();
    }
  } catch (error) {
    deps.showToast?.(error.message);
    deps.appendEngineLog?.(`Broadcast reaction send failed (non-fatal, local state already applied): ${error.message}`);
  }
}

function hideSender(address) {
  if (!activeChannel || !address || address === deps.engine.address) return;
  const set = new Set(hiddenByRoom[activeChannel] || []);
  set.add(address);
  hiddenByRoom[activeChannel] = [...set];
  saveHidden();
  renderRoom();
  deps.showToast?.("User hidden in this room");
}

function renderHiddenUsersPanel() {
  const panel = document.querySelector("[data-broadcast-hidden-panel]");
  if (!panel || !activeChannel) return;
  const addresses = hiddenByRoom[activeChannel] || [];
  panel.hidden = false;
  panel.innerHTML = `
    <div class="kaposts-thread-header"><strong>Hidden in #${deps.escapeHtml(activeChannel)}</strong>
      <button class="kaposts-view-link" type="button" data-broadcast-hidden-close>Done</button></div>
    ${addresses.length === 0
      ? `<div class="no-results-card"><strong>No hidden users</strong><span>Click a sender's name in the room to hide them here.</span></div>`
      : addresses.map((address) => `
          <div class="kaposts-notification-row">
            <div class="kaposts-notification-main"><span><strong>${deps.escapeHtml(senderName(address))}</strong></span></div>
            <button class="kaposts-view-link" type="button" data-broadcast-unhide="${deps.escapeHtml(address)}">Unhide</button>
          </div>`).join("")}`;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function refreshBroadcasts() {
  loadState();
  renderChannelList();
  if (activeChannel) renderRoom();
}

export function resetBroadcastsForAccount() {
  cancelVoiceRecordingIfActive();
  stopPolling();
  activeChannel = null;
  loadState();
  renderChannelList();
  renderRoom();
}

export function stopBroadcastPolling() {
  stopPolling();
}

export function initBroadcasts(dependencies) {
  deps = dependencies;
  listEl = document.querySelector("[data-broadcast-list]");
  roomEl = document.querySelector("[data-broadcast-room]");
  roomTitleEl = document.querySelector("[data-broadcast-room-title]");
  roomDotEl = document.querySelector("[data-broadcast-room-dot]");
  roomBodyEl = document.querySelector("[data-broadcast-room-body]");
  roomBannerEl = document.querySelector("[data-broadcast-room-banner]");
  composerInput = document.querySelector("[data-broadcast-input]");
  sendBtn = document.querySelector("[data-broadcast-send]");
  joinInput = document.querySelector("[data-broadcast-join-input]");
  voicePanelEl = document.querySelector("[data-broadcast-voice-panel]");
  voiceTimeEl = document.querySelector("[data-broadcast-voice-time]");
  voiceBtn = document.querySelector("[data-broadcast-voice]");

  loadState();
  renderChannelList();
  updateVoiceButtonVisibility();

  deps.engine.onConnectionState?.(() => updateConnectionDot());

  document.querySelector("[data-broadcast-join]")?.addEventListener("click", () => {
    joinChannel(joinInput?.value || "");
    if (joinInput) joinInput.value = "";
  });
  joinInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      joinChannel(joinInput.value);
      joinInput.value = "";
    }
  });

  document.querySelector("[data-broadcast-back]")?.addEventListener("click", closeRoom);
  sendBtn?.addEventListener("click", sendCurrentMessage);
  composerInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendCurrentMessage();
    }
  });
  document.querySelector("[data-broadcast-hidden-users]")?.addEventListener("click", renderHiddenUsersPanel);

  voiceBtn?.addEventListener("click", startVoiceRecording);
  document.querySelector("[data-broadcast-voice-stop]")?.addEventListener("click", () => voiceRecorder?.stop(false));
  document.querySelector("[data-broadcast-voice-cancel]")?.addEventListener("click", () => voiceRecorder?.stop(true));

  const screen = document.querySelector('[data-app-tab-screen="broadcasts"]');
  screen?.addEventListener("click", (event) => {
    const react = event.target.closest("[data-broadcast-react]");
    if (react) {
      event.stopPropagation();
      sendBroadcastReaction(react.dataset.broadcastReact, react.dataset.emoji);
      return;
    }

    const leave = event.target.closest("[data-broadcast-leave]");
    if (leave) {
      event.stopPropagation();
      if (window.confirm(`Leave #${leave.dataset.broadcastLeave}? Cached messages for it are deleted.`)) {
        leaveChannel(leave.dataset.broadcastLeave);
      }
      return;
    }
    const open = event.target.closest("[data-broadcast-open]");
    if (open) { openRoom(open.dataset.broadcastOpen); return; }

    const sender = event.target.closest("[data-broadcast-sender]");
    if (sender) {
      const address = sender.dataset.broadcastSender;
      if (address && address !== deps.engine.address &&
          window.confirm(`Hide ${senderName(address)} in #${activeChannel}? Their messages disappear from this room only.`)) {
        hideSender(address);
      }
      return;
    }

    const unhide = event.target.closest("[data-broadcast-unhide]");
    if (unhide) {
      hiddenByRoom[activeChannel] = (hiddenByRoom[activeChannel] || []).filter((a) => a !== unhide.dataset.broadcastUnhide);
      saveHidden();
      renderHiddenUsersPanel();
      renderRoom();
      return;
    }

    const hiddenClose = event.target.closest("[data-broadcast-hidden-close]");
    if (hiddenClose) {
      const panel = document.querySelector("[data-broadcast-hidden-panel]");
      if (panel) panel.hidden = true;
    }
  });
}
