// Nextcloud integration — desktop port of the iOS stack:
// connect a server with an app password, browse it over WebDAV, send photos/videos in chats as
// public /s/TOKEN share links (rendered by the link-preview feature), and back up the account's
// chat data to the server (manual + automatic with hourly throttle and launch catch-up).
//
// The backup is cross-platform: one `kachat-backup.json` per folder in the shared
// ChatHistoryArchive schema, written and read by iPhone, Android and desktop alike. Every
// upload first downloads the file already there and uploads the UNION, so restoring on one
// device never costs another device its history.
//
// Browser reality: unlike the native apps, fetches here would be subject to CORS — solved by
// routing all API traffic through vite.config.mjs's same-origin /nc-proxy passthrough (see
// apiBase()). The connect screen still detects total-failure shapes and
// tells the user to allow this origin on their server/reverse proxy. Credentials live in
// account-scoped localStorage — same trust model as the rest of this desktop build (the wallet
// itself persists there too).

const NC_KEY = "kachat-nextcloud-v1"; // account-scoped: { server, username, appPassword, startFolder, backupFolder, autoBackup, lastAutoBackup }
// ONE shared backup file across iPhone, Android and desktop: same name, same
// ChatHistoryArchive schema, so any device can restore any other device's
// backup. Uploads MERGE with whatever is already on the server (see runBackup),
// so no device can ever delete another's history.
const BACKUP_FILENAME = "kachat-backup.json";
// Pre-4.0 desktop-only file. Read on restore so an old backup can still be
// recovered; never written again.
const LEGACY_DESKTOP_BACKUP_FILENAME = "kachat-backup-desktop.json";
const DEFAULT_BACKUP_FOLDER = "KaChat";
const AUTO_BACKUP_MIN_MS = 3600_000;
const AUTO_CATCHUP_MS = 86_400_000;

let deps = null;
let nc = null;              // null = not connected; else the stored account object
let settingsEl = null;
let modalsEl = null;
let thumbCache = new Map(); // path -> object URL
let autoBackupTimer = null;

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
  return `/nc-proxy/${encodeURIComponent(String(server || "").replace(/\/+$/, ""))}`;
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
}

/**
 * One backup run: read what the server already has, hand it to the exporter so
 * the two archives are unioned, then upload the union.
 *
 * Both failure modes deliberately abort BEFORE the PUT, leaving the existing
 * file untouched: a download error other than 404 throws out of
 * downloadBackupFile, and an unreadable/foreign/wrong-schema body throws out of
 * exportBackupPayload.
 */
async function runBackup() {
  const existingRemoteJson = await downloadBackupFile(BACKUP_FILENAME);
  await uploadBackup(deps.exportBackupPayload(existingRemoteJson));
}

async function fetchBackupInfo() {
  try {
    const listing = await listFolder(backupFolderPath());
    return listing.find((f) => !f.isDirectory && f.name === BACKUP_FILENAME) || null;
  } catch { return null; }
}

