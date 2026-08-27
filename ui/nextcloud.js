// Nextcloud integration — desktop port of the iOS stack:
// connect a server with an app password, browse it over WebDAV, send photos/videos in chats as
// public /s/TOKEN share links (rendered by the link-preview feature), and keep the account's
// chat data in sync with the server.
//
// Sync is TWO-WAY, not an upload schedule. Uploading: local changes arm a debounced merge
// upload (fast while a chat is open, relaxed otherwise), floored so a busy chat coalesces,
// with an hourly heartbeat and a flush when the tab is hidden. Downloading: a change watcher
// polls the shared file's ETag with a Depth-0 PROPFIND and merge-imports anything another
// device wrote, so a message sent on a phone lands here in seconds instead of waiting for
// someone to press Restore. Both halves stop while the page is hidden. See the "Automatic
// sync" section for the cadence tiers and the own-write ETag guard that keeps a device from
// importing its own upload back.
//
// The backup is cross-platform: one `kachat-backup.json` per folder in the shared
// ChatHistoryArchive schema, written and read by iPhone, Android and desktop alike. Every
// upload first downloads the file already there and uploads the UNION, so restoring on one
// device never costs another device its history. Since envelope v1 the file is encrypted at
// rest (AES-256-GCM keyed off the identity private key — see ui/backup-crypto.js); every
// device on the same seed derives the same key, and legacy plaintext files stay restorable.
//
// Browser reality: unlike the native apps, fetches here would be subject to CORS — solved by
// routing all API traffic through vite.config.mjs's same-origin /nc-proxy passthrough (see
// apiBase()). The connect screen still detects total-failure shapes and
// tells the user to allow this origin on their server/reverse proxy. Credentials live in
// account-scoped localStorage — same trust model as the rest of this desktop build (the wallet
// itself persists there too).

// Account-scoped (per wallet), which is also what makes `lastBackupEtag` and `autoRestoreDone`
// per-wallet the way iOS scopes them by wallet hash suffix:
// { server, username, appPassword, startFolder, backupFolder, autoBackup, lastAutoBackup,
//   lastBackupEtag, autoRestoreDone }
const NC_KEY = "kachat-nextcloud-v1";
// ONE shared backup file across iPhone, Android and desktop: same name, same
// ChatHistoryArchive schema, so any device can restore any other device's
// backup. Uploads MERGE with whatever is already on the server (see runBackup),
// so no device can ever delete another's history.
const BACKUP_FILENAME = "kachat-backup.json";
// Pre-4.0 desktop-only file. Read on restore so an old backup can still be
// recovered; never written again (so it also never gets encrypted — existing
// copies stay plaintext-readable forever, though the restore path would open
// an enveloped copy too).
const LEGACY_DESKTOP_BACKUP_FILENAME = "kachat-backup-desktop.json";
const DEFAULT_BACKUP_FOLDER = "KaChat";
// Heartbeat: upload even when nothing looks changed, so a device that missed an activity
// signal still refreshes the shared file once an hour.
const AUTO_BACKUP_MIN_MS = 3600_000;
const AUTO_CATCHUP_MS = 86_400_000;

// --- Near-live sync cadence (mirrors iOS NextcloudService's tier constants) -------------
// Two tiers everywhere: fast while a chat is open on screen (the latency-sensitive case),
// relaxed elsewhere in the app. Everything stops while the page is hidden.
//
// Change watcher: how often the shared file's ETag is polled with a Depth-0 PROPFIND (a tiny
// request, no body download). iOS: inChatChangeWatchInterval 5s / idleChangeWatchInterval 30s.
const CHANGE_WATCH_IN_CHAT_MS = 5_000;
const CHANGE_WATCH_IDLE_MS = 30_000;
// Failed polls back off from the CURRENT tier's base (x3 per consecutive failure, capped) and
// snap back to the tier cadence on the next success. iOS: changeWatchBackoffMax 60s.
const CHANGE_WATCH_BACKOFF_MAX_MS = 60_000;
const CHANGE_WATCH_BACKOFF_FACTOR_MAX = 12;
// Quiet time after the last local change before the merge upload runs.
// iOS: inChatSyncDebounceInterval 5s / idleSyncDebounceInterval 15s.
const SYNC_DEBOUNCE_IN_CHAT_MS = 5_000;
const SYNC_DEBOUNCE_IDLE_MS = 15_000;
// Floor between AUTOMATIC merge uploads (the manual backup button is unaffected). The debounce
// decides WHEN a burst has settled; this decides how often settled bursts may actually upload.
// A debounce firing earlier re-arms itself to the earliest allowed time instead of dropping the
// sync (the dirty flag stays set), so nothing is lost. iOS: autoSyncMinInterval 90s.
const AUTO_SYNC_MIN_MS = 90_000;
// Coalescing window for the DOM change detector below — a render burst counts once.
const ACTIVITY_COALESCE_MS = 400;

let deps = null;
let nc = null;              // null = not connected; else the stored account object
let settingsEl = null;
let modalsEl = null;
let thumbCache = new Map(); // path -> object URL
let autoBackupTimer = null;

// --- Near-live sync state ---------------------------------------------------------------
let syncInFlight = false;       // a merge upload / silent import owns the local store
let syncDirty = false;          // local changes are owed an upload
let syncDebounceTimer = null;
let lastAutoSyncAt = 0;
let watcherEpoch = 0;           // bumped to retire a running watcher loop
let watcherRunning = false;
let lastSeenConversationId = null;
let autoRestoreTimer = null;
let activityObserver = null;
let activityCoalesceTimer = null;
let lastActivityFingerprint = null;

// Picker state
let pickerOpen = false;
let pickerMode = "media";   // "media" (send flow) | "folder-start" | "folder-backup"
let pickerPath = "";
let pickerStack = [];
let pickerFiles = [];
let pickerLoading = false;
let pickerError = null;
let pickerSharingPath = null;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function loadState() {
  try { nc = JSON.parse(localStorage.getItem(deps.accountScopedKey(NC_KEY)) || "null"); }
  catch { nc = null; }
  if (nc && (!nc.server || !nc.username || !nc.appPassword)) nc = null;
}

function saveState() {
  if (nc) localStorage.setItem(deps.accountScopedKey(NC_KEY), JSON.stringify(nc));
  else localStorage.removeItem(deps.accountScopedKey(NC_KEY));
}

