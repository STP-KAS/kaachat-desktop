// Broadcasts tab UI — desktop port of the iOS/Android 4.0 broadcast rooms. Channel list
// (featured rooms pinned + joinable customs), room view with indexer backfill (once on open +
// 8s polling while open), per-room hidden users, the permanent public/3-day banner on the
// featured rooms, and a live connection dot in the room header.

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
const POLL_MS = 8000;

let deps = null;

let listEl, roomEl, roomTitleEl, roomDotEl, roomBodyEl, roomBannerEl, composerInput, sendBtn, joinInput;
let joinedChannels = [];
let hiddenByRoom = {};
let messageCache = {}; // { [channel]: [{ txId, senderAddress, content, blockTime, status? }] }
let activeChannel = null;
let pollTimer = null;
let sendInFlight = false;

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
  // The curated rooms are always present for every account (matches iOS/Android).
  for (const name of FEATURED_BROADCAST_CHANNELS) {
    if (!joinedChannels.includes(name)) joinedChannels.push(name);
  }
  pruneCache();
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

/** Fixed 3-day rolling retention, matching the featured rooms' product rule. */
function pruneCache() {
  const cutoff = Date.now() - BROADCAST_RETENTION_MS;
  for (const channel of Object.keys(messageCache)) {
    messageCache[channel] = (messageCache[channel] || []).filter((m) => (m.blockTime || 0) >= cutoff);
    if (messageCache[channel].length === 0) delete messageCache[channel];
  }
}

function hiddenIn(channel) {
  return new Set(hiddenByRoom[channel] || []);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function mergeMessages(channel, rows) {
  const existing = messageCache[channel] || [];
  const seen = new Set(existing.map((m) => m.txId));
  let added = 0;
  for (const row of rows) {
    if (!row?.txId || seen.has(row.txId)) continue;
    existing.push({
      txId: row.txId,
      senderAddress: row.senderAddress || "",
      content: row.content ?? "",
      blockTime: Number(row.blockTime) || Date.now(),
    });
    seen.add(row.txId);
    added += 1;
  }
  existing.sort((a, b) => a.blockTime - b.blockTime);
  messageCache[channel] = existing;
  if (added > 0) saveCache();
  return added;
}

async function backfillChannel(channel, { quiet = true } = {}) {
  try {
    const result = await fetchBroadcastHistory({ channel });
    const added = mergeMessages(channel, result.messages);
    if (added > 0 && activeChannel === channel) renderRoom();
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

function renderChannelList() {
  if (!listEl) return;
  const rows = [...joinedChannels].sort((a, b) => {
    const fa = isFeaturedBroadcastChannel(a) ? 0 : 1;
    const fb = isFeaturedBroadcastChannel(b) ? 0 : 1;
    return fa - fb || a.localeCompare(b);
  });
  listEl.innerHTML = rows.map((name) => {
    const featured = isFeaturedBroadcastChannel(name);
    return `
      <button class="chat-row broadcast-row" type="button" data-broadcast-open="${deps.escapeHtml(name)}">
        <span class="chat-meta">
          <strong>#${deps.escapeHtml(name)}</strong>
          <span>${featured ? "Featured — public, 3-day history" : "Custom room"}</span>
        </span>
        ${featured
          ? `<span class="architecture-badge">Featured</span>`
          : `<span class="kaposts-view-link" data-broadcast-leave="${deps.escapeHtml(name)}">Leave</span>`}
      </button>`;
  }).join("");
}

function renderRoom() {
  const inRoom = Boolean(activeChannel);
  if (roomEl) roomEl.hidden = !inRoom;
  const listWrap = document.querySelector("[data-broadcast-list-wrap]");
  if (listWrap) listWrap.hidden = inRoom;
  if (!inRoom) return;

  if (roomTitleEl) roomTitleEl.textContent = `#${activeChannel}`;
  if (roomBannerEl) roomBannerEl.hidden = !isFeaturedBroadcastChannel(activeChannel);

  const hidden = hiddenIn(activeChannel);
  const messages = (messageCache[activeChannel] || []).filter((m) => !hidden.has(m.senderAddress));
  if (roomBodyEl) {
    roomBodyEl.innerHTML = messages.length === 0
      ? `<div class="no-results-card"><strong>No messages yet</strong><span>Be the first to post in #${deps.escapeHtml(activeChannel)}.</span></div>`
      : messages.map((m) => {
          const mine = m.senderAddress === deps.engine.address;
          const time = new Date(m.blockTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          return `
            <div class="broadcast-message${mine ? " mine" : ""}">
              <div class="broadcast-message-head">
                <strong data-broadcast-sender="${deps.escapeHtml(m.senderAddress)}">${deps.escapeHtml(senderName(m.senderAddress))}</strong>
                <span>${deps.escapeHtml(time)}</span>
                ${m.status === "pending" ? `<span class="broadcast-pending">sending…</span>` : ""}
                ${m.status === "failed" ? `<span class="broadcast-failed">failed</span>` : ""}
              </div>
              <div class="broadcast-message-body">${deps.escapeHtml(m.content)}</div>
            </div>`;
        }).join("");
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
  if (activeChannel === name) closeRoom();
  renderChannelList();
}

async function sendCurrentMessage() {
  if (sendInFlight || !activeChannel || !composerInput) return;
  const text = composerInput.value.trim();
  if (!text) return;
  sendInFlight = true;
  composerInput.value = "";
  const channel = activeChannel;
  const pendingId = `pending-${Date.now()}`;
  (messageCache[channel] ||= []).push({
    txId: pendingId,
    senderAddress: deps.engine.address || "",
    content: text,
    blockTime: Date.now(),
    status: "pending",
  });
  renderRoom();
  try {
    const txid = await sendBroadcastMessage({ engine: deps.engine, channel, content: text });
    messageCache[channel] = messageCache[channel].map((m) =>
      m.txId === pendingId ? { ...m, txId: txid, status: undefined } : m);
    saveCache();
  } catch (error) {
    messageCache[channel] = messageCache[channel].map((m) =>
      m.txId === pendingId ? { ...m, status: "failed" } : m);
    deps.showToast?.(error.message);
    deps.appendEngineLog?.(`Broadcast send failed: ${error.message}`);
  } finally {
    sendInFlight = false;
    renderRoom();
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

  loadState();
  renderChannelList();

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

  const screen = document.querySelector('[data-app-tab-screen="broadcasts"]');
  screen?.addEventListener("click", (event) => {
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