/** Downloads one backup file from the configured folder; null when it doesn't exist (404). */
async function downloadBackupFile(filename) {
  const davRoot = `${apiBase()}/remote.php/dav/files/${nc.username}`;
  const url = `${davRoot}/${backupFolderPath().split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(filename)}`;
  const response = await fetch(url, { headers: { Authorization: authHeader() }, cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Backup download failed (HTTP ${response.status}).`);
  return response.text();
}

// ---------------------------------------------------------------------------
// Automatic backup
// ---------------------------------------------------------------------------

async function autoBackupIfDue(minMs = AUTO_BACKUP_MIN_MS) {
  if (!nc?.autoBackup) return;
  const last = Number(nc.lastAutoBackup || 0);
  if (Date.now() - last < minMs) return;
  try {
    await runBackup();
    nc.lastAutoBackup = Date.now();
    saveState();
    renderSettings();
  } catch (error) {
    deps.appendEngineLog?.(`Nextcloud auto-backup failed: ${error.message}`);
  }
}

function armAutoBackup() {
  if (autoBackupTimer) { clearInterval(autoBackupTimer); autoBackupTimer = null; }
  if (!nc?.autoBackup) return;
  // Hourly while the tab lives, on tab-hide (the desktop "leaving" moment), and a
  // day-stale catch-up at startup.
  autoBackupTimer = window.setInterval(() => autoBackupIfDue(), AUTO_BACKUP_MIN_MS);
  autoBackupIfDue(AUTO_CATCHUP_MS);
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
      <div class="settings-toggle-row"><span><strong>Automatic Backup</strong><small>Uploads hourly while open, plus a daily catch-up at launch.</small></span><label class="switch-control"><input type="checkbox" data-nc-auto ${nc.autoBackup ? "checked" : ""}><span></span></label></div>
      <button class="settings-list-row" type="button" data-nc-pick-backup><span class="settings-row-copy"><strong>Backup Folder</strong><small>${deps.escapeHtml(nc.backupFolder || `${DEFAULT_BACKUP_FOLDER} (default)`)}</small></span></button>
      <button class="settings-list-row" type="button" data-nc-backup-now><span class="settings-row-copy"><strong>Back Up Messages Now</strong><small data-nc-backup-status>Checking last backup…</small></span></button>
      <button class="settings-list-row" type="button" data-nc-restore><span class="settings-row-copy"><strong>Restore from Backup</strong><small>Merges ${deps.escapeHtml(BACKUP_FILENAME)} back into this device's chat history, whichever device wrote it.</small></span></button>
      <p class="field-hint">One backup, shared across your devices: iPhone, Android and desktop all read and write <strong>${deps.escapeHtml(BACKUP_FILENAME)}</strong> in this folder, in the same format. Every backup merges with what is already there, so no device can erase another's history.</p>
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
    </div>`;
  document.body.appendChild(modalsEl);

  modalsEl.addEventListener("click", (event) => {
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
    if (event.key === "Escape" && pickerOpen) closePicker();
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
      saveState();
      armAutoBackup();
      renderSettings();
      return;
    }
    if (event.target.closest("[data-nc-pick-start]")) { openPicker("folder-start"); return; }
    if (event.target.closest("[data-nc-pick-backup]")) { openPicker("folder-backup"); return; }
    if (event.target.closest("[data-nc-backup-now]")) {
      const status = settingsEl.querySelector("[data-nc-backup-status]");
      if (status) status.textContent = "Backing up…";
      try {
        await runBackup();
        nc.lastAutoBackup = Date.now();
        saveState();
        deps.showToast?.("Backup uploaded — merged with what your other devices had already backed up.");
      } catch (error) {
        deps.showToast?.(corsHint(error));
      }
      refreshBackupStatusLine();
      return;
    }
    if (event.target.closest("[data-nc-restore]")) {
      if (!window.confirm("Restore from the backup in that folder? Chat history from every device merges into this one; any desktop settings stored in the backup replace this device's.")) return;
      try {
        // Primary: the shared cross-device archive. A pre-4.0 desktop-only file
        // may still be sitting next to it — read as a fallback for the desktop
        // half. A missing file (404) is fine as long as one of them exists.
        const sharedJson = await downloadBackupFile(BACKUP_FILENAME);
        const legacyJson = await downloadBackupFile(LEGACY_DESKTOP_BACKUP_FILENAME);
        if (!sharedJson && !legacyJson) throw new Error("No KaChat backup was found in that folder.");

        // Desktop state first (it REPLACES local state), then the archive merge
        // — that ordering is what stops the replace from wiping the freshly
        // merged history. A shared file written by a phone has no desktopState,
        // in which case the legacy desktop file (if any) supplies it.
        let desktopRestored = sharedJson ? deps.importDesktopState?.(sharedJson) === true : false;
        if (!desktopRestored && legacyJson) {
          deps.importBackupPayload(legacyJson);
          desktopRestored = true;
        }
        const summary = sharedJson ? deps.importPhoneArchive?.(sharedJson) : null;
        if (summary) {
          const merged = `Merged ${summary.messages} message${summary.messages === 1 ? "" : "s"} from ${summary.conversations} chat${summary.conversations === 1 ? "" : "s"}.`;
          deps.showToast?.(desktopRestored ? `Backup restored. ${merged}` : merged);
        } else {
          deps.showToast?.("Backup restored.");
        }
      } catch (error) {
        deps.showToast?.(corsHint(error));
      }
      return;
    }
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

  // Tab-hide is the desktop "leaving" moment — mirror iOS's on-background backup.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") autoBackupIfDue();
  });

  renderSettings();
  armAutoBackup();
}