function normalizedServer(input) {
  let raw = String(input || "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  raw = raw.replace(/\/+$/, "").replace(/\/index\.php$/i, "");
  try { const url = new URL(raw); return url.host ? raw : null; } catch { return null; }
}

function authHeader(account = nc) {
  return "Basic " + btoa(`${account.username}:${account.appPassword}`);
}

/** All API traffic goes through the dev server's same-origin /nc-proxy passthrough (see
 *  vite.config.mjs) — the browser never makes a cross-origin request, so stock Nextcloud's
 *  missing CORS headers on WebDAV/OCS no longer matter. Public /s/TOKEN share links are NOT
 *  proxied; recipients open those on the real server. */
function apiBase(server = nc?.server) {
  return `${import.meta.env.BASE_URL}nc-proxy/${encodeURIComponent(String(server || "").replace(/\/+$/, ""))}`;
}

function corsHint(error) {
  // With the same-origin proxy a TypeError means the dev server itself (or the network) is
  // unreachable, not CORS.
  if (error instanceof TypeError) {
    return "Could not reach the server. Check the server address and your connection, and make sure the app is running via its own dev server (npm run dev), which provides the built-in proxy.";
  }
  return error.message;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function verifyCredentials(server, username, appPassword) {
  const response = await fetch(`${apiBase(server)}/ocs/v2.php/cloud/user?format=json`, {
    headers: {
      Authorization: "Basic " + btoa(`${username}:${appPassword}`),
      "OCS-APIRequest": "true",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (response.status === 401) throw new Error("Nextcloud rejected the username or app password.");
  if (!response.ok) throw new Error(`Nextcloud returned HTTP ${response.status}.`);
  const decoded = await response.json();
  if (!decoded?.ocs?.data) throw new Error("Unexpected response from the Nextcloud server.");
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "bmp", "tiff"]);
const VIDEO_EXTENSIONS = new Set(["mov", "mp4", "m4v", "webm", "mkv", "avi"]);

function fileExtension(path) {
  const name = path.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function classifyEntry(entry) {
  if (entry.isDirectory) return entry;
  const type = entry.contentType || "";
  entry.isImage = type.startsWith("image/") || IMAGE_EXTENSIONS.has(fileExtension(entry.path));
  entry.isVideo = type.startsWith("video/") || VIDEO_EXTENSIONS.has(fileExtension(entry.path));
  return entry;
}

/** Depth-1 PROPFIND folder listing. The multistatus includes the listed folder ITSELF —
 *  excluded here at any depth (the "folder inside itself forever" bug class). */
async function listFolder(relativePath = "") {
  const davBasePath = `/remote.php/dav/files/${nc.username}`;
  const listedPath = relativePath.split("/").filter(Boolean).join("/");
  const url = `${apiBase()}${davBasePath}${listedPath ? "/" + listedPath.split("/").map(encodeURIComponent).join("/") : ""}`;
  const response = await fetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader(),
      Depth: "1",
      "Content-Type": "application/xml",
    },
    body: `<?xml version="1.0"?>
      <d:propfind xmlns:d="DAV:">
        <d:prop><d:displayname/><d:resourcetype/><d:getcontenttype/><d:getcontentlength/><d:getlastmodified/></d:prop>
      </d:propfind>`,
    cache: "no-store",
  });
  if (response.status === 401) throw new Error("Nextcloud rejected the stored app password — reconnect in Settings.");
  if (response.status !== 207) throw new Error(`Nextcloud returned HTTP ${response.status}.`);

  const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
  const results = [];
  for (const responseNode of xml.getElementsByTagNameNS("DAV:", "response")) {
    const hrefNode = responseNode.getElementsByTagNameNS("DAV:", "href")[0];
    const decoded = decodeURIComponent(hrefNode?.textContent?.trim() || "");
    const baseIndex = decoded.indexOf(davBasePath);
    if (baseIndex === -1) continue;
    const relative = decoded.slice(baseIndex + davBasePath.length).replace(/^\/+|\/+$/g, "");
    if (!relative || relative === listedPath) continue; // the listed folder itself

    const isDirectory = responseNode.getElementsByTagNameNS("DAV:", "collection").length > 0;
    const contentType = responseNode.getElementsByTagNameNS("DAV:", "getcontenttype")[0]?.textContent || null;
    const size = Number(responseNode.getElementsByTagNameNS("DAV:", "getcontentlength")[0]?.textContent || 0) || null;
    const modifiedRaw = responseNode.getElementsByTagNameNS("DAV:", "getlastmodified")[0]?.textContent || null;
    const name = responseNode.getElementsByTagNameNS("DAV:", "displayname")[0]?.textContent
      || relative.split("/").pop();
    results.push(classifyEntry({
      path: relative,
      name,
      isDirectory,
      contentType,
      size,
      modified: modifiedRaw ? new Date(modifiedRaw) : null,
      isImage: false,
      isVideo: false,
    }));
  }
  return results;
}

/** Creates (or reuses) a public link share — shareType 3 — and returns its /s/TOKEN URL. */
async function createPublicShareLink(relativePath) {
  const endpoint = `${apiBase()}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`;
  const body = `path=${encodeURIComponent("/" + relativePath)}&shareType=3`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "OCS-APIRequest": "true",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
  });
  if (response.status === 401) throw new Error("Nextcloud rejected the stored app password — reconnect in Settings.");
  if (response.ok) {
    const decoded = await response.json().catch(() => null);
    const url = decoded?.ocs?.data?.url;
    if (url) return url;
  }
  // Creating can fail when a link share already exists — reuse it.
  const lookup = await fetch(`${endpoint}&path=${encodeURIComponent("/" + relativePath)}`, {
    headers: { Authorization: authHeader(), "OCS-APIRequest": "true" },
    cache: "no-store",
  });
  if (lookup.ok) {
    const decoded = await lookup.json().catch(() => null);
    const share = (decoded?.ocs?.data || []).find((s) => s.share_type === 3 && s.url);
    if (share) return share.url;
  }
  throw new Error("Could not create a share link for that file.");
}

/** Server-side square thumbnail; returns an object URL (cached per session), or null. */
async function thumbnailURL(path) {
  if (thumbCache.has(path)) return thumbCache.get(path);
  try {
    const url = `${apiBase()}/index.php/core/preview.png?file=${encodeURIComponent("/" + path)}&x=256&y=256&a=1`;
    const response = await fetch(url, { headers: { Authorization: authHeader() }, cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    if (!blob.size) throw new Error("empty");
    const objectURL = URL.createObjectURL(blob);
    thumbCache.set(path, objectURL);
    return objectURL;
  } catch {
    thumbCache.set(path, null);
    return null;
  }
}

function backupFolderPath() {
  return nc?.backupFolder || DEFAULT_BACKUP_FOLDER;
}

// --- Media send (photos/voice upload + share link instead of on-chain bytes) ---

export function isNextcloudMediaSendActive() {
  return Boolean(nc && nc.mediaSend);
}

async function ensureFolder(davRoot, parts) {
  let url = davRoot;
  for (const part of parts) {
    url = `${url}/${encodeURIComponent(part)}`;
    const mkcol = await fetch(url, { method: "MKCOL", headers: { Authorization: authHeader() } });
    if (mkcol.status === 401) throw new Error("Nextcloud rejected the stored app password — reconnect in Settings.");
    if (!mkcol.ok && mkcol.status !== 405) throw new Error(`Could not create the media folder (HTTP ${mkcol.status}).`);
  }
  return url;
}

/** Uploads media bytes to KaChat/Media/ and returns the public /s/TOKEN share link. */
export async function uploadNextcloudMedia(blob, filename, contentType) {
  if (!nc) throw new Error("Nextcloud is not connected.");
  const safeName = String(filename || "file").replace(/[^\w.\-]+/g, "_");
  const unique = `${Math.random().toString(36).slice(2, 10)}_${safeName}`;
  const davRoot = `${apiBase()}/remote.php/dav/files/${nc.username}`;
  const folderURL = await ensureFolder(davRoot, ["KaChat", "Media"]);
  const put = await fetch(`${folderURL}/${encodeURIComponent(unique)}`, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": contentType || "application/octet-stream" },
    body: blob,
  });
  if (!put.ok) throw new Error(`Media upload failed (HTTP ${put.status}).`);
  return createPublicShareLink(`KaChat/Media/${unique}`);
}

/** Uploads the merged archive. Returns the uploaded file's ETag when the server sent one on the
 *  PUT response (`OC-ETag` first — Nextcloud's canonical header — then `ETag`), normalized;
 *  null when the header is missing (some proxies strip it; runBackup then recovers it with a
 *  follow-up PROPFIND). */
async function uploadBackup(payloadJson) {
  const davRoot = `${apiBase()}/remote.php/dav/files/${nc.username}`;
  const folderURL = `${davRoot}/${backupFolderPath().split("/").map(encodeURIComponent).join("/")}`;
  const mkcol = await fetch(folderURL, { method: "MKCOL", headers: { Authorization: authHeader() } });
  if (mkcol.status === 401) throw new Error("Nextcloud rejected the stored app password — reconnect in Settings.");
  if (!mkcol.ok && mkcol.status !== 405) throw new Error(`Could not create the backup folder (HTTP ${mkcol.status}).`);

  const put = await fetch(`${folderURL}/${BACKUP_FILENAME}`, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: payloadJson,
  });
  if (!put.ok) throw new Error(`Backup upload failed (HTTP ${put.status}).`);
  const raw = put.headers.get("OC-ETag") || put.headers.get("ETag");
  const normalized = raw ? normalizeETag(raw) : "";
  return normalized || null;
}

/**
 * One backup run: read what the server already has, hand it to the exporter so
 * the two archives are unioned, then upload the union. The exporter also owns
 * the encrypted-envelope codec: it decrypts the downloaded file when it is an
 * envelope (legacy plaintext still merges as-is) and ALWAYS encrypts the
 * uploaded union, so the file at rest is unreadable without this wallet's key.
 *
 * All failure modes deliberately abort BEFORE the PUT, leaving the existing
 * file untouched: a download error other than 404 throws out of
 * downloadBackupFile, and an undecryptable/unreadable/foreign/wrong-schema
 * body throws out of exportBackupPayload.
 */
async function runBackup() {
  const existingRemoteJson = await downloadBackupFile(BACKUP_FILENAME);
  const payload = await deps.exportBackupPayload(existingRemoteJson);
  let newETag = await uploadBackup(payload);
  if (!newETag) {
    // Some proxies strip the PUT response's ETag header; one follow-up Depth-0 PROPFIND
    // recovers it so the change watcher still recognises this device's own write.
    newETag = await fetchBackupETag().catch(() => null);
  }
  // Feedback-loop guard: remember our own write's ETag so the watcher never downloads it back.
  // If both captures failed the stored ETag is cleared, and the watcher re-imports our own
  // upload once — which the txId/id dedupe in importPhoneArchive makes a harmless no-op.
  rememberBackupETag(newETag);
}

async function fetchBackupInfo() {
  try {
    const listing = await listFolder(backupFolderPath());
    return listing.find((f) => !f.isDirectory && f.name === BACKUP_FILENAME) || null;
  } catch { return null; }
}

/** A failure the caller should RETRY rather than report as a bad file: a captive portal, a
 *  reverse-proxy error page, a maintenance screen, a truncated body. Marked so the change
 *  watcher backs off, the auto-restore stays silent and the restore overlay says "temporary"
 *  instead of "pick a different folder". */
function transientError(message) {
  const error = new Error(message);
  error.transient = true;
  return error;
}

/** Downloads one backup file from the configured folder; null when it doesn't exist (404).
 *
 *  A WebDAV GET of the backup file is NEVER legitimately HTML: a 2xx HTML body is a
 *  reverse-proxy, sign-in, captive-portal or maintenance page standing in for the server.
 *  Without this check that page flows into the archive parser and surfaces as the
 *  permanent-sounding "not a KaChat backup, pick a different folder", misreading a transient
 *  hiccup as a foreign file — and on the upload path it would abort the merge with the same
 *  misleading message. Mirrors iOS NextcloudService.performBackupDownload's mimeType guard and
 *  its empty-body check. */
async function downloadBackupFile(filename) {
  const davRoot = `${apiBase()}/remote.php/dav/files/${nc.username}`;
  const url = `${davRoot}/${backupFolderPath().split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(filename)}`;
  const response = await fetch(url, { headers: { Authorization: authHeader() }, cache: "no-store" });
  if (response.status === 404) return null;
  if (response.status === 401) throw new Error("Nextcloud rejected the stored app password. Reconnect in Settings.");
  if (!response.ok) throw new Error(`Backup download failed (HTTP ${response.status}).`);
  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  const text = await response.text();
  if (contentType.includes("html") || /^\s*(<!doctype html|<html[\s>])/i.test(text)) {
    throw transientError("The server sent a web page instead of the backup file (a sign-in, proxy or maintenance page). The backup was left untouched.");
  }
  // A 2xx with nothing in it is a truncated/proxied response, not an empty archive.
  if (!text.trim()) {
    throw transientError("The server returned an empty response for the backup file. The backup was left untouched.");
  }
  return text;
}

// ---------------------------------------------------------------------------
// ETag helpers (change detection + own-write feedback guard)
// ---------------------------------------------------------------------------

/** Strips the weak-validator prefix and surrounding quotes so a PUT response header ETag and a
 *  PROPFIND getetag for the same content compare equal. Mirrors iOS `normalizedETag`. */
function normalizeETag(raw) {
  let value = String(raw || "").trim();
  if (/^W\//i.test(value)) value = value.slice(2).trim();
  return value.replace(/^"+|"+$/g, "").trim();
}

/** Pulls the getetag value out of a Depth-0 multistatus. DOMParser first (namespace-correct
 *  whatever prefix the server uses), regex as a fallback for servers whose XML the parser
 *  rejects. Mirrors iOS `parseETagFromMultistatus`. */
function parseETagFromMultistatus(xmlText) {
  try {
    const xml = new DOMParser().parseFromString(xmlText, "application/xml");
    const node = xml.getElementsByTagNameNS("DAV:", "getetag")[0];
    const value = normalizeETag(node?.textContent || "");
    if (value) return value;
  } catch { /* fall through to the regex */ }
  const match = String(xmlText || "").match(/<[^<>]*getetag[^<>]*>([^<]+)<\/[^<>]*getetag[^<>]*>/i);
  if (!match) return null;
  const decoded = match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  return normalizeETag(decoded) || null;
}

/** The backup file's current ETag via a Depth-0 PROPFIND requesting only `getetag` — a tiny
 *  request with no body download, which is what makes a 5s poll affordable.
 *  null = no backup file yet (404); throws on any other failure. */
async function fetchBackupETag() {
  if (!nc) return null;
  const davRoot = `${apiBase()}/remote.php/dav/files/${nc.username}`;
  const url = `${davRoot}/${backupFolderPath().split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(BACKUP_FILENAME)}`;
  const response = await fetch(url, {
    method: "PROPFIND",
    headers: { Authorization: authHeader(), Depth: "0", "Content-Type": "application/xml" },
    body: `<?xml version="1.0"?>\n<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`,
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (response.status === 401) throw new Error("Nextcloud rejected the stored app password. Reconnect in Settings.");
  if (response.status !== 207) throw new Error(`Nextcloud returned HTTP ${response.status}.`);
  const etag = parseETagFromMultistatus(await response.text());
  if (!etag) throw transientError("The server's file listing did not include an ETag.");
  return etag;
}

/** Persists the last ETag this device wrote or imported. `nc` is already account-scoped
 *  (accountScopedKey), so this is per-wallet the same way iOS scopes `lastETagKey`. */
function rememberBackupETag(etag) {
  if (!nc) return;
  if (etag) nc.lastBackupEtag = etag;
  else delete nc.lastBackupEtag;
  saveState();
}

// ---------------------------------------------------------------------------
// Automatic sync — the desktop half of a two-way mirror
//
// Upload side: local changes arm a debounced merge upload (5s while a chat is open, 15s
// otherwise), floored at one automatic upload per 90s, plus an hourly heartbeat and a flush
// when the tab is hidden.
// Download side: the change watcher below polls the shared file's ETag and pulls in whatever
// another device wrote. Together they make desktop a mirror instead of an uploader.
// ---------------------------------------------------------------------------

/** True while a 1:1 conversation is actually open on screen — the desktop equivalent of iOS's
 *  `isChatOpenOnScreen` (ChatService.activeConversationAddress != nil). */
function isChatOpenOnScreen() {
  return Boolean(deps?.getActiveConversationId?.());
}

function currentChangeWatchMs() {
  return isChatOpenOnScreen() ? CHANGE_WATCH_IN_CHAT_MS : CHANGE_WATCH_IDLE_MS;
}

function currentSyncDebounceMs() {
  return isChatOpenOnScreen() ? SYNC_DEBOUNCE_IN_CHAT_MS : SYNC_DEBOUNCE_IDLE_MS;
}

/** A manual restore, a silent import or another upload owns the local store right now. Mirrors
 *  the `BackupRestoreCoordinator.shared.isRunning || syncInFlight` guards on iOS. */
function isBusy() {
  return syncInFlight || restore.phase === "running";
}

function armSyncDebounce(delayMs) {
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = window.setTimeout(() => {
    syncDebounceTimer = null;
    performAutomaticSync();
  }, Math.max(0, delayMs));
}

/**
 * The one automatic upload path. The dirty flag is cleared BEFORE the upload — a change
 * arriving during it re-marks the flag, so nothing is lost — and re-marked on any failure so a
 * later trigger retries. `bypassFloor` is used only by the tab-hide flush, which is the desktop
 * "leaving" moment and may be the last chance to write.
 */
async function performAutomaticSync({ bypassFloor = false } = {}) {
  if (!nc?.autoBackup) return;
  if (isBusy()) {
    // Something else owns the store; the dirty flag stays set and a short re-arm retries.
    armSyncDebounce(30_000);
    return;
  }
  if (!bypassFloor && lastAutoSyncAt) {
    const elapsed = Date.now() - lastAutoSyncAt;
    if (elapsed < AUTO_SYNC_MIN_MS) {
      // Re-arm to the earliest allowed moment instead of dropping the sync.
      armSyncDebounce(AUTO_SYNC_MIN_MS - elapsed);
      return;
    }
  }
  syncInFlight = true;
  syncDirty = false;
  try {
    await runBackup();
    lastAutoSyncAt = Date.now();
    if (nc) { nc.lastAutoBackup = lastAutoSyncAt; saveState(); }
    refreshBackupStatusLine();
  } catch (error) {
    syncDirty = true;
    deps.appendEngineLog?.(`Nextcloud automatic sync upload failed (a later trigger retries): ${error.message}`);
  } finally {
    syncInFlight = false;
    // Our own upload changed nothing locally; keep the detector from reading the settings
    // re-render as fresh activity.
    lastActivityFingerprint = activityFingerprint();
  }
}

async function autoBackupIfDue(minMs = AUTO_BACKUP_MIN_MS) {
  if (!nc?.autoBackup) return;
  const last = Number(nc.lastAutoBackup || 0);
  const due = Date.now() - last >= minMs;
  if (!due && !syncDirty) return;
  await performAutomaticSync();
}

// --- Local change detection -------------------------------------------------------------
// iOS gets an explicit signal (`noteMessageActivity`, called from ChatService for every message
// that lands). Desktop's message pipeline lives in ui/app.js, which this module may not edit,
// so the equivalent signal is derived from the rendered chat list instead: a fingerprint of
// every row's conversation id, preview line and unread badge, plus the open thread's message
// count. A new message (either direction, any path) always moves one of those. Timestamps are
// deliberately excluded so a minute ticking over is not mistaken for activity.

function activityFingerprint() {
  const rows = document.querySelectorAll("[data-chat-list] [data-conversation-id]");
  const parts = [];
  for (const row of rows) {
    const preview = row.querySelector(".chat-meta span")?.textContent || "";
    const unread = row.querySelector(".unread-badge")?.textContent || "";
    parts.push(`${row.dataset.conversationId}${preview}${unread}`);
  }
  const area = document.querySelector("[data-message-area]");
  // The open thread's own bubble count catches the one case the previews miss: the same text
  // sent twice in a row inside the chat you are looking at.
  parts.push(`${area?.dataset?.renderedConversationId || ""}${area?.childElementCount ?? 0}`);
  return parts.join("\n");
}

/** Local activity signal. Cheap and safe to call at any rate: it only arms a timer. */
function noteLocalActivity() {
  if (!nc?.autoBackup) return;
  syncDirty = true;
  // Tier picked at ARM time, and every re-arm re-reads it, so the last change of a burst
  // decides — same as iOS's armSyncDebounce.
  armSyncDebounce(currentSyncDebounceMs());
}

// Explicit signal from the host app for every message that lands, the desktop equivalent of
// iOS's noteMessageActivity. Exact, unlike the DOM fingerprint below.
export function noteMessageActivity() {
  noteLocalActivity();
}

function startActivityWatch() {
  if (activityObserver) return;
  // With a real signal wired up, the DOM fingerprint is redundant - and it is the weaker
  // detector (it can miss the same text sent twice in a chat that is not open, and can fire
  // on an unrelated list re-render), so prefer the signal alone.
  if (deps?.hasMessageActivitySignal) return;
  const chatList = document.querySelector("[data-chat-list]");
  const messageArea = document.querySelector("[data-message-area]");
  if (!chatList && !messageArea) return;
  lastActivityFingerprint = activityFingerprint();
  activityObserver = new MutationObserver(() => {
    if (activityCoalesceTimer) return;
    activityCoalesceTimer = window.setTimeout(() => {
      activityCoalesceTimer = null;
      const fingerprint = activityFingerprint();
      if (fingerprint === lastActivityFingerprint) return;
      lastActivityFingerprint = fingerprint;
      noteLocalActivity();
    }, ACTIVITY_COALESCE_MS);
  });
  const options = { childList: true, subtree: true, characterData: true };
  if (chatList) activityObserver.observe(chatList, options);
  if (messageArea) activityObserver.observe(messageArea, options);
}

// ---------------------------------------------------------------------------
// Change watcher — the near-live pull of another device's uploads
//
// Polls the shared file's ETag with a Depth-0 PROPFIND. When it differs from the last ETag this
// device wrote or imported, the file is downloaded, decrypted and merge-imported (additive,
// txId-deduped) silently, with one engine-log line. Combined with the other device's upload
// debounce, a message sent on a phone lands here in seconds while you are looking at the chat.
// Mirrors iOS NextcloudService.startChangeWatcherIfNeeded / runChangeWatcher.
// ---------------------------------------------------------------------------

function startChangeWatcherIfNeeded() {
  if (watcherRunning) return;
  if (!nc?.autoBackup) return;
  if (document.visibilityState === "hidden") return;
  watcherEpoch += 1;
  watcherRunning = true;
  lastSeenConversationId = deps?.getActiveConversationId?.() ?? null;
  const epoch = watcherEpoch;
  runChangeWatcher(epoch).finally(() => { if (watcherEpoch === epoch) watcherRunning = false; });
}

/** Stops the watcher: on tab-hide, disconnect, wallet switch and toggle-off. The epoch bump
 *  keeps a mid-await loop iteration from outliving the stop. */
function stopChangeWatcher() {
  watcherEpoch += 1;
  watcherRunning = false;
}

async function runChangeWatcher(epoch) {
  let backoffFactor = 1;
  while (watcherEpoch === epoch) {
    // Tier resolved fresh every tick, so leaving a chat relaxes the very next sleep and
    // entering one tightens it.
    const interval = Math.min(currentChangeWatchMs() * backoffFactor, CHANGE_WATCH_BACKOFF_MAX_MS);
    await sleepInterruptibly(interval, epoch);
    if (watcherEpoch !== epoch) break;
    if (!nc?.autoBackup || document.visibilityState === "hidden") break;
    try {
      await checkForRemoteChangeAndImport();
      backoffFactor = 1;
    } catch (error) {
      backoffFactor = Math.min(backoffFactor * 3, CHANGE_WATCH_BACKOFF_FACTOR_MAX);
      deps.appendEngineLog?.(`Nextcloud change watcher poll failed (backing off): ${error.message}`);
    }
  }
}

/** Sleeps up to `ms` in short slices, returning early when the watcher is retired (epoch bump)
 *  or when a chat is opened. The chat-entry wake is iOS's `noteChatOpened`, which ChatService
 *  calls directly; with no hook into ui/app.js, entry is detected by watching the active
 *  conversation id across the sleep slices instead. Not a busy loop, and the watcher only runs
 *  while the page is visible, so the quarter-second granularity costs nothing. */
async function sleepInterruptibly(ms, epoch) {
  const deadline = Date.now() + ms;
  while (watcherEpoch === epoch) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const current = deps?.getActiveConversationId?.() ?? null;
    if (current !== lastSeenConversationId) {
      lastSeenConversationId = current;
      // Opening a chat polls immediately instead of waiting out a residual idle-tier tick.
      // Leaving one only re-reads the tier on the next iteration.
      if (current) return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(250, remaining)));
  }
}

/** One poll: fetch the ETag, import the file if it changed. */
async function checkForRemoteChangeAndImport() {
  // ETag BEFORE the download: if the file is replaced between the two requests the stored ETag
  // is the older one and the next poll simply imports again — the safe direction, since an
  // import can only add.
  const etag = await fetchBackupETag();
  if (!etag) return;                      // no backup on the server yet
  if (etag === nc?.lastBackupEtag) return; // our own write, or already imported
  if (isBusy()) return;                    // retry on the next poll, ETag left alone

  syncInFlight = true;
  try {
    const raw = await downloadBackupFile(BACKUP_FILENAME);
    if (!raw) return;                     // vanished between the poll and the download
    let plain = null;
    try {
      plain = await deps.openBackupPayload(raw);
    } catch (error) {
      // A file this wallet cannot read (another wallet's backup, corrupt envelope): record the
      // ETag so it is not re-downloaded every poll. A future replacement changes the ETag and
      // gets a fresh look.
      rememberBackupETag(etag);
      deps.appendEngineLog?.(`Nextcloud change watcher skipped an unreadable server backup: ${error.message}`);
      return;
    }
    let summary = null;
    try {
      summary = deps.importPhoneArchive?.(plain) || null;
    } catch (error) {
      // Out of local storage is worth retrying once space frees up; a foreign wallet or a
      // wrong-schema file never becomes importable, so record its ETag and move on.
      if (/quota|too large/i.test(String(error.message || ""))) throw error;
      rememberBackupETag(etag);
      deps.appendEngineLog?.(`Nextcloud change watcher could not merge the server backup: ${error.message}`);
      return;
    }
    rememberBackupETag(etag);
    if (summary?.messages) {
      refreshOpenConversationView();
      // Converge the other direction too: this device may hold history the file we just merged
      // never had, so owe an upload of the union. This terminates rather than ping-pongs — the
      // next device's import of that union adds nothing (txId/id dedupe), so it uploads nothing.
      noteLocalActivity();
      deps.appendEngineLog?.(
        `Nextcloud sync merged another device's update: ${summary.messages} message${summary.messages === 1 ? "" : "s"} in ${summary.conversations} chat${summary.conversations === 1 ? "" : "s"}.`,
      );
    }
  } finally {
    syncInFlight = false;
    // The import legitimately changed local state, but it is the SAME state the server already
    // holds — re-baselining here is what stops two devices ping-ponging uploads forever.
    lastActivityFingerprint = activityFingerprint();
  }
}

/**
 * Re-renders the open thread after a silent merge. `importPhoneArchive` re-renders the chat
 * LIST itself, but the message pane is drawn by ui/app.js's `renderMessages`, which this module
 * cannot call. The chat row's own click handler is the only public route to it, and clicking
 * the active row closes then reopens the thread — both dispatches happen inside one task, so
 * the browser paints only the final state and nothing flickers.
 *
 * Skipped when the list is in selection mode (a click would toggle a checkbox instead), when a
 * draft is sitting in the composer, or when the composer is in payment mode: reopening a chat
 * re-activates message mode and clears the input, and a half-typed message or amount is worth
 * more than an instantly refreshed thread. Those cases simply see the new messages on the next
 * natural render.
 */
function refreshOpenConversationView() {
  // The host app can re-render the open thread directly; that is exact and side-effect free.
  // The synthetic-click path below is the fallback for wiring that predates the dep.
  if (typeof deps?.refreshActiveConversationView === "function") {
    deps.refreshActiveConversationView();
    return;
  }
  const activeId = deps?.getActiveConversationId?.();
  if (!activeId) return;
  const selector = `[data-chat-list] [data-conversation-id="${CSS.escape(String(activeId))}"]`;
  const row = document.querySelector(selector);
  if (!row || row.classList.contains("selecting")) return;
  const composerEl = document.querySelector("[data-composer]");
  if (composerEl?.classList.contains("payment-mode")) return;
  const draft = composerEl?.querySelector('textarea[name="message"]');
  if (draft && String(draft.value || "").trim()) return;
  row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  // The close re-rendered the list, so the row element above is stale — re-query it.
  document.querySelector(selector)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Silent auto-restore (one-time bootstrap per wallet)
//
// Mirrors iOS `scheduleAutoRestoreIfNeeded` / `runAutoRestore`: shortly after a wallet loads,
// if the server holds a backup and this device has never imported one, merge it in silently —
// a log line, no modal. A missing file (404) deliberately leaves the done flag UNSET, so a
// backup that appears later (the first sync from another device) still bootstraps this one.
// Only the additive archive merge runs here; the desktop-state REPLACE stays on the explicit
// restore path, where the user asked for it.
// ---------------------------------------------------------------------------

function scheduleAutoRestoreIfNeeded() {
  if (autoRestoreTimer) { clearTimeout(autoRestoreTimer); autoRestoreTimer = null; }
  if (!nc?.autoBackup || nc.autoRestoreDone) return;
  // A few seconds' delay so wallet activation (state reload, chat list render) finishes first.
  autoRestoreTimer = window.setTimeout(() => { autoRestoreTimer = null; runAutoRestore(); }, 3_000);
}

async function runAutoRestore() {
  if (!nc?.autoBackup || nc.autoRestoreDone) return;
  if (isBusy()) return;   // the done flag stays unset, so a later trigger retries
  syncInFlight = true;
  try {
    // ETag before the download (best effort): recorded after a successful import so the change
    // watcher's first poll does not immediately re-download what the bootstrap just imported.
    const etagAtDownload = await fetchBackupETag().catch(() => null);
    const raw = await downloadBackupFile(BACKUP_FILENAME);
    if (!raw) return;     // no backup yet: NOT an error, and NOT done
    const plain = await deps.openBackupPayload(raw);
    const summary = deps.importPhoneArchive?.(plain) || null;
    if (!nc) return;
    nc.autoRestoreDone = true;
    saveState();
    if (etagAtDownload) rememberBackupETag(etagAtDownload);
    refreshOpenConversationView();
    // A bootstrapping device usually also has history the server has never seen (chats it made
    // before sync was switched on). Owe an upload of the union so convergence is two-way.
    noteLocalActivity();
    // Fully silent by design — sync is invisible plumbing, like iCloud. The log line is the
    // only trace.
    deps.appendEngineLog?.(
      `Nextcloud automatic restore finished: ${summary?.messages ?? 0} message${summary?.messages === 1 ? "" : "s"} in ${summary?.conversations ?? 0} chat${summary?.conversations === 1 ? "" : "s"}.`,
    );
  } catch (error) {
    // Includes an unreadable archive and transient network failures: stay silent, leave the
    // done flag unset so a later trigger retries, and never surface a modal.
    deps.appendEngineLog?.(`Nextcloud automatic restore skipped (a later attempt retries): ${error.message}`);
  } finally {
    syncInFlight = false;
    lastActivityFingerprint = activityFingerprint();
  }
}

/** Arms (or disarms) everything automatic: the hourly heartbeat, the change watcher, the
 *  local-change detector and the one-time silent bootstrap. */
function armAutoBackup() {
  if (autoBackupTimer) { clearInterval(autoBackupTimer); autoBackupTimer = null; }
  if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
  if (autoRestoreTimer) { clearTimeout(autoRestoreTimer); autoRestoreTimer = null; }
  stopChangeWatcher();
  if (!nc?.autoBackup) return;
  startActivityWatch();
  autoBackupTimer = window.setInterval(() => autoBackupIfDue(), AUTO_BACKUP_MIN_MS);
  autoBackupIfDue(AUTO_CATCHUP_MS);
  startChangeWatcherIfNeeded();
  scheduleAutoRestoreIfNeeded();
}

// ---------------------------------------------------------------------------
// Restore coordinator + blocking progress overlay
//
// The desktop port of iOS's BackupRestoreCoordinator (NextcloudService.swift) and its
// ChatRestoreProgressModal (SettingsView.swift): a small state machine with an `isRunning`
// gate, and a full-screen modal that CANNOT be dismissed while the import is in flight — no
// close button, no Escape, and a beforeunload guard against a reload mid-import. The old flow
// was a window.confirm plus toasts, which let the user navigate away while the merge ran.
//
// Progress is real, not decorative. The download is one fetch that resolves whole, so it is a
// fixed slice of the bar (iOS streams bytes there; a browser fetch would need a reader loop for
// no practical gain on a file this size). The merge, which is the slow part, is fed to
// importPhoneArchive in batches so the "N of M chats" count advances for real, yielding a frame
// between batches so the bar paints. Batch size targets roughly ten steps, since every batch
// costs one full persist round.
// ---------------------------------------------------------------------------

const RESTORE_PROGRESS_STEPS = 10;

const restore = {
  phase: "idle",      // idle | confirm | running | success | failure
  fraction: 0,
  stage: "",
  summary: null,
  error: null,
  transient: false,
};

function nextFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

/** Monotonic progress: an out-of-order report can never move the bar backwards. */
function advanceRestore(fraction, stage) {
  restore.fraction = Math.max(restore.fraction, Math.min(fraction, 1));
  if (stage) restore.stage = stage;
  renderRestoreOverlay();
}

function openRestoreOverlay() {
  if (restore.phase === "running") return;
  restore.phase = "confirm";
  restore.fraction = 0;
  restore.stage = "";
  restore.summary = null;
  restore.error = null;
  restore.transient = false;
  renderRestoreOverlay();
}

/** Leaves the overlay. Only honored from a terminal state — a running restore cannot be
 *  dismissed, which is the whole point of the gate. */
function closeRestoreOverlay() {
  if (restore.phase === "running") return;
  restore.phase = "idle";
  renderRestoreOverlay();
}

function renderRestoreOverlay() {
  const modal = modalsEl?.querySelector("[data-nc-restore-modal]");
  if (!modal) return;
  modal.hidden = restore.phase === "idle";
  if (restore.phase === "idle") return;
  const body = modal.querySelector("[data-nc-restore-body]");
  const actions = modal.querySelector("[data-nc-restore-actions]");
  const title = modal.querySelector("[data-nc-restore-title]");
  if (!body || !actions || !title) return;

  const bar = (percent) => `
    <div class="nc-restore-track" style="height:8px;border-radius:999px;background:var(--surface-2);overflow:hidden;margin:16px 0 10px;">
      <div style="height:100%;width:${percent}%;border-radius:999px;background:var(--kaspa);transition:width .25s ease;"></div>
    </div>`;

  if (restore.phase === "confirm") {
    title.textContent = "Restore from Backup";
    body.innerHTML = `
      <p class="field-hint">Chat history from every device merges into this one. Nothing is deleted: the merge only adds messages this device is missing.</p>
      <p class="field-hint">Any desktop settings stored in the backup replace this device's.</p>`;
    actions.innerHTML = `
      <button class="secondary-button" type="button" data-nc-restore-cancel>Cancel</button>
      <button class="primary-button" type="button" data-nc-restore-start>Restore</button>`;
    return;
  }

  if (restore.phase === "running") {
    title.textContent = "Restoring";
    const percent = Math.round(restore.fraction * 100);
    body.innerHTML = `
      <p class="field-hint" style="margin:0;">${deps.escapeHtml(restore.stage)}</p>
      ${bar(percent)}
      <p class="field-hint" style="margin:0;font-variant-numeric:tabular-nums;">${percent}%</p>
      <p class="field-hint">Keep this window open until the restore finishes.</p>`;
    actions.innerHTML = "";
    return;
  }

  if (restore.phase === "success") {
    title.textContent = "Restore Complete";
    const summary = restore.summary || { messages: 0, conversations: 0, groups: 0 };
    const groups = summary.groups
      ? `<p class="field-hint">Recovered ${summary.groups} group${summary.groups === 1 ? "" : "s"}.</p>` : "";
    body.innerHTML = `
      ${bar(100)}
      <p class="field-hint">Merged ${summary.messages} message${summary.messages === 1 ? "" : "s"} from ${summary.conversations} chat${summary.conversations === 1 ? "" : "s"}.</p>
      ${groups}`;
    actions.innerHTML = `<button class="primary-button" type="button" data-nc-restore-close>Done</button>`;
    return;
  }

  title.textContent = "Restore Failed";
  body.innerHTML = `
    <p class="field-error">${deps.escapeHtml(restore.error || "Something went wrong.")}</p>
    ${restore.transient ? `<p class="field-hint">This looks temporary. Nothing on the server was changed, so trying again in a moment is safe.</p>` : ""}`;
  actions.innerHTML = `
    <button class="secondary-button" type="button" data-nc-restore-close>Close</button>
    <button class="primary-button" type="button" data-nc-restore-start>Try Again</button>`;
}

/** Counts what an archive is about to contribute, for the progress line. */
function archiveConversationCount(plainJson) {
  try {
    const parsed = JSON.parse(plainJson);
    return Array.isArray(parsed?.conversations) ? parsed.conversations.length : 0;
  } catch { return 0; }
}

/** Splits a shared archive into per-batch archives so the import reports honest progress.
 *  Returns null when the archive should just be handed over whole (unparseable — let the real
 *  importer produce its own error — or too small to be worth splitting). Groups ride along with
 *  the LAST batch so they are imported exactly once. */
function splitArchiveForProgress(plainJson) {
  let parsed = null;
  try { parsed = JSON.parse(plainJson); } catch { return null; }
  const conversations = Array.isArray(parsed?.conversations) ? parsed.conversations : null;
  if (!conversations || conversations.length <= 1) return null;
  const batchSize = Math.max(1, Math.ceil(conversations.length / RESTORE_PROGRESS_STEPS));
  const batches = [];
  for (let index = 0; index < conversations.length; index += batchSize) {
    const batch = { ...parsed, conversations: conversations.slice(index, index + batchSize) };
    delete batch.groups;
    batches.push(batch);
  }
  if (Array.isArray(parsed.groups) && parsed.groups.length) {
    batches[batches.length - 1].groups = parsed.groups;
  }
  return { total: conversations.length, batches };
}

async function runRestore() {
  if (restore.phase === "running") return;
  if (!nc) return;
  restore.phase = "running";
  restore.fraction = 0;
  restore.summary = null;
  restore.error = null;
  restore.transient = false;
  advanceRestore(0.04, "Contacting your server…");

  const wasWatching = watcherRunning;
  stopChangeWatcher();
  if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }

  try {
    // ETag before the download, recorded on success so the change watcher does not immediately
    // re-download the file this restore just imported.
    const etagAtDownload = await fetchBackupETag().catch(() => null);

    advanceRestore(0.10, "Downloading backup…");
    // Primary: the shared cross-device archive. A pre-4.0 desktop-only file may still be
    // sitting next to it — read as a fallback for the desktop half. A missing file (404) is
    // fine as long as one of them exists.
    let sharedJson = await downloadBackupFile(BACKUP_FILENAME);
    advanceRestore(0.22, "Downloading backup…");
    // A hiccup on the legacy probe must not sink a restore whose real file already downloaded.
    let legacyJson = sharedJson
      ? await downloadBackupFile(LEGACY_DESKTOP_BACKUP_FILENAME).catch(() => null)
      : await downloadBackupFile(LEGACY_DESKTOP_BACKUP_FILENAME);
    if (!sharedJson && !legacyJson) throw new Error("No KaChat backup was found in that folder.");

    advanceRestore(0.30, "Validating backup…");
    // Envelope v1: files written since the phones/desktop started encrypting are envelopes —
    // decrypt before any importer sees them. Legacy plaintext passes through unchanged, and a
    // failed decrypt throws, aborting the whole restore before anything local is touched.
    if (sharedJson) sharedJson = await deps.openBackupPayload(sharedJson);
    if (legacyJson) legacyJson = await deps.openBackupPayload(legacyJson);

    const totalConversations = sharedJson ? archiveConversationCount(sharedJson) : 0;
    advanceRestore(0.38, "Preparing messages…");
    await nextFrame();

    // Desktop state first (it REPLACES local state), then the archive merge — that ordering is
    // what stops the replace from wiping the freshly merged history. A shared file written by a
    // phone has no desktopState, in which case the legacy desktop file (if any) supplies it.
    let desktopRestored = sharedJson ? deps.importDesktopState?.(sharedJson) === true : false;
    if (!desktopRestored && legacyJson) {
      deps.importBackupPayload(legacyJson);
      desktopRestored = true;
    }
    advanceRestore(0.46, `Restoring messages… 0 of ${totalConversations} chat${totalConversations === 1 ? "" : "s"}`);
    await nextFrame();

    const summary = { conversations: 0, messages: 0, groups: 0 };
    if (sharedJson) {
      const split = splitArchiveForProgress(sharedJson);
      if (!split) {
        const single = deps.importPhoneArchive?.(sharedJson);
        if (single) {
          summary.conversations += single.conversations || 0;
          summary.messages += single.messages || 0;
          summary.groups += single.groups || 0;
        }
        advanceRestore(0.92, "Restoring messages…");
      } else {
        let done = 0;
        for (const batch of split.batches) {
          const partial = deps.importPhoneArchive?.(JSON.stringify(batch));
          if (partial) {
            summary.conversations += partial.conversations || 0;
            summary.messages += partial.messages || 0;
            summary.groups += partial.groups || 0;
          }
          done += batch.conversations.length;
          advanceRestore(
            0.46 + 0.46 * (done / split.total),
            `Restoring messages… ${done} of ${split.total} chat${split.total === 1 ? "" : "s"}`,
          );
          // Yield so the bar actually paints between batches.
          await nextFrame();
        }
      }
    }

    advanceRestore(0.95, "Finishing up…");
    await nextFrame();
    if (nc) {
      // This device now holds the server's history: mark the one-time bootstrap done and adopt
      // the file's ETag so the watcher does not re-import it on its first poll.
      nc.autoRestoreDone = true;
      saveState();
      if (etagAtDownload) rememberBackupETag(etagAtDownload);
    }
    refreshOpenConversationView();
    lastActivityFingerprint = activityFingerprint();
    // Same two-way convergence as the silent bootstrap: this device may hold history the
    // restored file never had, so owe an upload of the union.
    noteLocalActivity();
    restore.summary = summary;
    restore.phase = "success";
    advanceRestore(1, "Done");
    refreshBackupStatusLine();
  } catch (error) {
    restore.error = corsHint(error);
    restore.transient = Boolean(error?.transient);
    restore.phase = "failure";
    renderRestoreOverlay();
  } finally {
    if (restore.phase !== "running" && (wasWatching || nc?.autoBackup)) startChangeWatcherIfNeeded();
  }
}

// ---------------------------------------------------------------------------
// Settings UI (renders into [data-nextcloud-settings])
// ---------------------------------------------------------------------------

function renderSettings() {
  if (!settingsEl) return;
  if (!nc) {
    settingsEl.innerHTML = `
      <div class="settings-list-card nc-connect-card">
        <label class="field-label">Server<input class="field-input" type="text" data-nc-server placeholder="cloud.example.com" autocomplete="off" spellcheck="false" /></label>
        <label class="field-label">Username<input class="field-input" type="text" data-nc-username autocomplete="off" spellcheck="false" /></label>
        <label class="field-label">App password<span class="password-field-wrap"><input class="field-input" type="password" data-nc-password autocomplete="off" /><button class="password-eye-btn" type="button" data-eye-toggle aria-label="Show password"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.3 12.3C4.4 7.7 8 5.2 12 5.2s7.6 2.5 9.7 7.1a.9.9 0 0 1 0 .8c-2.1 4.6-5.7 7.1-9.7 7.1s-7.6-2.5-9.7-7.1a.9.9 0 0 1 0-.8Z"/><circle cx="12" cy="12.7" r="3.1"/></svg></button></span></label>
        <p class="field-hint">Create an app password in Nextcloud under Settings → Security → Devices &amp; sessions. No server CORS setup needed — the app's own dev server proxies Nextcloud traffic.</p>
        <p class="field-error" data-nc-connect-error hidden></p>
        <button class="primary-button" type="button" data-nc-connect>Connect</button>
      </div>`;
    updateComposerButton();
    return;
  }

  const host = (() => { try { return new URL(nc.server).host; } catch { return nc.server; } })();
  settingsEl.innerHTML = `
    <div class="settings-list-card">
      <div class="settings-list-row settings-info-row"><span class="settings-row-copy"><strong>Connected</strong><small>${deps.escapeHtml(nc.username)}@${deps.escapeHtml(host)}</small></span></div>
      <button class="settings-list-row" type="button" data-nc-pick-start><span class="settings-row-copy"><strong>Start Folder</strong><small>${deps.escapeHtml(nc.startFolder || "All Files")}</small></span></button>
      <div class="settings-toggle-row"><span><strong>Send Media via Nextcloud</strong><small>Photos and voice notes upload full-quality to your server and send as links; the file sits unencrypted behind an unguessable link, while the message itself stays end-to-end encrypted. Off = media embeds in the encrypted on-chain payload.</small></span><label class="switch-control"><input type="checkbox" data-nc-media-send ${nc.mediaSend ? "checked" : ""}><span></span></label></div>
      <div class="settings-toggle-row"><span><strong>Automatic Sync</strong><small>Keeps this device level with your phone: uploads a few seconds after new messages, and pulls in whatever your other devices wrote, checking every few seconds while a chat is open. Pauses when this window is hidden.</small></span><label class="switch-control"><input type="checkbox" data-nc-auto ${nc.autoBackup ? "checked" : ""}><span></span></label></div>
      <button class="settings-list-row" type="button" data-nc-pick-backup><span class="settings-row-copy"><strong>Backup Folder</strong><small>${deps.escapeHtml(nc.backupFolder || `${DEFAULT_BACKUP_FOLDER} (default)`)}</small></span></button>
      <button class="settings-list-row" type="button" data-nc-backup-now><span class="settings-row-copy"><strong>Back Up Messages Now</strong><small data-nc-backup-status>Checking last backup…</small></span></button>
      <button class="settings-list-row" type="button" data-nc-restore><span class="settings-row-copy"><strong>Restore from Backup</strong><small>Merges ${deps.escapeHtml(BACKUP_FILENAME)} back into this device's chat history, whichever device wrote it.</small></span></button>
      <p class="field-hint">One backup, shared across your devices: iPhone, Android and desktop all read and write <strong>${deps.escapeHtml(BACKUP_FILENAME)}</strong> in this folder, in the same format. Every backup merges with what is already there, so no device can erase another's history. The file is encrypted; only devices signed in with this wallet's recovery phrase can read it.</p>
      <button class="settings-list-row danger-row" type="button" data-nc-disconnect><span class="settings-row-copy"><strong>Disconnect</strong><small>Removes the stored app password from this device.</small></span></button>
    </div>`;
  updateComposerButton();
  refreshBackupStatusLine();
}

async function refreshBackupStatusLine() {
  const line = settingsEl?.querySelector("[data-nc-backup-status]");
  if (!line || !nc) return;
  const info = await fetchBackupInfo();
  const current = settingsEl?.querySelector("[data-nc-backup-status]");
  if (!current) return;
  if (!info) { current.textContent = "No backup in this folder yet."; return; }
  const when = info.modified ? info.modified.toLocaleString() : "unknown time";
  const size = info.size ? ` · ${(info.size / 1024).toFixed(1)} KB` : "";
  current.textContent = `Last backup: ${when}${size}`;
}

function updateComposerButton() {
  const button = document.querySelector("[data-nextcloud-pick]");
  if (button) button.hidden = !nc;
}

// ---------------------------------------------------------------------------
// Picker modal (media send + folder selection, one modal, in-place navigation)
// ---------------------------------------------------------------------------

function openPicker(mode) {
  pickerMode = mode;
  pickerOpen = true;
  pickerStack = [];
  pickerPath = mode === "media" ? (nc.startFolder || "") : "";
  const modal = modalsEl.querySelector("[data-nc-picker-modal]");
  if (modal) modal.hidden = false;
  loadPickerFolder();
}

function closePicker() {
  pickerOpen = false;
  const modal = modalsEl?.querySelector("[data-nc-picker-modal]");
  if (modal) modal.hidden = true;
}

async function loadPickerFolder() {
  pickerLoading = true;
  pickerError = null;
  pickerFiles = [];
  renderPicker();
  try {
    pickerFiles = await listFolder(pickerPath);
  } catch (error) {
    pickerError = corsHint(error);
  }
  pickerLoading = false;
  renderPicker();
  hydratePickerThumbnails();
}

function pickerTitle() {
  if (!pickerPath) return pickerMode === "media" ? "Nextcloud" : "All Files";
  return pickerPath.split("/").pop();
}

function renderPicker() {
  const body = modalsEl?.querySelector("[data-nc-picker-body]");
  const titleEl = modalsEl?.querySelector("[data-nc-picker-title]");
  const chooseBtn = modalsEl?.querySelector("[data-nc-picker-choose]");
  const allFilesBtn = modalsEl?.querySelector("[data-nc-picker-allfiles]");
  const backBtn = modalsEl?.querySelector("[data-nc-picker-back]");
  if (!body) return;
  if (titleEl) titleEl.textContent = pickerTitle();
  if (chooseBtn) {
    chooseBtn.hidden = pickerMode === "media";
    chooseBtn.textContent = pickerPath ? "Use This Folder" : "Use All Files";
  }
  if (allFilesBtn) allFilesBtn.hidden = !(pickerMode === "media" && (pickerPath || pickerStack.length));
  if (backBtn) backBtn.hidden = pickerStack.length === 0;

  const folders = pickerFiles.filter((f) => f.isDirectory)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const media = pickerMode === "media"
    ? pickerFiles.filter((f) => f.isImage || f.isVideo)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    : [];
  // Everything else (audio, PDFs, docs, …) is sendable too — listed as rows under the grid.
  const others = pickerMode === "media"
    ? pickerFiles.filter((f) => !f.isDirectory && !f.isImage && !f.isVideo)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    : [];

  body.innerHTML = `
    ${pickerError ? `<p class="field-error nc-picker-error">${deps.escapeHtml(pickerError)}</p>` : ""}
    ${folders.map((folder) => `
      <button class="nc-folder-row" type="button" data-nc-open-folder="${deps.escapeHtml(folder.path)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5A2 2 0 0 1 5.5 4.5h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/></svg>
        <span>${deps.escapeHtml(folder.name)}</span>
        <svg class="nc-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>`).join("")}
    ${media.length ? `<div class="nc-grid">${media.map((file) => `
      <button class="nc-cell" type="button" data-nc-pick-file="${deps.escapeHtml(file.path)}" data-nc-thumb="${deps.escapeHtml(file.path)}">
        <span class="nc-cell-icon">${file.isVideo
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3Z"/></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m5 17 4.5-4.5 3.2 3.2 2.3-2.3L19 17"/></svg>'}</span>
        ${file.isVideo ? '<span class="nc-play">▶</span>' : ""}
        <span class="nc-cell-busy" hidden></span>
      </button>`).join("")}</div>` : ""}
    ${others.map((file) => `
      <button class="nc-folder-row nc-file-row" type="button" data-nc-pick-file="${deps.escapeHtml(file.path)}">
        ${fileRowIcon(file)}
        <span>${deps.escapeHtml(file.name)}</span>
        ${file.size ? `<small>${(file.size / 1024).toFixed(0)} KB</small>` : ""}
      </button>`).join("")}
    ${!pickerLoading && !folders.length && !media.length && !others.length && !pickerError
      ? `<p class="nc-empty">${pickerMode === "media" ? "This folder is empty." : "No subfolders."}</p>` : ""}
    ${pickerLoading ? '<p class="nc-empty">Loading…</p>' : ""}`;
}

function fileRowIcon(file) {
  const ext = fileExtension(file.path);
  const type = file.contentType || "";
  if (type.startsWith("audio/") || ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"].includes(ext)) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>';
  }
  if (ext === "pdf" || type.includes("pdf")) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M8.5 13h7M8.5 16.5h5"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>';
}

async function hydratePickerThumbnails() {
  if (pickerMode !== "media") return;
  const cells = Array.from(modalsEl?.querySelectorAll("[data-nc-thumb]") || []);
  for (const cell of cells) {
    if (!pickerOpen) return;
    const path = cell.dataset.ncThumb;
    const url = await thumbnailURL(path);
    if (!pickerOpen) return;
    if (url && cell.isConnected) {
      cell.style.backgroundImage = `url("${url}")`;
      cell.classList.add("has-thumb");
    }
  }
}

async function pickMediaFile(path) {
  if (pickerSharingPath) return;
  pickerSharingPath = path;
  const cell = modalsEl?.querySelector(`[data-nc-pick-file="${CSS.escape(path)}"] .nc-cell-busy`);
  if (cell) cell.hidden = false;
  try {
    const url = await createPublicShareLink(path);
    pickerSharingPath = null;
    closePicker();
    // Stage the link in the composer for review instead of auto-sending — the user presses
    // send themselves (matches iOS/Android).
    deps.stageComposerText?.(url);
  } catch (error) {
    pickerSharingPath = null;
    if (cell) cell.hidden = true;
    pickerError = corsHint(error);
    renderPicker();
    hydratePickerThumbnails();
  }
}

function chooseCurrentFolder() {
  const chosen = pickerPath || null;
  if (pickerMode === "folder-start") {
    nc.startFolder = chosen;
  } else if (pickerMode === "folder-backup") {
    nc.backupFolder = chosen; // null = default KaChat folder
    // A different folder means a different file: the remembered ETag describes the old one, so
    // drop it and let the watcher take a fresh look.
    delete nc.lastBackupEtag;
  }
  saveState();
  closePicker();
  renderSettings();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function buildModals() {
  modalsEl = document.createElement("div");
  modalsEl.innerHTML = `
    <div class="modal-backdrop nc-picker-backdrop" data-nc-picker-modal hidden>
      <div class="contact-modal nc-picker-modal" role="dialog" aria-modal="true" aria-label="Nextcloud files">
        <div class="modal-header">
          <div class="nc-picker-head">
            <button class="kaposts-icon-button" type="button" data-nc-picker-back aria-label="Back" hidden>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>
            </button>
            <div><p class="modal-kicker">Nextcloud</p><h2 data-nc-picker-title>Nextcloud</h2></div>
          </div>
          <div class="nc-picker-actions">
            <button class="cold-inline-link" type="button" data-nc-picker-allfiles hidden>All Files</button>
            <button class="modal-close" type="button" data-nc-picker-close aria-label="Close">×</button>
          </div>
        </div>
        <div class="nc-picker-body" data-nc-picker-body></div>
        <div class="modal-actions">
          <button class="primary-button" type="button" data-nc-picker-choose hidden>Use This Folder</button>
        </div>
      </div>
    </div>
    <div class="modal-backdrop nc-restore-backdrop" data-nc-restore-modal hidden>
      <div class="contact-modal nc-restore-modal" role="dialog" aria-modal="true" aria-live="polite" aria-label="Restore from backup">
        <div class="modal-header">
          <div><p class="modal-kicker">Nextcloud</p><h2 data-nc-restore-title>Restore from Backup</h2></div>
        </div>
        <div data-nc-restore-body></div>
        <div class="modal-actions" data-nc-restore-actions></div>
      </div>
    </div>`;
  document.body.appendChild(modalsEl);

  // A reload or tab close mid-import would leave a half-merged store; warn while running.
  window.addEventListener("beforeunload", (event) => {
    if (restore.phase !== "running") return;
    event.preventDefault();
    event.returnValue = "";
  });

  modalsEl.addEventListener("click", (event) => {
    if (event.target.closest("[data-nc-restore-start]")) { runRestore(); return; }
    if (event.target.closest("[data-nc-restore-cancel]") || event.target.closest("[data-nc-restore-close]")) {
      closeRestoreOverlay();
      return;
    }
    if (event.target.closest("[data-nc-picker-close]")) { closePicker(); return; }
    if (event.target.closest("[data-nc-picker-back]")) {
      pickerPath = pickerStack.pop() ?? "";
      loadPickerFolder();
      return;
    }
    if (event.target.closest("[data-nc-picker-allfiles]")) {
      pickerStack = [];
      pickerPath = "";
      loadPickerFolder();
      return;
    }
    if (event.target.closest("[data-nc-picker-choose]")) { chooseCurrentFolder(); return; }
    const openFolder = event.target.closest("[data-nc-open-folder]");
    if (openFolder) {
      pickerStack.push(pickerPath);
      pickerPath = openFolder.dataset.ncOpenFolder;
      loadPickerFolder();
      return;
    }
    const pickFile = event.target.closest("[data-nc-pick-file]");
    if (pickFile) { pickMediaFile(pickFile.dataset.ncPickFile); }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // A running restore swallows Escape: the overlay is only leavable from a terminal state.
    if (restore.phase !== "idle") { closeRestoreOverlay(); return; }
    if (pickerOpen) closePicker();
  });
}

function wireSettings() {
  settingsEl?.addEventListener("click", async (event) => {
    if (event.target.closest("[data-nc-connect]")) {
      const server = normalizedServer(settingsEl.querySelector("[data-nc-server]")?.value);
      const username = String(settingsEl.querySelector("[data-nc-username]")?.value || "").trim();
      const appPassword = String(settingsEl.querySelector("[data-nc-password]")?.value || "").trim();
      const errorEl = settingsEl.querySelector("[data-nc-connect-error]");
      const showError = (message) => { if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; } };
      if (!server) { showError("That doesn't look like a valid server URL."); return; }
      if (!username || !appPassword) { showError("Enter your username and an app password."); return; }
      const button = event.target.closest("[data-nc-connect]");
      button.disabled = true;
      button.textContent = "Connecting…";
      try {
        await verifyCredentials(server, username, appPassword);
        nc = { server, username, appPassword, startFolder: null, backupFolder: null, autoBackup: false, lastAutoBackup: 0 };
        saveState();
        renderSettings();
        armAutoBackup();
        deps.showToast?.("Nextcloud connected.");
      } catch (error) {
        button.disabled = false;
        button.textContent = "Connect";
        showError(corsHint(error));
      }
      return;
    }
    if (event.target.closest("[data-nc-disconnect]")) {
      nc = null;
      syncDirty = false;
      lastAutoSyncAt = 0;
      if (restore.phase !== "running") closeRestoreOverlay();
      saveState();
      armAutoBackup();  // stops the watcher, the heartbeat and the debounce
      renderSettings();
      return;
    }
    if (event.target.closest("[data-nc-pick-start]")) { openPicker("folder-start"); return; }
    if (event.target.closest("[data-nc-pick-backup]")) { openPicker("folder-backup"); return; }
    if (event.target.closest("[data-nc-backup-now]")) {
      const status = settingsEl.querySelector("[data-nc-backup-status]");
      // The manual button bypasses the debounce and the automatic-sync floor, but still waits
      // for whatever already owns the store rather than racing it.
      if (isBusy()) { if (status) status.textContent = "A sync is already running. Try again in a moment."; return; }
      if (status) status.textContent = "Backing up…";
      syncInFlight = true;
      syncDirty = false;
      try {
        await runBackup();
        lastAutoSyncAt = Date.now();
        nc.lastAutoBackup = lastAutoSyncAt;
        saveState();
        deps.showToast?.("Backup uploaded. Merged with what your other devices had already backed up.");
      } catch (error) {
        syncDirty = true;
        deps.showToast?.(corsHint(error));
      } finally {
        syncInFlight = false;
        lastActivityFingerprint = activityFingerprint();
      }
      refreshBackupStatusLine();
      return;
    }
    // The restore itself lives in the blocking overlay (confirm -> progress -> result), so the
    // user cannot navigate away mid-import and the merge is never a toast-only affair.
    if (event.target.closest("[data-nc-restore]")) { openRestoreOverlay(); return; }
  });

  settingsEl?.addEventListener("change", (event) => {
    if (event.target.matches("[data-nc-auto]")) {
      if (!nc) return;
      nc.autoBackup = event.target.checked;
      saveState();
      armAutoBackup();
    }
    if (event.target.matches("[data-nc-media-send]")) {
      if (!nc) return;
      nc.mediaSend = event.target.checked;
      saveState();
    }
  });
}

// ---------------------------------------------------------------------------
// Contacts sync (CardDAV) — the desktop equivalent of iOS's "sync system contacts".
// A browser has no OS address book, so instead we read the connected account's Nextcloud
// address book(s) over CardDAV and import any vCard that carries a Kaspa address. iOS stores
// the KaChat address in a contact's URL entries as `kaspa:...`; we match the same shape here,
// so a card synced from an iPhone flows straight in. Read-only: nothing is written back.
// ---------------------------------------------------------------------------

const KASPA_ADDRESS_RE = /(kaspa:[a-z0-9]{20,}|kaspatest:[a-z0-9]{20,})/i;

// Enumerate the account's address-book collection ids (default is "contacts", but a user may
// have renamed it or have several). Falls back to ["contacts"] on any failure so the common
// case still works without a successful PROPFIND.
async function listAddressBookIds() {
  try {
    const home = `${apiBase()}/remote.php/dav/addressbooks/users/${encodeURIComponent(nc.username)}/`;
    const response = await fetch(home, {
      method: "PROPFIND",
      headers: { Authorization: authHeader(), Depth: "1", "Content-Type": "application/xml" },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
      cache: "no-store",
    });
    if (!response.ok) return ["contacts"];
    const doc = new DOMParser().parseFromString(await response.text(), "application/xml");
    const ids = [];
    for (const res of Array.from(doc.getElementsByTagNameNS("DAV:", "response"))) {
      const isBook = res.getElementsByTagNameNS("urn:ietf:params:xml:ns:carddav", "addressbook").length > 0;
      if (!isBook) continue;
      const href = res.getElementsByTagNameNS("DAV:", "href")[0]?.textContent || "";
      // Take just the collection id (last path segment) and rebuild the URL through apiBase —
      // using the raw href would double any server subpath the proxy target already carries.
      const match = href.match(/\/addressbooks\/users\/[^/]+\/([^/]+)\/?$/i);
      if (match && match[1]) ids.push(decodeURIComponent(match[1]));
    }
    return ids.length ? ids : ["contacts"];
  } catch {
    return ["contacts"];
  }
}

// vCard lines can be folded across multiple physical lines (a CRLF followed by a space/tab is a
// continuation). Unfold before scanning so a folded FN or URL value isn't split.
function unfoldVCards(text) {
  return String(text || "").replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function parseVCardContacts(text) {
  const cards = unfoldVCards(text).split(/BEGIN:VCARD/i).slice(1);
  const entries = [];
  for (const card of cards) {
    const addrMatch = card.match(KASPA_ADDRESS_RE);
    if (!addrMatch) continue;
    const address = addrMatch[1];
    const fn = card.match(/(?:^|\n)FN(?:;[^:\r\n]*)?:(.+)/i);
    const name = fn ? fn[1].trim() : "";
    entries.push({ address, name });
  }
  return entries;
}

async function syncContactsFromNextcloud() {
  if (!nc) throw new Error("Connect Nextcloud first.");
  const bookIds = await listAddressBookIds();
  const seen = new Set();
  const entries = [];
  for (const bookId of bookIds) {
    const url = `${apiBase()}/remote.php/dav/addressbooks/users/${encodeURIComponent(nc.username)}/${encodeURIComponent(bookId)}/?export`;
    const response = await fetch(url, { headers: { Authorization: authHeader() }, cache: "no-store" });
    if (!response.ok) continue;
    for (const entry of parseVCardContacts(await response.text())) {
      const key = entry.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  const summary = deps.importNextcloudContacts
    ? deps.importNextcloudContacts(entries)
    : { added: 0, updated: 0, skipped: entries.length };
  return { found: entries.length, ...summary };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function isNextcloudConnected() {
  return Boolean(nc);
}

export async function syncNextcloudContacts() {
  return syncContactsFromNextcloud();
}

export function resetNextcloudForAccount() {
  closePicker();
  // A wallet switch retires everything in flight before the new account's state loads: the
  // ETag, the dirty flag and the sync floor all belong to the wallet that just left.
  stopChangeWatcher();
  if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
  if (autoRestoreTimer) { clearTimeout(autoRestoreTimer); autoRestoreTimer = null; }
  syncDirty = false;
  lastAutoSyncAt = 0;
  lastSeenConversationId = null;
  if (restore.phase !== "running") closeRestoreOverlay();
  for (const url of thumbCache.values()) { if (url) URL.revokeObjectURL(url); }
  thumbCache = new Map();
  loadState();
  renderSettings();
  armAutoBackup();
}

export function initNextcloud(dependencies) {
  deps = dependencies;
  settingsEl = document.querySelector("[data-nextcloud-settings]");
  loadState();
  buildModals();
  wireSettings();

  // "Send from Nextcloud" in the composer's + menu (hidden until connected).
  document.querySelector("[data-nextcloud-pick]")?.addEventListener("click", () => {
    document.querySelector("[data-composer-plus-menu]")?.setAttribute("hidden", "");
    if (!nc) { deps.showToast?.("Connect Nextcloud in Settings → Storage first."); return; }
    openPicker("media");
  });

  // Tab-hide is the desktop "leaving" moment — mirror iOS's on-background backup, and stop the
  // change watcher entirely (a hidden tab has its timers throttled anyway, and polling a server
  // for a window nobody is looking at is pure waste). Coming back re-arms everything and runs a
  // catch-up.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopChangeWatcher();
      if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
      // The hide flush takes over from any pending quiet-time timer: bypass the automatic-sync
      // floor so a change that was still waiting out its debounce is not left unwritten.
      if (syncDirty) performAutomaticSync({ bypassFloor: true });
      else autoBackupIfDue();
      return;
    }
    // Timers are throttled while hidden, so a change that landed back there may never have
    // reached the detector. Compare rather than re-baseline, so it is not lost.
    const fingerprint = activityFingerprint();
    if (fingerprint !== lastActivityFingerprint) {
      lastActivityFingerprint = fingerprint;
      noteLocalActivity();
    }
    startChangeWatcherIfNeeded();
    autoBackupIfDue(AUTO_CATCHUP_MS);
    scheduleAutoRestoreIfNeeded();
  });

  renderSettings();
  armAutoBackup();
}
