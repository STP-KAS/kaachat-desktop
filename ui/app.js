import { KaspaEngine } from "../engine/index.js";
import { initKaPosts, refreshKaPostsFeed, resetKaPostsForAccount } from "./kaposts.js";
import { initBroadcasts, refreshBroadcasts, resetBroadcastsForAccount, stopBroadcastPolling } from "./broadcasts.js";
import { initPortfolio, refreshPortfolio, resetPortfolioForAccount } from "./portfolio.js";
import { initColdStorage, refreshColdStorage, resetColdStorageForAccount } from "./coldstorage.js";
import { initNextcloud, resetNextcloudForAccount, isNextcloudMediaSendActive, uploadNextcloudMedia } from "./nextcloud.js";
import { initSwaps, refreshSwaps, resetSwapsForAccount } from "./swaps.js";
import {
  initChatStorage,
  setChatStorageFlushErrorHandler,
  chatStorageGetSync,
  chatStorageSetSync,
  chatStorageRemoveSync,
  flushChatStorage,
} from "./storage.js";
import {
  MESSAGE_STATUSES,
  createConversation,
  createMessage,
  normalizeMessage as normalizeEngineMessage,
  applyMessagePatch,
  addMessageToConversation,
  lastMessage as engineLastMessage,
  statusLabel as engineStatusLabel,
} from "../engine/conversations.js";
import { KNSProfileLinkBuilder } from "../engine/kns.js";
import { getEndpoint, getEndpointOverride, setEndpoint, resetEndpoints, ENDPOINT_DEFAULTS } from "../engine/endpoints.js";
import * as Chess from "../engine/chess.js";
import { registrationAmounts as knsRegistrationAmounts, PROFILE_FIELD_EDIT_ORDER as KNS_PROFILE_FIELD_EDIT_ORDER } from "../engine/kns-write.js";

// Step 25 shell:
// - Keeps KaspaEngine modules intact.
// - Keeps UI behavior visually close to Step 10.
// - Refactors local chat state into Contacts + Conversations so future Kasia/Kaspa wiring
//   can attach txid, DAA score, status, unread state, and conversation metadata cleanly.
// - Messages still do not touch Kaspa/Kasia networking yet.

window.KaspaEngineClass = KaspaEngine;
window.__kaspaEngineStep = "kachat-shell-step-71";

const engine = new KaspaEngine({ log: appendEngineLog });
engine.onConnectionState?.(() => {
  updateServiceSummary();
});
engine.onSubscriptionState?.(() => {
  updateServiceSummary();
});
engine.onWalletActivity?.((event) => {
  if (walletActivityRefreshTimer) window.clearTimeout(walletActivityRefreshTimer);
  walletActivityRefreshTimer = window.setTimeout(async () => {
    appendEngineLog(`Live wallet activity: ${event?.type || "UTXO change"}`);
    await refreshBalanceOnly({ quiet: true });
    await refreshAllConversations({ quiet: true });
  }, 250);
});
const STORAGE_KEY = "kachat-shell-step25-state";
const MESSAGE_HISTORY_KEY = "kachat-shell-message-history-v1";
const STATE_BACKUP_KEY = "kachat-shell-state-backup-v1";
const ACCOUNT_DATA_PREFIX = "kachat-account-data-v1";
const SESSION_LOGGED_OUT_KEY = "kachat-session-logged-out-v1";
// Marks that an account is active for THIS browser session (sessionStorage:
// survives reload, cleared when the tab/window closes). Lets "Keep me signed in"
// off still allow a manual sign-in to survive its own reload, while a fresh
// launch lands on the sign-in screen.
const SESSION_ACTIVE_KEY = "kachat-session-active-v1";
function markSessionActive() { try { sessionStorage.setItem(SESSION_ACTIVE_KEY, "1"); } catch {} }
function clearSessionActive() { try { sessionStorage.removeItem(SESSION_ACTIVE_KEY); } catch {} }
function isSessionActive() { try { return sessionStorage.getItem(SESSION_ACTIVE_KEY) === "1"; } catch { return false; } }

// Per-contact preferences (Chat Info): incoming-notification and photo-display
// overrides, keyed by contact address. { [address]: { notify, photos } }.
const CONTACT_PREFS_KEY = "kachat-contact-prefs-v1";
let contactPrefs = (() => { try { return JSON.parse(localStorage.getItem(CONTACT_PREFS_KEY) || "{}") || {}; } catch { return {}; } })();
function saveContactPrefs() { localStorage.setItem(CONTACT_PREFS_KEY, JSON.stringify(contactPrefs)); }
function getContactNotify(address) { return contactPrefs[address]?.notify || "enabled"; } // "enabled" | "muted"
function getContactPhotos(address) { return contactPrefs[address]?.photos || "auto"; }     // "auto" | "manual"
function setContactPref(address, key, value) {
  if (!address) return;
  contactPrefs[address] = { ...(contactPrefs[address] || {}), [key]: value };
  saveContactPrefs();
}
// Photos revealed this session when a contact's Photo Display is "manual".
const revealedPhotoIds = new Set();
const BALANCE_REFRESH_MS = 15000;
const MESSAGE_REFRESH_MS = 5000;
const INDEXER_URL_KEY = "kachat-shell-step27-indexer-url";
const PERSISTED_WALLET_KEY = "kachat-shell-testing-wallet-v2";
const LEGACY_PERSISTED_WALLET_KEY = "kachat-shell-testing-wallet-private-key";
const HANDSHAKE_SYNC_KEY = "kachat-shell-handshake-sync-v1";
const LEGACY_STORAGE_KEYS = [
  "kachat-shell-step24-state",
  "kachat-shell-step23-state",
  "kachat-shell-step22-state",
  "kachat-shell-step21-state",
  "kachat-shell-step20-state",
  "kachat-shell-step19-state",
  "kachat-shell-step18-state",
  "kachat-shell-step17-state",
  "kachat-shell-step16-state",
  "kachat-shell-step15-state",
  "kachat-shell-step14-state",
  "kachat-shell-step13-state",
  "kachat-shell-step12-state",
  "kachat-shell-step11-state",
  "kachat-shell-step10-conversations",
  "kachat-shell-step9-conversations",
  "kachat-shell-step7-contacts",
];

function accountScopedKey(baseKey, address = engine.address) {
  const clean = String(address || "").trim();
  return clean ? `${ACCOUNT_DATA_PREFIX}:${clean}:${baseKey}` : baseKey;
}

// ---------------------------------------------------------------------------
// Chat state persists in IndexedDB (ui/storage.js): localStorage's ~5MB quota
// cannot hold a large phone-backup import, IndexedDB's device-proportional
// quota can. The top-level await below warms storage.js's synchronous cache
// BEFORE any state read in this module — including the first render at the
// bottom of the file — so every existing restore path (loadStoredState,
// buildFullyRestoredState, reloadStateFromBrowserStorage, account switches via
// activateWalletDataScope, backup imports) stays synchronous and reads the
// already-loaded data. On the first run after this update, chat-state keys
// still in localStorage (all accounts) are migrated into IndexedDB and deleted
// from localStorage, freeing the quota; every OTHER localStorage key
// (settings, dock prefs, caches, nextcloud, portfolio…) stays where it is.
// If IndexedDB is unavailable (e.g. private browsing), storage.js passes
// through to localStorage and the legacy quota-aware persistState() fallback
// below still applies.
// ---------------------------------------------------------------------------
const CHAT_STORAGE_BASE_KEYS = [STORAGE_KEY, STATE_BACKUP_KEY, MESSAGE_HISTORY_KEY];
function isChatStorageKey(key) {
  return CHAT_STORAGE_BASE_KEYS.some(
    (base) => key === base || (key.startsWith(`${ACCOUNT_DATA_PREFIX}:`) && key.endsWith(`:${base}`)),
  );
}
await initChatStorage({
  shouldMigrateKey: isChatStorageKey,
  log: (line) => { try { appendEngineLog(line); } catch { console.log(line); } },
});
setChatStorageFlushErrorHandler((error) => {
  try { handleChatStorageFlushError(error); } catch (fallbackError) { console.error(fallbackError); }
});

let state = loadStoredState();

function subscriptionContactAddresses() {
  return [...new Set((state.contacts || [])
    .map((contact) => String(contact?.address || "").trim())
    .filter((address) => address.startsWith("kaspa:") && address !== engine.address))];
}

function refreshSubscriptionAddresses({ restart = true } = {}) {
  return engine.setSubscriptionAddresses?.(subscriptionContactAddresses(), { restart });
}

refreshSubscriptionAddresses({ restart: false });

function loadHandshakeSyncState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HANDSHAKE_SYNC_KEY) || "{}");
    const parserVersion = Number(parsed?.parserVersion || 0);
    return {
      walletAddress: String(parsed?.walletAddress || ""),
      cursor: parserVersion >= 3 ? Number(parsed?.cursor || 0) : 0,
      parserVersion: 3,
      processedTxids: parserVersion >= 3 && Array.isArray(parsed?.processedTxids) ? [...new Set(parsed.processedTxids.map(String))] : [],
      declinedTxids: parserVersion >= 3 && Array.isArray(parsed?.declinedTxids) ? [...new Set(parsed.declinedTxids.map(String))] : [],
    };
  } catch {
    return { walletAddress: "", cursor: 0, parserVersion: 3, processedTxids: [], declinedTxids: [] };
  }
}

let handshakeSyncState = loadHandshakeSyncState();

function persistHandshakeSyncState() {
  localStorage.setItem(HANDSHAKE_SYNC_KEY, JSON.stringify(handshakeSyncState));
}

let activeConversationId = null;
let currentBalanceKas = "--";
let composerMode = "message";
let availableBalanceHideTimer = null;
let paymentSendInFlight = false;
let handshakeSendInFlight = false;
// All messages are now real on-chain Kaspa transactions, unconditionally —
// there is no preview/simulation mode reachable from the UI anymore. This
// used to be a user-facing Settings toggle defaulting to "preview", which
// meant messages never actually reached the network (and thus never showed
// up on a peer's iOS/Android app) unless the toggle was found and flipped.
const transportMode = "onchain";
let pendingOnchainDraft = null;
let balanceRefreshTimer = null;
let messageRefreshTimer = null;
let balanceRefreshInFlight = false;
let messageRefreshInFlight = false;
let walletActivityRefreshTimer = null;
let activeMessageActionId = null;
let messageSelectionMode = false;
const selectedMessageIds = new Set();
const ACCOUNT_SHELL_PREFS_KEY = "kachat-account-shell-preferences-v1";
const ACCOUNT_SHELL_META_KEY = "kachat-account-shell-metadata-v1";
const SAVED_ACCOUNTS_KEY = "kachat-saved-accounts-v1";
const ACTIVE_ACCOUNT_KEY = "kachat-active-account-v1";
let accountShellPrefs = loadAccountShellPreferences();
const loggedOutScreen = document.querySelector("[data-logged-out-screen]");
const mainAppShell = document.querySelector("#app");
const savedAccountList = document.querySelector("[data-saved-account-list]");

function loadAccountShellPreferences() {
  try { return JSON.parse(localStorage.getItem(ACCOUNT_SHELL_PREFS_KEY) || "{}"); }
  catch { return {}; }
}

function persistAccountShellPreferences() {
  localStorage.setItem(ACCOUNT_SHELL_PREFS_KEY, JSON.stringify(accountShellPrefs));
}

// --- App password (replaces the mockup "biometrics" toggles). A single password
// is stored as a salted SHA-256 hash, never in plaintext. It gates revealing the
// seed phrase / private key and signing in, when the matching toggle is on. ---
const APP_PASSWORD_KEY = "kachat-app-password-v1";
function loadStoredPassword() {
  try { return JSON.parse(localStorage.getItem(APP_PASSWORD_KEY) || "null"); } catch { return null; }
}
function hasAppPassword() {
  const stored = loadStoredPassword();
  return !!(stored && stored.hash && stored.salt);
}
async function hashPassword(password, saltHex) {
  const data = new TextEncoder().encode(`${saltHex}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function setAppPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = [...saltBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await hashPassword(password, salt);
  localStorage.setItem(APP_PASSWORD_KEY, JSON.stringify({ salt, hash }));
}
async function verifyAppPassword(password) {
  const stored = loadStoredPassword();
  if (!stored) return false;
  return (await hashPassword(password, stored.salt)) === stored.hash;
}

// Promise-based password prompt. mode "verify" asks for the password; mode "set"
// asks for a new password + confirmation. Resolves true on success, false if
// cancelled / dismissed.
const passwordModal = document.querySelector("[data-password-modal]");
const passwordForm = document.querySelector("[data-password-form]");
const passwordInput = document.querySelector("[data-password-input]");
const passwordConfirmInput = document.querySelector("[data-password-confirm]");
const passwordConfirmLabel = document.querySelector("[data-password-confirm-label]");
const passwordTitleEl = document.querySelector("[data-password-title]");
const passwordMessageEl = document.querySelector("[data-password-message]");
const passwordErrorEl = document.querySelector("[data-password-error]");
let passwordResolver = null;
let passwordMode = "verify";

function showPasswordError(message) {
  if (passwordErrorEl) { passwordErrorEl.textContent = message; passwordErrorEl.hidden = false; }
}
function closePasswordModal(result) {
  if (passwordModal) passwordModal.hidden = true;
  if (passwordInput) passwordInput.value = "";
  if (passwordConfirmInput) passwordConfirmInput.value = "";
  const resolve = passwordResolver;
  passwordResolver = null;
  if (resolve) resolve(result);
}
function requestPassword({ mode = "verify", title, message } = {}) {
  return new Promise((resolve) => {
    if (passwordResolver) { const prev = passwordResolver; passwordResolver = null; prev(false); }
    passwordMode = mode;
    passwordResolver = resolve;
    if (passwordTitleEl) passwordTitleEl.textContent = title || (mode === "set" ? "Set Password" : "Enter Password");
    if (passwordMessageEl) { passwordMessageEl.textContent = message || ""; passwordMessageEl.hidden = !message; }
    if (passwordConfirmLabel) passwordConfirmLabel.hidden = mode !== "set";
    if (passwordErrorEl) passwordErrorEl.hidden = true;
    if (passwordInput) passwordInput.value = "";
    if (passwordConfirmInput) passwordConfirmInput.value = "";
    if (passwordModal) passwordModal.hidden = false;
    queueMicrotask(() => passwordInput?.focus());
  });
}
passwordForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pw = String(passwordInput?.value || "");
  if (passwordErrorEl) passwordErrorEl.hidden = true;
  if (passwordMode === "set") {
    if (pw.length < 4) { showPasswordError("Use at least 4 characters."); return; }
    if (pw !== String(passwordConfirmInput?.value || "")) { showPasswordError("Passwords do not match."); return; }
    await setAppPassword(pw);
    closePasswordModal(true);
  } else {
    if (!(await verifyAppPassword(pw))) { showPasswordError("Incorrect password."); return; }
    closePasswordModal(true);
  }
});
document.querySelectorAll("[data-password-cancel]").forEach((b) => b.addEventListener("click", () => closePasswordModal(false)));
passwordModal?.addEventListener("click", (event) => { if (event.target === passwordModal) closePasswordModal(false); });

// Ensures a password exists (prompting to create one if not). Returns true if a
// password is available afterward.
async function ensureAppPassword(message) {
  if (hasAppPassword()) return true;
  return requestPassword({ mode: "set", title: "Set Password", message: message || "Create a password to protect this." });
}

const passwordStatusEl = document.querySelector("[data-password-status]");
function refreshPasswordStatus() {
  if (passwordStatusEl) passwordStatusEl.textContent = hasAppPassword() ? "Password set" : "No password set";
}
function initSecurityToggle(toggle, key) {
  if (!toggle) return;
  toggle.checked = !!accountShellPrefs[key];
  toggle.addEventListener("change", async () => {
    if (toggle.checked) {
      if (!(await ensureAppPassword())) { toggle.checked = false; return; }
      accountShellPrefs[key] = true;
    } else {
      // Require the password to turn a protection off, so it can't be trivially bypassed.
      if (hasAppPassword() && !(await requestPassword({ mode: "verify", title: "Confirm Password", message: "Enter your password to turn this off." }))) {
        toggle.checked = true;
        return;
      }
      accountShellPrefs[key] = false;
    }
    persistAccountShellPreferences();
    refreshPasswordStatus();
  });
}
initSecurityToggle(document.querySelector("[data-pref-password-seed]"), "passwordForSeed");
initSecurityToggle(document.querySelector("[data-pref-password-login]"), "passwordForLogin");
refreshPasswordStatus();
document.querySelector("[data-change-password]")?.addEventListener("click", async () => {
  if (hasAppPassword() && !(await requestPassword({ mode: "verify", title: "Current Password", message: "Enter your current password." }))) return;
  if (await requestPassword({ mode: "set", title: "New Password", message: "Create a new password." })) {
    showCopyToast("Password updated");
    refreshPasswordStatus();
  }
});

// Block explorer used for "view transaction / address" links, matching the URL
// schemes in iOS's KaspaExplorer enum and Android's KaspaExplorer.kt. The user
// picks one in Settings > Kaspa Explorer; the choice persists in shell prefs.
const KASPA_EXPLORERS = {
  kaspaStream: { displayName: "kaspa.stream", tx: "https://kaspa.stream/transactions/", address: "https://kaspa.stream/addresses/" },
  kaspaOrg: { displayName: "explorer.kaspa.org", tx: "https://explorer.kaspa.org/txs/", address: "https://explorer.kaspa.org/addresses/" },
};
const DEFAULT_KASPA_EXPLORER = "kaspaOrg";

function currentExplorer() {
  return KASPA_EXPLORERS[accountShellPrefs.explorer] || KASPA_EXPLORERS[DEFAULT_KASPA_EXPLORER];
}
function explorerTxUrl(txid) { return currentExplorer().tx + txid; }
function explorerAddressUrl(address) { return currentExplorer().address + address; }

function activeAccountMetadata() {
  const address = String(engine.address || "");
  if (!address) return { name: "No Active Account", createdAt: null };
  let all = {};
  try { all = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  if (!all[address]) {
    all[address] = { name: `Account ${address.slice(-6)}`, createdAt: Date.now() };
    localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(all));
  }
  return all[address];
}

function loadSavedAccounts() {
  let accounts = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_ACCOUNTS_KEY) || "[]");
    if (Array.isArray(parsed)) accounts = parsed;
  } catch {}

  // Migrate the pre-Step-70 single saved wallet into the account registry.
  try {
    const raw = localStorage.getItem(PERSISTED_WALLET_KEY);
    const wallet = raw ? JSON.parse(raw) : null;
    const address = String(wallet?.address || "").trim();
    const privateKeyHex = String(wallet?.privateKeyHex || "").trim();
    if (address && privateKeyHex && !accounts.some((entry) => entry.address === address)) {
      let metadata = {};
      try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
      const meta = metadata[address] || {};
      accounts.push({
        version: 1,
        address,
        privateKeyHex,
        mnemonic: String(wallet?.mnemonic || ""),
        passphrase: String(wallet?.passphrase || ""),
        derivationPath: String(wallet?.derivationPath || ""),
        wordCount: Number(wallet?.wordCount || 0),
        name: meta.name || `Account ${address.slice(-6)}`,
        createdAt: meta.createdAt || wallet.savedAt || new Date().toISOString(),
        savedAt: wallet.savedAt || new Date().toISOString(),
      });
      localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(accounts));
      if (!localStorage.getItem(ACTIVE_ACCOUNT_KEY)) localStorage.setItem(ACTIVE_ACCOUNT_KEY, address);
    }
  } catch (error) {
    appendEngineLog?.(`Saved-account migration failed: ${error.message}`);
  }
  return accounts;
}

function persistSavedAccounts(accounts) {
  localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(accounts));
}

function upsertSavedAccount({ address, privateKeyHex, mnemonic = "", passphrase = "", derivationPath = "", wordCount = 0, name, createdAt, savedAt = new Date().toISOString() }) {
  const cleanAddress = String(address || "").trim();
  const cleanKey = String(privateKeyHex || "").trim();
  if (!cleanAddress || !cleanKey) throw new Error("Account address or private key is missing.");
  const accounts = loadSavedAccounts();
  const index = accounts.findIndex((entry) => entry.address === cleanAddress);
  const existing = index >= 0 ? accounts[index] : null;
  const record = {
    version: 1,
    address: cleanAddress,
    privateKeyHex: cleanKey,
    mnemonic: String(mnemonic || existing?.mnemonic || ""),
    // BIP39 passphrase ("25th word"). Needed to re-derive spending addresses that
    // match iOS/Android. Persisted alongside the (already-plaintext) mnemonic; iOS
    // stores both together too (Secure-Enclave-wrapped). "" means no passphrase.
    passphrase: String(passphrase || existing?.passphrase || ""),
    derivationPath: String(derivationPath || existing?.derivationPath || ""),
    wordCount: Number(wordCount || existing?.wordCount || 0),
    name: String(name || existing?.name || `Account ${cleanAddress.slice(-6)}`),
    createdAt: createdAt || existing?.createdAt || new Date().toISOString(),
    savedAt,
  };
  if (index >= 0) accounts[index] = record;
  else accounts.push(record);
  persistSavedAccounts(accounts);
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, cleanAddress);
  return record;
}

function savedAccountSummaries() {
  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  return loadSavedAccounts().map((entry) => ({
    ...entry,
    name: metadata[entry.address]?.name || entry.name || `Account ${entry.address.slice(-6)}`,
    createdAt: metadata[entry.address]?.createdAt || entry.createdAt || entry.savedAt || null,
  }));
}

function activateSavedAccount(address) {
  const account = loadSavedAccounts().find((entry) => entry.address === address);
  if (!account) throw new Error("Saved account was not found.");
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.address);
  localStorage.setItem(PERSISTED_WALLET_KEY, JSON.stringify({
    version: 2,
    privateKeyHex: account.privateKeyHex,
    mnemonic: String(account.mnemonic || ""),
    passphrase: String(account.passphrase || ""),
    derivationPath: String(account.derivationPath || ""),
    wordCount: Number(account.wordCount || 0),
    address: account.address,
    savedAt: account.savedAt || new Date().toISOString(),
  }));
  localStorage.removeItem(SESSION_LOGGED_OUT_KEY);
  markSessionActive(); // survives the sign-in reload even if "Keep me signed in" is off
}

let pendingSavedAccountRemoval = null;

function renderSavedAccountsScreen() {
  if (!savedAccountList) return;
  savedAccountList.replaceChildren();
  const accounts = savedAccountSummaries();
  if (!accounts.length) {
    const empty = document.createElement("div");
    empty.className = "saved-account-empty";
    empty.textContent = "Create or import an account to continue.";
    savedAccountList.append(empty);
    return;
  }
  for (const account of accounts) {
    const row = document.createElement("div");
    row.className = "saved-account-card";
    row.dataset.savedAccountAddress = account.address;

    const signInButton = document.createElement("button");
    signInButton.type = "button";
    signInButton.className = "saved-account-signin";
    signInButton.setAttribute("aria-label", `Sign in to ${account.name}`);
    signInButton.innerHTML = `<span class="saved-account-icon" aria-hidden="true">✓</span><span class="saved-account-copy"><strong></strong><small></small></span><span class="saved-account-chevron" aria-hidden="true">›</span>`;
    signInButton.querySelector("strong").textContent = account.name;
    signInButton.querySelector("small").textContent = shortAddress(account.address);
    signInButton.addEventListener("click", async () => {
      try {
        if (accountShellPrefs.passwordForLogin && hasAppPassword()) {
          const ok = await requestPassword({ mode: "verify", title: "Enter Password", message: "Enter your password to sign in." });
          if (!ok) return;
        }
        activateSavedAccount(account.address);
        location.reload();
      } catch (error) {
        showCopyToast(error.message);
      }
    });

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "saved-account-edit";
    editButton.setAttribute("aria-label", `Edit ${account.name}`);
    editButton.setAttribute("aria-haspopup", "menu");
    editButton.setAttribute("aria-expanded", "false");
    editButton.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
    editButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleAccountActionMenu(editButton, account);
    });

    row.append(signInButton, editButton);
    savedAccountList.append(row);
  }
}

const accountActionMenu = document.querySelector("[data-account-action-menu]");
let accountActionMenuTarget = null;

function closeAccountActionMenu() {
  if (!accountActionMenu || accountActionMenu.hidden) return;
  accountActionMenu.hidden = true;
  accountActionMenuTarget?.button?.setAttribute("aria-expanded", "false");
  accountActionMenuTarget = null;
}

function toggleAccountActionMenu(button, account) {
  if (!accountActionMenu) return;
  const reopeningSame = accountActionMenuTarget?.button === button;
  closeAccountActionMenu();
  if (reopeningSame) return;

  const rect = button.getBoundingClientRect();
  const menuWidth = accountActionMenu.offsetWidth || 168;
  const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
  accountActionMenu.style.top = `${rect.bottom + 6}px`;
  accountActionMenu.style.left = `${left}px`;
  accountActionMenu.hidden = false;
  button.setAttribute("aria-expanded", "true");
  accountActionMenuTarget = { button, account };
}

accountActionMenu?.addEventListener("click", (event) => {
  event.stopPropagation();
  const actionButton = event.target.closest("[data-menu-action]");
  if (!actionButton || !accountActionMenuTarget) return;
  const { account } = accountActionMenuTarget;
  const action = actionButton.dataset.menuAction;
  closeAccountActionMenu();
  if (action === "rename") openSavedAccountRename(account);
  else if (action === "delete") openSavedAccountDelete(account);
});

document.addEventListener("click", () => closeAccountActionMenu());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAccountActionMenu();
});
window.addEventListener("resize", () => closeAccountActionMenu());
window.addEventListener("scroll", () => closeAccountActionMenu(), true);

function showLoggedOutScreen() {
  if (mainAppShell) mainAppShell.hidden = true;
  if (loggedOutScreen) loggedOutScreen.hidden = false;
  document.body.classList.add("session-logged-out");
  try {
    renderSavedAccountsScreen();
  } catch (error) {
    console.error("Saved-account screen render failed", error);
    if (savedAccountList) {
      savedAccountList.replaceChildren();
      const fallback = document.createElement("div");
      fallback.className = "saved-account-empty";
      fallback.textContent = "Saved accounts could not be displayed. Refresh and try again.";
      savedAccountList.append(fallback);
    }
  }
}

function hideLoggedOutScreen() {
  if (loggedOutScreen) loggedOutScreen.hidden = true;
  if (mainAppShell) mainAppShell.hidden = false;
  document.body.classList.remove("session-logged-out");
}

const accountDeleteModal = document.querySelector("[data-account-delete-modal]");
const accountDeleteCopy = document.querySelector("[data-account-delete-copy]");

function openSavedAccountDelete(account) {
  pendingSavedAccountRemoval = account;
  if (accountDeleteCopy) {
    accountDeleteCopy.textContent = `This removes ${account.name} (${shortAddress(account.address)}) and its local data from this device. Make sure you have backed up the private key or recovery phrase.`;
  }
  if (accountDeleteModal) accountDeleteModal.hidden = false;
}

function closeSavedAccountDelete() {
  pendingSavedAccountRemoval = null;
  if (accountDeleteModal) accountDeleteModal.hidden = true;
}

function removeAccountScopedLocalData(address) {
  const cleanAddress = String(address || "").trim();
  if (!cleanAddress) return;
  const prefix = `${ACCOUNT_DATA_PREFIX}:${cleanAddress}:`;
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) localStorage.removeItem(key);
  }

  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  delete metadata[cleanAddress];
  if (Object.keys(metadata).length) localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(metadata));
  else localStorage.removeItem(ACCOUNT_SHELL_META_KEY);

  try {
    const persisted = JSON.parse(localStorage.getItem(PERSISTED_WALLET_KEY) || "null");
    if (persisted?.address === cleanAddress) localStorage.removeItem(PERSISTED_WALLET_KEY);
  } catch {}

  try {
    const handshakeState = JSON.parse(localStorage.getItem(HANDSHAKE_SYNC_KEY) || "null");
    if (handshakeState?.walletAddress === cleanAddress) localStorage.removeItem(HANDSHAKE_SYNC_KEY);
  } catch {}

  if (localStorage.getItem(ACTIVE_ACCOUNT_KEY) === cleanAddress) {
    localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
  }
}

function removeSavedAccountFromDevice(account) {
  const address = String(account?.address || "").trim();
  if (!address) throw new Error("Saved account address is missing.");
  const remaining = loadSavedAccounts().filter((entry) => entry.address !== address);
  persistSavedAccounts(remaining);
  removeAccountScopedLocalData(address);
  renderSavedAccountsScreen();
  showCopyToast("Saved account removed");
}

document.querySelector("[data-confirm-account-delete]")?.addEventListener("click", () => {
  const account = pendingSavedAccountRemoval;
  if (!account) return closeSavedAccountDelete();
  try {
    removeSavedAccountFromDevice(account);
    closeSavedAccountDelete();
  } catch (error) {
    appendEngineLog(`Saved-account removal failed: ${error.message}`);
    showCopyToast(error.message);
  }
});

document.querySelector("[data-cancel-account-delete]")?.addEventListener("click", closeSavedAccountDelete);
accountDeleteModal?.addEventListener("click", (event) => {
  if (event.target === accountDeleteModal) closeSavedAccountDelete();
});

let pendingSavedAccountRename = null;
const accountRenameModal = document.querySelector("[data-account-rename-modal]");
const accountRenameForm = document.querySelector("[data-account-rename-form]");
const accountRenameError = document.querySelector("[data-account-rename-error]");

function openSavedAccountRename(account) {
  pendingSavedAccountRename = account;
  if (accountRenameError) { accountRenameError.hidden = true; accountRenameError.textContent = ""; }
  if (accountRenameForm?.elements?.accountName) {
    accountRenameForm.elements.accountName.value = account.name;
  }
  if (accountRenameModal) accountRenameModal.hidden = false;
  queueMicrotask(() => accountRenameForm?.elements?.accountName?.select());
}

function closeSavedAccountRename() {
  pendingSavedAccountRename = null;
  if (accountRenameModal) accountRenameModal.hidden = true;
}

function renameSavedAccount(address, newName) {
  const cleanAddress = String(address || "").trim();
  const cleanName = String(newName || "").trim();
  if (!cleanAddress) throw new Error("Saved account address is missing.");
  if (!cleanName) throw new Error("Enter an account name.");

  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  metadata[cleanAddress] = { ...(metadata[cleanAddress] || {}), name: cleanName };
  localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(metadata));

  const accounts = loadSavedAccounts();
  const index = accounts.findIndex((entry) => entry.address === cleanAddress);
  if (index >= 0) {
    accounts[index] = { ...accounts[index], name: cleanName };
    persistSavedAccounts(accounts);
  }

  if (engine.address === cleanAddress) updateWalletUi();
}

accountRenameForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const account = pendingSavedAccountRename;
  if (!account) return closeSavedAccountRename();
  const name = String(accountRenameForm.elements.accountName?.value || "").trim();
  if (!name) {
    if (accountRenameError) { accountRenameError.textContent = "Enter an account name."; accountRenameError.hidden = false; }
    return;
  }
  try {
    renameSavedAccount(account.address, name);
    closeSavedAccountRename();
    renderSavedAccountsScreen();
    showCopyToast("Account name saved");
  } catch (error) {
    if (accountRenameError) { accountRenameError.textContent = error.message; accountRenameError.hidden = false; }
  }
});

document.querySelector("[data-close-account-rename]")?.addEventListener("click", closeSavedAccountRename);
accountRenameModal?.addEventListener("click", (event) => {
  if (event.target === accountRenameModal) closeSavedAccountRename();
});

// --- Rename UTXO modal (Manage Address > UTXOs). Blank name clears the label. ---
let pendingUtxoRename = null;
const utxoRenameModal = document.querySelector("[data-utxo-rename-modal]");
const utxoRenameForm = document.querySelector("[data-utxo-rename-form]");
const utxoRenameOutpoint = document.querySelector("[data-utxo-rename-outpoint]");

function openUtxoRename(address, outpointKey, currentLabel) {
  pendingUtxoRename = { address, outpointKey };
  if (utxoRenameForm?.elements?.utxoName) utxoRenameForm.elements.utxoName.value = currentLabel || "";
  if (utxoRenameOutpoint) utxoRenameOutpoint.textContent = outpointKey;
  if (utxoRenameModal) utxoRenameModal.hidden = false;
  queueMicrotask(() => utxoRenameForm?.elements?.utxoName?.select());
}
function closeUtxoRename() {
  pendingUtxoRename = null;
  if (utxoRenameModal) utxoRenameModal.hidden = true;
}
utxoRenameForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const pending = pendingUtxoRename;
  if (!pending) return closeUtxoRename();
  const name = String(utxoRenameForm.elements.utxoName?.value || "").trim();
  setUtxoLabel(pending.address, pending.outpointKey, name);
  closeUtxoRename();
  renderManageAddressUtxos();
  showCopyToast(name ? "UTXO name saved" : "UTXO name removed");
});
document.querySelectorAll("[data-close-utxo-rename]").forEach((el) => el.addEventListener("click", closeUtxoRename));
utxoRenameModal?.addEventListener("click", (event) => {
  if (event.target === utxoRenameModal) closeUtxoRename();
});

const searchWrap = document.querySelector("[data-search-wrap]");
const serviceHealthButton = document.querySelector("[data-service-health-button]");
const serviceHealthLed = document.querySelector("[data-service-health-led]");
let latestServiceStatusText = "Starting services";
const toolbarBalance = document.querySelector("[data-toolbar-balance]");
const toolbarBalanceValue = document.querySelector("[data-toolbar-balance-value]");
const profileAddress = document.querySelector("[data-profile-address]");
const profileBalance = document.querySelector("[data-profile-balance]");
const profileInitial = document.querySelector("[data-profile-initial]");
const profileKnsEmptyCta = document.querySelector("[data-profile-kns-empty-cta]");
const profileKnsOwned = document.querySelector("[data-profile-kns-owned]");
const profileKnsDomain = document.querySelector("[data-profile-kns-domain]");
const profileKnsBio = document.querySelector("[data-profile-kns-bio]");
const profileKnsLinks = document.querySelector("[data-profile-kns-links]");
const profileQr = document.querySelector("[data-profile-qr]");
const profileQrCard = document.querySelector("[data-profile-qr-card]");
const profileQrOverlay = document.querySelector("[data-profile-qr-overlay]");
const photoPreviewOverlay = document.querySelector("[data-photo-preview-overlay]");
const photoPreviewImage = document.querySelector("[data-photo-preview-image]");

function openPhotoPreview(dataUrl) {
  if (!photoPreviewOverlay || !photoPreviewImage) return;
  photoPreviewImage.src = dataUrl;
  photoPreviewOverlay.hidden = false;
}

photoPreviewOverlay?.addEventListener("click", () => { photoPreviewOverlay.hidden = true; });

// --- Message link previews (docs/NEXTCLOUD_MEDIA_PREVIEW.md) -----------------
// Linkifies URLs in message text and, for previewable links, appends a media
// card. Nextcloud public shares are privacy-gated: nothing is fetched from the
// sender's server until the recipient taps "view" (the share URL alone doesn't
// say image vs video, so the tap runs a progressive probe — try <video>, fall
// back to <img>, else an "Open in Nextcloud" link).

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"']+/g;

/** `https://host/s/TOKEN` (or `/index.php/s/TOKEN`) -> its raw-file endpoints, else null. */
function nextcloudShareDownloadUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^(\/index\.php)?\/s\/([A-Za-z0-9_-]{10,})\/?$/);
    if (!match) return null;
    const base = `${parsed.origin}${match[1] || ""}/s/${match[2]}`;
    return { downloadUrl: `${base}/download`, previewUrl: `${base}/preview` };
  } catch { return null; }
}

function isDirectImageUrl(url) {
  return /\.(png|jpe?g|gif|webp|avif)(\?[^#]*)?$/i.test(url);
}

function isPreviewableUrl(url) {
  return isDirectImageUrl(url) || Boolean(nextcloudShareDownloadUrl(url));
}

/** Renders `text` into `container` with URLs as clickable links; returns the URLs found. */
function renderTextWithLinks(container, text) {
  const source = String(text ?? "");
  const urls = [];
  let last = 0;
  for (const match of source.matchAll(URL_IN_TEXT_RE)) {
    let url = match[0];
    const trailing = url.match(/[),.;:!?\]]+$/); // sentence punctuation isn't part of the URL
    if (trailing) url = url.slice(0, -trailing[0].length);
    if (!url) continue;
    if (match.index > last) container.append(source.slice(last, match.index));
    const anchor = document.createElement("a");
    anchor.className = "message-link";
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = url;
    anchor.addEventListener("click", (event) => event.stopPropagation());
    container.append(anchor);
    urls.push(url);
    last = match.index + url.length;
  }
  if (last < source.length) container.append(source.slice(last));
  return urls;
}

/** Preview card for the first previewable link in a message, or null. */
function buildLinkPreviewCard(url) {
  const nextcloud = nextcloudShareDownloadUrl(url);
  if (nextcloud) return buildNextcloudRevealCard(url, nextcloud.downloadUrl);
  if (isDirectImageUrl(url)) {
    const img = document.createElement("img");
    img.className = "message-link-image";
    img.loading = "lazy";
    img.alt = "Image preview";
    img.addEventListener("error", () => img.remove(), { once: true });
    img.addEventListener("click", (event) => { event.stopPropagation(); openPhotoPreview(url); });
    img.src = url;
    return img;
  }
  return null;
}

function buildNextcloudRevealCard(shareUrl, downloadUrl) {
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "message-photo-hidden message-nextcloud-reveal";
  reveal.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 18.5h-11a4 4 0 0 1-.6-7.96 5.5 5.5 0 0 1 10.7-1.4 4.5 4.5 0 0 1 .9 9.36Z"/></svg><span>Tap to view Nextcloud media</span>';
  reveal.addEventListener("click", (event) => {
    event.stopPropagation();
    probeNextcloudMedia(reveal, shareUrl, downloadUrl);
  });
  return reveal;
}

/** Progressive type probe (cross-origin headers are unreadable without CORS, but media
 *  element `src` loads need none): <video> that reports a finite duration wins; on error
 *  retry as <img>; if both fail, an "Open in Nextcloud" link. */
function probeNextcloudMedia(placeholder, shareUrl, downloadUrl) {
  placeholder.disabled = true;
  const label = placeholder.querySelector("span");
  if (label) label.textContent = "Loading…";
  let settled = false;
  const settle = (el) => {
    if (settled) return;
    settled = true;
    placeholder.replaceWith(el);
  };

  // Probe order: video -> audio (a media element that has duration but no video track is an
  // mp3/m4a) -> image -> attachment card. Office docs and other unrenderable types land on the
  // card, whose link opens Nextcloud's own web viewer — the only thing that can show them.
  const attachmentFallback = () => {
    const card = document.createElement("a");
    card.className = "message-attachment-card";
    card.href = shareUrl;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg><span><strong>File on Nextcloud</strong><small>Open in Nextcloud</small></span>';
    card.addEventListener("click", (event) => event.stopPropagation());
    settle(card);
  };

  const settleAudio = () => {
    if (settled) return;
    const audio = document.createElement("audio");
    audio.className = "message-link-audio";
    audio.controls = true;
    audio.preload = "metadata";
    audio.addEventListener("click", (event) => event.stopPropagation());
    audio.src = downloadUrl;
    settle(audio);
  };

  const tryImage = () => {
    if (settled) return;
    const img = document.createElement("img");
    img.className = "message-link-image";
    img.alt = "Nextcloud media";
    img.addEventListener("load", () => settle(img), { once: true });
    img.addEventListener("error", attachmentFallback, { once: true });
    img.addEventListener("click", (event) => { event.stopPropagation(); openPhotoPreview(downloadUrl); });
    img.src = downloadUrl;
  };

  const video = document.createElement("video");
  video.className = "message-link-video";
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  video.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth > 0) settle(video);
    else if (Number.isFinite(video.duration) && video.duration > 0) settleAudio(); // audio-only stream
    else tryImage(); // metadata but no playable track (e.g. the file is an image)
  }, { once: true });
  video.addEventListener("error", tryImage, { once: true });
  video.addEventListener("click", (event) => event.stopPropagation());
  video.src = downloadUrl;
}

// --- Reply-to-message (matches iOS's ChatService.replyingTo/cancelReply) ---

let replyingToMessageId = null;
const replyBanner = document.querySelector("[data-reply-banner]");
const replyBannerPreview = document.querySelector("[data-reply-banner-preview]");

function cancelReply() {
  replyingToMessageId = null;
  if (replyBanner) replyBanner.hidden = true;
}

function startReplyTo(messageId) {
  if (!activeConversationId) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const message = conversationEntry?.messages.find((entry) => entry.id === messageId);
  if (!message) return;
  replyingToMessageId = messageId;
  if (replyBannerPreview) replyBannerPreview.textContent = replyPreviewTextFor(message);
  if (replyBanner) replyBanner.hidden = false;
  composer.elements.message?.focus();
}

document.querySelector("[data-cancel-reply]")?.addEventListener("click", cancelReply);

// Scrolls to and briefly highlights the message a reply-quote points at,
// within the currently open conversation only (matches iOS's
// pendingJumpToTxId scroll-and-highlight behavior).
function jumpToMessageByTxid(txid) {
  if (!txid || !activeConversationId) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const target = conversationEntry?.messages.find((entry) => entry.txid === txid || entry.id === txid);
  if (!target) { showCopyToast("Original message not found."); return; }
  const el = messageArea.querySelector(`[data-message-id="${CSS.escape(target.id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("message-highlight");
  window.setTimeout(() => el.classList.remove("message-highlight"), 1200);
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && photoPreviewOverlay && !photoPreviewOverlay.hidden) photoPreviewOverlay.hidden = true;
});
const profileQrOverlayCanvas = document.querySelector("[data-profile-qr-overlay-canvas]");
const chattingAddressScreen = document.querySelector("[data-chatting-address-screen]");
const chattingAddressQr = document.querySelector("[data-chatting-address-qr]");
const chattingAddressValue = document.querySelector("[data-chatting-address-value]");
const chattingAddressBalance = document.querySelector("[data-chatting-address-balance]");
const profileAccountName = document.querySelector("[data-profile-account-name]");
const profileSessionState = document.querySelector("[data-profile-session-state]");
const profileCreated = document.querySelector("[data-profile-created]");
const settingsAccountName = document.querySelector("[data-settings-account-name]");
const settingsAccountAddress = document.querySelector("[data-settings-account-address]");
const accountModalName = null;
const accountModalAddress = null;
const accountModalInitial = null;
const engineLog = document.querySelector("[data-engine-log]");
const privateKeyInput = document.querySelector("[data-private-key-input]");
const messageDetailsModal = document.querySelector("[data-message-details-modal]");
const messageDetailsBody = document.querySelector("[data-message-details-body]");
const messageActionSheet = document.querySelector("[data-message-action-sheet]");
const copyToast = document.querySelector("[data-copy-toast]");
const copyToastText = document.querySelector("[data-copy-toast-text]");
let copyToastTimer = null;
const exportChoiceModal = document.querySelector("[data-export-choice-modal]");
const selectionToolbar = document.querySelector("[data-selection-toolbar]");
const selectionCount = document.querySelector("[data-selection-count]");
const deleteConfirmModal = document.querySelector("[data-delete-confirm-modal]");
const deleteConfirmCopy = document.querySelector("[data-delete-confirm-copy]");
const readinessList = document.querySelector("[data-readiness-list]");
const indexerUrlInput = document.querySelector("[data-indexer-url]");
const testIndexerButton = document.querySelector("[data-test-indexer]");
const onchainConfirmModal = document.querySelector("[data-onchain-confirm-modal]");
const onchainSummary = document.querySelector("[data-onchain-summary]");
const importPayloadModal = document.querySelector("[data-import-payload-modal]");
const importPayloadForm = document.querySelector("[data-import-payload-form]");
const importPayloadInput = document.querySelector("[data-import-payload-input]");
const runtimeStatus = document.querySelector("[data-runtime-status]");
const runtimeIndicator = document.querySelector("[data-runtime-indicator]");
const walletStatus = document.querySelector("[data-wallet-status]");
const walletIndicator = document.querySelector("[data-wallet-indicator]");
const networkStatus = document.querySelector("[data-network-status]");
const standbyStatus = document.querySelector("[data-standby-status]");
const networkBadge = document.querySelector("[data-network-badge]");
const messagingBadge = document.querySelector("[data-messaging-badge]");
const nodePoolStatus = document.querySelector("[data-node-pool-status]");
const lastGoodNodeStatus = document.querySelector("[data-last-good-node]");
const nodePoolHistoryStatus = document.querySelector("[data-node-pool-history]");
const syncServiceStatus = document.querySelector("[data-sync-service-status]");
const subscriptionIndicator = document.querySelector("[data-subscription-indicator]");
const storageStatus = document.querySelector("[data-storage-status]");
const networkIndicator = document.querySelector("[data-network-indicator]");
const standbyIndicator = document.querySelector("[data-standby-indicator]");
const messagingStatus = document.querySelector("[data-messaging-status]");
const messagingIndicator = document.querySelector("[data-messaging-indicator]");

const appBody = document.querySelector("[data-app-body]");
const appSidebar = document.querySelector("[data-app-sidebar]");
const newChatFab = document.querySelector("[data-new-chat-fab]");
const appDetail = document.querySelector("[data-app-detail]");
const detailEmptyState = document.querySelector("[data-detail-empty]");
const emptyState = document.querySelector("[data-empty-state]");
const chatList = document.querySelector("[data-chat-list]");
const groupChatsPlaceholder = document.querySelector("[data-group-chats-placeholder]");
const chatsListTabButtons = document.querySelectorAll("[data-chats-list-tab]");
const chatsTabBadge = document.querySelector("[data-chats-tab-badge]");
const groupsTabBadge = document.querySelector("[data-groups-tab-badge]");
const chatSelectToggle = document.querySelector("[data-chat-select-toggle]");
const chatSelectionBar = document.querySelector("[data-chat-selection-bar]");
let activeChatsListTab = "chats";
let chatSelectionModeActive = false;
const selectedChatConversationIds = new Set();
const conversation = document.querySelector("[data-conversation]");
const conversationName = document.querySelector("[data-conversation-name]");
const conversationAddress = document.querySelector("[data-conversation-address]");
const conversationAvatar = document.querySelector("[data-conversation-avatar]");
const conversationAvatarInitials = document.querySelector("[data-conversation-avatar-initials]");
const conversationAvatarImage = document.querySelector("[data-conversation-avatar-image]");
const conversationBio = document.querySelector("[data-conversation-bio]");

// Shows the contact's KNS primary-domain bio under the name in the open chat.
function updateConversationBio(contact) {
  if (!conversationBio) return;
  const bio = engine.peekKnsAddressProfile?.(contact?.address)?.profile?.bio;
  if (bio) { conversationBio.textContent = bio; conversationBio.hidden = false; }
  else { conversationBio.textContent = ""; conversationBio.hidden = true; }
}

// Shared by the conversation header and (via avatarHtmlFor) the sidebar row
// template: shows the contact's KNS avatarUrl when the profile cache already
// has one, otherwise falls back to initials. Synchronous/cache-only — callers
// that need to react to a KNS fetch landing later re-invoke this themselves.
// Same cache-only avatar logic as updateAvatarElement, but as an HTML string
// for the sidebar row template (which re-renders via innerHTML, not live DOM
// nodes it can update in place).
function avatarHtmlFor(contact, className = "chat-avatar") {
  const avatarUrl = engine.peekKnsAddressProfile?.(contact.address)?.profile?.avatarUrl;
  if (avatarUrl) return `<span class="${className}"><img src="${escapeHtml(avatarUrl)}" alt="" /></span>`;
  return `<span class="${className}">${escapeHtml(initialsFor(contact.name))}</span>`;
}

// Same idea as avatarHtmlFor, but for the active wallet's own messages —
// shows your own KNS avatar if you've set one, otherwise your account name's
// initials. There's always something to show, even with no KNS profile at all.
function selfAvatarHtml(className = "chat-avatar") {
  if (!engine.address) return `<span class="${className}">?</span>`;
  const avatarUrl = engine.peekKnsAddressProfile?.(engine.address)?.profile?.avatarUrl;
  if (avatarUrl) return `<span class="${className}"><img src="${escapeHtml(avatarUrl)}" alt="" /></span>`;
  const name = activeAccountMetadata()?.name || shortAddress(engine.address);
  return `<span class="${className}">${escapeHtml(initialsFor(name))}</span>`;
}

function updateAvatarElement(initialsEl, imageEl, contact) {
  if (initialsEl) initialsEl.textContent = initialsFor(contact.name);
  if (!imageEl) return;
  const avatarUrl = engine.peekKnsAddressProfile?.(contact.address)?.profile?.avatarUrl;
  if (avatarUrl) {
    imageEl.src = avatarUrl;
    imageEl.hidden = false;
  } else {
    imageEl.hidden = true;
    imageEl.src = "";
  }
}
const chatInfoOverlay = document.querySelector("[data-chat-info-overlay]");
const chatInfoAvatar = document.querySelector("[data-chat-info-avatar]");
const chatInfoAvatarInitials = document.querySelector("[data-chat-info-avatar-initials]");
const chatInfoAvatarImage = document.querySelector("[data-chat-info-avatar-image]");
const chatInfoNameInput = document.querySelector("[data-chat-info-name-input]");
const chatInfoAddressCaption = document.querySelector("[data-chat-info-address-caption]");
const chatInfoQr = document.querySelector("[data-chat-info-qr]");
const chatInfoAddressMono = document.querySelector("[data-chat-info-address-mono]");
const chatInfoAdded = document.querySelector("[data-chat-info-added]");
const chatInfoLastMessage = document.querySelector("[data-chat-info-last-message]");
const chatInfoChessRow = document.querySelector("[data-chat-info-chess-row]");
const chatInfoChess = document.querySelector("[data-chat-info-chess]");
const chatInfoSent = document.querySelector("[data-chat-info-sent]");
const chatInfoReceived = document.querySelector("[data-chat-info-received]");
const chatInfoTotal = document.querySelector("[data-chat-info-total]");
const chatInfoProfileSection = document.querySelector("[data-chat-info-profile-section]");
const chatInfoBio = document.querySelector("[data-chat-info-bio]");
const chatInfoSocialLinks = document.querySelector("[data-chat-info-social-links]");
let chatInfoRequestToken = 0;
let chatInfoContactId = null;
let chatInfoContactAddress = null;
const chatInfoNotifyToggle = document.querySelector("[data-chat-info-notify]");
const chatInfoPhotosToggle = document.querySelector("[data-chat-info-photos]");

function refreshChatInfoContactControls() {
  if (chatInfoNotifyToggle) chatInfoNotifyToggle.checked = getContactNotify(chatInfoContactAddress) !== "muted";
  if (chatInfoPhotosToggle) chatInfoPhotosToggle.checked = getContactPhotos(chatInfoContactAddress) !== "manual";
}
chatInfoNotifyToggle?.addEventListener("change", async () => {
  if (!chatInfoContactAddress) return;
  setContactPref(chatInfoContactAddress, "notify", chatInfoNotifyToggle.checked ? "enabled" : "muted");
  if (chatInfoNotifyToggle.checked) {
    const granted = await ensureNotificationPermission();
    if (!granted) showCopyToast("Allow notifications in your browser to receive them.");
  }
});
chatInfoPhotosToggle?.addEventListener("change", () => {
  if (!chatInfoContactAddress) return;
  setContactPref(chatInfoContactAddress, "photos", chatInfoPhotosToggle.checked ? "auto" : "manual");
  const conv = state.conversations.find((entry) => entry.id === activeConversationId);
  if (conv && contactForConversation(conv)?.address === chatInfoContactAddress) renderMessages(conv);
});
// Best-effort permission request at load (browsers that require a gesture will
// no-op; the Chat Info toggle also requests it on demand).
ensureNotificationPermission();

// Browser notifications for incoming messages. Best-effort: requests permission on
// a user gesture; fires only when the message's chat isn't the focused active one.
async function ensureNotificationPermission() {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try { return (await Notification.requestPermission()) === "granted"; } catch { return false; }
}
function maybeNotifyIncoming(conversationEntry, contact, message) {
  if (!message || message.direction !== "incoming") return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (getContactNotify(contact?.address) === "muted") return;
  if (parseReactionEnvelope(message.text)) return; // reactions aren't standalone messages
  // Don't notify for the conversation you're already looking at in a focused window.
  if (activeConversationId === conversationEntry.id && !document.hidden) return;
  const title = displayNameForAddress(contact) || contact?.name || shortAddress(contact?.address || "");
  try {
    const note = new Notification(title, {
      body: displayTextForMessage(message) || "New message",
      tag: `kachat-${conversationEntry.id}`,
      icon: "./ui/assets/kachat-logo.png",
    });
    note.onclick = () => { try { window.focus(); } catch {} setActiveAppTab("chats"); openConversation(conversationEntry.id); note.close(); };
  } catch { /* notification construction can throw in some contexts */ }
}
const copyContactAddressButtons = document.querySelectorAll("[data-copy-contact-address]");
const clearChatButton = document.querySelector("[data-clear-chat]");
const simulateIncomingButton = document.querySelector("[data-simulate-incoming]");
const syncPreviewButton = document.querySelector("[data-sync-preview]");
const importPayloadButton = document.querySelector("[data-open-import-payload]");
const syncStatus = document.querySelector("[data-sync-status]");
const messageArea = document.querySelector("[data-message-area]");
const messageEmpty = document.querySelector("[data-message-empty]");
const composer = document.querySelector("[data-composer]");
const composerPlusButton = document.querySelector("[data-composer-plus]");
const composerPlusMenu = document.querySelector("[data-composer-plus-menu]");
const photoFileInput = document.querySelector("[data-photo-file-input]");
const pendingPhotoPreview = document.querySelector("[data-pending-photo-preview]");
const pendingPhotoThumb = document.querySelector("[data-pending-photo-thumb]");
const pendingPhotoMeta = document.querySelector("[data-pending-photo-meta]");
const pendingPhotoRemove = document.querySelector("[data-pending-photo-remove]");
let pendingPhotoAttachment = null;
const composerModeButtons = Array.from(document.querySelectorAll("[data-composer-mode]"));
const availableBalanceBanner = document.querySelector("[data-available-balance-banner]");
const feeEstimateBanner = document.querySelector("[data-fee-estimate-banner]");
const handshakeWarningBanner = document.querySelector("[data-handshake-warning-banner]");
let feeEstimateDebounceTimer = null;
let feeEstimateRequestToken = 0;
const kasPaymentAlert = document.querySelector("[data-kas-payment-alert]");
const kasPaymentAlertTitle = document.querySelector("[data-kas-payment-alert-title]");
const kasPaymentAlertMessage = document.querySelector("[data-kas-payment-alert-message]");
const kasPaymentAlertPrimary = document.querySelector("[data-kas-payment-alert-primary]");
const kasPaymentAlertCancel = document.querySelector("[data-kas-payment-alert-cancel]");
const contactModal = document.querySelector("[data-contact-modal]");
const contactForm = document.querySelector("[data-contact-form]");
const contactAddressInput = contactForm?.elements?.address;
const contactNameInput = contactForm?.elements?.name;
const createChatAddButton = document.querySelector("[data-create-chat-add]");
const createChatError = document.querySelector("[data-create-chat-error]");
const contactImportButton = document.querySelector("[data-contact-import]");
const contactImportFile = document.querySelector("[data-contact-import-file]");
const contactPasteButton = document.querySelector("[data-contact-paste]");
const contactScanButton = document.querySelector("[data-contact-scan]");
const searchInput = document.querySelector(".search-input");

// Step 101 — full-window desktop layout. Sidebar + detail pane are both
// visible at once at wide widths (matching styles.css's 860px breakpoint);
// below that, only one pane shows at a time via the .conversation-open class.
const wideLayoutMedia = window.matchMedia("(min-width: 860px)");
let isWideLayout = wideLayoutMedia.matches;
wideLayoutMedia.addEventListener("change", (event) => {
  isWideLayout = event.matches;
});

// Step 102 — which of the 5 bottom-left tabs is currently selected. Drives
// updateDetailActiveClass() below alongside conversation state.
let currentAppTab = "chats";

// `.detail-active` covers both "a conversation is open" and "a non-Chats tab
// is selected" — either one means the detail pane, not the sidebar's chat
// list, should take over the full width in narrow mode (see the media query
// in ui/styles.css). `.conversation-open` stays narrower (conversation only)
// since it's also used there to hide the tab bar during that specific
// drill-down, which placeholder tabs should NOT do.
function updateDetailActiveClass() {
  appBody?.classList.toggle("detail-active", Boolean(activeConversationId) || currentAppTab !== "chats");
}

function setActiveConversationId(id) {
  activeConversationId = id;
  try { updateChatFundingGate(); } catch { /* gate section not evaluated yet */ }
  const isOpen = Boolean(id);
  appBody?.classList.toggle("conversation-open", isOpen);
  // The conversation pane and its "Select a conversation" empty state belong to the CHATS
  // tab only - background refreshes call this with null while another tab (KaPosts etc.)
  // is showing, and unconditionally unhiding the empty state stacked it on top of that
  // tab's screen.
  const onChatsTab = currentAppTab === "chats";
  if (conversation) conversation.hidden = !isOpen || !onChatsTab;
  if (detailEmptyState) detailEmptyState.hidden = isOpen || !onChatsTab;
  updateDetailActiveClass();
}

function nowId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stringToHex(value) {
  return Array.from(new TextEncoder().encode(String(value || "")))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeImportedPayload(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withoutPrefix = raw.replace(/^0x/i, "").replace(/\s+/g, "");
  if (/^[0-9a-fA-F]+$/.test(withoutPrefix) && withoutPrefix.length % 2 === 0) {
    return withoutPrefix.toLowerCase();
  }
  return stringToHex(raw);
}

function initialsFor(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

function shortAddress(address) {
  if (!address) return "";
  if (address.length <= 20) return address;
  return `${address.slice(0, 14)}…${address.slice(-8)}`;
}

// Matches iOS/Android's KNS alias behavior: shows the address's resolved KNS
// primary domain when one is cached, falling back to the shortened address —
// unlike an arbitrary hand-typed name, a verified on-chain domain is treated
// as trustworthy enough to replace the raw address in the chat list/header.
// Reads the cache synchronously (no network wait); refreshKnsIfNeeded keeps
// it populated in the background.
// Contacts must show the domain the address actually set as its on-chain
// primary — not just whichever domain it owns most recently, which is what
// primaryDomain falls back to when no explicit primary is set (matches
// iOS's own-profile fallback behavior, but that fallback would misrepresent
// which domain a contact actually chose to identify themselves with).
//
// A name the user explicitly typed (at Add Contact time, or via Chat Info's
// rename field) always wins over anything KNS-derived — auto-naming only
// fills in contact.name itself (see applyKnsPrimaryDomainToContact) when no
// custom name has been set, so this just reads contact.name normally.
function displayNameForAddress(contact) {
  if (!contact) return "";
  if (contact.nameIsCustom) return contact.name || shortAddress(contact.address);
  const knsInfo = engine.peekKnsAddressInfo?.(contact.address);
  return knsInfo?.explicitPrimaryDomain || contact.name || shortAddress(contact.address);
}

// Called after any KNS info refresh: if this contact has no user-set custom
// name and its address has an explicit on-chain primary domain, adopt it as
// contact.name so it becomes the single source of truth everywhere (sidebar,
// header, Chat Info) instead of being recomputed separately in each place.
function applyKnsPrimaryDomainToContact(contact) {
  if (!contact || contact.nameIsCustom) return false;
  const knsInfo = engine.peekKnsAddressInfo?.(contact.address);
  const domain = knsInfo?.explicitPrimaryDomain || null;
  if (domain && contact.name !== domain) {
    contact.name = domain;
    contact.updatedAt = Date.now();
    return true;
  }
  return false;
}

function validateContactAddress(value) {
  const clean = String(value || "").trim();
  if (!clean) throw new Error("Enter a Kaspa address.");
  if (!engine.kaspa) throw new Error("Kaspa validation is still loading. Try again in a moment.");
  if (!clean.startsWith("kaspa:")) throw new Error("Contact address must be a mainnet kaspa: address.");

  try {
    const parsed = new engine.kaspa.Address(clean);
    const normalized = parsed.toString();
    if (!normalized.startsWith("kaspa:")) throw new Error("Not a mainnet address.");
    return normalized;
  } catch {
    throw new Error("That Kaspa address is not valid.");
  }
}

function getStoredTestingWalletHex() {
  try {
    const activeAddress = String(localStorage.getItem(ACTIVE_ACCOUNT_KEY) || "").trim();
    if (activeAddress) {
      const account = loadSavedAccounts().find((entry) => entry.address === activeAddress);
      if (account?.privateKeyHex) return String(account.privateKeyHex).trim();
    }
    const raw = localStorage.getItem(PERSISTED_WALLET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.privateKeyHex) return String(parsed.privateKeyHex).trim();
    }
    const legacy = localStorage.getItem(LEGACY_PERSISTED_WALLET_KEY);
    if (legacy) return String(legacy).trim();
  } catch (error) {
    appendEngineLog(`Wallet storage read failed: ${error.message}`);
  }
  return "";
}

function persistTestingWallet({ mnemonic = "", passphrase = "", derivationPath = "", wordCount = 0 } = {}) {
  const privateKeyHex = String(engine.privateKeyHex || "").trim();
  if (!privateKeyHex) throw new Error("Wallet private key was unavailable for browser storage.");
  const address = String(engine.address || "").trim();
  // "Save account on this device" off → session-only: keep the wallet in engine
  // memory but write nothing, so it won't appear in Saved Accounts or auto-restore.
  if (accountShellPrefs.saveAccount === false) {
    appendEngineLog(`Account kept in memory only (Save account is off): ${address}`);
    return true;
  }
  const meta = activeAccountMetadata();
  const existingAccount = loadSavedAccounts().find((entry) => entry.address === address);
  const payload = {
    version: 3,
    privateKeyHex,
    mnemonic: String(mnemonic || existingAccount?.mnemonic || ""),
    passphrase: String(passphrase || existingAccount?.passphrase || ""),
    derivationPath: String(derivationPath || existingAccount?.derivationPath || ""),
    wordCount: Number(wordCount || existingAccount?.wordCount || 0),
    address,
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(PERSISTED_WALLET_KEY, JSON.stringify(payload));
  localStorage.removeItem(LEGACY_PERSISTED_WALLET_KEY);
  upsertSavedAccount({
    address,
    privateKeyHex,
    mnemonic: payload.mnemonic,
    passphrase: payload.passphrase,
    derivationPath: payload.derivationPath,
    wordCount: payload.wordCount,
    name: meta?.name,
    createdAt: meta?.createdAt,
    savedAt: payload.savedAt,
  });
  const verified = getStoredTestingWalletHex();
  if (verified !== privateKeyHex) throw new Error("Browser storage verification failed.");
  appendEngineLog(`Account saved in browser storage: ${engine.address}`);
  return true;
}

function clearPersistedTestingWallet() {
  localStorage.removeItem(PERSISTED_WALLET_KEY);
  localStorage.removeItem(LEGACY_PERSISTED_WALLET_KEY);
}

function restorePersistedTestingWallet() {
  if (!engine.kaspa) return false;
  if (localStorage.getItem(SESSION_LOGGED_OUT_KEY) === "true") {
    appendEngineLog("Stored account remains on device, but the session is logged out.");
    return false;
  }
  // "Keep me signed in" off → don't auto-enter on a fresh launch; the saved
  // account stays on device so it can be picked from the sign-in screen. A manual
  // sign-in (which marks the session active) still survives its own reload.
  if ((accountShellPrefs.keepSignedIn ?? true) === false && !isSessionActive()) {
    appendEngineLog("Keep me signed in is off — showing the sign-in screen.");
    return false;
  }
  const privateKeyHex = getStoredTestingWalletHex();
  if (!privateKeyHex) {
    appendEngineLog("No persistent testing wallet was found in this browser origin.");
    return false;
  }

  try {
    const wallet = engine.importPrivateKey(privateKeyHex);
    persistTestingWallet();
    markSessionActive();
    appendEngineLog(`Restored persistent testing wallet: ${wallet.address}`);
    activateWalletDataScope(wallet.address);
    return true;
  } catch (error) {
    clearPersistedTestingWallet();
    appendEngineLog(`Stored testing wallet could not be restored: ${error.message}`);
    return false;
  }
}

function normalizeContact(contact) {
  const name = String(contact?.name || contact?.displayName || "Unnamed").trim() || "Unnamed";
  const createdAt = Number(contact?.createdAt || Date.now());
  return {
    id: String(contact?.id || nowId()),
    name,
    nameIsCustom: Boolean(contact?.nameIsCustom),
    address: String(contact?.address || contact?.kaspaAddress || "").trim(),
    avatar: String(contact?.avatar || initialsFor(name)),
    createdAt,
    updatedAt: Number(contact?.updatedAt || createdAt),
    relationshipState: String(contact?.relationshipState || "legacy-manual"),
    handshakeTxid: String(contact?.handshakeTxid || ""),
    incomingHandshakeTxid: String(contact?.incomingHandshakeTxid || ""),
    peerConversationId: String(contact?.peerConversationId || ""),
  };
}

function normalizeMessage(message, conversationId) {
  return normalizeEngineMessage(message, conversationId);
}

function contactForConversation(conversationEntry) {
  return state.contacts.find((contact) => contact.id === conversationEntry?.contactId) || null;
}

function promoteRelationshipFromIncomingEvidence(contact, conversationEntry, { persist = true } = {}) {
  if (!contact || !conversationEntry) return false;
  if (contact.relationshipState !== "outgoing-request" && contact.relationshipState !== "legacy-manual") return false;

  const messages = conversationEntry.messages || [];
  const reciprocalMessage = messages.find((message) =>
    message?.direction === "incoming" &&
    message?.messageType !== "handshake" &&
    String(message?.sender || "") === String(contact.address || "") &&
    String(message?.text || "").trim().length > 0
  );
  if (!reciprocalMessage) return false;

  // A manually-added contact has no handshake to confirm acceptance —
  // only silence the no-handshake warning once there's real evidence both
  // sides have actually exchanged messages, not just one unprompted incoming
  // message.
  if (contact.relationshipState === "legacy-manual") {
    const hasOutgoing = messages.some((message) =>
      message?.direction === "outgoing" &&
      message?.messageType !== "handshake" &&
      String(message?.text || "").trim().length > 0
    );
    if (!hasOutgoing) return false;
  }

  contact.relationshipState = "established";
  contact.updatedAt = Date.now();
  conversationEntry.updatedAt = Date.now();
  conversationEntry.lastActivityAt = Math.max(
    Number(conversationEntry.lastActivityAt || 0),
    Number(reciprocalMessage.createdAt || Date.now()),
  );

  for (const message of conversationEntry.messages || []) {
    if (message?.messageType === "handshake" && message?.direction === "outgoing" && message?.status !== MESSAGE_STATUSES.FAILED) {
      applyMessagePatch(message, {
        status: MESSAGE_STATUSES.CONFIRMED,
        note: "Communication request accepted",
        confirmations: Math.max(1, Number(message.confirmations || 0)),
      });
    }
  }

  refreshSubscriptionAddresses({ restart: true });
  if (persist) persistState();
  appendEngineLog(`Handshake accepted for ${contact.address}: reciprocal encrypted message received.`);
  return true;
}

function reconcileEstablishedRelationships({ persist = true } = {}) {
  let changed = false;
  for (const conversationEntry of state.conversations || []) {
    const contact = contactForConversation(conversationEntry);
    if (promoteRelationshipFromIncomingEvidence(contact, conversationEntry, { persist: false })) changed = true;
  }
  if (changed && persist) persistState();
  return changed;
}

function normalizeConversation(conversationEntry) {
  const id = String(conversationEntry?.id || nowId());
  const createdAt = Number(conversationEntry?.createdAt || Date.now());
  const messages = Array.isArray(conversationEntry?.messages)
    ? conversationEntry.messages.map((message) => normalizeMessage(message, id)).filter((message) => message.text)
    : [];
  const lastMessage = messages.at(-1);
  const lastActivityAt = Number(conversationEntry?.lastActivityAt || conversationEntry?.updatedAt || lastMessage?.createdAt || createdAt);

  return {
    id,
    type: String(conversationEntry?.type || "direct"),
    contactId: String(conversationEntry?.contactId || ""),
    createdAt,
    updatedAt: Number(conversationEntry?.updatedAt || lastActivityAt),
    lastActivityAt,
    unreadCount: Number(conversationEntry?.unreadCount || 0),
    pinned: Boolean(conversationEntry?.pinned),
    muted: Boolean(conversationEntry?.muted),
    archived: Boolean(conversationEntry?.archived),
    hiddenMessageKeys: Array.isArray(conversationEntry?.hiddenMessageKeys) ? [...new Set(conversationEntry.hiddenMessageKeys.map(String))] : [],
    reactionsByTxId: (conversationEntry?.reactionsByTxId && typeof conversationEntry.reactionsByTxId === "object") ? conversationEntry.reactionsByTxId : {},
    sync: {
      lastSyncAt: Number(conversationEntry?.sync?.lastSyncAt || 0),
      lastFound: Number(conversationEntry?.sync?.lastFound || 0),
      runs: Number(conversationEntry?.sync?.runs || 0),
      cursor: Number(conversationEntry?.sync?.cursor || 0),
      lastNote: String(conversationEntry?.sync?.lastNote || ""),
    },
    messages,
  };
}

function migrateLegacyContacts(legacyContacts) {
  const contacts = [];
  const conversations = [];

  for (const rawContact of legacyContacts) {
    if (!rawContact?.name || !rawContact?.address) continue;
    const contact = normalizeContact(rawContact);
    const conversationId = nowId();
    const messages = Array.isArray(rawContact.messages)
      ? rawContact.messages.map((message) => ({
          ...normalizeMessage(message, conversationId),
          contactId: contact.id,
        })).filter((message) => message.text)
      : [];
    const lastMessage = messages.at(-1);

    contacts.push(contact);
    conversations.push({
      id: conversationId,
      type: "direct",
      contactId: contact.id,
      createdAt: Number(rawContact.createdAt || Date.now()),
      updatedAt: Number(rawContact.updatedAt || lastMessage?.updatedAt || Date.now()),
      lastActivityAt: Number(rawContact.updatedAt || lastMessage?.createdAt || rawContact.createdAt || Date.now()),
      unreadCount: Number(rawContact.unreadCount || 0),
      pinned: false,
      muted: false,
      archived: false,
      messages,
    });
  }

  return { contacts, conversations };
}

function loadStoredState() {
  try {
    const raw = chatStorageGetSync(accountScopedKey(STORAGE_KEY));
    if (raw) {
      const parsed = JSON.parse(raw);
      const contacts = Array.isArray(parsed?.contacts) ? parsed.contacts.map(normalizeContact).filter((contact) => contact.address) : [];
      const conversations = Array.isArray(parsed?.conversations)
        ? parsed.conversations.map(normalizeConversation).filter((entry) => entry.contactId && contacts.some((contact) => contact.id === entry.contactId))
        : [];
      return { contacts, conversations };
    }
  } catch {
    // Try legacy storage below.
  }

  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      const migrated = migrateLegacyContacts(parsed);
      if (migrated.contacts.length > 0) {
        chatStorageSetSync(accountScopedKey(STORAGE_KEY), JSON.stringify(migrated));
        return migrated;
      }
    } catch {
      // Try the next legacy key.
    }
  }

  return { contacts: [], conversations: [] };
}

function loadStoredMessageHistory() {
  try {
    const parsed = JSON.parse(chatStorageGetSync(accountScopedKey(MESSAGE_HISTORY_KEY)) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function mergeStoredMessageHistory(targetState) {
  const history = loadStoredMessageHistory();
  for (const conversationEntry of targetState.conversations || []) {
    const stored = Array.isArray(history[conversationEntry.id]) ? history[conversationEntry.id] : [];
    const current = Array.isArray(conversationEntry.messages) ? conversationEntry.messages : [];
    const byId = new Map();
    for (const raw of [...stored, ...current]) {
      const message = normalizeMessage(raw, conversationEntry.id);
      if (message.text) byId.set(message.id, message);
    }
    conversationEntry.messages = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
    const last = conversationEntry.messages.at(-1);
    if (last) conversationEntry.lastActivityAt = Math.max(Number(conversationEntry.lastActivityAt || 0), last.createdAt);
  }
  return targetState;
}

state = buildFullyRestoredState();


function hydrateConversationMessages(conversationEntry) {
  if (!conversationEntry) return conversationEntry;

  const candidates = [];
  const current = Array.isArray(conversationEntry.messages) ? conversationEntry.messages : [];
  candidates.push(...current);

  const history = loadStoredMessageHistory();
  if (Array.isArray(history[conversationEntry.id])) candidates.push(...history[conversationEntry.id]);

  try {
    const backup = JSON.parse(chatStorageGetSync(accountScopedKey(STATE_BACKUP_KEY)) || "null");
    const backupConversation = Array.isArray(backup?.conversations)
      ? backup.conversations.find((entry) => String(entry?.id) === String(conversationEntry.id))
      : null;
    if (Array.isArray(backupConversation?.messages)) candidates.push(...backupConversation.messages);
  } catch {
    // Ignore a malformed backup and continue with current/history state.
  }

  const hidden = new Set((conversationEntry.hiddenMessageKeys || []).map(String));
  const byId = new Map();
  for (const raw of candidates) {
    const message = normalizeMessage(raw, conversationEntry.id);
    if (!message.text) continue;
    if (hidden.has(String(message.id)) || (message.txid && hidden.has(String(message.txid)))) continue;
    const key = String(message.id || message.txid || `${message.createdAt}:${message.direction}:${message.text}`);
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, message);
      continue;
    }

    // Keep the newest canonical copy of a message. Older history/backup copies
    // must never downgrade a live confirmed payment back to pending.
    const existingUpdatedAt = Number(existing.updatedAt || existing.createdAt || 0);
    const messageUpdatedAt = Number(message.updatedAt || message.createdAt || 0);
    const statusRank = (status) => ({ failed: 0, pending: 1, building: 1, draft: 1, confirmed: 2 }[String(status || "pending")] ?? 1);
    const newer = messageUpdatedAt >= existingUpdatedAt ? message : existing;
    const older = newer === message ? existing : message;
    const merged = { ...older, ...newer };
    if (statusRank(existing.status) > statusRank(merged.status)) merged.status = existing.status;
    if (statusRank(message.status) > statusRank(merged.status)) merged.status = message.status;
    merged.confirmations = Math.max(Number(existing.confirmations || 0), Number(message.confirmations || 0));
    byId.set(key, merged);
  }

  conversationEntry.messages = [...byId.values()].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  const last = conversationEntry.messages.at(-1);
  if (last) {
    conversationEntry.lastActivityAt = Math.max(Number(conversationEntry.lastActivityAt || 0), Number(last.createdAt || 0));
    conversationEntry.updatedAt = Math.max(Number(conversationEntry.updatedAt || 0), Number(last.updatedAt || last.createdAt || 0));
  }
  return conversationEntry;
}


function buildFullyRestoredState() {
  const restored = mergeStoredMessageHistory(loadStoredState());
  for (const conversationEntry of restored.conversations || []) {
    hydrateConversationMessages(conversationEntry);
  }
  return restored;
}

function reloadStateFromBrowserStorage() {
  const restored = buildFullyRestoredState();
  const activeId = activeConversationId;
  state = restored;
  if (activeId && !state.conversations.some((entry) => entry.id === activeId)) {
    setActiveConversationId(null);
  }
  return state;
}

function persistStateWrites({ includeBackup = true } = {}) {
  // In IndexedDB mode these set calls update the in-memory cache immediately
  // and flush to disk on a 300ms debounce (coalescing bursts of persistState
  // calls into one write of the latest snapshot). In localStorage-fallback
  // mode they write synchronously and can throw QuotaExceededError, which
  // persistState() below still handles.
  const serialized = JSON.stringify(state);
  chatStorageSetSync(accountScopedKey(STORAGE_KEY), serialized);
  if (includeBackup) chatStorageSetSync(accountScopedKey(STATE_BACKUP_KEY), serialized);
  const history = Object.fromEntries((state.conversations || []).map((entry) => [entry.id, entry.messages || []]));
  chatStorageSetSync(accountScopedKey(MESSAGE_HISTORY_KEY), JSON.stringify(history));
  const verified = chatStorageGetSync(accountScopedKey(STORAGE_KEY));
  if (verified !== serialized) throw new Error("Local conversation storage verification failed.");
}

/** Oldest-first trim of messages imported from a phone backup (transport "phone-backup"),
 *  keeping at most `keepPerConversation` per chat — live desktop messages are never dropped. */
function trimPhoneBackupMessages(keepPerConversation) {
  let removed = 0;
  for (const entry of state.conversations || []) {
    const messages = entry.messages || [];
    const phone = messages.filter((m) => m.transport === "phone-backup");
    if (phone.length <= keepPerConversation) continue;
    const drop = new Set(
      phone
        .slice()
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .slice(0, phone.length - keepPerConversation)
        .map((m) => m.id || m.txid),
    );
    entry.messages = messages.filter((m) => !drop.has(m.id || m.txid));
    removed += drop.size;
  }
  return removed;
}

let storageQuotaToastShown = false;

/** In IndexedDB mode persistStateWrites never throws (quota is device-proportional and the
 *  write is async) — the catch blocks below only ever run in the localStorage FALLBACK mode
 *  (IndexedDB unavailable, e.g. private browsing), where a full localStorage right after a
 *  large phone-backup import must never crash a sync. Fallback recovery order: drop the
 *  redundant full-state backup copy (halves the footprint), then trim phone-backup messages
 *  oldest-first in stages, retrying the save after each step. */
function persistState() {
  try {
    persistStateWrites();
    return;
  } catch { /* quota — reclaim space below and retry */ }
  try { chatStorageRemoveSync(accountScopedKey(STATE_BACKUP_KEY)); } catch { /* ignore */ }
  for (const keep of [100, 25, 0]) {
    trimPhoneBackupMessages(keep);
    try {
      persistStateWrites({ includeBackup: false });
      if (!storageQuotaToastShown) {
        storageQuotaToastShown = true;
        try { showCopyToast("Browser storage was full — trimmed the oldest phone-backup messages to keep saving."); } catch { /* early init */ }
      }
      return;
    } catch { /* still full — trim harder */ }
  }
  throw new Error("Local storage is full — could not save conversation state.");
}

let chatStorageFlushErrorNotified = false;

/** Emergency path, registered with setChatStorageFlushErrorHandler at module top: a debounced
 *  IndexedDB write FAILED after in-memory state was already updated. storage.js re-queues the
 *  batch for the next flush; additionally push a copy into localStorage via the legacy
 *  quota-aware trimming path so a crash right now cannot lose everything since the last
 *  successful flush. (trimPhoneBackupMessages only mutates state here, in this failure path —
 *  exactly like the old localStorage-quota behavior.) */
function handleChatStorageFlushError(error) {
  appendEngineLog(`IndexedDB save failed (${error?.message || error}) — writing localStorage fallback copy.`);
  if (!chatStorageFlushErrorNotified) {
    chatStorageFlushErrorNotified = true;
    try { showCopyToast("Saving chats to IndexedDB failed — using localStorage fallback."); } catch { /* early init */ }
  }
  const writeLocal = (includeBackup) => {
    const serialized = JSON.stringify(state);
    localStorage.setItem(accountScopedKey(STORAGE_KEY), serialized);
    if (includeBackup) localStorage.setItem(accountScopedKey(STATE_BACKUP_KEY), serialized);
    const history = Object.fromEntries((state.conversations || []).map((entry) => [entry.id, entry.messages || []]));
    localStorage.setItem(accountScopedKey(MESSAGE_HISTORY_KEY), JSON.stringify(history));
  };
  try { writeLocal(true); return; } catch { /* quota — trim and retry */ }
  for (const keep of [100, 25, 0]) {
    trimPhoneBackupMessages(keep);
    try { writeLocal(false); return; } catch { /* still full — trim harder */ }
  }
  appendEngineLog("localStorage fallback copy also failed — conversation state is only in memory.");
}

function activateWalletDataScope(address, { migrateLegacy = true } = {}) {
  // KaPosts state (follows/mutes/blocks + session posts) is per account too.
  try { resetKaPostsForAccount(); } catch { /* not yet initialized */ }
  try { reloadDockPrefsForAccount(); } catch { /* not yet initialized */ }
  try { resetBroadcastsForAccount(); } catch { /* not yet initialized */ }
  try { resetPortfolioForAccount(); } catch { /* not yet initialized */ }
  try { resetColdStorageForAccount(); } catch { /* not yet initialized */ }
  try { resetNextcloudForAccount(); } catch { /* not yet initialized */ }
  try { resetSwapsForAccount(); } catch { /* not yet initialized */ }
  const clean = String(address || "").trim();
  if (!clean) {
    state = { contacts: [], conversations: [] };
    setActiveConversationId(null);
    return state;
  }

  const scopedStateKey = accountScopedKey(STORAGE_KEY, clean);
  if (migrateLegacy && !chatStorageGetSync(scopedStateKey)) {
    const legacy = chatStorageGetSync(STORAGE_KEY);
    if (legacy) {
      chatStorageSetSync(scopedStateKey, legacy);
      const legacyBackup = chatStorageGetSync(STATE_BACKUP_KEY);
      const legacyHistory = chatStorageGetSync(MESSAGE_HISTORY_KEY);
      if (legacyBackup) chatStorageSetSync(accountScopedKey(STATE_BACKUP_KEY, clean), legacyBackup);
      if (legacyHistory) chatStorageSetSync(accountScopedKey(MESSAGE_HISTORY_KEY, clean), legacyHistory);
      appendEngineLog(`Migrated existing chats into wallet scope ${shortAddress(clean)}.`);
    }
  }

  setActiveConversationId(null);
  state = buildFullyRestoredState();
  refreshSubscriptionAddresses({ restart: false });
  return state;
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}


function formatDateTime(timestamp) {
  if (!timestamp) return "Never synced";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function syncLabel(conversationEntry) {
  const sync = conversationEntry?.sync || {};
  if (!sync.lastSyncAt) return "Not synced yet";
  const found = Number(sync.lastFound || 0);
  const foundLabel = found === 1 ? "1 new payload" : `${found} new payloads`;
  return `Last sync ${formatDateTime(sync.lastSyncAt)} · ${foundLabel} · cursor ${sync.cursor || 0}`;
}

function lastMessageFor(conversationEntry) {
  const messages = conversationEntry.messages || [];
  return messages.length ? messages[messages.length - 1] : null;
}

function statusLabel(status) {
  return engineStatusLabel(status);
}

function protocolSummary(message) {
  if (!message) return "No message selected.";
  const rows = [
    ["Status", statusLabel(message.status)],
    ["Direction", message.direction || "outgoing"],
    ["Protocol", `${message.protocol || "kasia"} v${message.protocolVersion || 1}`],
    ["Network", message.network || "mainnet"],
    ["Type", message.messageType || "not created yet"],
    ["Transport", message.transport || "preview"],
    ["Payload bytes", message.payloadBytes ?? "--"],
    ["TXID", message.txid || "--"],
    ["DAA score", message.daaScore || "--"],
    ["Confirmations", message.confirmations ?? 0],
    ["Sender", message.sender || "--"],
    ["Receiver", message.receiver || "--"],
    ["Created", new Date(message.createdAt).toLocaleString()],
  ];

  const meta = rows.map(([label, value]) => `
    <div class="detail-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>`).join("");

  const payload = message.payloadHex
    ? `<div class="payload-box" data-copy-payload title="Click to copy payload hex">${escapeHtml(message.payloadHex)}</div>`
    : `<div class="payload-box muted">Payload will appear after KaspaEngine creates it.</div>`;

  const protocolString = message.protocolString
    ? `<div class="detail-section-title">Kasia protocol string</div><div class="payload-box muted">${escapeHtml(message.protocolString)}</div>`
    : "";

  return `${meta}
    <div class="detail-section-title">Kasia payload hex</div>
    ${payload}
    ${protocolString}`;
}

function closeMessageDetails() {
  activeMessageActionId = null;
  if (messageDetailsModal) messageDetailsModal.hidden = true;
}

function activeMessageRecord() {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const message = conversationEntry?.messages.find((entry) => entry.id === activeMessageActionId);
  return { conversationEntry, message };
}

function rawMessageRecord(message) {
  if (!message) return null;
  return {
    id: message.id,
    status: message.status,
    direction: message.direction,
    protocol: message.protocol,
    protocolVersion: message.protocolVersion,
    network: message.network,
    messageType: message.messageType,
    transport: message.transport,
    payloadBytes: message.payloadBytes,
    txid: message.txid,
    daaScore: message.daaScore,
    confirmations: message.confirmations,
    sender: message.sender,
    receiver: message.receiver,
    createdAt: new Date(message.createdAt).toISOString(),
    updatedAt: new Date(message.updatedAt || message.createdAt).toISOString(),
    text: message.text,
    payloadHex: message.payloadHex,
    protocolString: message.protocolString,
  };
}

function rawMessageText(message) {
  return JSON.stringify(rawMessageRecord(message), null, 2);
}

function downloadBlob(filename, type, content) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvEscape(value) {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function exportMessageCsv(message) {
  const record = rawMessageRecord(message);
  const rows = Object.entries(record || {}).map(([key, value]) => `${csvEscape(key)},${csvEscape(value)}`);
  downloadBlob(`kachat-message-${message.id}.csv`, "text/csv;charset=utf-8", `field,value\n${rows.join("\n")}\n`);
  setStatus("Message raw data exported as CSV");
}

function exportMessagePdf(message) {
  const record = rawMessageRecord(message);
  const popup = window.open("", "_blank");
  if (!popup) throw new Error("Allow pop-ups to export a PDF.");
  const rows = Object.entries(record || {}).map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value))}</td></tr>`).join("");
  popup.document.write(`<!doctype html><html><head><title>KaChat Message Raw Data</title><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:32px;color:#111}h1{font-size:24px;margin:0 0 8px}p{color:#555;margin:0 0 24px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{width:180px;background:#f4f4f4}@media print{body{padding:0}}</style></head><body><h1>KaChat Message Raw Data</h1><p>Use the browser print dialog and choose “Save as PDF”.</p><table>${rows}</table><script>window.onload=()=>setTimeout(()=>window.print(),150)<\/script></body></html>`);
  popup.document.close();
  setStatus("PDF export opened");
}

function openExportChoice() {
  if (!exportChoiceModal) return;
  exportChoiceModal.hidden = false;
}

function closeExportChoice() {
  if (exportChoiceModal) exportChoiceModal.hidden = true;
}

function updateSelectionUi() {
  if (selectionToolbar) selectionToolbar.hidden = !messageSelectionMode;
  if (selectionCount) selectionCount.textContent = `${selectedMessageIds.size} selected`;
  const selectAllButton = document.querySelector("[data-select-all-messages]");
  if (selectAllButton) {
    const total = messageArea?.querySelectorAll("[data-message-id]").length || 0;
    selectAllButton.textContent = total > 0 && selectedMessageIds.size >= total ? "Deselect All" : "Select All";
  }
  messageArea?.classList.toggle("selection-mode", messageSelectionMode);
}

function exitMessageSelection() {
  messageSelectionMode = false;
  selectedMessageIds.clear();
  updateSelectionUi();
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  if (conversationEntry) renderMessages(conversationEntry);
}

function enterMessageSelection(initialMessageId = null) {
  messageSelectionMode = true;
  selectedMessageIds.clear();
  if (initialMessageId) selectedMessageIds.add(initialMessageId);
  closeMessageDetails();
  updateSelectionUi();
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  if (conversationEntry) renderMessages(conversationEntry);
}

function toggleSelectedMessage(messageId) {
  if (selectedMessageIds.has(messageId)) selectedMessageIds.delete(messageId);
  else selectedMessageIds.add(messageId);
  updateSelectionUi();
  const bubble = messageArea.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  bubble?.classList.toggle("selected", selectedMessageIds.has(messageId));
  bubble?.closest(".message-row")?.classList.toggle("selected", selectedMessageIds.has(messageId));
  bubble?.setAttribute("aria-checked", selectedMessageIds.has(messageId) ? "true" : "false");
}

function openDeleteSelectedConfirmation() {
  if (!selectedMessageIds.size || !deleteConfirmModal) return;
  const count = selectedMessageIds.size;
  if (deleteConfirmCopy) {
    deleteConfirmCopy.textContent = `${count} message${count === 1 ? "" : "s"} will be hidden from this browser only. They cannot be removed from Kaspa.`;
  }
  deleteConfirmModal.hidden = false;
}

function closeDeleteSelectedConfirmation() {
  if (deleteConfirmModal) deleteConfirmModal.hidden = true;
}

function deleteSelectedMessages() {
  if (!selectedMessageIds.size) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  if (!conversationEntry) return;
  const count = selectedMessageIds.size;
  const removed = (conversationEntry.messages || []).filter((message) => selectedMessageIds.has(message.id));
  conversationEntry.hiddenMessageKeys = [...new Set([
    ...(conversationEntry.hiddenMessageKeys || []),
    ...removed.flatMap((message) => [message.id, message.txid].filter(Boolean).map(String)),
  ])];
  conversationEntry.messages = (conversationEntry.messages || []).filter((message) => !selectedMessageIds.has(message.id));
  const last = lastMessageFor(conversationEntry);
  conversationEntry.lastActivityAt = last?.createdAt || conversationEntry.createdAt;
  conversationEntry.updatedAt = Date.now();
  persistState();
  closeDeleteSelectedConfirmation();
  exitMessageSelection();
  setStatus(`${count} message${count === 1 ? "" : "s"} deleted locally`);
}

function onchainAmountKas() {
  return "0.2";
}

function closeOnchainConfirm() {
  pendingOnchainDraft = null;
  if (onchainConfirmModal) onchainConfirmModal.hidden = true;
}

function openOnchainConfirm({ conversationId, text }) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact || !onchainConfirmModal || !onchainSummary) return false;
  const envelope = engine.createMessageEnvelope({
    conversationId,
    contactId: contact.id,
    toAddress: contact.address,
    fromAddress: engine.address || null,
    text,
    alias: "KaChat",
    localNonce: nowId(),
    createdAt: Date.now(),
  });
  pendingOnchainDraft = { conversationId, text };
  onchainSummary.innerHTML = `
    <div class="confirm-row"><span>Contact</span><strong>${escapeHtml(contact.name)}</strong></div>
    <div class="confirm-row"><span>To</span><code>${escapeHtml(shortAddress(contact.address, 18))}</code></div>
    <div class="confirm-row"><span>Amount</span><strong>${escapeHtml(onchainAmountKas())} KAS</strong></div>
    <div class="confirm-row"><span>Payload</span><strong>${envelope.payloadBytes} bytes</strong></div>
    <div class="confirm-preview">${escapeHtml(text)}</div>
  `;
  onchainConfirmModal.hidden = false;
  return true;
}

// Full, unwrapped display text for a message — reply envelopes show just
// their own typed text, photo/audio envelopes show a friendly label. Used
// anywhere the raw wire content (JSON envelope) shouldn't leak into the UI.
function displayTextForMessage(message) {
  if (!message) return "";
  if (Chess.isChessEnvelope(Chess.unwrapReplyText(message.text))) return "♟ Chess";
  const replyEnvelope = parseReplyEnvelope(message.text);
  if (replyEnvelope) return replyEnvelope.text;
  if (parseImageEnvelope(message.text)) return "📷 Photo";
  if (parseAudioEnvelope(message.text)) return "🎤 Audio message";
  return message.text || "";
}

function openMessageDetails(messageId) {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const message = conversationEntry?.messages.find((entry) => entry.id === messageId);
  if (!message || !messageDetailsModal) return;
  activeMessageActionId = messageId;
  if (messageDetailsBody) messageDetailsBody.textContent = displayTextForMessage(message) || "Message";
  const explorerRow = document.querySelector("[data-message-explorer-row]");
  if (explorerRow) explorerRow.hidden = !message.txid;
  messageDetailsModal.hidden = false;
}

function conversationPreview(conversationEntry) {
  const contact = contactForConversation(conversationEntry);
  const last = lastMessageFor(conversationEntry);
  const reactionEvent = conversationEntry.lastReactionEvent;

  // If the most recent activity was a reaction (newer than the last real
  // message, or there's no message at all yet), the preview describes whose
  // message got reacted to rather than showing stale message text.
  if (reactionEvent && (!last || reactionEvent.timestamp >= last.createdAt)) {
    const targetMessage = conversationEntry.messages.find((entry) => entry.txid === reactionEvent.targetTxId || entry.id === reactionEvent.targetTxId);
    if (targetMessage) {
      return targetMessage.direction === "outgoing" ? "Reacted to your message" : "Reacted to their message";
    }
    return "Reacted to a message";
  }

  if (!last) return shortAddress(contact?.address || "");
  const prefix = last.direction === "outgoing" ? "You: " : "";
  return `${prefix}${displayTextForMessage(last)}`;
}

function sortedConversations() {
  return [...state.conversations]
    .filter((conversationEntry) => !conversationEntry.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt);
}

function appendEngineLog(message) {
  if (!engineLog) return;
  const line = typeof message === "string" ? message : JSON.stringify(message, null, 2);
  engineLog.textContent = `${line}\n${engineLog.textContent}`.trim();
}

async function copyTextToClipboard(value) {
  const text = String(value ?? "");
  if (!text) throw new Error("Nothing to copy");

  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access was blocked by the browser");
}

function showCopyToast(message) {
  if (!copyToast || !copyToastText) return;
  copyToastText.textContent = message;
  copyToast.hidden = false;
  requestAnimationFrame(() => copyToast.classList.add("visible"));
  window.clearTimeout(copyToastTimer);
  copyToastTimer = window.setTimeout(() => {
    copyToast.classList.remove("visible");
    window.setTimeout(() => { copyToast.hidden = true; }, 180);
  }, 1800);
}

function updateGlobalHealthIndicator() {
  if (!serviceHealthLed) return;

  const { stateName, latencyMs } = computeConnectionHealth();

  serviceHealthLed.classList.remove("ready", "busy", "error");
  serviceHealthLed.classList.add(stateName);
  if (serviceHealthButton) {
    const stateLabel = stateName === "error"
      ? "Disconnected"
      : stateName === "busy"
        ? `Connected · high latency${latencyMs ? ` (${latencyMs} ms)` : ""}`
        : "Connected";
    serviceHealthButton.setAttribute("aria-label", `${stateLabel}. Open Connection Status`);
    serviceHealthButton.title = stateLabel;
  }
}

function setStatus(text) {
  latestServiceStatusText = String(text || "Service status");
  updateGlobalHealthIndicator();
  renderTransportReadiness();
  if (connectionOverlay && !connectionOverlay.hidden) renderConnectionStatus();
}

function setService(indicator, label, stateName, text) {
  if (indicator) {
    indicator.classList.remove("ready", "busy", "error");
    if (stateName) indicator.classList.add(stateName);
  }
  if (label) label.textContent = text;
  updateGlobalHealthIndicator();
}

function setArchitectureBadge(element, stateName, text) {
  if (!element) return;
  element.classList.remove("ready", "busy", "error");
  if (stateName) element.classList.add(stateName);
  element.textContent = text;
}

function updateArchitectureDetails() {
  const connection = engine.connectionSnapshot?.() || {};
  const networkReady = Boolean(engine.rpc) && connection.primary === "ready";
  const standbyReady = Boolean(engine.standbyRpc) && connection.standby === "ready";
  const cipherReady = engine.isKasiaCipherLoaded?.() === true;
  const registry = engine.nodeRegistrySnapshot?.() || { endpoints: [], endpointCount: 0, totalSuccesses: 0, totalFailures: 0, lastGoodEndpoint: "", successfulFailovers: 0, failedFailovers: 0 };
  const activeEndpoint = engine.rpc?.url || connection.primaryEndpoint || "";
  const standbyEndpoint = engine.standbyRpc?.url || connection.standbyEndpoint || "";
  const lastGoodRecord = (registry.endpoints || []).find((entry) => entry.endpoint === registry.lastGoodEndpoint);

  if (nodePoolStatus) {
    nodePoolStatus.textContent = networkReady
      ? standbyReady
        ? `Primary + warm standby · ${activeEndpoint || "mainnet RPC"}`
        : `Primary active · standby ${connection.standby || "unavailable"}`
      : connection.failover && connection.failover !== "idle"
        ? `Failover ${connection.failover}`
        : registry.lastGoodEndpoint
          ? "Last-good-first · resolver fallback"
          : "Resolver discovery · persistent scoring enabled";
  }
  if (standbyStatus) {
    standbyStatus.textContent = standbyReady
      ? `Ready · ${standbyEndpoint}`
      : connection.standby === "connecting"
        ? "Connecting alternate synced RPC…"
        : connection.standby === "error"
          ? `Unavailable · ${connection.lastError || "connection failed"}`
          : networkReady
            ? "No independent standby available yet"
            : "Waiting for primary RPC";
  }
  if (lastGoodNodeStatus) {
    lastGoodNodeStatus.textContent = registry.lastGoodEndpoint
      ? `${registry.lastGoodEndpoint}${lastGoodRecord?.averageLatencyMs ? ` · ${lastGoodRecord.averageLatencyMs} ms avg` : ""}`
      : "None recorded yet";
  }
  if (nodePoolHistoryStatus) {
    nodePoolHistoryStatus.textContent = registry.endpointCount
      ? `${registry.endpointCount} observed · ${registry.totalSuccesses} successes · ${registry.totalFailures} failures · ${registry.successfulFailovers || 0}/${(registry.successfulFailovers || 0) + (registry.failedFailovers || 0)} failovers`
      : "No connection attempts recorded";
  }
  const subscription = engine.subscriptionSnapshot?.() || { status: "idle" };
  if (syncServiceStatus) syncServiceStatus.textContent = subscription.status === "ready"
    ? `Live wallet + ${Number(subscription.contactCount || 0)} contact subscription${Number(subscription.contactCount || 0) === 1 ? "" : "s"} · 5-second indexer fallback${subscription.lastEventType ? ` · last ${subscription.lastEventType}` : ""}`
    : subscription.status === "connecting"
      ? "Connecting live wallet UTXO subscription…"
      : subscription.status === "error"
        ? `Subscription error · ${subscription.lastError || "retrying on reconnect"}`
        : cipherReady ? "Waiting for wallet and primary RPC" : "Waiting for Kasia cipher";
  if (storageStatus) storageStatus.textContent = engine.address
    ? "Wallet, contacts, messages, node history and failover records persisted locally"
    : "Contacts, messages and node history persisted · wallet not loaded";
}

function updateServiceSummary() {
  const connection = engine.connectionSnapshot?.() || {};
  const runtimeReady = Boolean(engine.kaspa);
  const cipherReady = engine.isKasiaCipherLoaded?.() === true;
  const walletReady = Boolean(engine.address);
  const networkReady = Boolean(engine.rpc) && connection.primary === "ready";
  const standbyReady = Boolean(engine.standbyRpc) && connection.standby === "ready";
  const failoverBusy = connection.failover && connection.failover !== "idle";

  setService(runtimeIndicator, runtimeStatus, runtimeReady ? "ready" : "busy", runtimeReady ? `Rusty Kaspa ${engine.version?.() || "ready"}` : "Starting Rusty Kaspa…");
  setService(walletIndicator, walletStatus, walletReady ? "ready" : "", walletReady ? shortAddress(engine.address) : "Not loaded");
  setService(networkIndicator, networkStatus, networkReady ? "ready" : (connection.primary === "error" ? "error" : (walletReady ? "busy" : "")), networkReady ? `Connected · ${currentBalanceKas} KAS` : (connection.primary === "error" ? "No usable primary RPC" : (walletReady ? "Connecting…" : "Waiting for wallet")));
  setService(standbyIndicator, standbyStatus, standbyReady ? "ready" : (connection.standby === "error" ? "error" : (networkReady ? "busy" : "")), standbyReady ? `Ready · ${engine.standbyRpc?.url || connection.standbyEndpoint || "alternate RPC"}` : (networkReady ? (connection.standby === "connecting" ? "Connecting alternate synced RPC…" : "No independent standby available yet") : "Waiting for primary RPC"));
  setService(messagingIndicator, messagingStatus, cipherReady ? "ready" : "busy", cipherReady ? "Encryption runtime ready" : "Loading encryption runtime…");
  const subscription = engine.subscriptionSnapshot?.() || { status: "idle" };
  const subscriptionText = subscription.status === "ready"
    ? `Live subscription · wallet + ${Number(subscription.contactCount || 0)} contact${Number(subscription.contactCount || 0) === 1 ? "" : "s"}`
    : subscription.status === "connecting"
      ? "Connecting live wallet UTXO subscription…"
      : subscription.status === "error"
        ? `Subscription error · ${subscription.lastError || "unknown error"}`
        : "Waiting for wallet and primary RPC";
  setService(subscriptionIndicator, syncServiceStatus, subscription.status === "ready" ? "ready" : subscription.status === "error" ? "error" : "busy", subscriptionText);
  const networkBadgeState = networkReady && standbyReady && !failoverBusy ? "ready" : (connection.primary === "error" ? "error" : (walletReady ? "busy" : ""));
  const networkBadgeText = networkReady && standbyReady && !failoverBusy ? "Protected" : networkReady ? "Primary only" : connection.primary === "error" ? "Offline" : walletReady ? "Connecting" : "Waiting";
  setArchitectureBadge(networkBadge, networkBadgeState, networkBadgeText);
  setArchitectureBadge(messagingBadge, cipherReady ? "ready" : "busy", cipherReady ? "Ready" : "Starting");
  updateArchitectureDetails();
  updateGlobalHealthIndicator();
}

async function ensureRuntimes({ quiet = false } = {}) {
  let failed = false;
  if (!engine.kaspa) {
    try {
      if (!quiet) setStatus("Loading Rusty Kaspa…");
      await engine.loadWasm();
      appendEngineLog(`WASM loaded ${engine.version() || ""}`);
    } catch (error) {
      failed = true;
      appendEngineLog(`WASM failed: ${error.message}`);
      setService(runtimeIndicator, runtimeStatus, "error", "Rusty Kaspa failed to load");
    }
  }
  if (!engine.isKasiaCipherLoaded?.()) {
    try {
      if (!quiet) setStatus("Loading Kasia cipher…");
      await engine.loadKasiaCipher();
      appendEngineLog("Kasia cipher loaded.");
    } catch (error) {
      failed = true;
      appendEngineLog(`Cipher failed: ${error.message}`);
      setService(messagingIndicator, messagingStatus, "error", "Kasia cipher failed to load");
    }
  }
  updateServiceSummary();
  if (!failed && !quiet) setStatus("KaChat services ready");
  return !failed;
}

async function connectAndRefresh({ quiet = false } = {}) {
  if (!engine.address) {
    updateServiceSummary();
    return;
  }
  try {
    setService(networkIndicator, networkStatus, "busy", "Resolving mainnet RPC…");
    setArchitectureBadge(networkBadge, "busy", "Resolving");
    if (!quiet) setStatus("Resolving Kaspa nodes…");
    await engine.connect();
    setService(networkIndicator, networkStatus, "busy", "Connected · fetching balance…");
    setArchitectureBadge(networkBadge, "busy", "Syncing");
    if (!quiet) setStatus("Fetching wallet balance…");
    const balance = await engine.balance();
    refreshSubscriptionAddresses({ restart: false });
    await engine.startWalletSubscription({ force: false });
    currentBalanceKas = balance.totalKas ?? balance.kas ?? "--";
    updateWalletUi();
    updateServiceSummary();
    if (!quiet) setStatus("Ready");
    appendEngineLog(`Balance: ${currentBalanceKas} KAS / UTXOs: ${balance.entries.length}`);
  } catch (error) {
    setService(networkIndicator, networkStatus, "error", "Connection needs attention");
    if (!quiet) setStatus("Network unavailable");
    appendEngineLog(`Auto-connect failed: ${error.message}`);
  }
}

async function refreshBalanceOnly({ quiet = true } = {}) {
  if (!engine.address || balanceRefreshInFlight) return false;
  balanceRefreshInFlight = true;
  try {
    await engine.connect();
    const balance = await engine.balance();
    currentBalanceKas = balance.totalKas ?? balance.kas ?? "--";
    updateWalletUi();
    updateServiceSummary();
    if (!quiet) setStatus("Balance refreshed");
    return true;
  } catch (error) {
    if (!quiet) setStatus(`Refresh failed: ${error.message}`);
    appendEngineLog(`Balance refresh failed: ${error.message}`);
    return false;
  } finally {
    balanceRefreshInFlight = false;
  }
}

async function syncOneConversation(conversationEntry, { quiet = true } = {}) {
  const contact = contactForConversation(conversationEntry);
  if (!contact || !engine.address || !engine.isKasiaCipherLoaded?.()) return 0;
  const knownTxids = (conversationEntry.messages || []).map((message) => message.txid).filter(Boolean);
  const indexerUrl = indexerUrlInput?.value?.trim() || getEndpoint("kasiaIndexer");
  const result = await engine.syncConversationFromIndexer({
    conversationId: conversationEntry.id, contact, knownTxids,
    cursor: conversationEntry.sync?.cursor || 0, indexerUrl,
  });
  let added = 0;
  for (const incoming of result.messages || []) {
    const hiddenKeys = new Set((conversationEntry.hiddenMessageKeys || []).map(String));
    if ((incoming.txid && hiddenKeys.has(String(incoming.txid))) || (incoming.id && hiddenKeys.has(String(incoming.id)))) continue;
    if ((conversationEntry.messages || []).some((m) => m.txid && m.txid === incoming.txid)) continue;
    const message = createMessage({ ...incoming, conversationId: conversationEntry.id, contactId: contact.id });
    applyMessagePatch(message, incoming);
    appendIncomingOrReactionMessage(conversationEntry, message);
    maybeNotifyIncoming(conversationEntry, contact, message);
    added += 1;
  }
  try {
    const paymentResult = await engine.syncIncomingPayments({
      conversationId: conversationEntry.id,
      contact,
      knownTxids: (conversationEntry.messages || []).map((message) => message.txid).filter(Boolean),
      cursor: 0,
      limit: 100,
    });
    for (const incoming of paymentResult.messages || []) {
      if ((conversationEntry.messages || []).some((message) => message.txid && message.txid === incoming.txid)) continue;
      const message = createMessage({ ...incoming, conversationId: conversationEntry.id, contactId: contact.id });
      applyMessagePatch(message, incoming);
      appendIncomingOrReactionMessage(conversationEntry, message);
      added += 1;
    }
  } catch (error) {
    appendEngineLog(`Payment sync failed for ${contact.name}: ${error.message}`);
  }

  const paymentStatusChanged = await refreshPendingPaymentStatuses(conversationEntry, contact);
  if (paymentStatusChanged) persistState();
  if (added) promoteRelationshipFromIncomingEvidence(contact, conversationEntry, { persist: false });
  conversationEntry.sync = {
    ...(conversationEntry.sync || {}), lastSyncAt: Date.now(), lastFound: added,
    runs: Number(conversationEntry.sync?.runs || 0) + 1,
    cursor: Number(result.nextCursor || conversationEntry.sync?.cursor || 0),
    lastNote: result.note || "Automatic Kasia sync complete.",
    scannedCount: Number(result.scannedCount || 0), decryptFailures: Number(result.decryptFailures || 0), indexerUrl,
  };
  if (added && activeConversationId !== conversationEntry.id) conversationEntry.unreadCount = Number(conversationEntry.unreadCount || 0) + added;
  if ((added || paymentStatusChanged) && activeConversationId === conversationEntry.id) renderMessages(conversationEntry);
  if (!quiet && added) setStatus(`${added} new message${added === 1 ? "" : "s"}`);
  return added;
}

async function syncIncomingHandshakeRequests({ quiet = true } = {}) {
  if (!engine.address || !engine.isKasiaCipherLoaded?.() || typeof engine.syncIncomingHandshakesFromIndexer !== "function") return 0;
  // Handshake cursors and processed IDs must be scoped to the active wallet.
  // Step 64 reused one global cursor after wallet changes, which could skip a
  // brand-new wallet's incoming requests completely.
  if (handshakeSyncState.walletAddress !== engine.address) {
    handshakeSyncState = { walletAddress: engine.address, cursor: 0, parserVersion: 3, processedTxids: [], declinedTxids: [] };
    persistHandshakeSyncState();
    appendEngineLog(`Handshake scan reset for active wallet ${shortAddress(engine.address)}.`);
  }
  const result = await engine.syncIncomingHandshakesFromIndexer({
    knownTxids: handshakeSyncState.processedTxids,
    cursor: handshakeSyncState.cursor,
    indexerUrl: indexerUrlInput?.value || undefined,
  });
  let added = 0;
  const declined = new Set(handshakeSyncState.declinedTxids);
  for (const request of result.handshakes || []) {
    if (declined.has(request.txid)) continue;
    let contact = state.contacts.find((entry) => entry.address === request.sender);
    let conversationEntry = contact ? state.conversations.find((entry) => entry.contactId === contact.id) : null;
    let wasOutgoingRequest = false;
    if (!contact) {
      const createdAt = Number(request.createdAt || Date.now());
      const displayName = request.alias || shortAddress(request.sender);
      contact = {
        id: nowId(), name: displayName, nameIsCustom: false, address: request.sender, avatar: initialsFor(displayName),
        createdAt, updatedAt: createdAt, relationshipState: "incoming-request", handshakeTxid: "",
        incomingHandshakeTxid: request.txid, peerConversationId: request.conversationId || "",
      };
      conversationEntry = createConversation({ contactId: contact.id, createdAt });
      state.contacts.push(contact);
      state.conversations.push(conversationEntry);
    } else {
      wasOutgoingRequest = contact.relationshipState === "outgoing-request";
      contact.incomingHandshakeTxid = request.txid;
      contact.peerConversationId = request.conversationId || contact.peerConversationId || "";
      if (wasOutgoingRequest) {
        contact.relationshipState = "established";
        for (const existingMessage of conversationEntry?.messages || []) {
          if (existingMessage.messageType === "handshake" && existingMessage.direction === "outgoing" && existingMessage.status !== MESSAGE_STATUSES.FAILED) {
            applyMessagePatch(existingMessage, { status: MESSAGE_STATUSES.CONFIRMED, note: "Handshake completed", confirmations: Math.max(1, Number(existingMessage.confirmations || 0)) });
          }
        }
      } else if (contact.relationshipState !== "established") {
        // Restored/merged history (e.g. a phone-backup restore) can already prove both sides
        // were talking — the acceptance happened on the other device, so don't resurface
        // accept/decline for a conversation we clearly replied in.
        const alreadyTalking = (conversationEntry?.messages || []).some((m) =>
          m?.direction === "outgoing" && m?.messageType !== "handshake" && String(m?.text || "").trim().length > 0);
        contact.relationshipState = alreadyTalking ? "established" : "incoming-request";
      }
      if (request.alias && (!contact.name || contact.name.startsWith("kaspa:"))) contact.name = request.alias;
      if (!conversationEntry) {
        conversationEntry = createConversation({ contactId: contact.id, createdAt: Number(request.createdAt || Date.now()) });
        state.conversations.push(conversationEntry);
      }
    }
    const exists = (conversationEntry.messages || []).some((message) => message.txid === request.txid);
    if (!exists) {
      const message = createMessage({
        conversationId: conversationEntry.id, contactId: contact.id, direction: "incoming",
        text: wasOutgoingRequest ? "Handshake completed" : "Communication request received",
        sender: request.sender, receiver: engine.address,
        status: MESSAGE_STATUSES.CONFIRMED, transport: "kasia-indexer", createdAt: Number(request.createdAt || Date.now()),
      });
      applyMessagePatch(message, {
        txid: request.txid, messageType: "handshake", protocol: "kasia", protocolVersion: 1,
        payloadHex: request.payloadHex || "", encryptedHex: request.encryptedHex || "",
        daaScore: request.daaScore || null, acceptingBlock: request.acceptingBlock || null, confirmations: 1,
        note: wasOutgoingRequest ? "Handshake completed" : "Incoming communication request",
      });
      appendIncomingOrReactionMessage(conversationEntry, message);
      conversationEntry.unreadCount = Number(conversationEntry.unreadCount || 0) + 1;
      added += 1;
    }
    handshakeSyncState.processedTxids = [...new Set([...handshakeSyncState.processedTxids, request.txid])];
  }
  handshakeSyncState.walletAddress = engine.address;
  handshakeSyncState.cursor = Math.max(Number(handshakeSyncState.cursor || 0), Number(result.nextCursor || 0));
  persistHandshakeSyncState();
  appendEngineLog(`Incoming handshake audit: ${result.indexerScannedCount || 0} indexer row(s), ${result.restScannedCount || 0} REST row(s), ${added} new request(s)${result.errors?.length ? ` · ${result.errors.join(" | ")}` : ""}.`);
  if (added) {
    refreshSubscriptionAddresses({ restart: true });
    persistState();
    if (activeConversationId) {
      const active = state.conversations.find((entry) => entry.id === activeConversationId);
      if (active) renderMessages(active);
    } else renderChats();
    if (!quiet) setStatus(`${added} incoming communication request${added === 1 ? "" : "s"}`);
  }
  return added;
}

async function refreshAllConversations({ quiet = true } = {}) {
  if (messageRefreshInFlight || !engine.address || !engine.isKasiaCipherLoaded?.()) return 0;
  messageRefreshInFlight = true;
  let added = 0;
  try {
    try { added += await syncIncomingHandshakeRequests({ quiet }); }
    catch (error) { appendEngineLog(`Incoming handshake sync failed: ${error.message}`); }
    for (const conversationEntry of state.conversations || []) {
      const contact = contactForConversation(conversationEntry);
      // Match KaChat's relationship boundary: discovering an incoming
      // handshake must not import that unknown sender's historical contextual
      // messages before the user accepts the request.
      if (contact?.relationshipState === "incoming-request" || contact?.relationshipState === "declined") continue;
      try { added += await syncOneConversation(conversationEntry, { quiet }); }
      catch (error) { appendEngineLog(`Automatic message sync failed for ${conversationEntry.id}: ${error.message}`); }
    }
    persistState();
    if (!activeConversationId) renderChats();
    return added;
  } finally {
    messageRefreshInFlight = false;
  }
}

function startAutomaticRefresh() {
  if (!balanceRefreshTimer) balanceRefreshTimer = window.setInterval(() => refreshBalanceOnly({ quiet: true }), BALANCE_REFRESH_MS);
  if (!messageRefreshTimer) messageRefreshTimer = window.setInterval(() => refreshAllConversations({ quiet: true }), MESSAGE_REFRESH_MS);
}

function renderTransportReadiness() {
  updateServiceSummary();
  if (!readinessList) return;
  const items = [
    { label: "Engine message facade", ready: typeof engine.createMessageEnvelope === "function" && typeof engine.sendMessagePreview === "function" },
    { label: "Kasia COMM protocol builder", ready: typeof engine.buildCommMessage === "function", note: "matched wire container" },
    { label: "Official Kasia cipher WASM", ready: engine.isKasiaCipherLoaded?.() === true, note: engine.isKasiaCipherLoaded?.() ? "loaded / encrypted direct messages" : "run setup:cipher, then load" },
    { label: "Rusty Kaspa WASM loaded", ready: Boolean(engine.kaspa) },
    { label: "Session wallet loaded", ready: Boolean(engine.address) },
    { label: "Mainnet RPC connected", ready: Boolean(engine.rpc) },
    { label: "Live wallet and contact UTXO subscriptions", ready: engine.subscriptionSnapshot?.().status === "ready", note: `${engine.subscriptionSnapshot?.().contactCount || 0} contacts · ${engine.subscriptionSnapshot?.().status || "idle"}` },
    { label: "Real on-chain payload transport", ready: typeof engine.sendMessageOnchain === "function", note: "enabled / 0.2 KAS default" },
    { label: "Incoming Kasia payload decoder", ready: typeof engine.parseKasiaPayloadHex === "function", note: "preview" },
    { label: "Real Kasia indexer sync", ready: typeof engine.syncConversationFromIndexer === "function", note: indexerUrlInput?.value || "indexer.kasia.fyi" },
    { label: "Manual payload import", ready: typeof engine.parseKasiaPayloadHex === "function", note: "decoder" },
  ];

  readinessList.innerHTML = items.map((item) => `
    <div class="readiness-row ${item.ready ? "ready" : "pending"}">
      <span>${item.ready ? "✓" : "○"}</span>
      <strong>${escapeHtml(item.label)}</strong>
      <em>${escapeHtml(item.note || (item.ready ? "ready" : "not ready"))}</em>
    </div>
  `).join("");
}

// Step 104 — Settings-only overlay (Profile is its own full tab screen now,
// see setActiveAppTab below). Opened via the topbar health button or the
// gear icon on the Profile screen.
const accountOverlay = document.querySelector("[data-account-overlay]");

function openAccountOverlay() {
  accountOverlay.hidden = false;
  renderTransportReadiness();
  updateLocalStorageUsedLabel();
}

function closeAccountOverlay() {
  accountOverlay.hidden = true;
}

document.querySelector("[data-close-account-overlay]").addEventListener("click", closeAccountOverlay);
accountOverlay.addEventListener("click", (event) => {
  if (event.target === accountOverlay) closeAccountOverlay();
});

const connectionOverlay = document.querySelector("[data-connection-overlay]");

function openConnectionOverlay() {
  connectionOverlay.hidden = false;
  renderConnectionStatus();
}

function closeConnectionOverlay() {
  connectionOverlay.hidden = true;
}

document.querySelector("[data-open-connection-status]")?.addEventListener("click", openConnectionOverlay);
document.querySelector("[data-close-connection-overlay]").addEventListener("click", closeConnectionOverlay);
connectionOverlay.addEventListener("click", (event) => {
  if (event.target === connectionOverlay) closeConnectionOverlay();
});

document.querySelector("[data-connection-reconnect]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await connectAndRefresh(); }
  finally { button.disabled = false; renderConnectionStatus(); }
});

document.querySelector("[data-connection-refresh-standby]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { await engine.ensureStandby?.(); }
  finally { button.disabled = false; renderConnectionStatus(); }
});

document.querySelector("[data-connection-clear-pool]")?.addEventListener("click", () => {
  if (!confirm("Clear the connection pool? This removes all recorded endpoints and failover history from this browser. Your active connection is not affected.")) return;
  engine.clearNodeRegistry?.();
  showCopyToast("Connection pool cleared");
  renderConnectionStatus();
});

// Step 102/104 — 5-tab bottom-center navigation. Cold Storage/Portfolio/Swaps
// are placeholder screens for now; Chats is the existing sidebar+detail view;
// Profile is its own full-tab screen (mocked up to match iOS 3.0's design).
const sidebarTabButtons = document.querySelectorAll("[data-app-tab]");
const appTabScreens = document.querySelectorAll("[data-app-tab-screen]");

// Own-account version of the Chat Info Domains/Profile display: shows the
// resolved KNS domain + bio/links for the active wallet's own address when it
// owns one, otherwise leaves the existing "Create KNS Profile" CTA (real
// registration is a separate, later on-chain feature — this call is read-only).
let ownKnsAssetId = null;
let ownKnsProfileFields = null;

function updateProfileHero(info, profileInfo) {
  const bannerEl = document.querySelector("[data-profile-hero-banner]");
  const avatarEl = document.querySelector("[data-profile-hero-avatar]");
  const nameEl = document.querySelector("[data-profile-hero-name]");
  const bioEl = document.querySelector("[data-profile-hero-bio]");
  const domain = info?.explicitPrimaryDomain || info?.primaryDomain || "";
  const displayName = domain
    ? (domain.toLowerCase().endsWith(".kas") ? domain.slice(0, -4) : domain)
    : (activeAccountMetadata().name || "Account");
  if (nameEl) nameEl.textContent = displayName;
  const bio = profileInfo?.profile?.bio || "";
  if (bioEl) { bioEl.hidden = !bio; bioEl.textContent = bio; }
  const bannerUrl = profileInfo?.profile?.bannerUrl || "";
  if (bannerEl) bannerEl.style.backgroundImage = bannerUrl ? `url("${bannerUrl}")` : "";
  const avatarUrl = profileInfo?.profile?.avatarUrl || "";
  if (avatarEl) {
    avatarEl.innerHTML = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="" />`
      : `<svg viewBox="0 0 24 24"><path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.118a7.5 7.5 0 0 1 15 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.5-1.632Z"/></svg>`;
  }
}

async function refreshOwnKnsProfile() {
  if (!engine.address || !profileKnsOwned || !profileKnsEmptyCta) return;
  const address = engine.address;
  const [info, profileInfo] = await Promise.all([
    engine.fetchKnsAddressInfo(address).catch(() => null),
    engine.fetchKnsAddressProfile(address).catch(() => null),
  ]);
  if (engine.address !== address) return; // account switched mid-fetch
  updateProfileHero(info, profileInfo);

  if (!info?.primaryDomain) {
    profileKnsEmptyCta.hidden = false;
    profileKnsOwned.hidden = true;
    ownKnsAssetId = null;
    ownKnsProfileFields = null;
    return;
  }

  profileKnsEmptyCta.hidden = true;
  profileKnsOwned.hidden = false;
  if (profileKnsDomain) profileKnsDomain.textContent = info.primaryDomain;
  ownKnsAssetId = info.primaryInscriptionId || null;
  ownKnsProfileFields = profileInfo?.profile || null;

  const profile = profileInfo?.profile;
  if (profileKnsBio) {
    if (profile?.bio) { profileKnsBio.textContent = profile.bio; profileKnsBio.hidden = false; }
    else profileKnsBio.hidden = true;
  }
  if (profileKnsLinks) {
    profileKnsLinks.replaceChildren();
    const linkDefs = [
      ["website", "Website", KNSProfileLinkBuilder.websiteUrl],
      ["x", "X", KNSProfileLinkBuilder.xUrl],
      ["telegram", "Telegram", KNSProfileLinkBuilder.telegramUrl],
      ["discord", "Discord", KNSProfileLinkBuilder.discordUrl],
      ["github", "GitHub", KNSProfileLinkBuilder.githubUrl],
      ["contactEmail", "Email", KNSProfileLinkBuilder.emailUrl],
    ];
    for (const [field, label, builder] of linkDefs) {
      const raw = profile?.[field];
      if (!raw) continue;
      const href = builder(raw);
      if (!href) continue;
      const link = document.createElement("a");
      link.className = "chat-info-social-link";
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = label;
      profileKnsLinks.appendChild(link);
    }
  }
}

// --- Spending addresses (m/44'/111111'/1'/0/N). A second BIP44 account branch
// off the same seed, derived live from the recovery phrase + passphrase so the
// exact addresses restore identically on iOS/Android/desktop. Only the index
// bounds, hidden set, and labels are persisted (per wallet address), mirroring
// iOS's WalletManager+SpendingAddresses UserDefaults model. ---
const SPENDING_STATE_KEY = "kachat-spending-state-v1";
const spendingBalanceEl = document.querySelector("[data-spending-balance]");
const spendingManageScreen = document.querySelector("[data-spending-manage-screen]");
const spendingListEl = document.querySelector("[data-spending-address-list]");
const spendingGenerateBtn = document.querySelector("[data-spending-generate]");
const spendingScanBtn = document.querySelector("[data-spending-scan]");
const spendingConsolidateBtn = document.querySelector("[data-spending-consolidate]");
const spendingActionsToggle = document.querySelector("[data-spending-actions-toggle]");
const spendingActionsMenu = document.querySelector("[data-spending-actions-menu]");
let activeSpendingAddress = null;
let spendingConsolidating = false;
let spendingListToken = 0;
const SPENDING_GAP_LIMIT = 20;

function activeAccountMnemonic() {
  return activeSavedAccountRecord()?.mnemonic || "";
}

function activeAccountPassphrase() {
  return activeSavedAccountRecord()?.passphrase || "";
}

function loadAllSpendingState() {
  try { return JSON.parse(localStorage.getItem(SPENDING_STATE_KEY) || "{}") || {}; }
  catch { return {}; }
}

// Per-wallet spending state, sanitized. maxIndex is always ≥ activeIndex so the
// active address can never fall outside the revealed range.
function getSpendingState(address = engine.address) {
  const raw = (loadAllSpendingState() || {})[address] || {};
  const activeIndex = Math.max(0, Math.floor(Number(raw.activeIndex) || 0));
  const maxIndex = Math.max(activeIndex, Math.floor(Number(raw.maxIndex) || 0));
  const hidden = Array.isArray(raw.hidden)
    ? Array.from(new Set(raw.hidden.map(Number).filter((n) => Number.isInteger(n) && n >= 0)))
    : [];
  const labels = raw.labels && typeof raw.labels === "object" ? { ...raw.labels } : {};
  return { activeIndex, maxIndex, hidden, labels };
}

function saveSpendingState(patch, address = engine.address) {
  if (!address) return getSpendingState(address);
  const all = loadAllSpendingState();
  const next = { ...getSpendingState(address), ...patch };
  next.activeIndex = Math.max(0, Math.floor(Number(next.activeIndex) || 0));
  next.maxIndex = Math.max(next.activeIndex, Math.floor(Number(next.maxIndex) || 0));
  all[address] = next;
  localStorage.setItem(SPENDING_STATE_KEY, JSON.stringify(all));
  return next;
}

function getActiveSpendingIndex() {
  return getSpendingState().activeIndex;
}

function deriveSpendingAddressAt(index) {
  const mnemonic = activeAccountMnemonic();
  if (!mnemonic || !engine.kaspa) return null;
  try { return engine.deriveSpendingWallet(mnemonic, index, activeAccountPassphrase()).address; }
  catch (error) { appendEngineLog(`Spending derive #${index} failed: ${error.message}`); return null; }
}

function spendingLabelFor(state, index) {
  const custom = state.labels?.[index] ?? state.labels?.[String(index)];
  const trimmed = custom != null ? String(custom).trim() : "";
  if (trimmed) return trimmed;
  return index === 0 ? "Primary spending" : `Spending #${index}`;
}

// --- Profile card summary (active spending address + live balance) ---
async function refreshSpendingSummary() {
  const mnemonic = activeAccountMnemonic();
  if (!mnemonic || !engine.kaspa) {
    activeSpendingAddress = null;
    if (spendingBalanceEl) spendingBalanceEl.textContent = "-- KAS";
    return;
  }
  const address = deriveSpendingAddressAt(getActiveSpendingIndex());
  if (!address) {
    activeSpendingAddress = null;
    if (spendingBalanceEl) spendingBalanceEl.textContent = "-- KAS";
    return;
  }
  activeSpendingAddress = address;
  if (spendingBalanceEl) spendingBalanceEl.textContent = "…";
  try {
    const bal = await engine.balanceForAddress(address);
    // Guard against a stale response if the active address changed meanwhile.
    if (activeSpendingAddress === address && spendingBalanceEl) {
      spendingBalanceEl.textContent = `${bal.totalKas} KAS`;
    }
  } catch (error) {
    if (activeSpendingAddress === address && spendingBalanceEl) {
      spendingBalanceEl.textContent = "-- KAS";
    }
  }
}

// --- Manage Spending Addresses screen ---
const STAR_PATH = "m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.8 3 1.1-6.5L2.6 9.8l6.5-.9Z";
// Each row: tap the body to open the address's detail (transactions + send/
// receive); the ⋯ button opens a menu (Rename / Copy / Show QR / Set as Primary),
// matching iOS's ManageAddressesView.
function spendingRowHtml(index, address, state, balanceText, used) {
  const isActive = index === state.activeIndex;
  const label = spendingLabelFor(state, index);
  const usageBadge = used === true
    ? '<span class="spending-address-usage used">Used</span>'
    : used === false
      ? '<span class="spending-address-usage unused">Unused</span>'
      : "";
  const menuItems = [
    `<button type="button" role="menuitem" class="spending-row-menu-item" data-spending-action="rename" data-index="${index}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>Rename Address</button>`,
    `<button type="button" role="menuitem" class="spending-row-menu-item" data-spending-action="copy" data-index="${index}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>Copy Address</button>`,
    `<button type="button" role="menuitem" class="spending-row-menu-item" data-spending-action="receive" data-index="${index}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/></svg>Show QR Code</button>`,
    isActive ? "" : `<button type="button" role="menuitem" class="spending-row-menu-item" data-spending-action="activate" data-index="${index}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>Set as Primary Address</button>`,
  ].filter(Boolean).join("");
  return `
    <div class="spending-address-row${isActive ? " active" : ""}" data-spending-row="${index}">
      <button type="button" class="spending-address-row-main" data-spending-open="${index}" aria-label="Open spending address #${index}">
        <div class="spending-address-row-head">
          <span class="spending-address-index">#${index}</span>
          <span class="spending-address-label">${escapeHtml(label)}</span>
          ${isActive ? `<span class="spending-address-active-badge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg>Primary</span>` : ""}
          ${usageBadge}
        </div>
        <span class="spending-address-value">${escapeHtml(shortAddress(address))}</span>
        <span class="spending-address-balance" data-spending-balance-cell="${index}">${escapeHtml(balanceText)}</span>
        <span class="spending-address-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
      </button>
      <div class="spending-address-row-menu-wrap">
        <button type="button" class="spending-row-menu-btn" data-spending-menu-toggle="${index}" aria-haspopup="true" aria-expanded="false" aria-label="Address options">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
        </button>
        <div class="spending-row-menu" data-spending-menu="${index}" role="menu" hidden>${menuItems}</div>
      </div>
    </div>`;
}

// An address counts as "used" if it holds a balance now or has any on-chain
// transaction history — mirrors iOS's everUsed || balance>0.
async function spendingAddressHasHistory(address) {
  try {
    const url = `${getEndpoint("kaspaApi")}/addresses/${encodeURIComponent(address)}/full-transactions?limit=1&offset=0&resolve_previous_outpoints=no`;
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return false;
    const txs = await response.json();
    return Array.isArray(txs) && txs.length > 0;
  } catch { return false; }
}

async function renderSpendingList() {
  if (!spendingListEl) return;
  if (!activeAccountMnemonic()) {
    spendingListEl.innerHTML = '<p class="spending-address-empty">This account has no recovery phrase, so spending addresses aren\'t available.</p>';
    return;
  }
  const state = getSpendingState();
  const primaryIndex = state.activeIndex;
  const token = ++spendingListToken;
  const items = [];
  for (let i = 0; i <= state.maxIndex; i++) {
    const address = deriveSpendingAddressAt(i);
    if (address) items.push({ index: i, address });
  }
  if (!items.length) {
    spendingListEl.innerHTML = '<p class="spending-address-empty">No spending addresses yet.</p>';
    return;
  }
  // Provisional render (index order, balances pending) so the list appears at once.
  spendingListEl.innerHTML = items.map((it) => spendingRowHtml(it.index, it.address, state, "…", null)).join("");
  // Enrich each with balance + used-state, then order:
  //   primary first → funded (balance>0) by index → the rest by index.
  const enriched = await Promise.all(items.map(async (it) => {
    let kas = 0, totalKas = null;
    try { const bal = await engine.balanceForAddress(it.address); totalKas = bal.totalKas; kas = Number(bal.totalKas) || 0; }
    catch { /* leave balance unknown */ }
    const used = kas > 0 ? true : await spendingAddressHasHistory(it.address);
    return { ...it, kas, totalKas, used };
  }));
  if (token !== spendingListToken) return;
  const rank = (e) => (e.index === primaryIndex ? 0 : e.kas > 0 ? 1 : 2);
  enriched.sort((a, b) => rank(a) - rank(b) || a.index - b.index);
  spendingListEl.innerHTML = enriched
    .map((e) => spendingRowHtml(e.index, e.address, state, e.totalKas != null ? `${e.totalKas} KAS` : "-- KAS", e.used))
    .join("");
}

function openSpendingManageScreen() {
  if (!spendingManageScreen) return;
  if (!activeAccountMnemonic()) {
    showCopyToast("This account has no recovery phrase, so spending addresses aren't available.");
    return;
  }
  spendingManageScreen.hidden = false;
  renderSpendingList();
}

function closeSpendingManageScreen() {
  closeAllSpendingMenus();
  if (spendingManageScreen) spendingManageScreen.hidden = true;
}

function closeAllSpendingMenus() {
  spendingListEl?.querySelectorAll("[data-spending-menu]").forEach((m) => { m.hidden = true; });
  spendingListEl?.querySelectorAll("[data-spending-menu-toggle]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

spendingListEl?.addEventListener("click", async (event) => {
  // ⋯ menu toggle — open this row's menu, close any other.
  const toggle = event.target.closest("[data-spending-menu-toggle]");
  if (toggle) {
    const idx = toggle.dataset.spendingMenuToggle;
    const menu = spendingListEl.querySelector(`[data-spending-menu="${idx}"]`);
    const willOpen = menu && menu.hidden;
    closeAllSpendingMenus();
    if (menu && willOpen) { menu.hidden = false; toggle.setAttribute("aria-expanded", "true"); }
    return;
  }

  const btn = event.target.closest("[data-spending-action]");
  if (btn) {
    closeAllSpendingMenus();
    const index = Math.max(0, Math.floor(Number(btn.dataset.index) || 0));
    const action = btn.dataset.spendingAction;
    const state = getSpendingState();
    if (action === "activate") {
      saveSpendingState({ activeIndex: index });
      renderSpendingList();
      refreshSpendingSummary();
      showCopyToast(`Spending address #${index} is now the primary address.`);
    } else if (action === "copy") {
      const addr = deriveSpendingAddressAt(index);
      if (!addr) { showCopyToast("Address is not ready yet."); return; }
      try { await copyTextToClipboard(addr); showCopyToast("Spending address copied to clipboard."); }
      catch (error) { appendEngineLog(error.message); }
    } else if (action === "receive") {
      const addr = deriveSpendingAddressAt(index);
      if (!addr) { showCopyToast("Address is not ready yet."); return; }
      const cell = spendingListEl.querySelector(`[data-spending-balance-cell="${index}"]`);
      openChattingAddressScreen({ address: addr, balanceText: cell?.textContent || "", subtitle: null });
    } else if (action === "rename") {
      const current = spendingLabelFor(state, index);
      const next = window.prompt("Label for this spending address", current);
      if (next == null) return;
      const labels = { ...state.labels };
      const trimmed = String(next).trim();
      if (trimmed) labels[index] = trimmed; else { delete labels[index]; delete labels[String(index)]; }
      saveSpendingState({ labels });
      renderSpendingList();
    }
    return;
  }

  // Tapping the row body (not a control) opens the address detail screen.
  const open = event.target.closest("[data-spending-open]");
  if (open) {
    closeAllSpendingMenus();
    openSpendingDetailScreen(Math.max(0, Math.floor(Number(open.dataset.spendingOpen) || 0)));
  }
});

// Click anywhere outside an open row menu closes it.
document.addEventListener("click", (event) => {
  if (!event.target.closest(".spending-address-row-menu-wrap")) closeAllSpendingMenus();
});

// --- Spending address detail (balance + Transaction History / UTXOs + Receive /
// Send), mirrors iOS's SpendingAddressTransactionHistoryView. Reuses the
// address-parameterized transaction loader; UTXOs come from balanceForAddress. ---
const spendingDetailScreen = document.querySelector("[data-spending-detail-screen]");
const spendingDetailTitle = document.querySelector("[data-spending-detail-title]");
const spendingDetailBalanceEl = document.querySelector("[data-spending-detail-balance]");
const spendingDetailAddressEl = document.querySelector("[data-spending-detail-address]");
const spendingDetailExplorer = document.querySelector("[data-spending-detail-explorer]");
const spendingDetailTxList = document.querySelector("[data-spending-detail-transactions]");
const spendingDetailUtxoList = document.querySelector("[data-spending-detail-utxos]");
let spendingDetailIndex = 0;
let spendingDetailAddress = null;

function renderSpendingDetailUtxos(address, utxos) {
  if (!spendingDetailUtxoList) return;
  if (!utxos.length) { spendingDetailUtxoList.innerHTML = '<div class="manage-address-empty">No UTXOs at this address.</div>'; return; }
  const labels = getUtxoLabels(address);
  spendingDetailUtxoList.replaceChildren();
  for (const entry of utxos) {
    const outpointKey = utxoOutpointKey(entry.outpoint || {});
    const label = labels[outpointKey];
    const row = document.createElement("div");
    row.className = "manage-address-utxo-row";
    const meta = document.createElement("div"); meta.className = "manage-address-utxo-meta";
    if (label) { const l = document.createElement("span"); l.className = "manage-address-utxo-label"; l.textContent = label; meta.appendChild(l); }
    const op = document.createElement("span"); op.className = "manage-address-utxo-outpoint"; op.textContent = outpointKey; meta.appendChild(op);
    const amt = document.createElement("span"); amt.className = "manage-address-utxo-amount"; amt.textContent = `${sompiToKasDisplay(BigInt(entry.amount || 0))} KAS`;
    row.append(meta, amt);
    spendingDetailUtxoList.appendChild(row);
  }
}

async function loadSpendingDetailUtxos(address) {
  if (!spendingDetailUtxoList) return;
  spendingDetailUtxoList.innerHTML = '<div class="manage-address-empty">Loading…</div>';
  try {
    const balance = await engine.balanceForAddress(address);
    if (spendingDetailAddress !== address) return; // user navigated away
    renderSpendingDetailUtxos(address, balance.entries || []);
    if (spendingDetailBalanceEl) spendingDetailBalanceEl.textContent = `${balance.totalKas} KAS`;
  } catch (error) {
    if (spendingDetailAddress !== address) return;
    spendingDetailUtxoList.innerHTML = `<div class="manage-address-empty">Could not load UTXOs: ${escapeHtml(error.message)}</div>`;
  }
}

function setSpendingDetailTab(tab) {
  document.querySelectorAll("[data-spending-detail-tab]").forEach((b) => b.classList.toggle("active", b.dataset.spendingDetailTab === tab));
  document.querySelectorAll("[data-spending-detail-panel]").forEach((p) => { p.hidden = p.dataset.spendingDetailPanel !== tab; });
}

async function openSpendingDetailScreen(index) {
  if (!spendingDetailScreen) return;
  const address = deriveSpendingAddressAt(index);
  if (!address) { showCopyToast("Address is not ready yet."); return; }
  spendingDetailIndex = index;
  spendingDetailAddress = address;
  const state = getSpendingState();
  if (spendingDetailTitle) spendingDetailTitle.textContent = spendingLabelFor(state, index);
  if (spendingDetailAddressEl) spendingDetailAddressEl.textContent = shortAddress(address);
  if (spendingDetailBalanceEl) spendingDetailBalanceEl.textContent = "…";
  if (spendingDetailExplorer) spendingDetailExplorer.href = explorerAddressUrl(address);
  setSpendingDetailTab("transactions");
  spendingDetailScreen.hidden = false;
  loadManageAddressTransactions(address, spendingDetailTxList);
  loadSpendingDetailUtxos(address);
}

function closeSpendingDetailScreen() {
  if (spendingDetailScreen) spendingDetailScreen.hidden = true;
  spendingDetailAddress = null;
}

function refreshSpendingDetailIfOpen() {
  if (spendingDetailScreen && !spendingDetailScreen.hidden && spendingDetailAddress) {
    loadManageAddressTransactions(spendingDetailAddress, spendingDetailTxList);
    loadSpendingDetailUtxos(spendingDetailAddress);
  }
}

document.querySelectorAll("[data-spending-detail-tab]").forEach((b) => b.addEventListener("click", () => setSpendingDetailTab(b.dataset.spendingDetailTab)));
document.querySelector("[data-close-spending-detail]")?.addEventListener("click", closeSpendingDetailScreen);
document.querySelector("[data-spending-detail-receive]")?.addEventListener("click", () => {
  if (!spendingDetailAddress) return;
  openChattingAddressScreen({ address: spendingDetailAddress, balanceText: spendingDetailBalanceEl?.textContent || "", subtitle: null });
});
document.querySelector("[data-spending-detail-send]")?.addEventListener("click", () => openSpendingSendModal(spendingDetailIndex));

// "Address Actions" footer menu (Generate / Discover / Send All to Primary),
// matching iOS's toolbar Menu. Opens upward above the button.
function closeSpendingActionsMenu() {
  if (spendingActionsMenu) spendingActionsMenu.hidden = true;
  spendingActionsToggle?.setAttribute("aria-expanded", "false");
}
spendingActionsToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!spendingActionsMenu) return;
  const willOpen = spendingActionsMenu.hidden;
  spendingActionsMenu.hidden = !willOpen;
  spendingActionsToggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".spending-actions-wrap")) closeSpendingActionsMenu();
});

spendingGenerateBtn?.addEventListener("click", () => {
  closeSpendingActionsMenu();
  if (!activeAccountMnemonic()) { showCopyToast("This account has no recovery phrase."); return; }
  const state = getSpendingState();
  const nextIndex = state.maxIndex + 1;
  saveSpendingState({ maxIndex: nextIndex });
  renderSpendingList();
  showCopyToast(`Revealed spending address #${nextIndex}.`);
});

// Send All Kaspa to the primary spending address: sweep every non-primary
// spending address that holds a balance into the primary one (matches iOS's
// consolidateToPrimary). Money-moving — confirmed first, fires one tx per source.
spendingConsolidateBtn?.addEventListener("click", async () => {
  closeSpendingActionsMenu();
  if (spendingConsolidating) return;
  if (!activeAccountMnemonic()) { showCopyToast("This account has no recovery phrase."); return; }
  const state = getSpendingState();
  const primaryIndex = state.activeIndex;
  const primaryAddress = deriveSpendingAddressAt(primaryIndex);
  if (!primaryAddress) { showCopyToast("Primary spending address is not ready yet."); return; }

  spendingConsolidating = true;
  const label = spendingConsolidateBtn.querySelector("span");
  const original = label?.textContent;
  try {
    // Find every non-primary funded address.
    const sources = [];
    for (let i = 0; i <= state.maxIndex; i++) {
      if (i === primaryIndex) continue;
      const addr = deriveSpendingAddressAt(i);
      if (!addr) continue;
      try {
        const bal = await engine.balanceForAddress(addr);
        const kas = Number(bal?.totalKas) || 0;
        if (kas > 0) sources.push({ index: i, kas });
      } catch { /* skip on lookup failure */ }
    }
    if (!sources.length) { showCopyToast("No non-primary spending addresses hold a balance."); return; }

    const total = sources.reduce((sum, s) => sum + s.kas, 0);
    const ok = window.confirm(
      `Send all Kaspa from ${sources.length} spending address${sources.length > 1 ? "es" : ""} (~${total} KAS) to your primary spending address #${primaryIndex}?\n\nThis broadcasts ${sources.length} transaction${sources.length > 1 ? "s" : ""}.`
    );
    if (!ok) return;

    if (label) label.textContent = "Sending…";
    // 0.0001 KAS headroom over the network fee — same buffer the Max button uses.
    const FEE_BUFFER = 0.0001;
    let sent = 0;
    for (const src of sources) {
      const amountKas = src.kas - FEE_BUFFER;
      if (amountKas <= 0) continue;
      try {
        await engine.sendFromSpending({
          mnemonic: activeAccountMnemonic(),
          index: src.index,
          passphrase: activeAccountPassphrase(),
          destinationAddress: primaryAddress,
          amountKas: String(amountKas),
          feeKas: "0",
          selectedOutpoints: null,
        });
        sent += 1;
      } catch (error) {
        appendEngineLog(`Consolidate #${src.index} failed: ${error.message}`);
      }
    }
    showCopyToast(sent ? `Swept ${sent} address${sent > 1 ? "es" : ""} to your primary address.` : "Nothing could be swept.");
    renderSpendingList();
    refreshSpendingSummary();
    refreshSpendingDetailIfOpen();
  } finally {
    spendingConsolidating = false;
    if (label && original != null) label.textContent = original;
  }
});

// Gap-limit scan: reveal addresses beyond the current max that already hold a
// balance, mirroring standard BIP44 recovery. Balance-based (desktop has no
// message-history index here); stops after SPENDING_GAP_LIMIT empties in a row.
spendingScanBtn?.addEventListener("click", async () => {
  closeSpendingActionsMenu();
  if (!activeAccountMnemonic()) { showCopyToast("This account has no recovery phrase."); return; }
  const label = spendingScanBtn.querySelector("span");
  const original = label?.textContent;
  spendingScanBtn.disabled = true;
  if (label) label.textContent = "Scanning…";
  try {
    const state = getSpendingState();
    let index = state.maxIndex + 1;
    let consecutiveEmpty = 0;
    let highestFunded = state.maxIndex;
    while (consecutiveEmpty < SPENDING_GAP_LIMIT) {
      const addr = deriveSpendingAddressAt(index);
      if (!addr) break;
      let held = 0;
      try { const bal = await engine.balanceForAddress(addr); held = Number(bal?.totalKas) || 0; }
      catch { break; }
      if (held > 0) { highestFunded = index; consecutiveEmpty = 0; }
      else consecutiveEmpty += 1;
      index += 1;
    }
    if (highestFunded > state.maxIndex) {
      saveSpendingState({ maxIndex: highestFunded });
      renderSpendingList();
      showCopyToast(`Found funded addresses up to #${highestFunded}.`);
    } else {
      showCopyToast("No additional funded spending addresses found.");
    }
  } finally {
    spendingScanBtn.disabled = false;
    if (label && original != null) label.textContent = original;
  }
});

document.querySelector("[data-copy-spending-address]")?.addEventListener("click", async () => {
  if (!activeSpendingAddress) { showCopyToast("Spending address is not ready yet."); return; }
  try { await copyTextToClipboard(activeSpendingAddress); showCopyToast("Spending address copied to clipboard."); }
  catch (error) { appendEngineLog(error.message); }
});
document.querySelector("[data-open-spending-receive]")?.addEventListener("click", () => {
  if (!activeSpendingAddress) { showCopyToast("Spending address is not ready yet."); return; }
  openChattingAddressScreen({ address: activeSpendingAddress, balanceText: spendingBalanceEl?.textContent || "", subtitle: null });
});
document.querySelector("[data-open-spending-send]")?.addEventListener("click", () => openSpendingSendModal(getActiveSpendingIndex()));
document.querySelector("[data-open-spending-manage]")?.addEventListener("click", openSpendingManageScreen);
document.querySelector("[data-close-spending-manage]")?.addEventListener("click", closeSpendingManageScreen);

// --- Send from a spending address (Stage C). Reuses makeSendController with a
// spending-scoped sendFn (engine.sendFromSpending) + balance source, so recipient
// resolution / amount validation / progress behave exactly like the chatting send. ---
const spendingSendModal = document.querySelector("[data-spending-send-modal]");
const spendingSendSourceEl = document.querySelector("[data-spending-send-source]");
const spendingSendFeeButtons = document.querySelectorAll("[data-spending-send-fee]");
const spendingSendFeeCustom = document.querySelector("[data-spending-send-fee-custom]");
const spendingSendFeeSummary = document.querySelector("[data-spending-send-fee-summary]");
let spendingSendIndex = 0;
let spendingSendFeeTier = "0";

function spendingSendGetFeeKas() {
  const v = Number(spendingSendFeeCustom?.value);
  return isFinite(v) && v > 0 ? String(v) : "0";
}
function updateSpendingSendFeeSummary() {
  if (!spendingSendFeeSummary) return;
  const labels = { "0": "Normal", "0.00002": "Priority", custom: "Custom" };
  spendingSendFeeSummary.textContent = `${labels[spendingSendFeeTier] || "Normal"} · ${spendingSendGetFeeKas()} KAS`;
}
function selectSpendingSendFeeTier(tier) {
  spendingSendFeeTier = tier;
  spendingSendFeeButtons.forEach((b) => b.classList.toggle("active", b.dataset.spendingSendFee === tier));
  if (spendingSendFeeCustom) {
    if (tier === "custom") { spendingSendFeeCustom.readOnly = false; spendingSendFeeCustom.value = ""; spendingSendFeeCustom.focus(); }
    else { spendingSendFeeCustom.readOnly = true; spendingSendFeeCustom.value = tier; }
  }
  updateSpendingSendFeeSummary();
}
spendingSendFeeButtons.forEach((b) => b.addEventListener("click", () => selectSpendingSendFeeTier(b.dataset.spendingSendFee)));
spendingSendFeeCustom?.addEventListener("input", updateSpendingSendFeeSummary);

function closeSpendingSendModal() { if (spendingSendModal) spendingSendModal.hidden = true; }

const spendingSendController = makeSendController({
  recipient: document.querySelector("[data-spending-send-recipient]"),
  resolvedHint: document.querySelector("[data-spending-send-resolved]"),
  amount: document.querySelector("[data-spending-send-amount]"),
  balanceHint: document.querySelector("[data-spending-send-balance]"),
  error: document.querySelector("[data-spending-send-error]"),
  progress: document.querySelector("[data-spending-send-progress]"),
  submit: document.querySelector("[data-spending-send-submit]"),
}, {
  onOpen: () => { if (spendingSendModal) spendingSendModal.hidden = false; },
  onClose: () => { closeSpendingSendModal(); if (spendingManageScreen && !spendingManageScreen.hidden) renderSpendingList(); refreshSpendingDetailIfOpen(); refreshSpendingSummary(); },
  getFeeKas: spendingSendGetFeeKas,
  getBalance: () => engine.balanceForAddress(deriveSpendingAddressAt(spendingSendIndex)),
  sendFn: ({ destination, amountKas, feeKas, selectedOutpoints }) => engine.sendFromSpending({
    mnemonic: activeAccountMnemonic(),
    index: spendingSendIndex,
    passphrase: activeAccountPassphrase(),
    destinationAddress: destination,
    amountKas,
    feeKas,
    selectedOutpoints: selectedOutpoints && selectedOutpoints.length ? selectedOutpoints : null,
  }),
});

function openSpendingSendModal(index) {
  if (!activeAccountMnemonic()) {
    showCopyToast("This account has no recovery phrase, so spending sends aren't available.");
    return;
  }
  spendingSendIndex = Math.max(0, Math.floor(Number(index) || 0));
  const addr = deriveSpendingAddressAt(spendingSendIndex);
  if (!addr) { showCopyToast("Spending address is not ready yet."); return; }
  if (spendingSendSourceEl) spendingSendSourceEl.textContent = `From spending #${spendingSendIndex} · ${shortAddress(addr)}`;
  selectSpendingSendFeeTier("0");
  spendingSendController.open();
}

document.querySelectorAll("[data-close-spending-send]").forEach((b) => b.addEventListener("click", closeSpendingSendModal));

// Refresh keeps your place: the active tab persists and is re-applied at boot (the
// screens themselves refetch their data, so the restored spot is fresh, not a snapshot).
const UI_SPOT_TAB_KEY = "kachat-ui-spot-tab-v1";

function restoreLastAppTab() {
  try {
    const tab = localStorage.getItem(UI_SPOT_TAB_KEY);
    if (tab && tab !== "chats" && document.querySelector(`.sidebar-tab[data-app-tab="${tab}"]`)) {
      setActiveAppTab(tab);
      applyDockLayout(); // falls back to chats if this account hides that tab
    }
  } catch { /* restoring the spot is best-effort */ }
}

function setActiveAppTab(tab) {
  try { localStorage.setItem(UI_SPOT_TAB_KEY, tab); } catch { /* best-effort */ }
  sidebarTabButtons.forEach((button) => {
    const active = button.dataset.appTab === tab;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  currentAppTab = tab;
  const isChats = tab === "chats";
  if (appSidebar) appSidebar.hidden = !isChats;
  if (newChatFab) newChatFab.hidden = !isChats;
  appTabScreens.forEach((screen) => {
    screen.hidden = screen.dataset.appTabScreen !== tab;
  });
  if (!isChats) {
    if (conversation) conversation.hidden = true;
    if (detailEmptyState) detailEmptyState.hidden = true;
  } else {
    if (conversation) conversation.hidden = !activeConversationId;
    if (detailEmptyState) detailEmptyState.hidden = Boolean(activeConversationId);
  }
  updateDetailActiveClass();
  if (tab === "profile") { refreshOwnKnsProfile(); refreshSpendingSummary(); }
  if (tab === "kaposts") refreshKaPostsFeed();
  if (tab === "broadcasts") refreshBroadcasts();
  else stopBroadcastPolling();
  if (tab === "portfolio") refreshPortfolio();
  if (tab === "cold-storage") refreshColdStorage();
  if (tab === "swaps") refreshSwaps();
}

sidebarTabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveAppTab(button.dataset.appTab);
    applyDockLayout();
  });
});

// 4.0 dock auto-hide: the dock sits centered at the bottom but stays tucked away until the
// pointer nears the bottom edge (macOS-dock style). It also shows briefly after a tab
// switch so the selection change is visible, and always shows while it has keyboard focus.
const dockBar = document.querySelector(".sidebar-tabbar");
const DOCK_REVEAL_ZONE_PX = 110;
let dockHideTimer = null;

function showDock() {
  if (!dockBar) return;
  dockBar.classList.remove("dock-hidden");
  if (dockHideTimer) { clearTimeout(dockHideTimer); dockHideTimer = null; }
}

function hideDockSoon(delay = 400) {
  if (!dockBar) return;
  if (dockHideTimer) clearTimeout(dockHideTimer);
  dockHideTimer = window.setTimeout(() => {
    if (dockBar.matches(":hover") || dockBar.contains(document.activeElement)) return;
    dockBar.classList.add("dock-hidden");
  }, delay);
}

if (dockBar) {
  window.addEventListener("mousemove", (event) => {
    // No bottom-edge reveal while a modal dialog is up — the dock would slide over the
    // dialog's own bottom buttons (e.g. the Cold Storage send flow's Scan button).
    if (document.querySelector(".modal-backdrop:not([hidden])")) { hideDockSoon(); return; }
    if (window.innerHeight - event.clientY <= DOCK_REVEAL_ZONE_PX) showDock();
    else hideDockSoon();
  }, { passive: true });
  dockBar.addEventListener("focusin", showDock);
  dockBar.addEventListener("focusout", () => hideDockSoon(800));
  // Tab switches surface the dock for a moment so the new selection is visible.
  sidebarTabButtons.forEach((button) => {
    button.addEventListener("click", () => { showDock(); hideDockSoon(1600); });
  });
  // Start revealed so first-time users see the dock exists, then tuck away.
  hideDockSoon(2600);
}

// Menu customization (Settings > Customization > Menu) — which dock tabs appear.
// Chats and Profile are always shown (like iOS); Portfolio, Cold Storage and Swap
// can be hidden. Hidden ids persist in accountShellPrefs.hiddenTabs.
// ---------------------------------------------------------------------------
// 4.0 dock model, desktop variant: unlike iOS (5-tab cap with KaPosts/Broadcasts
// riding a Chats-slot cycle), a desktop window fits everything — every enabled
// tab renders directly in the dock. Dock config (hidden + order) is PER ACCOUNT.
// ---------------------------------------------------------------------------

const DOCK_PREFS_KEY = "kachat-dock-prefs-v1"; // account-scoped: { hiddenTabs, order }
const DOCK_DEFAULT_ORDER = ["cold-storage", "portfolio", "chats", "kaposts", "broadcasts", "swaps", "profile"];
const DOCK_ALWAYS_VISIBLE = ["chats", "profile"];
const MENU_TOGGLEABLE_TABS = ["portfolio", "cold-storage", "swaps", "kaposts", "broadcasts"];

function loadDockPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(accountScopedKey(DOCK_PREFS_KEY)) || "null");
    if (parsed && typeof parsed === "object") {
      return {
        hiddenTabs: Array.isArray(parsed.hiddenTabs) ? parsed.hiddenTabs : [],
        order: Array.isArray(parsed.order) ? parsed.order : [...DOCK_DEFAULT_ORDER],
      };
    }
  } catch { /* fall through */ }
  // Migration: adopt the old global hiddenTabs the first time an account loads.
  const legacy = Array.isArray(accountShellPrefs.hiddenTabs) ? accountShellPrefs.hiddenTabs : [];
  return { hiddenTabs: [...legacy], order: [...DOCK_DEFAULT_ORDER] };
}

let dockPrefs = loadDockPrefs();

function persistDockPrefs() {
  localStorage.setItem(accountScopedKey(DOCK_PREFS_KEY), JSON.stringify(dockPrefs));
}

function reloadDockPrefsForAccount() {
  dockPrefs = loadDockPrefs();
  applyDockLayout();
}

function isTabHidden(tab) {
  return dockPrefs.hiddenTabs.includes(tab);
}

function dockResolvedOrder() {
  const known = DOCK_DEFAULT_ORDER;
  const order = dockPrefs.order.filter((t) => known.includes(t));
  return [...order, ...known.filter((t) => !order.includes(t))];
}

/** The tabs the dock actually renders, in order — every enabled tab, no cap. */
function dockVisibleTabs() {
  return dockResolvedOrder().filter((t) => DOCK_ALWAYS_VISIBLE.includes(t) || !isTabHidden(t));
}

function applyDockLayout() {
  const tabbar = document.querySelector(".sidebar-tabbar");
  if (!tabbar) return;
  const visible = dockVisibleTabs();

  // Order + visibility straight from the per-account prefs.
  for (const tab of dockResolvedOrder()) {
    const btn = tabbar.querySelector(`.sidebar-tab[data-app-tab="${tab}"]`);
    if (!btn) continue;
    tabbar.appendChild(btn);
    btn.hidden = !visible.includes(tab);
  }

  // Menu checkboxes mirror the state.
  MENU_TOGGLEABLE_TABS.forEach((tab) => {
    const input = document.querySelector(`[data-menu-tab="${tab}"]`);
    if (input) input.checked = !isTabHidden(tab);
  });

  const activeBtn = tabbar.querySelector(".sidebar-tab.active");
  if (activeBtn && activeBtn.hidden) setActiveAppTab("chats");
}

function applyMenuTabVisibility() { applyDockLayout(); }

document.querySelectorAll("[data-menu-tab]").forEach((input) => {
  input.addEventListener("change", () => {
    const tab = input.dataset.menuTab;
    let hidden = [...dockPrefs.hiddenTabs];
    if (input.checked) hidden = hidden.filter((t) => t !== tab);
    else if (!hidden.includes(tab)) hidden.push(tab);
    dockPrefs.hiddenTabs = hidden;
    persistDockPrefs();
    applyDockLayout();
  });
});
applyDockLayout();

// --- What's-new wizard (once per install) ---------------------------------

const DOCK_WIZARD_DISMISSED_KEY = "kachat-dock-wizard-dismissed-v1";
const DOCK_WIZARD_PAGES = [
  { title: "Meet KaPosts", body: "A social feed built on Kaspa — post, follow, and discover, fully on-chain. It lives in your dock now." },
  { title: "The dock hides itself", body: "Your dock stays tucked away until your mouse nears the bottom of the window — glide down to bring it up." },
  { title: "Make it yours", body: "Choose which tabs show from Settings → Customization → Menu. Each account keeps its own dock." },
];
let dockWizardPage = 0;

function renderDockWizard() {
  const backdrop = document.querySelector("[data-dock-wizard]");
  const pageEl = document.querySelector("[data-dock-wizard-page]");
  const dotsEl = document.querySelector("[data-dock-wizard-dots]");
  const nextBtn = document.querySelector("[data-dock-wizard-next]");
  if (!backdrop || !pageEl) return;
  const page = DOCK_WIZARD_PAGES[dockWizardPage];
  pageEl.innerHTML = `<h3>${page.title}</h3><p>${page.body}</p>`;
  if (dotsEl) {
    dotsEl.innerHTML = DOCK_WIZARD_PAGES
      .map((_, i) => `<span class="${i === dockWizardPage ? "active" : ""}"></span>`).join("");
  }
  if (nextBtn) nextBtn.textContent = dockWizardPage === DOCK_WIZARD_PAGES.length - 1 ? "Get Started" : "Next";
}

function dismissDockWizard() {
  localStorage.setItem(DOCK_WIZARD_DISMISSED_KEY, "1");
  const backdrop = document.querySelector("[data-dock-wizard]");
  if (backdrop) backdrop.hidden = true;
}

function maybeShowDockWizard() {
  if (localStorage.getItem(DOCK_WIZARD_DISMISSED_KEY)) return;
  if (!engine.address) return;
  dockWizardPage = 0;
  renderDockWizard();
  const backdrop = document.querySelector("[data-dock-wizard]");
  if (backdrop) backdrop.hidden = false;
}

document.querySelector("[data-dock-wizard-skip]")?.addEventListener("click", dismissDockWizard);
document.querySelector("[data-dock-wizard-next]")?.addEventListener("click", () => {
  if (dockWizardPage >= DOCK_WIZARD_PAGES.length - 1) { dismissDockWizard(); return; }
  dockWizardPage += 1;
  renderDockWizard();
});

// Step 104 — Profile screen mockup wiring. QR buttons reveal the existing
// real QR card; address dropdowns expand/collapse; anything without real
// desktop backend yet (KNS, spending address, withdraw, transaction history,
// manage addresses, gift) just surfaces a "Coming soon" toast.
// "Receive Kaspa" opens the same full-screen QR view as Chatting Address (and the
// spending-address Receive), just without the chat-fee note — the old inline
// profile-qr-card toggle looked nothing like it.
document.querySelectorAll("[data-profile-qr-trigger]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!engine.address) return;
    openChattingAddressScreen({ subtitle: null });
  });
});

async function openChattingAddressScreen(options = {}) {
  if (!chattingAddressScreen) return;
  const address = options.address || engine.address;
  if (!address) return;
  const balanceText = options.balanceText != null ? options.balanceText : `${currentBalanceKas} KAS`;
  chattingAddressScreen.hidden = false;
  // Subtitle: default chat-fee note for the chatting address; callers pass their
  // own text (or null to hide it) — spending receive hides the chat-fee note.
  const subtitleEl = document.querySelector("[data-chatting-address-subtitle]");
  if (subtitleEl) {
    if (options.subtitle === undefined) {
      subtitleEl.hidden = false;
      subtitleEl.textContent = "Just send 5-10 KAS at a time, that's plenty to cover chat fees for a while (about 500 messages per KAS).";
    } else if (options.subtitle) {
      subtitleEl.hidden = false;
      subtitleEl.textContent = options.subtitle;
    } else {
      subtitleEl.hidden = true;
    }
  }
  if (chattingAddressValue) chattingAddressValue.textContent = address;
  if (chattingAddressBalance) chattingAddressBalance.textContent = balanceText;
  if (chattingAddressQr) {
    const ctx = chattingAddressQr.getContext("2d");
    ctx.clearRect(0, 0, chattingAddressQr.width, chattingAddressQr.height);
    try { await engine.drawQrFor(chattingAddressQr, address, { dark: "#06110f", light: "#ffffff" }); }
    catch (error) { appendEngineLog(`QR failed: ${error.message}`); }
  }
}

function closeChattingAddressScreen() {
  if (chattingAddressScreen) chattingAddressScreen.hidden = true;
}

document.querySelector("[data-open-chatting-address]")?.addEventListener("click", openChattingAddressScreen);
document.querySelector("[data-close-chatting-address]")?.addEventListener("click", closeChattingAddressScreen);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && chattingAddressScreen && !chattingAddressScreen.hidden) closeChattingAddressScreen();
});

// --- Profile > Apps and Help screens (iOS ProfileAppsView / ProfileHelpView).
// Both follow the full-screen overlay pattern of the address screens: back
// button and Escape close them. The Help rows launch the existing guides
// (setup guide modals sit below the 1500 z-band, so close Help first).
const appsScreenEl = document.querySelector("[data-apps-screen]");
const helpScreenEl = document.querySelector("[data-help-screen]");

document.querySelector("[data-open-apps-screen]")?.addEventListener("click", () => {
  if (appsScreenEl) appsScreenEl.hidden = false;
});
document.querySelector("[data-close-apps-screen]")?.addEventListener("click", () => {
  if (appsScreenEl) appsScreenEl.hidden = true;
});
document.querySelector("[data-open-help-screen]")?.addEventListener("click", () => {
  if (helpScreenEl) helpScreenEl.hidden = false;
});
document.querySelector("[data-close-help-screen]")?.addEventListener("click", () => {
  if (helpScreenEl) helpScreenEl.hidden = true;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (appsScreenEl && !appsScreenEl.hidden) appsScreenEl.hidden = true;
  else if (helpScreenEl && !helpScreenEl.hidden) helpScreenEl.hidden = true;
});

document.querySelector("[data-help-welcome]")?.addEventListener("click", () => {
  if (helpScreenEl) helpScreenEl.hidden = true;
  openSetupGuide();
});
document.querySelector("[data-help-kns]")?.addEventListener("click", () => {
  if (helpScreenEl) helpScreenEl.hidden = true;
  document.querySelector("[data-open-kns-register]")?.click();
});
document.querySelector("[data-help-dock]")?.addEventListener("click", () => {
  if (helpScreenEl) helpScreenEl.hidden = true;
  dockWizardPage = 0;
  renderDockWizard();
  const backdrop = document.querySelector("[data-dock-wizard]");
  if (backdrop) backdrop.hidden = false;
});

// --- Profile > About: Version and Donate (iOS aboutSection). Donate resolves
// kachat.kas and jumps straight into that chat in payment mode.
const APP_VERSION = "2.0.11"; // keep in step with package.json
const profileVersionEl = document.querySelector("[data-profile-version]");
if (profileVersionEl) profileVersionEl.textContent = APP_VERSION;

const DONATE_DOMAIN = "kachat.kas";
let donateResolving = false;

document.querySelector("[data-profile-donate]")?.addEventListener("click", async () => {
  if (donateResolving) return;
  donateResolving = true;
  const labelEl = document.querySelector("[data-profile-donate-label]");
  if (labelEl) labelEl.textContent = "Resolving…";
  try {
    await ensureRuntimes({ quiet: true });
    if (!engine.address) throw new Error("Generate or import a wallet first.");
    const resolution = await engine.resolveKnsDomain(DONATE_DOMAIN);
    if (!resolution) throw new Error(`Couldn't resolve ${DONATE_DOMAIN}. Please try again later.`);
    const address = validateContactAddress(resolution.ownerAddress);
    let contact = state.contacts.find((entry) => entry.address === address);
    if (!contact) {
      const createdAt = Date.now();
      contact = {
        id: nowId(), name: resolution.domain || DONATE_DOMAIN, nameIsCustom: false, address,
        avatar: initialsFor(resolution.domain || DONATE_DOMAIN), createdAt, updatedAt: createdAt,
        relationshipState: "legacy-manual", handshakeTxid: "",
      };
      state.contacts.push(contact);
    }
    let conversationEntry = state.conversations.find((entry) => entry.contactId === contact.id);
    if (!conversationEntry) {
      conversationEntry = createConversation({ contactId: contact.id, createdAt: Date.now() });
      state.conversations.push(conversationEntry);
      refreshSubscriptionAddresses({ restart: true });
      persistState();
    }
    setActiveAppTab("chats");
    openConversation(conversationEntry.id);
    await activateComposerMode("kas");
  } catch (error) {
    showCopyToast(error?.message || `Couldn't resolve ${DONATE_DOMAIN}.`);
  } finally {
    donateResolving = false;
    if (labelEl) labelEl.textContent = DONATE_DOMAIN;
  }
});

// --- Send Kaspa modal (matches iOS's WithdrawKaspaView for this pass: real
// recipient + amount + send; fee tiers/QR-scan/coin-control are follow-ups) ---

// Send-Kaspa flow, factored into a reusable controller so the same logic
// (balance check, KNS/address resolution, validation, broadcast) drives both
// the standalone modal (profile > Send Kaspa) and the in-card Send screen
// inside the Manage Address popup. `els` is a set of field elements; `onOpen`/
// `onClose` show/hide whichever container hosts them.
// `sendFn`/`getBalance` let a caller retarget the same controller at a different
// source wallet (e.g. a spending address via engine.sendFromSpending); when
// omitted it drives the chatting/identity address through engine.send/balance.
function makeSendController(els, { onOpen, onClose, getSelection, resolveAmountKas, getFeeKas, sendFn, getBalance } = {}) {
  let resolvedAddress = null;
  let resolveToken = 0;

  async function open() {
    if (!engine.address) return;
    if (els.recipient) els.recipient.value = "";
    if (els.amount) els.amount.value = "";
    resolvedAddress = null;
    if (els.resolvedHint) els.resolvedHint.hidden = true;
    if (els.error) els.error.hidden = true;
    if (els.progress) els.progress.hidden = true;
    if (els.submit) els.submit.disabled = true;
    onOpen?.();
    if (els.balanceHint) els.balanceHint.textContent = "Checking balance…";
    try {
      await ensureRuntimes({ quiet: true });
      const balance = getBalance ? await getBalance() : await engine.balance();
      if (els.balanceHint) els.balanceHint.textContent = `Available: ${balance.totalKas} KAS`;
    } catch {
      if (els.balanceHint) els.balanceHint.textContent = "";
    }
  }

  async function updateValidity() {
    const token = ++resolveToken;
    const raw = String(els.recipient?.value || "").trim();
    const amountValid = Number(els.amount?.value) > 0;
    resolvedAddress = null;
    if (els.resolvedHint) els.resolvedHint.hidden = true;
    if (els.error) els.error.hidden = true;

    if (!raw) { if (els.submit) els.submit.disabled = true; return; }

    if (raw.startsWith("kaspa:")) {
      if (els.submit) els.submit.disabled = !amountValid;
      return;
    }

    if (engine.knsLooksLikeDomain(raw)) {
      if (els.submit) els.submit.disabled = true;
      try {
        const resolution = await engine.resolveKnsDomain(raw);
        if (token !== resolveToken) return; // a newer keystroke superseded this lookup
        if (resolution) {
          resolvedAddress = resolution.ownerAddress;
          if (els.resolvedHint) { els.resolvedHint.textContent = `Resolved: ${resolution.domain}`; els.resolvedHint.hidden = false; }
          if (els.submit) els.submit.disabled = !amountValid;
        }
      } catch {
        // leave disabled; submit surfaces a clearer error if attempted anyway
      }
      return;
    }

    if (els.submit) els.submit.disabled = true;
  }

  async function submit() {
    if (els.error) els.error.hidden = true;
    const raw = String(els.recipient?.value || "").trim();
    const destination = resolvedAddress || raw;
    let amountKas;
    try {
      amountKas = normalizeKasAmount(resolveAmountKas ? resolveAmountKas() : els.amount?.value);
      validateContactAddress(destination);
    } catch (error) {
      if (els.error) { els.error.textContent = error.message; els.error.hidden = false; }
      return;
    }

    const selectedOutpoints = getSelection?.() || [];
    const feeKas = getFeeKas ? getFeeKas() : "0";
    if (els.submit) els.submit.disabled = true;
    if (els.progress) { els.progress.hidden = false; els.progress.textContent = "Broadcasting transaction…"; }
    try {
      const result = sendFn
        ? await sendFn({ destination, amountKas, feeKas, selectedOutpoints })
        : await engine.send(destination, amountKas, feeKas, selectedOutpoints.length ? { selectedOutpoints } : {});
      const txid = (result?.txids || [])[0];
      if (els.progress) els.progress.textContent = txid ? `Sent — txid ${txid}` : "Sent.";
      showCopyToast(`Sent ${amountKas} KAS`);
      window.setTimeout(() => onClose?.(), 900);
      refreshBalanceOnly({ quiet: true }).catch(() => {});
    } catch (error) {
      if (els.error) { els.error.textContent = error.message || "Send failed."; els.error.hidden = false; }
      if (els.progress) els.progress.hidden = true;
    } finally {
      if (els.submit) els.submit.disabled = false;
    }
  }

  els.recipient?.addEventListener("input", updateValidity);
  els.amount?.addEventListener("input", updateValidity);
  els.submit?.addEventListener("click", submit);

  return { open };
}

// Standalone Send Kaspa modal (opened from profile > Chatting Address > Send Kaspa).
const sendKaspaModal = document.querySelector("[data-send-kaspa-modal]");
function closeSendKaspaModal() { if (sendKaspaModal) sendKaspaModal.hidden = true; }
const sendKaspaController = makeSendController({
  recipient: document.querySelector("[data-send-kaspa-recipient]"),
  resolvedHint: document.querySelector("[data-send-kaspa-resolved]"),
  amount: document.querySelector("[data-send-kaspa-amount]"),
  balanceHint: document.querySelector("[data-send-kaspa-balance]"),
  error: document.querySelector("[data-send-kaspa-error]"),
  progress: document.querySelector("[data-send-kaspa-progress]"),
  submit: document.querySelector("[data-send-kaspa-submit]"),
}, {
  onOpen: () => { if (sendKaspaModal) sendKaspaModal.hidden = false; },
  onClose: closeSendKaspaModal,
});
function openSendKaspaModal() { return sendKaspaController.open(); }

document.querySelectorAll("[data-close-send-kaspa]").forEach((button) => button.addEventListener("click", closeSendKaspaModal));
document.querySelector("[data-open-send-kaspa]")?.addEventListener("click", openSendKaspaModal);

// --- Manage Address screen (matches iOS's ChattingAddressManageView for this
// pass: real transaction history + real UTXOs + Receive/Send/Explorer/Private
// key; UTXO labeling and Compound UTXOs are follow-ups) ---

const manageAddressScreen = document.querySelector("[data-manage-address-screen]");
const manageAddressBalanceEl = document.querySelector("[data-manage-address-balance]");
const manageAddressExplorerLink = document.querySelector("[data-manage-address-explorer-link]");
const manageAddressTransactionsList = document.querySelector("[data-manage-address-transactions]");
const manageAddressUtxosList = document.querySelector("[data-manage-address-utxos]");

function closeManageAddressScreen() {
  if (manageAddressScreen) manageAddressScreen.hidden = true;
}

function manageAddressTxDirection(tx, address) {
  const inputs = tx.inputs || [];
  const outputs = tx.outputs || [];
  const weAreSender = inputs.some((input) => input.previous_outpoint_address === address);
  let totalToUs = 0n;
  let totalToOthers = 0n;
  let recipientAmount = 0n;
  let haveRecipient = false;
  for (const output of outputs) {
    const outAddress = output.script_public_key_address;
    const amount = BigInt(output.amount || 0);
    if (!outAddress) continue;
    if (outAddress === address) {
      totalToUs += amount;
    } else {
      totalToOthers += amount;
      if (!haveRecipient || amount < recipientAmount) { recipientAmount = amount; haveRecipient = true; }
    }
  }
  if (weAreSender && totalToOthers > 0n) return { isOutgoing: true, amountSompi: haveRecipient ? recipientAmount : totalToOthers };
  if (!weAreSender && totalToUs > 0n) return { isOutgoing: false, amountSompi: totalToUs };
  return null;
}

async function loadManageAddressTransactions(address, listEl = manageAddressTransactionsList) {
  if (!listEl) return;
  listEl.innerHTML = '<div class="manage-address-empty">Loading…</div>';
  try {
    const url = `${getEndpoint("kaspaApi")}/addresses/${encodeURIComponent(address)}/full-transactions?limit=50&offset=0&resolve_previous_outpoints=light`;
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Kaspa API returned ${response.status}`);
    const transactions = await response.json();
    if (!Array.isArray(transactions) || !transactions.length) {
      listEl.innerHTML = '<div class="manage-address-empty">No transactions yet.</div>';
      return;
    }
    listEl.replaceChildren();
    for (const tx of transactions) {
      const info = manageAddressTxDirection(tx, address);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "manage-address-row";
      const icon = document.createElement("span");
      icon.className = `manage-address-row-icon ${info?.isOutgoing ? "outgoing" : "incoming"}`;
      icon.textContent = info?.isOutgoing ? "↑" : "↓";
      const meta = document.createElement("span");
      meta.className = "manage-address-row-meta";
      const label = document.createElement("strong");
      label.textContent = info == null ? "Transaction" : info.isOutgoing ? "Sent" : "Received";
      const txidEl = document.createElement("span");
      txidEl.className = "manage-address-row-txid";
      txidEl.textContent = tx.transaction_id || "";
      meta.append(label, txidEl);
      if (tx.block_time) {
        const timeEl = document.createElement("span");
        timeEl.className = "manage-address-row-time";
        timeEl.textContent = new Date(Number(tx.block_time)).toLocaleString();
        meta.append(timeEl);
      }
      row.append(icon, meta);
      if (info) {
        const amountEl = document.createElement("span");
        amountEl.className = `manage-address-row-amount ${info.isOutgoing ? "outgoing" : "incoming"}`;
        amountEl.textContent = `${info.isOutgoing ? "-" : "+"}${sompiToKasDisplay(info.amountSompi)} KAS`;
        row.append(amountEl);
      }
      row.addEventListener("click", () => {
        if (tx.transaction_id) window.open(explorerTxUrl(tx.transaction_id), "_blank", "noopener,noreferrer");
      });
      listEl.appendChild(row);
    }
  } catch (error) {
    listEl.innerHTML = `<div class="manage-address-empty">Could not load transaction history: ${escapeHtml(error.message)}</div>`;
  }
}

function sompiToKasDisplay(sompi) {
  const value = typeof sompi === "bigint" ? sompi : BigInt(Math.round(Number(sompi) || 0));
  const s = value.toString().padStart(9, "0");
  return `${s.slice(0, -8) || "0"}.${s.slice(-8).replace(/0+$/, "") || "0"}`;
}

// Per-UTXO labels, keyed by "txid:index" and scoped per address — mirrors the
// UTXO labeling in iOS's ManageAddressesView / ColdStorageManager and Android's
// KaspaExplorer counterparts. A blank name removes the label. Stored as
// { [address]: { [outpointKey]: label } } in localStorage.
const UTXO_LABELS_KEY = "kachat-utxo-labels-v1";

function loadUtxoLabelsMap() {
  try { return JSON.parse(localStorage.getItem(UTXO_LABELS_KEY) || "{}") || {}; }
  catch { return {}; }
}
function getUtxoLabels(address) {
  return loadUtxoLabelsMap()[address] || {};
}
function setUtxoLabel(address, outpointKey, label) {
  const map = loadUtxoLabelsMap();
  const forAddress = { ...(map[address] || {}) };
  const clean = String(label || "").trim();
  if (clean) forAddress[outpointKey] = clean;
  else delete forAddress[outpointKey];
  if (Object.keys(forAddress).length) map[address] = forAddress;
  else delete map[address];
  localStorage.setItem(UTXO_LABELS_KEY, JSON.stringify(map));
}
function utxoOutpointKey(outpoint) {
  return `${outpoint.transactionId || ""}:${outpoint.index ?? ""}`;
}

// Cache the last-loaded UTXO entries so a rename can re-render instantly without
// re-hitting the node for balance.
let lastManageAddressUtxos = [];

function renderManageAddressUtxos() {
  if (!manageAddressUtxosList) return;
  const address = engine.address;
  if (!lastManageAddressUtxos.length) {
    manageAddressUtxosList.innerHTML = '<div class="manage-address-empty">No UTXOs at this address.</div>';
    return;
  }
  const labels = getUtxoLabels(address);
  manageAddressUtxosList.replaceChildren();
  for (const entry of lastManageAddressUtxos) {
    const outpoint = entry.outpoint || {};
    const outpointKey = utxoOutpointKey(outpoint);
    const label = labels[outpointKey];

    const row = document.createElement("div");
    row.className = "manage-address-utxo-row";

    const meta = document.createElement("div");
    meta.className = "manage-address-utxo-meta";
    if (label) {
      const labelEl = document.createElement("span");
      labelEl.className = "manage-address-utxo-label";
      labelEl.textContent = label;
      meta.appendChild(labelEl);
    }
    const outpointEl = document.createElement("span");
    outpointEl.className = "manage-address-utxo-outpoint";
    outpointEl.textContent = outpointKey;
    meta.appendChild(outpointEl);

    const amountEl = document.createElement("span");
    amountEl.className = "manage-address-utxo-amount";
    amountEl.textContent = `${sompiToKasDisplay(BigInt(entry.amount || 0))} KAS`;

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "manage-address-utxo-rename";
    renameBtn.setAttribute("aria-label", label ? "Rename UTXO" : "Name UTXO");
    renameBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>';
    renameBtn.addEventListener("click", () => openUtxoRename(address, outpointKey, label || ""));

    row.append(meta, amountEl, renameBtn);
    manageAddressUtxosList.appendChild(row);
  }
}

async function loadManageAddressUtxos() {
  if (!manageAddressUtxosList) return;
  manageAddressUtxosList.innerHTML = '<div class="manage-address-empty">Loading…</div>';
  try {
    const balance = await engine.balance();
    lastManageAddressUtxos = balance.entries || [];
    renderManageAddressUtxos();
  } catch (error) {
    lastManageAddressUtxos = [];
    manageAddressUtxosList.innerHTML = `<div class="manage-address-empty">Could not load UTXOs: ${escapeHtml(error.message)}</div>`;
  }
}

async function openManageAddressScreen() {
  if (!manageAddressScreen || !engine.address) return;
  manageAddressScreen.hidden = false;
  showManageView("list");
  if (manageAddressBalanceEl) manageAddressBalanceEl.textContent = `${currentBalanceKas} KAS`;
  if (manageAddressExplorerLink) manageAddressExplorerLink.href = explorerAddressUrl(engine.address);
  await Promise.all([
    loadManageAddressTransactions(engine.address),
    loadManageAddressUtxos(),
  ]);
}

document.querySelector("[data-open-manage-address]")?.addEventListener("click", openManageAddressScreen);
document.querySelector("[data-close-manage-address]")?.addEventListener("click", closeManageAddressScreen);
document.querySelector("[data-manage-address-receive]")?.addEventListener("click", () => {
  closeManageAddressScreen();
  openChattingAddressScreen();
});

// In-card Send screen — clicking Send swaps the card's list view for a Send
// screen (matching iOS's send flow) instead of stacking a separate modal; the
// back arrow returns to the list.
function showManageView(view) {
  document.querySelectorAll("[data-manage-view]").forEach((el) => {
    el.hidden = el.dataset.manageView !== view;
  });
}
// Coin control (matches iOS's manualUtxos): the user optionally picks which
// UTXOs fund the send. No selection = automatic coin selection (spend all/auto).
const manageSendCoinToggle = document.querySelector("[data-manage-send-coin-toggle]");
const manageSendCoinList = document.querySelector("[data-manage-send-coin-list]");
const manageSendCoinSummary = document.querySelector("[data-manage-send-coin-summary]");
const selectedSendOutpoints = new Set();

function getSelectedSendOutpoints() {
  return [...selectedSendOutpoints];
}

function updateSendCoinSummary() {
  if (!manageSendCoinSummary) return;
  if (!selectedSendOutpoints.size) { manageSendCoinSummary.textContent = "Automatic"; return; }
  let totalSompi = 0n;
  for (const entry of lastManageAddressUtxos) {
    if (selectedSendOutpoints.has(utxoOutpointKey(entry.outpoint || {}))) totalSompi += BigInt(entry.amount || 0);
  }
  manageSendCoinSummary.textContent = `${selectedSendOutpoints.size} · ${sompiToKasDisplay(totalSompi)} KAS`;
}

function renderSendCoinControl() {
  selectedSendOutpoints.clear();
  updateSendCoinSummary();
  if (manageSendCoinList) manageSendCoinList.hidden = true;
  if (manageSendCoinToggle) manageSendCoinToggle.setAttribute("aria-expanded", "false");
  if (!manageSendCoinList) return;
  manageSendCoinList.replaceChildren();
  if (!lastManageAddressUtxos.length) {
    manageSendCoinList.innerHTML = '<div class="manage-address-empty">No UTXOs to select.</div>';
    return;
  }
  const labels = getUtxoLabels(engine.address);
  for (const entry of lastManageAddressUtxos) {
    const outpointKey = utxoOutpointKey(entry.outpoint || {});
    const row = document.createElement("label");
    row.className = "manage-send-coin-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "manage-send-coin-check";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedSendOutpoints.add(outpointKey);
      else selectedSendOutpoints.delete(outpointKey);
      updateSendCoinSummary();
    });

    const meta = document.createElement("span");
    meta.className = "manage-send-coin-meta";
    if (labels[outpointKey]) {
      const labelEl = document.createElement("span");
      labelEl.className = "manage-send-coin-label";
      labelEl.textContent = labels[outpointKey];
      meta.appendChild(labelEl);
    }
    const outpointEl = document.createElement("span");
    outpointEl.className = "manage-send-coin-outpoint";
    outpointEl.textContent = outpointKey;
    meta.appendChild(outpointEl);

    const amountEl = document.createElement("span");
    amountEl.className = "manage-send-coin-amount";
    amountEl.textContent = `${sompiToKasDisplay(BigInt(entry.amount || 0))} KAS`;

    row.append(checkbox, meta, amountEl);
    manageSendCoinList.appendChild(row);
  }
}

manageSendCoinToggle?.addEventListener("click", () => {
  if (!manageSendCoinList) return;
  const willShow = manageSendCoinList.hidden;
  manageSendCoinList.hidden = !willShow;
  manageSendCoinToggle.setAttribute("aria-expanded", String(willShow));
});

// Send amount fiat toggle: tapping the Kaspa logo flips the amount field between
// KAS and the selected fiat currency, converting the current value via live price.
const manageSendAmountInput = document.querySelector("[data-manage-send-amount]");
const manageSendAmountLabel = document.querySelector("[data-manage-send-amount-label]");
const manageSendUnitButton = document.querySelector("[data-manage-send-unit]");
const manageSendUnitCode = document.querySelector("[data-manage-send-unit-code]");
const manageSendLogo = document.querySelector("[data-manage-send-logo]");
const manageSendFiatSymbol = document.querySelector("[data-manage-send-fiat-symbol]");
const manageSendMaxButton = document.querySelector("[data-manage-send-max]");
const manageSendFiatHint = document.querySelector("[data-manage-send-fiat]");
let manageSendUnit = "kas";        // "kas" | "fiat"
let manageSendPrice = null;        // live KAS price in selectedCurrency
let manageSendAvailableKas = null; // available balance for the Max button

function manageSendCurrencyCode() { return selectedCurrency.toUpperCase(); }

// Returns the amount to actually send, always in KAS, converting from fiat if needed.
function manageSendResolveAmountKas() {
  const raw = Number(manageSendAmountInput?.value);
  if (!isFinite(raw) || raw <= 0) return manageSendAmountInput?.value || "";
  if (manageSendUnit === "fiat") {
    if (!manageSendPrice) throw new Error("KAS price unavailable — switch back to KAS to send.");
    return String(raw / manageSendPrice);
  }
  return manageSendAmountInput?.value || "";
}

function updateManageSendFiatHint() {
  if (!manageSendFiatHint) return;
  const raw = Number(manageSendAmountInput?.value);
  if (!isFinite(raw) || raw <= 0 || !manageSendPrice) { manageSendFiatHint.hidden = true; return; }
  if (manageSendUnit === "kas") {
    manageSendFiatHint.textContent = `≈ ${formatFiatValue(raw, manageSendPrice)}`;
  } else {
    const kas = raw / manageSendPrice;
    manageSendFiatHint.textContent = `≈ ${kas.toLocaleString(undefined, { maximumFractionDigits: 8 })} KAS`;
  }
  manageSendFiatHint.hidden = false;
}

function applyManageSendUnit() {
  const isKas = manageSendUnit === "kas";
  if (manageSendUnitCode) manageSendUnitCode.textContent = isKas ? "KAS" : manageSendCurrencyCode();
  // Kaspa logo in KAS mode; fiat symbol in fiat mode.
  if (manageSendLogo) manageSendLogo.hidden = !isKas;
  if (manageSendFiatSymbol) {
    manageSendFiatSymbol.hidden = isKas;
    manageSendFiatSymbol.textContent = currencyMeta().symbol.trim();
  }
  const amountWord = t("send.amount");
  if (manageSendAmountLabel) manageSendAmountLabel.textContent = isKas ? `${amountWord} (KAS)` : `${amountWord} (${manageSendCurrencyCode()})`;
  if (manageSendAmountInput) manageSendAmountInput.placeholder = isKas ? "0.00000000" : "0.00";
  updateManageSendFiatHint();
}

manageSendUnitButton?.addEventListener("click", () => {
  if (!manageSendPrice) { showCopyToast("KAS price unavailable right now."); return; }
  const raw = Number(manageSendAmountInput?.value);
  // Convert the currently-typed value into the new unit so it stays equivalent.
  if (isFinite(raw) && raw > 0) {
    manageSendAmountInput.value = manageSendUnit === "kas"
      ? (raw * manageSendPrice).toFixed(selectedCurrency === "btc" ? 8 : 2)
      : String(raw / manageSendPrice);
  }
  manageSendUnit = manageSendUnit === "kas" ? "fiat" : "kas";
  applyManageSendUnit();
});
manageSendAmountInput?.addEventListener("input", updateManageSendFiatHint);

// Network fee tiers → priorityFee passed to engine.send.
const manageSendFeeButtons = document.querySelectorAll("[data-manage-send-fee]");
const manageSendFeeCustom = document.querySelector("[data-manage-send-fee-custom]");
const manageSendFeeSummary = document.querySelector("[data-manage-send-fee-summary]");
let manageSendFeeTier = "0";
const FEE_TIER_LABELS = { "0": "Normal", "0.00002": "Priority", custom: "Custom" };

// The fee input always shows the actual fee amount — read-only for the Normal /
// Priority presets, editable for Custom.
function manageSendGetFeeKas() {
  const v = Number(manageSendFeeCustom?.value);
  return isFinite(v) && v > 0 ? String(v) : "0";
}
function updateManageSendFeeSummary() {
  if (!manageSendFeeSummary) return;
  manageSendFeeSummary.textContent = `${FEE_TIER_LABELS[manageSendFeeTier] || "Normal"} · ${manageSendGetFeeKas()} KAS`;
}
function selectManageSendFeeTier(tier) {
  manageSendFeeTier = tier;
  manageSendFeeButtons.forEach((b) => b.classList.toggle("active", b.dataset.manageSendFee === tier));
  if (manageSendFeeCustom) {
    if (tier === "custom") {
      manageSendFeeCustom.readOnly = false;
      manageSendFeeCustom.value = "";
      manageSendFeeCustom.focus();
    } else {
      manageSendFeeCustom.readOnly = true;
      manageSendFeeCustom.value = tier; // "0" or "0.00002"
    }
  }
  updateManageSendFeeSummary();
}
manageSendFeeButtons.forEach((button) => {
  button.addEventListener("click", () => selectManageSendFeeTier(button.dataset.manageSendFee));
});
manageSendFeeCustom?.addEventListener("input", updateManageSendFeeSummary);

// Max: fill the amount with the full sendable balance (selected UTXOs if coin
// control is on, otherwise the whole address), minus the fee. Approximate — the
// exact network fee is only known once the tx is built.
function computeMaxSendKas() {
  let availableKas = manageSendAvailableKas;
  const selected = getSelectedSendOutpoints();
  if (selected.length) {
    let sompi = 0n;
    for (const entry of lastManageAddressUtxos) {
      if (selectedSendOutpoints.has(utxoOutpointKey(entry.outpoint || {}))) sompi += BigInt(entry.amount || 0);
    }
    availableKas = Number(sompi) / 1e8;
  }
  if (availableKas == null || !isFinite(availableKas)) return null;
  const feeBuffer = Number(manageSendGetFeeKas()) + 0.0001; // priority fee + base-fee headroom
  const max = availableKas - feeBuffer;
  return max > 0 ? max : 0;
}
manageSendMaxButton?.addEventListener("click", () => {
  const maxKas = computeMaxSendKas();
  if (maxKas == null) { showCopyToast("Balance unavailable right now."); return; }
  if (manageSendUnit === "fiat" && manageSendPrice) {
    manageSendAmountInput.value = (maxKas * manageSendPrice).toFixed(selectedCurrency === "btc" ? 8 : 2);
  } else {
    manageSendAmountInput.value = String(maxKas);
  }
  updateManageSendFiatHint();
  manageSendAmountInput.dispatchEvent(new Event("input")); // re-run send validity
});

function resetManageSendExtras() {
  manageSendUnit = "kas";
  applyManageSendUnit();
  selectManageSendFeeTier("0");
  if (manageSendFiatHint) manageSendFiatHint.hidden = true;
  manageSendPrice = null;
  manageSendAvailableKas = null;
  fetchKasPrice(selectedCurrency).then((price) => { manageSendPrice = price; updateManageSendFiatHint(); });
  engine.balance().then((b) => { manageSendAvailableKas = Number(b.totalKas); }).catch(() => {});
}

const manageSendController = makeSendController({
  recipient: document.querySelector("[data-manage-send-recipient]"),
  resolvedHint: document.querySelector("[data-manage-send-resolved]"),
  amount: manageSendAmountInput,
  balanceHint: document.querySelector("[data-manage-send-balance]"),
  error: document.querySelector("[data-manage-send-error]"),
  progress: document.querySelector("[data-manage-send-progress]"),
  submit: document.querySelector("[data-manage-send-submit]"),
}, {
  onOpen: () => showManageView("send"),
  onClose: () => showManageView("list"),
  getSelection: getSelectedSendOutpoints,
  resolveAmountKas: manageSendResolveAmountKas,
  getFeeKas: manageSendGetFeeKas,
});
document.querySelector("[data-manage-address-send]")?.addEventListener("click", () => {
  renderSendCoinControl();
  resetManageSendExtras();
  manageSendController.open();
});
document.querySelector("[data-manage-send-back]")?.addEventListener("click", () => showManageView("list"));

document.querySelectorAll("[data-manage-address-tab]").forEach((tabButton) => {
  tabButton.addEventListener("click", () => {
    document.querySelectorAll("[data-manage-address-tab]").forEach((btn) => btn.classList.toggle("active", btn === tabButton));
    const target = tabButton.dataset.manageAddressTab;
    document.querySelectorAll("[data-manage-address-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.manageAddressPanel !== target;
    });
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (manageAddressScreen && !manageAddressScreen.hidden) closeManageAddressScreen();
  if (sendKaspaModal && !sendKaspaModal.hidden) closeSendKaspaModal();
  if (spendingSendModal && !spendingSendModal.hidden) closeSpendingSendModal();
  else if (spendingDetailScreen && !spendingDetailScreen.hidden) closeSpendingDetailScreen();
  else if (spendingManageScreen && !spendingManageScreen.hidden) closeSpendingManageScreen();
});

// --- Private key reveal (chatting address) — same hold-to-reveal UX as the
// existing seed-phrase modal, kept as a separate small implementation rather
// than refactoring that working code. ---

const privatekeyModal = document.querySelector("[data-privatekey-modal]");
const revealPrivatekeyButton = document.querySelector("[data-reveal-privatekey]");
const privatekeyProgressFill = document.querySelector("[data-privatekey-progress]");
const privatekeyValueBox = document.querySelector("[data-privatekey-value]");
const copyPrivatekeyButton = document.querySelector("[data-copy-privatekey]");
const PRIVATEKEY_HOLD_MS = 5000;
let privatekeyHoldStartedAt = 0;
let privatekeyHoldFrame = 0;
let privatekeyHoldPointerId = null;

function resetPrivatekeyHold() {
  if (privatekeyHoldFrame) cancelAnimationFrame(privatekeyHoldFrame);
  privatekeyHoldFrame = 0;
  privatekeyHoldStartedAt = 0;
  privatekeyHoldPointerId = null;
  revealPrivatekeyButton?.classList.remove("is-holding");
  if (privatekeyProgressFill) privatekeyProgressFill.style.width = "0%";
}

function revealPrivatekeyAfterHold() {
  if (!engine.privateKeyHex || !privatekeyValueBox) { resetPrivatekeyHold(); return; }
  privatekeyValueBox.textContent = engine.privateKeyHex;
  privatekeyValueBox.hidden = false;
  if (revealPrivatekeyButton) revealPrivatekeyButton.hidden = true;
  if (copyPrivatekeyButton) copyPrivatekeyButton.hidden = false;
  resetPrivatekeyHold();
}

function updatePrivatekeyHold(now) {
  if (!privatekeyHoldStartedAt) return;
  const elapsed = Math.max(0, now - privatekeyHoldStartedAt);
  const progress = Math.min(1, elapsed / PRIVATEKEY_HOLD_MS);
  if (privatekeyProgressFill) privatekeyProgressFill.style.width = `${progress * 100}%`;
  if (progress >= 1) { revealPrivatekeyAfterHold(); return; }
  privatekeyHoldFrame = requestAnimationFrame(updatePrivatekeyHold);
}

function beginPrivatekeyHold(event) {
  if (!revealPrivatekeyButton || revealPrivatekeyButton.hidden || privatekeyHoldStartedAt) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  privatekeyHoldPointerId = event.pointerId;
  try { revealPrivatekeyButton.setPointerCapture(event.pointerId); } catch {}
  revealPrivatekeyButton.classList.add("is-holding");
  privatekeyHoldStartedAt = performance.now();
  privatekeyHoldFrame = requestAnimationFrame(updatePrivatekeyHold);
}

function cancelPrivatekeyHold(event) {
  if (event && privatekeyHoldPointerId !== null && event.pointerId !== privatekeyHoldPointerId) return;
  resetPrivatekeyHold();
}

function closePrivatekeyModal() {
  resetPrivatekeyHold();
  if (privatekeyModal) privatekeyModal.hidden = true;
  if (privatekeyValueBox) { privatekeyValueBox.hidden = true; privatekeyValueBox.textContent = ""; }
  if (copyPrivatekeyButton) copyPrivatekeyButton.hidden = true;
  if (revealPrivatekeyButton) revealPrivatekeyButton.hidden = false;
}

function openPrivatekeyModal() {
  if (!engine.privateKeyHex) { showCopyToast("No wallet loaded."); return; }
  resetPrivatekeyHold();
  if (privatekeyValueBox) { privatekeyValueBox.hidden = true; privatekeyValueBox.textContent = ""; }
  if (copyPrivatekeyButton) copyPrivatekeyButton.hidden = true;
  if (revealPrivatekeyButton) revealPrivatekeyButton.hidden = false;
  if (privatekeyModal) privatekeyModal.hidden = false;
}

document.querySelector("[data-open-privatekey]")?.addEventListener("click", openPrivatekeyModal);
document.querySelectorAll("[data-close-privatekey]").forEach((button) => button.addEventListener("click", closePrivatekeyModal));
privatekeyModal?.addEventListener("click", (event) => { if (event.target === privatekeyModal) closePrivatekeyModal(); });
// Click-to-view (no longer hold): password-gated when the seed-phrase protection
// is on, since the value is now protected by the password.
revealPrivatekeyButton?.addEventListener("click", async () => {
  if (accountShellPrefs.passwordForSeed && hasAppPassword()) {
    const ok = await requestPassword({ mode: "verify", title: "Enter Password", message: "Enter your password to view the private key." });
    if (!ok) return;
  }
  revealPrivatekeyAfterHold();
});
copyPrivatekeyButton?.addEventListener("click", async () => {
  if (!engine.privateKeyHex) return;
  await copyTextToClipboard(engine.privateKeyHex);
  showCopyToast("Private key copied");
});

document.querySelectorAll("[data-profile-dropdown], [data-settings-dropdown]").forEach((dropdown) => {
  const toggle = dropdown.querySelector("[data-dropdown-toggle]");
  const body = dropdown.querySelector(".profile-dropdown-body, .settings-dropdown-body");
  toggle?.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    if (body) body.hidden = expanded;
  });
});

document.querySelectorAll("[data-mockup-action]").forEach((button) => {
  button.addEventListener("click", () => showCopyToast("Coming soon"));
});

// Kaspa Explorer selector (Settings > Connectivity). Persists the chosen
// explorer, reflects it in the dropdown's current-value label + checkmark, and
// updates the Manage Address explorer link if that screen is open.
const explorerCurrentLabel = document.querySelector("[data-explorer-current]");
const explorerOptionButtons = document.querySelectorAll("[data-explorer-option]");
function refreshExplorerSelectionUi() {
  const key = KASPA_EXPLORERS[accountShellPrefs.explorer] ? accountShellPrefs.explorer : DEFAULT_KASPA_EXPLORER;
  if (explorerCurrentLabel) explorerCurrentLabel.textContent = KASPA_EXPLORERS[key].displayName;
  explorerOptionButtons.forEach((button) => {
    button.classList.toggle("selected", button.dataset.explorerOption === key);
  });
}
explorerOptionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.explorerOption;
    if (!KASPA_EXPLORERS[key]) return;
    accountShellPrefs.explorer = key;
    persistAccountShellPreferences();
    refreshExplorerSelectionUi();
    if (manageAddressExplorerLink && engine.address) manageAddressExplorerLink.href = explorerAddressUrl(engine.address);
    const dropdownBody = button.closest(".settings-dropdown-body");
    const dropdownToggle = button.closest(".settings-dropdown")?.querySelector("[data-dropdown-toggle]");
    if (dropdownBody) dropdownBody.hidden = true;
    if (dropdownToggle) dropdownToggle.setAttribute("aria-expanded", "false");
    showCopyToast(`Explorer set to ${KASPA_EXPLORERS[key].displayName}`);
  });
});
refreshExplorerSelectionUi();

document.querySelectorAll("[data-mockup-toggle]").forEach((input) => {
  input.addEventListener("change", () => {
    const previous = !input.checked;
    showCopyToast("Coming soon");
    input.checked = previous;
  });
});

document.querySelectorAll(".settings-segmented-option:not([data-theme-option])").forEach((option) => {
  option.addEventListener("click", () => {
    const group = option.closest(".settings-segmented");
    group?.querySelectorAll(".settings-segmented-option").forEach((sibling) => sibling.classList.toggle("active", sibling === option));
  });
});

const THEME_PREF_KEY = "kachat-theme-preference-v1";
const systemThemeMedia = window.matchMedia("(prefers-color-scheme: light)");
let themePreference = "dark";

// The stored preference is one of system/light/dark; the *effective* theme
// (what actually paints) is light or dark. "System" follows the OS and updates
// live via the media-query listener below.
function effectiveTheme(preference) {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return systemThemeMedia.matches ? "light" : "dark";
}

function applyThemePreference(preference) {
  themePreference = preference === "light" || preference === "system" ? preference : "dark";
  localStorage.setItem(THEME_PREF_KEY, themePreference);
  const effective = effectiveTheme(themePreference);
  document.documentElement.setAttribute("data-theme", effective);
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.setAttribute("content", effective === "light" ? "#eef1f4" : "#070a0d");
  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    // Highlight the chosen preference (System/Light/Dark), not the resolved theme.
    button.classList.toggle("active", button.getAttribute("data-theme-option") === themePreference);
  });
}

document.querySelectorAll("[data-theme-option]").forEach((button) => {
  button.addEventListener("click", () => applyThemePreference(button.getAttribute("data-theme-option")));
});

systemThemeMedia.addEventListener("change", () => {
  if (themePreference === "system") applyThemePreference("system");
});

applyThemePreference(localStorage.getItem(THEME_PREF_KEY) || "dark");

// --- Currency + live KAS price (matches iOS AppCurrency; codes are CoinGecko
// vs_currency values, so no mapping table). Drives fiat conversion in the send
// screen and anywhere KAS value is shown. ---
const CURRENCY_PREF_KEY = "kachat-currency-v1";
const CURRENCIES = {
  usd: { name: "US Dollar (USD)", symbol: "$" },
  eur: { name: "Euro (EUR)", symbol: "€" },
  gbp: { name: "British Pound (GBP)", symbol: "£" },
  jpy: { name: "Japanese Yen (JPY)", symbol: "¥" },
  cny: { name: "Chinese Yuan (CNY)", symbol: "CN¥" },
  aud: { name: "Australian Dollar (AUD)", symbol: "A$" },
  cad: { name: "Canadian Dollar (CAD)", symbol: "C$" },
  chf: { name: "Swiss Franc (CHF)", symbol: "CHF " },
  hkd: { name: "Hong Kong Dollar (HKD)", symbol: "HK$" },
  inr: { name: "Indian Rupee (INR)", symbol: "₹" },
  krw: { name: "South Korean Won (KRW)", symbol: "₩" },
  sgd: { name: "Singapore Dollar (SGD)", symbol: "S$" },
  nzd: { name: "New Zealand Dollar (NZD)", symbol: "NZ$" },
  mxn: { name: "Mexican Peso (MXN)", symbol: "MX$" },
  brl: { name: "Brazilian Real (BRL)", symbol: "R$" },
  rub: { name: "Russian Ruble (RUB)", symbol: "₽" },
  try: { name: "Turkish Lira (TRY)", symbol: "₺" },
  zar: { name: "South African Rand (ZAR)", symbol: "R" },
  btc: { name: "Bitcoin (BTC)", symbol: "₿" },
};
const DEFAULT_CURRENCY = "usd";
let selectedCurrency = localStorage.getItem(CURRENCY_PREF_KEY) || DEFAULT_CURRENCY;
if (!CURRENCIES[selectedCurrency]) selectedCurrency = DEFAULT_CURRENCY;
const kasPriceCache = new Map();

function currencyMeta() { return CURRENCIES[selectedCurrency] || CURRENCIES[DEFAULT_CURRENCY]; }

async function fetchKasPrice(currency) {
  const cached = kasPriceCache.get(currency);
  if (cached && Date.now() - cached.at < 60000) return cached.price;
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=kaspa&vs_currencies=${encodeURIComponent(currency)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`price ${res.status}`);
    const data = await res.json();
    const price = data?.kaspa?.[currency];
    if (typeof price === "number") { kasPriceCache.set(currency, { price, at: Date.now() }); return price; }
  } catch { /* offline / rate-limited — fiat features degrade gracefully */ }
  return null;
}

function formatFiatValue(kasAmount, price) {
  const value = Number(kasAmount) * price;
  if (!isFinite(value)) return "";
  const digits = selectedCurrency === "btc" ? 8 : value >= 1 ? 2 : 4;
  return `${currencyMeta().symbol}${value.toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

const currencyCurrentLabel = document.querySelector("[data-currency-current]");
const currencyOptionButtons = document.querySelectorAll("[data-currency-option]");
function refreshCurrencyUi() {
  if (currencyCurrentLabel) currencyCurrentLabel.textContent = currencyMeta().name;
  currencyOptionButtons.forEach((b) => b.classList.toggle("selected", b.dataset.currencyOption === selectedCurrency));
}
currencyOptionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.currencyOption;
    if (!CURRENCIES[key]) return;
    selectedCurrency = key;
    localStorage.setItem(CURRENCY_PREF_KEY, key);
    refreshCurrencyUi();
    const body = button.closest(".settings-dropdown-body");
    const toggle = button.closest(".settings-dropdown")?.querySelector("[data-dropdown-toggle]");
    if (body) body.hidden = true;
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    document.dispatchEvent(new CustomEvent("kachat:currency-changed"));
    showCopyToast(`Currency set to ${currencyMeta().name}`);
  });
});
refreshCurrencyUi();

// --- Language (matches iOS AppLanguage). Persists the choice, sets the document
// lang + text direction (RTL for Arabic/Persian/Hebrew). NOTE: switching the
// actual UI strings needs a translation layer that isn't built yet, so today
// this drives lang/dir and the picker state; see summary. ---
const LANGUAGE_PREF_KEY = "kachat-language-v1";
const LANGUAGES = {
  system: "System", en: "English", es: "Español", de: "Deutsch", fr: "Français",
  it: "Italiano", pt: "Português", ru: "Русский", tr: "Türkçe", ar: "العربية",
  "ar-EG": "العربية (مصر)", fa: "فارسی", he: "עברית", hi: "हिन्दी", bn: "বাংলা",
  ja: "日本語", ko: "한국어", vi: "Tiếng Việt", "zh-Hans": "简体中文",
};
const RTL_LANG_PREFIXES = ["ar", "fa", "he"];
let selectedLanguage = localStorage.getItem(LANGUAGE_PREF_KEY) || "system";
if (!LANGUAGES[selectedLanguage]) selectedLanguage = "system";

function effectiveLanguageCode() {
  return selectedLanguage === "system" ? navigator.language || "en" : selectedLanguage;
}

// --- i18n. Static UI text carrying a data-i18n key is translated on load and
// whenever the language changes (mirrors how iOS re-resolves every Text() when
// the app language changes). English is the fallback for any missing key/lang,
// so screens are wired incrementally and untranslated strings stay readable. ---
const I18N = {
  en: { appearance: "Appearance", language: "Language", currency: "Currency", "theme.system": "System", "theme.light": "Light", "theme.dark": "Dark", "send.recipient": "Recipient", "send.amount": "Amount", "send.networkFee": "Network Fee", "fee.normal": "Normal", "fee.priority": "Priority", "fee.custom": "Custom", "send.coinControl": "Coin Control", "send.title": "Send Kaspa", "action.send": "Send", "action.receive": "Receive", "action.copyAddress": "Copy Address" },
  es: { appearance: "Apariencia", language: "Idioma", currency: "Moneda", "theme.system": "Sistema", "theme.light": "Claro", "theme.dark": "Oscuro", "send.recipient": "Destinatario", "send.amount": "Cantidad", "send.networkFee": "Comisión de red", "fee.normal": "Normal", "fee.priority": "Prioritaria", "fee.custom": "Personalizada", "send.coinControl": "Control de monedas", "send.title": "Enviar Kaspa", "action.send": "Enviar", "action.receive": "Recibir", "action.copyAddress": "Copiar dirección" },
  fr: { appearance: "Apparence", language: "Langue", currency: "Devise", "theme.system": "Système", "theme.light": "Clair", "theme.dark": "Sombre", "send.recipient": "Destinataire", "send.amount": "Montant", "send.networkFee": "Frais de réseau", "fee.normal": "Normal", "fee.priority": "Prioritaire", "fee.custom": "Personnalisé", "send.coinControl": "Contrôle des pièces", "send.title": "Envoyer du Kaspa", "action.send": "Envoyer", "action.receive": "Recevoir", "action.copyAddress": "Copier l'adresse" },
  de: { appearance: "Darstellung", language: "Sprache", currency: "Währung", "theme.system": "System", "theme.light": "Hell", "theme.dark": "Dunkel", "send.recipient": "Empfänger", "send.amount": "Betrag", "send.networkFee": "Netzwerkgebühr", "fee.normal": "Normal", "fee.priority": "Priorität", "fee.custom": "Benutzerdefiniert", "send.coinControl": "Coin-Auswahl", "send.title": "Kaspa senden", "action.send": "Senden", "action.receive": "Empfangen", "action.copyAddress": "Adresse kopieren" },
  pt: { appearance: "Aparência", language: "Idioma", currency: "Moeda", "theme.system": "Sistema", "theme.light": "Claro", "theme.dark": "Escuro", "send.recipient": "Destinatário", "send.amount": "Quantia", "send.networkFee": "Taxa de rede", "fee.normal": "Normal", "fee.priority": "Prioritária", "fee.custom": "Personalizada", "send.coinControl": "Controle de moedas", "send.title": "Enviar Kaspa", "action.send": "Enviar", "action.receive": "Receber", "action.copyAddress": "Copiar endereço" },
};
function i18nActiveLang() {
  const base = effectiveLanguageCode().toLowerCase().split("-")[0];
  return I18N[base] ? base : "en";
}
function t(key) {
  const lang = i18nActiveLang();
  return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
}
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const translated = t(key);
    if (translated) el.textContent = translated;
  });
}

function applyLanguage() {
  const code = effectiveLanguageCode();
  document.documentElement.setAttribute("lang", code);
  const base = code.toLowerCase().split("-")[0];
  document.documentElement.setAttribute("dir", RTL_LANG_PREFIXES.includes(base) ? "rtl" : "ltr");
  applyI18n();
}
const languageCurrentLabel = document.querySelector("[data-language-current]");
const languageOptionButtons = document.querySelectorAll("[data-language-option]");
function refreshLanguageUi() {
  if (languageCurrentLabel) languageCurrentLabel.textContent = LANGUAGES[selectedLanguage] || "System";
  languageOptionButtons.forEach((b) => b.classList.toggle("selected", b.dataset.languageOption === selectedLanguage));
}
languageOptionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.languageOption;
    if (!LANGUAGES[key]) return;
    selectedLanguage = key;
    localStorage.setItem(LANGUAGE_PREF_KEY, key);
    applyLanguage();
    refreshLanguageUi();
    const body = button.closest(".settings-dropdown-body");
    const toggle = button.closest(".settings-dropdown")?.querySelector("[data-dropdown-toggle]");
    if (body) body.hidden = true;
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  });
});
applyLanguage();
refreshLanguageUi();

const contactsSyncToggle = document.querySelector("[data-contacts-sync-toggle]");
const contactsAutocreateToggle = document.querySelector("[data-contacts-autocreate-toggle]");
contactsSyncToggle?.addEventListener("change", () => {
  const wasChecked = !contactsSyncToggle.checked;
  showCopyToast("Coming soon");
  contactsSyncToggle.checked = wasChecked;
  if (contactsAutocreateToggle) {
    contactsAutocreateToggle.disabled = !contactsSyncToggle.checked;
    if (!contactsSyncToggle.checked) contactsAutocreateToggle.checked = false;
  }
});

// Connectivity endpoint fields (Kaspa REST API, KNS API, Push Indexer, Trusted
// Node) persist through the endpoint registry. Blank = default; Trusted Node
// blank = auto-search resolver. Takes effect on the next request/reconnect.
function loadEndpointInputs() {
  document.querySelectorAll("[data-endpoint]").forEach((input) => {
    const key = input.dataset.endpoint;
    input.value = getEndpointOverride(key) || ENDPOINT_DEFAULTS[key] || "";
  });
}
document.querySelectorAll("[data-endpoint]").forEach((input) => {
  input.addEventListener("change", () => {
    setEndpoint(input.dataset.endpoint, input.value.trim());
    loadEndpointInputs();
    showCopyToast("Connection setting saved");
  });
});
loadEndpointInputs();

document.querySelector("[data-reset-connection-defaults]")?.addEventListener("click", () => {
  resetEndpoints();
  loadEndpointInputs();
  if (indexerUrlInput) { indexerUrlInput.value = ENDPOINT_DEFAULTS.kasiaIndexer; localStorage.setItem(INDEXER_URL_KEY, indexerUrlInput.value); }
  showCopyToast("Connection settings reset to defaults");
});

function updateLocalStorageUsedLabel() {
  const label = document.querySelector("[data-local-storage-used]");
  if (!label) return;
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("kachat-")) continue;
    bytes += key.length + (localStorage.getItem(key) || "").length;
  }
  const kb = bytes / 1024;
  label.textContent = kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(2)} MB`;
}

// Single source of truth for every green/orange/red connection dot in the
// app: green whenever the primary RPC is connected, orange only once latency
// on that connection reaches 500ms, red only when disconnected. Deliberately
// ignores standby/wallet/cipher/subscription readiness — those used to also
// gate the topbar dot, which made it show orange far more than "connected or
// not" actually warranted.
function computeConnectionHealth() {
  const connection = engine.connectionSnapshot?.() || {};
  const registry = engine.nodeRegistrySnapshot?.() || { endpoints: [], lastGoodEndpoint: "" };
  const primaryReady = Boolean(engine.rpc) && connection.primary === "ready";
  if (!primaryReady) return { stateName: "error", latencyMs: null };

  const activeEndpoint = engine.rpc?.url || connection.primaryEndpoint || "";
  const record = (registry.endpoints || []).find((entry) => entry.endpoint === activeEndpoint)
    || (registry.endpoints || []).find((entry) => entry.endpoint === registry.lastGoodEndpoint);
  const latencyMs = record?.averageLatencyMs || record?.lastLatencyMs || null;
  const stateName = latencyMs && latencyMs >= 500 ? "busy" : "ready";
  return { stateName, latencyMs };
}

function connectionLatencyColor(ms) {
  if (!ms) return "";
  if (ms < 100) return "good";
  if (ms < 200) return "";
  if (ms < 500) return "warn";
  return "bad";
}

function formatRelativeTime(ts) {
  if (!ts) return "Never";
  const diffMs = Date.now() - ts;
  if (diffMs < 5000) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function hostFromEndpoint(endpoint) {
  if (!endpoint) return "";
  try {
    return new URL(endpoint.includes("://") ? endpoint : `wss://${endpoint}`).host || endpoint;
  } catch {
    return endpoint;
  }
}

function renderConnectionStatus() {
  const connection = engine.connectionSnapshot?.() || {};
  const registry = engine.nodeRegistrySnapshot?.() || { endpoints: [], endpointCount: 0, failovers: [], successfulFailovers: 0, failedFailovers: 0, lastGoodEndpoint: "" };
  const subscription = engine.subscriptionSnapshot?.() || {};
  const primaryReady = connection.primary === "ready";
  const standbyReady = connection.standby === "ready";

  const statusDot = document.querySelector("[data-connection-status-dot]");
  const statusText = document.querySelector("[data-connection-status-text]");
  const health = computeConnectionHealth();
  const stateText = health.stateName === "error"
    ? "Disconnected"
    : health.stateName === "busy"
      ? `Connected · high latency (${health.latencyMs} ms)`
      : "Connected";
  if (statusDot) { statusDot.classList.remove("ready", "busy", "error"); statusDot.classList.add(health.stateName); }
  if (statusText) statusText.textContent = stateText;

  const primaryEl = document.querySelector("[data-connection-primary-endpoint]");
  if (primaryEl) primaryEl.textContent = connection.primaryEndpoint ? hostFromEndpoint(connection.primaryEndpoint) : (connection.primary === "connecting" ? "Connecting…" : "Not connected");

  const standbyEl = document.querySelector("[data-connection-standby-endpoint]");
  if (standbyEl) standbyEl.textContent = connection.standbyEndpoint ? hostFromEndpoint(connection.standbyEndpoint) : (connection.standby === "connecting" ? "Connecting…" : "Not connected");

  const lastGoodRecord = (registry.endpoints || []).find((entry) => entry.endpoint === (connection.primaryEndpoint || registry.lastGoodEndpoint));
  const latencyEl = document.querySelector("[data-connection-latency]");
  if (latencyEl) {
    latencyEl.classList.remove("good", "warn", "bad");
    const ms = lastGoodRecord?.averageLatencyMs;
    latencyEl.textContent = ms ? `${ms} ms` : "--";
    const color = connectionLatencyColor(ms);
    if (color) latencyEl.classList.add(color);
  }

  const indexerEl = document.querySelector("[data-connection-indexer]");
  if (indexerEl) indexerEl.textContent = indexerUrlInput?.value ? hostFromEndpoint(indexerUrlInput.value) : "--";

  const lastSyncEl = document.querySelector("[data-connection-last-sync]");
  if (lastSyncEl) lastSyncEl.textContent = subscription.status === "connecting" ? "In progress" : formatRelativeTime(subscription.updatedAt);

  const activeCount = (primaryReady ? 1 : 0) + (standbyReady ? 1 : 0);
  const activeEl = document.querySelector("[data-connection-pool-active]");
  if (activeEl) activeEl.textContent = String(activeCount);
  const knownEl = document.querySelector("[data-connection-pool-known]");
  if (knownEl) knownEl.textContent = String(registry.endpointCount || 0);
  const failoversEl = document.querySelector("[data-connection-pool-failovers]");
  if (failoversEl) failoversEl.textContent = String((registry.successfulFailovers || 0) + (registry.failedFailovers || 0));

  const poolHealthEl = document.querySelector("[data-connection-pool-health]");
  if (poolHealthEl) {
    poolHealthEl.classList.remove("good", "warn", "bad");
    let health = "Healthy";
    let healthColor = "good";
    if (connection.primary === "error") { health = "Failed"; healthColor = "bad"; }
    else if (!primaryReady) { health = "Connecting"; healthColor = "warn"; }
    else if (!standbyReady) { health = "Degraded"; healthColor = "warn"; }
    poolHealthEl.textContent = health;
    poolHealthEl.classList.add(healthColor);
  }

  const endpointsCountEl = document.querySelector("[data-connection-endpoints-count]");
  if (endpointsCountEl) endpointsCountEl.textContent = String(registry.endpointCount || 0);

  const endpointsList = document.querySelector("[data-connection-endpoints-list]");
  if (endpointsList) {
    endpointsList.replaceChildren();
    if (!registry.endpoints?.length) {
      const empty = document.createElement("div");
      empty.className = "settings-list-row settings-info-row";
      const copy = document.createElement("span");
      copy.className = "settings-row-copy";
      const small = document.createElement("small");
      small.textContent = "No endpoints recorded yet.";
      copy.appendChild(small);
      empty.appendChild(copy);
      endpointsList.appendChild(empty);
    } else {
      registry.endpoints.forEach((entry) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "settings-list-row connection-endpoint-row";

        const copy = document.createElement("span");
        copy.className = "settings-row-copy";
        const strong = document.createElement("strong");
        strong.className = "connection-endpoint-host";
        strong.textContent = hostFromEndpoint(entry.endpoint);
        const small = document.createElement("small");
        const latencyColor = connectionLatencyColor(entry.averageLatencyMs);
        let smallText = `${entry.successes || 0} ok · ${entry.failures || 0} failed`;
        if (entry.averageLatencyMs) {
          const latencySpan = document.createElement("span");
          if (latencyColor) latencySpan.className = latencyColor;
          latencySpan.textContent = `${entry.averageLatencyMs} ms`;
          small.textContent = `${smallText} · `;
          small.appendChild(latencySpan);
          small.appendChild(document.createTextNode(` · ${formatRelativeTime(entry.lastSuccessAt || entry.lastFailureAt)}`));
        } else {
          small.textContent = `${smallText} · ${formatRelativeTime(entry.lastSuccessAt || entry.lastFailureAt)}`;
        }
        copy.appendChild(strong);
        copy.appendChild(small);
        row.appendChild(copy);

        const isPrimary = entry.endpoint === connection.primaryEndpoint;
        const isStandby = entry.endpoint === connection.standbyEndpoint;
        const badgeText = isPrimary ? "Primary" : isStandby ? "Standby" : entry.endpoint === registry.lastGoodEndpoint ? "Last good" : "";
        if (badgeText) {
          const badge = document.createElement("span");
          badge.className = "architecture-badge ready";
          badge.textContent = badgeText;
          row.appendChild(badge);
        }

        row.addEventListener("click", async () => {
          await navigator.clipboard.writeText(entry.endpoint);
          showCopyToast("Endpoint copied");
        });
        endpointsList.appendChild(row);
      });
    }
  }

  const failoversCountEl = document.querySelector("[data-connection-failovers-count]");
  if (failoversCountEl) failoversCountEl.textContent = String(registry.failovers?.length || 0);

  const failoversList = document.querySelector("[data-connection-failovers-list]");
  if (failoversList) {
    failoversList.replaceChildren();
    if (!registry.failovers?.length) {
      const empty = document.createElement("div");
      empty.className = "settings-list-row settings-info-row";
      const copy = document.createElement("span");
      copy.className = "settings-row-copy";
      const small = document.createElement("small");
      small.textContent = "No failovers recorded yet.";
      copy.appendChild(small);
      empty.appendChild(copy);
      failoversList.appendChild(empty);
    } else {
      registry.failovers.slice(0, 10).forEach((event) => {
        const row = document.createElement("div");
        row.className = "settings-list-row settings-info-row";
        const copy = document.createElement("span");
        copy.className = "settings-row-copy";
        const strong = document.createElement("strong");
        strong.textContent = `${event.success ? "✓" : "✗"} ${hostFromEndpoint(event.from) || "resolver"} → ${hostFromEndpoint(event.to) || "none"}`;
        const small = document.createElement("small");
        small.textContent = event.error ? `${formatRelativeTime(event.at)} · ${event.error}` : formatRelativeTime(event.at);
        copy.appendChild(strong);
        copy.appendChild(small);
        row.appendChild(copy);
        failoversList.appendChild(row);
      });
    }
  }
}

const photoQualityModal = document.querySelector("[data-photo-quality-modal]");
document.querySelector("[data-open-photo-quality]")?.addEventListener("click", () => {
  if (photoQualityModal) photoQualityModal.hidden = false;
});
document.querySelectorAll("[data-close-photo-quality]").forEach((button) => {
  button.addEventListener("click", () => {
    if (photoQualityModal) photoQualityModal.hidden = true;
  });
});
document.querySelector("[data-save-photo-quality]")?.addEventListener("click", () => {
  if (photoQualityModal) photoQualityModal.hidden = true;
  showCopyToast("Coming soon");
});

// --- KNS registration wizard --------------------------------------------------
// Real, on-chain domain registration (commit+reveal) followed by an optional
// profile-details save. Every step here spends real KAS once "Register
// Domain" or "Save Profile" is pressed — see engine/kns-write.js.

const knsRegisterModal = document.querySelector("[data-kns-register-modal]");
const knsWizardSteps = {
  funding: document.querySelector('[data-kns-step="funding"]'),
  domain: document.querySelector('[data-kns-step="domain"]'),
  details: document.querySelector('[data-kns-step="details"]'),
  done: document.querySelector('[data-kns-step="done"]'),
};
let knsWizardState = { assetId: null, domain: null, availability: null };

function showKnsWizardStep(name) {
  for (const [key, el] of Object.entries(knsWizardSteps)) if (el) el.hidden = key !== name;
}

function closeKnsRegisterModal() {
  if (knsRegisterModal) knsRegisterModal.hidden = true;
}

function knsStatusMessage(status) {
  return {
    "checking-availability": "Checking availability…",
    "fetching-fees": "Fetching current fee rates…",
    committing: "Broadcasting commit transaction…",
    committed: "Commit confirmed. Preparing reveal…",
    revealing: "Broadcasting reveal transaction…",
    revealed: "Reveal broadcast. Verifying…",
    verifying: "Verifying on the KNS indexer…",
    confirmed: "Confirmed!",
    "pending-confirmation": "Broadcast, but not showing on the indexer yet. It may still land shortly.",
  }[status] || status;
}

document.querySelector("[data-open-kns-register]")?.addEventListener("click", async () => {
  if (!knsRegisterModal) return;
  knsWizardState = { assetId: null, domain: null, availability: null };
  const errorEl = document.querySelector("[data-kns-funding-error]");
  const balanceEl = document.querySelector("[data-kns-current-balance]");
  const continueBtn = document.querySelector("[data-kns-funding-continue]");
  const minBalanceEl = document.querySelector("[data-kns-min-balance]");
  if (minBalanceEl) minBalanceEl.textContent = String(engine.knsEconomics().minRegistrationBalanceKas);
  if (errorEl) errorEl.hidden = true;
  if (balanceEl) balanceEl.textContent = "Checking…";
  if (continueBtn) continueBtn.disabled = true;
  document.querySelector("[data-kns-domain-label]").value = "";
  document.querySelector("[data-kns-domain-quote]").hidden = true;
  document.querySelector("[data-kns-register-submit]").disabled = true;
  document.querySelectorAll('[data-kns-step="details"] [data-kns-field]').forEach((el) => { el.value = ""; });
  showKnsWizardStep("funding");
  knsRegisterModal.hidden = false;

  try {
    await ensureRuntimes({ quiet: true });
    if (!engine.address) throw new Error("Generate or import a wallet first.");
    const balance = await engine.balance();
    if (balanceEl) balanceEl.textContent = `${balance.totalKas} KAS`;
    const minBalance = engine.knsEconomics().minRegistrationBalanceKas;
    const kas = Number(balance.totalKas);
    if (Number.isFinite(kas) && kas < minBalance) {
      if (errorEl) { errorEl.textContent = `You need at least ${minBalance} KAS to safely complete registration.`; errorEl.hidden = false; }
    } else if (continueBtn) {
      continueBtn.disabled = false;
    }
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message || "Could not check your balance."; errorEl.hidden = false; }
  }
});

document.querySelectorAll("[data-close-kns-register]").forEach((button) => {
  button.addEventListener("click", async () => {
    closeKnsRegisterModal();
    await refreshOwnKnsProfile();
  });
});

document.querySelector("[data-kns-funding-continue]")?.addEventListener("click", () => {
  showKnsWizardStep("domain");
});

document.querySelector("[data-kns-check-availability]")?.addEventListener("click", async () => {
  const input = document.querySelector("[data-kns-domain-label]");
  const quoteEl = document.querySelector("[data-kns-domain-quote]");
  const errorEl = document.querySelector("[data-kns-domain-error]");
  const submitBtn = document.querySelector("[data-kns-register-submit]");
  if (errorEl) errorEl.hidden = true;
  if (quoteEl) quoteEl.hidden = true;
  if (submitBtn) submitBtn.disabled = true;
  const rawLabel = input?.value || "";
  if (!rawLabel.trim()) {
    if (errorEl) { errorEl.textContent = "Enter a domain name."; errorEl.hidden = false; }
    return;
  }
  try {
    const availability = await engine.checkKnsDomainAvailability(rawLabel);
    if (!availability.available) {
      if (errorEl) { errorEl.textContent = `${availability.domain} is already taken.`; errorEl.hidden = false; }
      return;
    }
    const feeTiers = await engine.fetchKnsFeeTiers();
    const label = availability.domain.replace(/\.kas$/, "");
    const { commitAmountKas, revealAmountKas } = knsRegistrationAmounts(label, feeTiers, { isReservedDomain: availability.isReservedDomain });
    knsWizardState.availability = availability;
    if (quoteEl) {
      quoteEl.hidden = false;
      quoteEl.innerHTML = `<strong>${availability.domain}</strong> is available.<br>Estimated cost: ~${commitAmountKas} KAS (registration fee ~${revealAmountKas} KAS + network fees).`;
    }
    if (submitBtn) submitBtn.disabled = false;
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message || "Could not check availability."; errorEl.hidden = false; }
  }
});

document.querySelector("[data-kns-register-submit]")?.addEventListener("click", async () => {
  const input = document.querySelector("[data-kns-domain-label]");
  const errorEl = document.querySelector("[data-kns-domain-error]");
  const progressEl = document.querySelector("[data-kns-register-progress]");
  const submitBtn = document.querySelector("[data-kns-register-submit]");
  const checkBtn = document.querySelector("[data-kns-check-availability]");
  if (errorEl) errorEl.hidden = true;
  if (progressEl) { progressEl.hidden = false; progressEl.textContent = "Starting…"; }
  if (submitBtn) submitBtn.disabled = true;
  if (checkBtn) checkBtn.disabled = true;
  try {
    const result = await engine.inscribeKnsDomain(input?.value || "", {
      onStatus: (event) => { if (progressEl) progressEl.textContent = knsStatusMessage(event.status); },
    });
    knsWizardState.assetId = result.assetId;
    knsWizardState.domain = result.domain;
    document.querySelector("[data-kns-registered-domain]").textContent = result.domain;
    engine.clearKnsCache(engine.address);
    showKnsWizardStep("details");
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message || "Registration failed."; errorEl.hidden = false; }
    if (progressEl) progressEl.hidden = true;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (checkBtn) checkBtn.disabled = false;
  }
});

document.querySelector("[data-kns-details-skip]")?.addEventListener("click", async () => {
  closeKnsRegisterModal();
  await refreshOwnKnsProfile();
});

// --- KNS profile editor (for an already-registered domain) -------------------

const knsEditorModal = document.querySelector("[data-kns-editor-modal]");

document.querySelector("[data-open-kns-editor]")?.addEventListener("click", () => {
  if (!knsEditorModal || !ownKnsAssetId) {
    showCopyToast("Your domain isn't confirmed yet. Try again shortly.");
    return;
  }
  document.querySelector("[data-kns-editor-error]").hidden = true;
  document.querySelector("[data-kns-editor-progress]").hidden = true;
  document.querySelectorAll("[data-kns-editor-field]").forEach((el) => {
    el.value = ownKnsProfileFields?.[el.dataset.knsEditorField] || "";
  });
  knsEditorModal.hidden = false;
});

document.querySelectorAll("[data-close-kns-editor]").forEach((button) => {
  button.addEventListener("click", () => { if (knsEditorModal) knsEditorModal.hidden = true; });
});

document.querySelector("[data-kns-editor-save]")?.addEventListener("click", async () => {
  const errorEl = document.querySelector("[data-kns-editor-error]");
  const progressEl = document.querySelector("[data-kns-editor-progress]");
  const saveBtn = document.querySelector("[data-kns-editor-save]");
  if (errorEl) errorEl.hidden = true;
  if (!ownKnsAssetId) {
    if (errorEl) { errorEl.textContent = "Your domain isn't confirmed yet."; errorEl.hidden = false; }
    return;
  }

  const fields = {};
  document.querySelectorAll("[data-kns-editor-field]").forEach((el) => {
    const key = el.dataset.knsEditorField;
    const current = ownKnsProfileFields?.[key] || "";
    if (el.value.trim() !== current.trim()) fields[key] = el.value;
  });
  if (!Object.keys(fields).length) {
    if (knsEditorModal) knsEditorModal.hidden = true;
    return;
  }

  let validated;
  try {
    validated = engine.validateKnsProfileFields(fields);
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message; errorEl.hidden = false; }
    return;
  }

  if (progressEl) { progressEl.hidden = false; progressEl.textContent = "Starting…"; }
  if (saveBtn) saveBtn.disabled = true;
  try {
    const results = await engine.submitKnsProfileFields(ownKnsAssetId, validated, {
      onStatus: (event) => {
        if (!progressEl) return;
        const label = KNS_PROFILE_FIELD_EDIT_ORDER.includes(event.key) ? event.key : "";
        progressEl.textContent = `${label ? `${label}: ` : ""}${knsStatusMessage(event.status) || event.status}`;
      },
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length && errorEl) {
      errorEl.textContent = `Some fields failed: ${failed.map((f) => f.key).join(", ")}. Try again shortly.`;
      errorEl.hidden = false;
    } else if (knsEditorModal) {
      knsEditorModal.hidden = true;
    }
    engine.clearKnsCache(engine.address);
    await refreshOwnKnsProfile();
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message || "Saving profile changes failed."; errorEl.hidden = false; }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (progressEl) progressEl.hidden = true;
  }
});

document.querySelector("[data-kns-details-save]")?.addEventListener("click", async () => {
  const errorEl = document.querySelector("[data-kns-details-error]");
  const progressEl = document.querySelector("[data-kns-details-progress]");
  const saveBtn = document.querySelector("[data-kns-details-save]");
  if (errorEl) errorEl.hidden = true;
  if (!knsWizardState.assetId) {
    if (errorEl) { errorEl.textContent = "Domain isn't confirmed yet. Try again from your Profile screen shortly."; errorEl.hidden = false; }
    return;
  }
  const fields = {};
  document.querySelectorAll('[data-kns-step="details"] [data-kns-field]').forEach((el) => {
    fields[el.dataset.knsField] = el.value;
  });
  let validated;
  try {
    validated = engine.validateKnsProfileFields(fields);
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message; errorEl.hidden = false; }
    return;
  }
  const changed = Object.fromEntries(Object.entries(validated).filter(([, v]) => v));
  if (!Object.keys(changed).length) {
    showKnsWizardStep("done");
    return;
  }

  if (progressEl) { progressEl.hidden = false; progressEl.textContent = "Starting…"; }
  if (saveBtn) saveBtn.disabled = true;
  try {
    const results = await engine.submitKnsProfileFields(knsWizardState.assetId, changed, {
      onStatus: (event) => {
        if (!progressEl) return;
        const label = KNS_PROFILE_FIELD_EDIT_ORDER.includes(event.key) ? event.key : "";
        progressEl.textContent = `${label ? `${label}: ` : ""}${knsStatusMessage(event.status) || event.status}`;
      },
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length && errorEl) {
      errorEl.textContent = `Some fields failed: ${failed.map((f) => f.key).join(", ")}. You can retry from your Profile screen.`;
      errorEl.hidden = false;
    }
    engine.clearKnsCache(engine.address);
    showKnsWizardStep("done");
  } catch (error) {
    if (errorEl) { errorEl.textContent = error.message || "Saving profile details failed."; errorEl.hidden = false; }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (progressEl) progressEl.hidden = true;
  }
});

// Rebuilds contacts purely from on-chain self-stash data plus the active
// wallet's seed/private key — no local backup file required. See
// stashHandshakeForRecovery() for what gets written, and
// engine.syncSelfStashFromChain for the scan/decrypt side.
async function recoverConversationsFromBlockchain() {
  await ensureRuntimes({ quiet: true });
  if (!engine.address) throw new Error("Generate or import a wallet first.");
  const result = await engine.syncSelfStashFromChain({});
  let recovered = 0;
  for (const stash of result.stashes || []) {
    if (!stash.partnerAddress || stash.partnerAddress === engine.address) continue;
    if (state.contacts.some((entry) => entry.address === stash.partnerAddress)) continue;
    const createdAt = Number(stash.timestamp || stash.blockTime || Date.now());
    const displayName = shortAddress(stash.partnerAddress);
    const contact = {
      id: nowId(), name: displayName, nameIsCustom: false, address: stash.partnerAddress, avatar: initialsFor(displayName),
      createdAt, updatedAt: createdAt, relationshipState: "legacy-manual", handshakeTxid: "",
    };
    const conversationEntry = createConversation({ contactId: contact.id, createdAt });
    state.contacts.push(contact);
    state.conversations.push(conversationEntry);
    recovered += 1;
  }
  if (recovered > 0) {
    refreshSubscriptionAddresses({ restart: true });
    persistState();
    renderChats();
  }
  return { recovered, scanned: result.scannedCount || 0, errors: result.errors || [] };
}

document.querySelector("[data-recover-conversations]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const { recovered, scanned, errors } = await recoverConversationsFromBlockchain();
    if (errors.length) appendEngineLog(`Recovery scan warnings: ${errors.join(" | ")}`);
    appendEngineLog(`Recovery scan complete: ${scanned} self-stash record(s) found, ${recovered} new conversation(s) recovered.`);
    showCopyToast(recovered > 0 ? `Recovered ${recovered} conversation${recovered === 1 ? "" : "s"}` : "No new conversations found");
  } catch (error) {
    showCopyToast(`Recovery failed: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

function saveProfileAccountName() {
  if (!profileAccountName || !engine.address) return;
  const cleanName = String(profileAccountName.value || "").trim();
  const current = activeAccountMetadata();
  if (!cleanName) {
    profileAccountName.value = current?.name || "Current Account";
    return;
  }
  if (cleanName === current?.name) return;

  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  metadata[engine.address] = {
    ...(metadata[engine.address] || {}),
    name: cleanName,
    createdAt: metadata[engine.address]?.createdAt || current?.createdAt || new Date().toISOString(),
  };
  localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(metadata));

  const accounts = loadSavedAccounts();
  const index = accounts.findIndex((entry) => entry.address === engine.address);
  if (index >= 0) {
    accounts[index] = { ...accounts[index], name: cleanName };
    persistSavedAccounts(accounts);
  }

  updateWalletUi();
  renderSavedAccountsScreen();
  showCopyToast("Account name saved");
}

profileAccountName?.addEventListener("blur", saveProfileAccountName);
profileAccountName?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    profileAccountName.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    profileAccountName.value = activeAccountMetadata()?.name || "Current Account";
    profileAccountName.blur();
  }
});

// Zero-balance chat gate: with a confirmed 0 KAS chatting balance, composing is disabled
// and a funding card (QR + address + copy) shows above the composer. "--"/unknown never
// gates — only a real zero does. Clears itself the moment the balance refresh finds funds.
let fundingGateQrDrawnFor = null;

/// True only for a CONFIRMED zero chatting balance ("--"/unknown never gates).
function isChattingBalanceZero() {
  const kas = Number(currentBalanceKas);
  return Boolean(engine.address) && Number.isFinite(kas) && kas === 0;
}

// Modal variant of the funding gate, for flows without an inline composer to gate
// (broadcast rooms, KaPosts new-post/reply). Built once, on demand.
let fundingGateModalEl = null;

function showFundingGateModal() {
  if (!fundingGateModalEl) {
    fundingGateModalEl = document.createElement("div");
    fundingGateModalEl.className = "modal-backdrop funding-gate-backdrop";
    fundingGateModalEl.innerHTML = `
      <div class="contact-modal funding-gate-modal" role="dialog" aria-modal="true" aria-label="Fund your chatting address">
        <div class="modal-header">
          <div><p class="modal-kicker">Balance needed</p><h2>Fund your chatting address to start chatting</h2></div>
          <button class="modal-close" type="button" data-funding-modal-close aria-label="Close">×</button>
        </div>
        <div class="chat-funding-gate funding-gate-modal-body">
          <canvas width="360" height="360" data-funding-modal-qr></canvas>
          <button type="button" class="chat-funding-gate-address" data-funding-modal-address title="Copy address"></button>
          <button type="button" class="secondary-button" data-funding-modal-copy>Copy Address</button>
        </div>
      </div>`;
    document.body.appendChild(fundingGateModalEl);
    fundingGateModalEl.addEventListener("click", async (event) => {
      if (event.target === fundingGateModalEl || event.target.closest("[data-funding-modal-close]")) {
        fundingGateModalEl.hidden = true;
        return;
      }
      if (event.target.closest("[data-funding-modal-address]") || event.target.closest("[data-funding-modal-copy]")) {
        if (!engine.address) return;
        try { await copyTextToClipboard(engine.address); showCopyToast("Address copied to clipboard."); }
        catch (error) { appendEngineLog(error.message); }
      }
    });
  }
  const addressEl = fundingGateModalEl.querySelector("[data-funding-modal-address]");
  if (addressEl) addressEl.textContent = engine.address || "";
  const canvas = fundingGateModalEl.querySelector("[data-funding-modal-qr]");
  if (canvas && engine.address) {
    engine.drawQrFor(canvas, engine.address, { dark: "#06110f", light: "#ffffff" })
      .then(() => { canvas.style.width = "180px"; canvas.style.height = "180px"; })
      .catch(() => {});
  }
  fundingGateModalEl.hidden = false;
}

function updateChatFundingGate() {
  // Looked up per call (not a module const): this runs from setActiveConversationId too,
  // which can fire before module evaluation reaches this section.
  const fundingGateEl = document.querySelector("[data-funding-gate]");
  if (!fundingGateEl) return;
  const kas = Number(currentBalanceKas);
  const shouldGate = Boolean(activeConversationId) && Boolean(engine.address)
    && Number.isFinite(kas) && kas === 0;
  fundingGateEl.hidden = !shouldGate;
  composer?.classList.toggle("composer-gated", shouldGate);
  const input = composer?.elements?.message;
  if (input) input.disabled = shouldGate;
  if (!shouldGate) return;

  const addressEl = fundingGateEl.querySelector("[data-funding-gate-address]");
  if (addressEl) addressEl.textContent = engine.address;
  const canvas = fundingGateEl.querySelector("[data-funding-gate-qr]");
  if (canvas && fundingGateQrDrawnFor !== engine.address) {
    fundingGateQrDrawnFor = engine.address;
    engine.drawQrFor(canvas, engine.address, { dark: "#06110f", light: "#ffffff" })
      .then(() => { canvas.style.width = "180px"; canvas.style.height = "180px"; })
      .catch(() => { fundingGateQrDrawnFor = null; });
  }
}

document.querySelector("[data-funding-gate]")?.addEventListener("click", async (event) => {
  if (event.target.closest("[data-funding-gate-address]") || event.target.closest("[data-funding-gate-copy]")) {
    if (!engine.address) return;
    try { await copyTextToClipboard(engine.address); showCopyToast("Address copied to clipboard."); }
    catch (error) { appendEngineLog(error.message); }
  }
});

function updateWalletUi() {
  updateChatFundingGate();
  const address = engine.address;
  const meta = activeAccountMetadata();
  const accountName = meta?.name || (address ? "Current Account" : "No Active Account");
  if (toolbarBalanceValue) toolbarBalanceValue.textContent = `${currentBalanceKas} KAS`;
  else toolbarBalance.textContent = `${currentBalanceKas} KAS`;
  if (profileBalance) profileBalance.textContent = `${currentBalanceKas} KAS`;
  if (chattingAddressBalance) chattingAddressBalance.textContent = `${currentBalanceKas} KAS`;
  if (profileAddress) profileAddress.textContent = address || "No wallet loaded";
  if (profileInitial) profileInitial.textContent = address ? accountName.trim().charAt(0).toUpperCase() || "K" : "◎";
  if (profileAccountName && document.activeElement !== profileAccountName) profileAccountName.value = accountName;
  if (profileSessionState) profileSessionState.textContent = "";
  if (profileCreated) profileCreated.textContent = meta?.createdAt ? new Date(meta.createdAt).toLocaleString() : "—";
  if (settingsAccountName) settingsAccountName.textContent = accountName;
  if (settingsAccountAddress) settingsAccountAddress.textContent = address ? shortAddress(address) : "No wallet loaded";
  if (accountModalName) accountModalName.textContent = accountName;
  if (accountModalAddress) accountModalAddress.textContent = address ? shortAddress(address) : "No wallet loaded";
  if (accountModalInitial) accountModalInitial.textContent = address ? accountName.trim().charAt(0).toUpperCase() || "K" : "◎";
  if (profileQrCard && !address) profileQrCard.hidden = true;
  drawProfileQr();
}

async function drawProfileQr() {
  if (!profileQr) return; // inline profile QR card removed — Receive Kaspa uses the full-screen view
  const ctx = profileQr.getContext("2d");
  ctx.clearRect(0, 0, profileQr.width, profileQr.height);

  if (!engine.address) return;

  try {
    await engine.drawQr(profileQr);
  } catch (error) {
    appendEngineLog(`QR failed: ${error.message}`);
  }
}

function setCreateChatError(message = "") {
  if (!createChatError) return;
  createChatError.textContent = String(message || "");
  createChatError.hidden = !message;
}

// Live validity feedback under the Create Chat address field, matching iOS's
// "Valid address" / "Resolved: name.kas" / "Invalid address format" states.
let createChatResolveToken = 0;

function renderCreateChatStatus(html) {
  const statusEl = document.querySelector("[data-create-chat-status]");
  if (!statusEl) return;
  statusEl.innerHTML = html || "";
  statusEl.hidden = !html;
}

function updateCreateChatAddState() {
  if (!createChatAddButton || !contactAddressInput) return;
  const raw = String(contactAddressInput.value || "").trim();
  const token = ++createChatResolveToken;

  if (!raw) {
    renderCreateChatStatus("");
    createChatAddButton.disabled = true;
    return;
  }

  if (raw.startsWith("kaspa:") || raw.startsWith("kaspatest:")) {
    let valid = false;
    if (engine.kaspa) {
      try { validateContactAddress(raw); valid = true; } catch { /* invalid */ }
    } else {
      valid = raw.length > 20;
    }
    renderCreateChatStatus(valid
      ? '<span class="create-chat-status-good">✓ Valid address</span>'
      : '<span class="create-chat-status-bad">✕ Invalid address format</span>');
    createChatAddButton.disabled = !valid;
    return;
  }

  if (engine.knsLooksLikeDomain(raw)) {
    // Matches both "name.kas" and a bare "name" — resolution normalizes either
    // form by appending .kas if it's missing (see resolveKnsDomain). Debounced
    // live resolution so Add only enables for a domain that actually exists.
    renderCreateChatStatus('<span class="create-chat-status-muted">Resolving KNS domain…</span>');
    createChatAddButton.disabled = true;
    window.setTimeout(async () => {
      if (token !== createChatResolveToken) return;
      try {
        const resolution = await engine.resolveKnsDomain(raw);
        if (token !== createChatResolveToken) return;
        if (resolution?.ownerAddress) {
          renderCreateChatStatus(
            `<span class="create-chat-status-good">✓ Resolved: ${escapeHtml(resolution.domain || raw)}</span>`
            + `<span class="create-chat-status-mono">${escapeHtml(resolution.ownerAddress)}</span>`
          );
          createChatAddButton.disabled = false;
        } else {
          renderCreateChatStatus('<span class="create-chat-status-bad">✕ KNS domain not found</span>');
        }
      } catch {
        if (token !== createChatResolveToken) return;
        renderCreateChatStatus('<span class="create-chat-status-bad">✕ KNS domain not found</span>');
      }
    }, 300);
    return;
  }

  renderCreateChatStatus('<span class="create-chat-status-bad">✕ Invalid address format</span>');
  createChatAddButton.disabled = true;
}

function setContactAddressValue(value) {
  if (!contactAddressInput) return;
  contactAddressInput.value = String(value || "").trim();
  setCreateChatError("");
  updateCreateChatAddState();
  contactAddressInput.focus();
}

function showContactModal() {
  contactModal.hidden = false;
  setCreateChatError("");
  updateCreateChatAddState();
  window.setTimeout(() => contactAddressInput?.focus(), 0);
}

function closeContactModal() {
  contactModal.hidden = true;
  contactForm.reset();
  setCreateChatError("");
  updateCreateChatAddState();
}

function showImportPayloadModal() {
  if (!activeConversationId || !importPayloadModal) return;
  importPayloadModal.hidden = false;
  window.setTimeout(() => importPayloadInput?.focus(), 0);
}

function closeImportPayloadModal() {
  if (!importPayloadModal) return;
  importPayloadModal.hidden = true;
  importPayloadForm?.reset();
}

function importPayloadIntoConversation(payloadValue) {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) return;

  const payloadHex = normalizeImportedPayload(payloadValue);
  const parsed = engine.parseKasiaPayloadHex(payloadHex);
  if (!parsed) throw new Error("Payload did not match the Kasia preview format.");

  const createdAt = Date.now();
  const bodyText = parsed.bodyText || "Imported Kasia payload";
  const txid = `manual-import-${String(payloadHex).slice(-8)}`;
  const message = createMessage({
    conversationId: conversationEntry.id,
    contactId: contact.id,
    direction: "incoming",
    text: bodyText,
    sender: contact.address,
    receiver: engine.address || null,
    status: MESSAGE_STATUSES.CONFIRMED,
    transport: "manual-import",
    createdAt,
  });

  applyMessagePatch(message, {
    txid,
    daaScore: String(Math.floor(createdAt / 1000)),
    confirmations: 1,
    network: "mainnet",
    payloadHex,
    payloadBytes: Math.ceil(payloadHex.length / 2),
    messageType: parsed.type || "comm",
    protocol: parsed.protocol || "kasia",
    protocolVersion: parsed.version || 1,
    checksum: parsed.checksum || null,
    protocolString: parsed.protocolString || String(payloadValue || "").trim(),
  });

  appendIncomingOrReactionMessage(conversationEntry, message);
  conversationEntry.sync = {
    ...(conversationEntry.sync || {}),
    lastSyncAt: Date.now(),
    lastFound: 1,
    runs: Number(conversationEntry.sync?.runs || 0) + 1,
    cursor: Number(conversationEntry.sync?.cursor || 0),
    lastNote: "Manual Kasia payload import decoded.",
  };

  persistState();
  renderMessages(conversationEntry);
  if (syncStatus) syncStatus.textContent = syncLabel(conversationEntry);
  setStatus("Kasia payload imported");
}

function updateChatsListTabBadges() {
  const totalUnread = state.conversations.reduce((sum, entry) => sum + Number(entry.unreadCount || 0), 0);
  if (chatsTabBadge) {
    chatsTabBadge.textContent = totalUnread > 99 ? "99+" : String(totalUnread);
    chatsTabBadge.hidden = totalUnread <= 0;
  }
  // Group Chats has no real backend yet, so its badge stays hidden at 0.
  if (groupsTabBadge) groupsTabBadge.hidden = true;
}

function renderChats() {
  // Keep one stable in-memory state object during the session. Browser storage is
  // for startup/recovery only; reloading it here used to replace live conversation
  // references and make message history disappear until another mutation rerendered it.
  if (!isWideLayout) setActiveConversationId(null);
  updateChatsListTabBadges();

  if (activeChatsListTab === "groups") {
    if (emptyState) emptyState.hidden = true;
    chatList.hidden = true;
    chatList.innerHTML = "";
    if (groupChatsPlaceholder) groupChatsPlaceholder.hidden = false;
    return;
  }
  if (groupChatsPlaceholder) groupChatsPlaceholder.hidden = true;

  const query = searchInput.value.trim().toLowerCase();
  const visibleConversations = sortedConversations().filter((conversationEntry) => {
    const contact = contactForConversation(conversationEntry);
    if (!contact) return false;
    const preview = conversationPreview(conversationEntry);
    return (
      contact.name.toLowerCase().includes(query) ||
      contact.address.toLowerCase().includes(query) ||
      preview.toLowerCase().includes(query)
    );
  });

  if (state.conversations.length === 0) {
    emptyState.hidden = false;
    chatList.hidden = true;
    chatList.innerHTML = "";
    return;
  }

  emptyState.hidden = true;
  chatList.hidden = false;

  if (visibleConversations.length === 0) {
    chatList.innerHTML = `
      <div class="no-results-card">
        <strong>No matching chats</strong>
        <span>Try a different name, address, or message.</span>
      </div>
    `;
    return;
  }

  chatList.innerHTML = visibleConversations
    .map((conversationEntry) => {
      const contact = contactForConversation(conversationEntry);
      const last = lastMessageFor(conversationEntry);
      const preview = conversationPreview(conversationEntry);
      const time = last ? formatTime(last.createdAt) : formatTime(conversationEntry.createdAt);
      const selected = selectedChatConversationIds.has(conversationEntry.id);
      return `
        <button class="chat-row${chatSelectionModeActive ? " selecting" : ""}${selected ? " selected" : ""}" type="button" data-conversation-id="${escapeHtml(conversationEntry.id)}">
          ${chatSelectionModeActive ? `<span class="chat-row-select" aria-hidden="true"><span class="chat-row-checkbox${selected ? " checked" : ""}"></span></span>` : ``}
          <span class="chat-row-time">${escapeHtml(time)}</span>
          ${avatarHtmlFor(contact)}
          <span class="chat-meta">
            <strong>${escapeHtml(displayNameForAddress(contact))}</strong>
            <span>${escapeHtml(preview)}</span>
          </span>
          ${conversationEntry.unreadCount > 0 ? `<b class="unread-badge">${conversationEntry.unreadCount > 99 ? "99+" : conversationEntry.unreadCount}</b>` : ``}
        </button>
      `;
    })
    .join("");

  refreshVisibleKnsNames(visibleConversations);
}

// Background KNS refresh for the chat list: peek-rendered synchronously above
// (possibly stale/absent), then quietly re-fetch and re-render once real data
// lands. refreshKnsIfNeeded's own debounce/backoff keeps this cheap even
// though renderChats() runs often.
let knsChatListRefreshInFlight = false;
async function refreshVisibleKnsNames(visibleConversations) {
  if (knsChatListRefreshInFlight || !engine.address) return;
  const contacts = visibleConversations
    .map((entry) => contactForConversation(entry))
    .filter((contact) => contact?.address);
  if (!contacts.length) return;
  knsChatListRefreshInFlight = true;
  try {
    const attempted = await engine.refreshKnsIfNeeded(contacts.map((contact) => contact.address));
    let changed = false;
    for (const contact of contacts) {
      if (applyKnsPrimaryDomainToContact(contact)) changed = true;
    }
    if (changed) persistState();
    if (attempted > 0 || changed) {
      renderChats();
      if (activeConversationId) {
        const activeEntry = state.conversations.find((entry) => entry.id === activeConversationId);
        const activeContact = activeEntry ? contactForConversation(activeEntry) : null;
        if (activeContact) {
          conversationName.textContent = displayNameForAddress(activeContact);
          updateAvatarElement(conversationAvatarInitials, conversationAvatarImage, activeContact);
          updateConversationBio(activeContact);
          renderMessages(activeEntry);
        }
      }
    }
  } catch {
    // best-effort background refresh; failures just leave the peeked cache as-is
  } finally {
    knsChatListRefreshInFlight = false;
  }
}

function createDeliveryStatusIcon(message) {
  if (message.direction !== "outgoing") return null;

  const status = String(message.status || MESSAGE_STATUSES.PENDING);
  const icon = document.createElement("span");
  icon.className = "message-delivery-icon";

  if (status === MESSAGE_STATUSES.FAILED) {
    icon.classList.add("failed");
    icon.setAttribute("aria-label", "Message not delivered");
    icon.title = "Not delivered";
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6.8v7.1"/><circle class="status-dot-mark" cx="12" cy="17.3" r="1.15"/></svg>';
    return icon;
  }

  if (status === MESSAGE_STATUSES.CONFIRMED) {
    icon.classList.add("confirmed");
    icon.setAttribute("aria-label", "Message delivered");
    icon.title = "Delivered";
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="status-fill" cx="12" cy="12" r="10"/><path class="status-check" d="m7.4 12.3 3 3.1 6.4-7"/></svg>';
    return icon;
  }

  icon.classList.add("pending");
  icon.setAttribute("aria-label", "Message pending");
  icon.title = "Pending";
  icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/><path d="M12 6.8v5.6l3.7 2.1"/></svg>';
  return icon;
}

function renderMessages(conversationEntry) {
  hydrateConversationMessages(conversationEntry);
  const messages = conversationEntry.messages || [];
  messageArea.innerHTML = "";

  const requestContact = contactForConversation(conversationEntry);
  if (requestContact?.relationshipState === "incoming-request") {
    const card = document.createElement("section");
    card.className = "handshake-request-card";
    card.innerHTML = `
      <strong>Communication request</strong>
      <span>${escapeHtml(requestContact.name || shortAddress(requestContact.address))} wants to start an encrypted KaChat conversation.</span>
      <div class="handshake-request-actions">
        <button type="button" class="secondary-button" data-decline-handshake>Decline</button>
        <button type="button" class="primary-button" data-accept-handshake>Accept</button>
      </div>`;
    messageArea.appendChild(card);
  }

  if (messages.length === 0) {
    messageArea.appendChild(messageEmpty);
    messageEmpty.hidden = false;
    return;
  }

  messageEmpty.hidden = true;

  messages.forEach((message, index) => {
    const row = document.createElement("div");
    row.className = `message-row ${message.direction === "incoming" ? "incoming" : "local"}`;

    const selector = document.createElement("span");
    selector.className = "message-selector";
    selector.setAttribute("aria-hidden", "true");
    selector.innerHTML = '<svg viewBox="0 0 20 20"><path d="m5.1 10.1 3.1 3.1 6.7-7"/></svg>';

    // Incoming messages match iMessage's grouping: an avatar sits next to
    // the last bubble of a consecutive run, not every single one. Your own
    // messages always get one, on every message, per request.
    const avatarSlot = document.createElement("span");
    avatarSlot.className = "message-avatar-slot";
    if (message.direction === "incoming") {
      const nextMessage = messages[index + 1];
      const isLastInGroup = !nextMessage || nextMessage.direction !== message.direction;
      if (isLastInGroup && requestContact) avatarSlot.innerHTML = avatarHtmlFor(requestContact, "message-avatar");
    } else {
      avatarSlot.innerHTML = selfAvatarHtml("message-avatar");
    }

    const bubble = document.createElement("div");
    bubble.className = `message-bubble ${message.direction === "incoming" ? "incoming" : "local"}`;
    bubble.dataset.messageId = message.id;
    bubble.title = messageSelectionMode ? "Select message" : "Open message actions";
    bubble.tabIndex = 0;
    bubble.setAttribute("role", messageSelectionMode ? "checkbox" : "button");
    bubble.setAttribute("aria-checked", selectedMessageIds.has(message.id) ? "true" : "false");
    if (messageSelectionMode) bubble.classList.add("selectable");
    if (selectedMessageIds.has(message.id)) {
      bubble.classList.add("selected");
      row.classList.add("selected");
    }

    const chessEnv = Chess.parseChessEnvelope(Chess.unwrapReplyText(message.text));
    if (chessEnv) {
      // The latest chess message of a game renders as a live board thumbnail with
      // status (so on your turn you see the position); earlier ones stay compact.
      const isLatestChess = !(conversationEntry.messages || []).some((other) => {
        if (other === message || (other.createdAt || 0) <= (message.createdAt || 0)) return false;
        const oe = Chess.parseChessEnvelope(Chess.unwrapReplyText(other.text));
        return oe && oe.gameId === chessEnv.gameId;
      });
      const contactAddr = requestContact?.address;
      const summary = (isLatestChess && contactAddr && engine.address)
        ? Chess.summarizeChessGame(chessEnv.gameId, (conversationEntry.messages || []).map((m) => ({ text: m.text, outgoing: m.direction === "outgoing", txid: m.txid || m.id, at: m.createdAt || 0 })), engine.address, contactAddr)
        : null;
      if (summary) {
        bubble.append(buildChessThumb(summary, chessEnv.gameId));
      } else {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "message-chess";
        const icon = document.createElement("span");
        icon.className = "message-chess-icon";
        icon.textContent = "♟";
        const label = document.createElement("span");
        label.className = "message-chess-label";
        label.textContent = Chess.chessEnvelopeLabel(message.text) || "Chess";
        card.append(icon, label);
        card.addEventListener("click", (event) => { event.stopPropagation(); openChessGame(chessEnv.gameId); });
        bubble.append(card);
      }
    } else {
    const imageEnvelope = parseImageEnvelope(message.text);
    const audioEnvelope = imageEnvelope ? null : parseAudioEnvelope(message.text);
    const replyEnvelope = (imageEnvelope || audioEnvelope) ? null : parseReplyEnvelope(message.text);
    if (replyEnvelope) {
      const quote = document.createElement("div");
      quote.className = "message-reply-quote";
      const label = document.createElement("strong");
      label.textContent = "Reply";
      const preview = document.createElement("span");
      preview.textContent = replyEnvelope.replyToPreview || "Message";
      quote.append(label, preview);
      quote.addEventListener("click", (event) => {
        event.stopPropagation();
        jumpToMessageByTxid(replyEnvelope.replyToId);
      });
      bubble.append(quote);
    }

    if (imageEnvelope) {
      const manualPhoto = message.direction === "incoming"
        && getContactPhotos(requestContact?.address) === "manual"
        && !revealedPhotoIds.has(message.id);
      if (manualPhoto) {
        const reveal = document.createElement("button");
        reveal.type = "button";
        reveal.className = "message-photo-hidden";
        reveal.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m5 17 4.5-4.5 3.2 3.2 2.3-2.3L19 17"/></svg><span>Tap to view photo</span>';
        reveal.addEventListener("click", (event) => { event.stopPropagation(); revealedPhotoIds.add(message.id); renderMessages(conversationEntry); });
        bubble.append(reveal);
      } else {
        const img = document.createElement("img");
        img.className = "message-photo";
        img.src = imageEnvelope.content;
        img.alt = imageEnvelope.name || "Photo";
        img.addEventListener("click", () => openPhotoPreview(imageEnvelope.content));
        bubble.append(img);
      }
    } else if (audioEnvelope) {
      const audioWrap = document.createElement("div");
      audioWrap.className = "message-audio-bubble";
      const player = document.createElement("audio");
      player.controls = true;
      player.preload = "metadata";
      player.src = audioEnvelope.content;
      player.addEventListener("click", (event) => event.stopPropagation());
      audioWrap.append(player);
      bubble.append(audioWrap);
    } else {
      const text = document.createElement("span");
      text.className = "message-text";
      const bodyText = replyEnvelope ? replyEnvelope.text : message.text;
      const linkUrls = renderTextWithLinks(text, bodyText);
      bubble.append(text);
      const previewable = linkUrls.find(isPreviewableUrl);
      if (previewable) {
        const card = buildLinkPreviewCard(previewable);
        if (card) bubble.append(card);
      }
    }
    }
    // Hover reaction bar — desktop's equivalent of iOS's double-tap
    // quick-reaction bar. Skipped for messages with no real txid yet
    // (nothing to target on the wire) and while in selection mode.
    if (message.txid || message.id) {
      const reactionBar = document.createElement("div");
      reactionBar.className = "message-reaction-bar";
      const pill = document.createElement("div");
      pill.className = "message-reaction-bar-pill";
      const myAddress = engine.address || "";
      const myCurrentEmoji = (conversationEntry.reactionsByTxId?.[message.txid || message.id] || [])
        .find((entry) => entry.reactorAddress === myAddress)?.emoji;
      for (const emoji of QUICK_REACTION_EMOJIS) {
        const emojiButton = document.createElement("button");
        emojiButton.type = "button";
        emojiButton.textContent = emoji;
        if (emoji === myCurrentEmoji) emojiButton.classList.add("active");
        emojiButton.addEventListener("click", (event) => {
          event.stopPropagation();
          sendReaction(conversationEntry, message, emoji);
        });
        pill.append(emojiButton);
      }
      reactionBar.append(pill);
      bubble.append(reactionBar);
    }

    const reactions = conversationEntry.reactionsByTxId?.[message.txid || message.id] || [];
    if (reactions.length) {
      const pill = document.createElement("div");
      pill.className = "message-reaction-pill";
      const counts = new Map();
      for (const entry of reactions) counts.set(entry.emoji, (counts.get(entry.emoji) || 0) + 1);
      for (const [emoji, count] of counts) {
        const entryEl = document.createElement("span");
        entryEl.className = "message-reaction-pill-entry";
        entryEl.textContent = emoji;
        if (count > 1) {
          const countEl = document.createElement("span");
          countEl.className = "message-reaction-pill-count";
          countEl.textContent = String(count);
          entryEl.append(countEl);
        }
        pill.append(entryEl);
      }
      pill.addEventListener("click", (event) => event.stopPropagation());
      bubble.append(pill);
    }

    const deliveryIcon = createDeliveryStatusIcon(message);
    row.append(selector, avatarSlot, bubble);
    if (deliveryIcon) row.append(deliveryIcon);
    if (message.direction === "outgoing" && message.status === MESSAGE_STATUSES.FAILED) {
      const retryLink = document.createElement("button");
      retryLink.type = "button";
      retryLink.className = "message-retry-link";
      retryLink.textContent = "Not Delivered · Retry";
      retryLink.addEventListener("click", (event) => {
        event.stopPropagation();
        runEngineSendPipeline(conversationEntry.id, message.id);
      });
      row.append(retryLink);
    }
    messageArea.appendChild(row);
  });

  messageArea.scrollTop = messageArea.scrollHeight;
  // Keep an open chess board in sync with newly-arrived moves/invites/resigns.
  refreshChessOverlay();
}

function openConversation(conversationId) {
  messageSelectionMode = false;
  selectedMessageIds.clear();
  updateSelectionUi();

  // The detail pane may still hold a Settings/Profile scroll offset. Reset it
  // before the thread switches to its own internal message scroller.
  if (appDetail) appDetail.scrollTop = 0;

  // Use the existing canonical in-memory state. Replacing state from localStorage
  // during navigation invalidated live conversation references and caused blank chats.
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) {
    setActiveConversationId(null);
    renderChats();
    return;
  }

  hydrateConversationMessages(conversationEntry);
  conversationEntry.unreadCount = 0;
  // Catches a manually-added contact who's since actually exchanged messages
  // both ways — the no-handshake warning shouldn't keep showing once that's
  // true, even if this is the first time re-opening the conversation since.
  promoteRelationshipFromIncomingEvidence(contact, conversationEntry, { persist: false });
  persistState();

  // Keep the sidebar list in sync (new/updated conversation row, unread badge)
  // now that it stays visible alongside the open conversation at wide widths.
  renderChats();
  setActiveConversationId(conversationId);
  if (applyKnsPrimaryDomainToContact(contact)) { persistState(); renderChats(); }
  conversationName.textContent = displayNameForAddress(contact);
  updateAvatarElement(conversationAvatarInitials, conversationAvatarImage, contact);
  updateConversationBio(contact);
  if (conversationAddress) conversationAddress.textContent = contact.address;
  if (syncStatus) syncStatus.textContent = syncLabel(conversationEntry);
  renderMessages(conversationEntry);
  activateComposerMode("message");
  window.setTimeout(() => composer.elements.message?.focus(), 0);

  // The header name above is a synchronous cache-peek and may render before
  // KNS data has ever been fetched for this address — refresh in the
  // background and update it once real data lands, same idea as the chat
  // list's own background refresh.
  if (!engine.peekKnsAddressInfo(contact.address)) {
    engine.fetchKnsAddressInfo(contact.address).then(() => {
      const nameChanged = applyKnsPrimaryDomainToContact(contact);
      if (nameChanged) { persistState(); renderChats(); }
      if (activeConversationId === conversationId) conversationName.textContent = displayNameForAddress(contact);
    }).catch(() => {});
  }
  if (!engine.peekKnsAddressProfile(contact.address)) {
    engine.fetchKnsAddressProfile(contact.address).then(() => {
      if (activeConversationId === conversationId) {
        updateAvatarElement(conversationAvatarInitials, conversationAvatarImage, contact);
        updateConversationBio(contact);
        renderMessages(conversationEntry);
      }
      renderChats();
    }).catch(() => {});
  }
}

// Matches iOS's ChatInfoView: opened from the conversation header (desktop
// binds this to the avatar/name button, where iOS uses a separate info.circle
// toolbar button instead — a deliberate desktop-specific choice). Presented
// as a sheet-style overlay with Cancel/Save, an editable local nickname, the
// contact's own address as a QR + monospaced string, and real Added/Last
// Message/Sent/Received/Total stats computed from this conversation's actual
// messages. Notifications/Photos rows are mockups, matching iOS's pickers
// structurally but with no functioning backend yet (same convention as the
// rest of Settings).
function openChatInfo() {
  if (!activeConversationId) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact || !chatInfoOverlay) return;

  chatInfoContactId = contact.id;
  chatInfoContactAddress = contact.address;
  refreshChatInfoContactControls();
  if (chatInfoAvatarInitials) { chatInfoAvatarInitials.textContent = initialsFor(contact.name); chatInfoAvatarInitials.hidden = false; }
  if (chatInfoAvatarImage) { chatInfoAvatarImage.hidden = true; chatInfoAvatarImage.src = ""; }
  if (chatInfoNameInput) chatInfoNameInput.value = contact.name || "";
  if (chatInfoAddressCaption) chatInfoAddressCaption.textContent = shortAddress(contact.address);
  if (chatInfoAddressMono) chatInfoAddressMono.textContent = contact.address;
  if (chatInfoAdded) chatInfoAdded.textContent = contact.createdAt ? new Date(contact.createdAt).toLocaleDateString() : "—";

  const messages = conversationEntry.messages || [];
  const sent = messages.filter((message) => message.direction === "outgoing").length;
  const received = messages.filter((message) => message.direction === "incoming").length;
  if (chatInfoSent) chatInfoSent.textContent = String(sent);
  if (chatInfoReceived) chatInfoReceived.textContent = String(received);
  if (chatInfoTotal) chatInfoTotal.textContent = String(messages.length);
  const last = lastMessageFor(conversationEntry);
  if (chatInfoLastMessage) chatInfoLastMessage.textContent = last ? formatRelativeTime(last.createdAt) : "—";

  // Chess record — only shown once this contact has actually played (matches iOS).
  if (chatInfoChessRow) {
    const chessMsgs = messages.map((m) => ({ text: m.text, outgoing: m.direction === "outgoing", txid: m.txid || m.id, at: m.createdAt || 0 }));
    const hasChessHistory = engine.address && chessMsgs.some((m) => { const e = Chess.parseChessEnvelope(Chess.unwrapReplyText(m.text)); return e && e.kind === "invite"; });
    if (hasChessHistory) {
      const rec = Chess.chessRecord(chessMsgs, engine.address, contact.address);
      if (chatInfoChess) chatInfoChess.textContent = `${rec.wins}W · ${rec.losses}L`;
      chatInfoChessRow.hidden = false;
    } else {
      chatInfoChessRow.hidden = true;
    }
  }

  if (chatInfoQr) {
    const ctx = chatInfoQr.getContext("2d");
    ctx.clearRect(0, 0, chatInfoQr.width, chatInfoQr.height);
    import("../engine/qr.js").then(({ drawKaspaQr }) => {
      drawKaspaQr(chatInfoQr, contact.address, { dark: "#06110f", light: "#ffffff" }).catch(() => {});
    });
  }

  if (chatInfoProfileSection) chatInfoProfileSection.hidden = true;
  refreshChatInfoKnsSections(contact);

  chatInfoOverlay.hidden = false;
}

// Chat Info always force-refreshes KNS info/profile on open (bypassing the
// passive debounce the chat list uses) so domain selection is anchored to the
// latest primary-domain metadata — matches iOS's ChatInfoView.task.
async function refreshChatInfoKnsSections(contact) {
  const token = ++chatInfoRequestToken;
  const [info, profileInfo] = await Promise.all([
    engine.fetchKnsAddressInfo(contact.address).catch(() => null),
    engine.fetchKnsAddressProfile(contact.address).catch(() => null),
  ]);
  if (token !== chatInfoRequestToken || chatInfoContactId !== contact.id) return;

  const profile = profileInfo?.profile;
  if (chatInfoAvatarImage && chatInfoAvatarInitials) {
    if (profile?.avatarUrl) {
      chatInfoAvatarImage.src = profile.avatarUrl;
      chatInfoAvatarImage.hidden = false;
      chatInfoAvatarInitials.hidden = true;
    } else {
      chatInfoAvatarImage.hidden = true;
      chatInfoAvatarImage.src = "";
      chatInfoAvatarInitials.hidden = false;
    }
  }
  if (chatInfoProfileSection && profile) {
    const hasDetail = ["bio", "x", "website", "telegram", "discord", "contactEmail", "github", "redirectUrl"]
      .some((key) => Boolean(profile[key]));
    if (hasDetail) {
      if (chatInfoBio) {
        if (profile.bio) { chatInfoBio.textContent = profile.bio; chatInfoBio.hidden = false; }
        else chatInfoBio.hidden = true;
      }
      if (chatInfoSocialLinks) {
        chatInfoSocialLinks.replaceChildren();
        const linkDefs = [
          ["website", "Website", KNSProfileLinkBuilder.websiteUrl],
          ["x", "X", KNSProfileLinkBuilder.xUrl],
          ["telegram", "Telegram", KNSProfileLinkBuilder.telegramUrl],
          ["discord", "Discord", KNSProfileLinkBuilder.discordUrl],
          ["github", "GitHub", KNSProfileLinkBuilder.githubUrl],
          ["contactEmail", "Email", KNSProfileLinkBuilder.emailUrl],
          ["redirectUrl", "Redirect", KNSProfileLinkBuilder.websiteUrl],
        ];
        for (const [field, label, builder] of linkDefs) {
          const raw = profile[field];
          if (!raw) continue;
          const href = builder(raw);
          if (!href) continue;
          const link = document.createElement("a");
          link.className = "chat-info-social-link";
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = label;
          chatInfoSocialLinks.appendChild(link);
        }
      }
      chatInfoProfileSection.hidden = false;
    }
  }
}

function closeChatInfo() {
  if (chatInfoOverlay) chatInfoOverlay.hidden = true;
  chatInfoContactId = null;
}

function saveChatInfo() {
  const contact = state.contacts.find((entry) => entry.id === chatInfoContactId);
  if (contact) {
    const trimmed = String(chatInfoNameInput?.value || "").trim();
    // A non-empty typed value is always a deliberate override; clearing the
    // field back to nothing reverts to auto-naming (KNS primary domain, or
    // the shortened address if none is set).
    contact.nameIsCustom = Boolean(trimmed);
    contact.name = trimmed || shortAddress(contact.address);
    if (!contact.nameIsCustom) applyKnsPrimaryDomainToContact(contact);
    contact.updatedAt = Date.now();
    persistState();
    if (activeConversationId) {
      const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
      if (conversationEntry) {
        updateAvatarElement(conversationAvatarInitials, conversationAvatarImage, contact);
        conversationName.textContent = displayNameForAddress(contact);
      }
    }
    renderChats();
  }
  closeChatInfo();
}

document.querySelector("[data-open-chat-info]")?.addEventListener("click", openChatInfo);
document.querySelector("[data-chat-info-cancel]")?.addEventListener("click", closeChatInfo);
document.querySelector("[data-chat-info-save]")?.addEventListener("click", saveChatInfo);
chatInfoOverlay?.addEventListener("click", (event) => {
  if (event.target === chatInfoOverlay) closeChatInfo();
});
document.querySelector("[data-chat-info-copy-address]")?.addEventListener("click", async () => {
  const contact = state.contacts.find((entry) => entry.id === chatInfoContactId);
  if (!contact) return;
  try {
    await copyTextToClipboard(contact.address);
    showCopyToast("Address copied");
  } catch (error) {
    showCopyToast("Copy failed");
  }
});

function addContact({ name, address, relationshipState = "legacy-manual" }) {
  const createdAt = Date.now();
  const contact = {
    id: nowId(),
    name: name.trim(),
    nameIsCustom: Boolean(name.trim()),
    address: address.trim(),
    avatar: initialsFor(name.trim()),
    createdAt,
    updatedAt: createdAt,
    relationshipState,
    handshakeTxid: "",
  };
  const conversationEntry = createConversation({ contactId: contact.id, createdAt });

  state.contacts.push(contact);
  state.conversations.push(conversationEntry);
  refreshSubscriptionAddresses({ restart: true });
  persistState();
  renderChats();
  openConversation(conversationEntry.id);
}

async function sendOutgoingHandshake(contact, conversationEntry, { accepting = false } = {}) {
  const createdAt = Date.now();
  const message = createMessage({
    conversationId: conversationEntry.id,
    contactId: contact.id,
    direction: "outgoing",
    text: accepting ? "Communication request accepted" : "Handshake sent",
    sender: engine.address,
    receiver: contact.address,
    status: MESSAGE_STATUSES.PENDING,
    transport: "onchain",
    createdAt,
  });
  applyMessagePatch(message, { messageType: "handshake", protocol: "kasia", transport: "onchain" });
  appendIncomingOrReactionMessage(conversationEntry, message);
  persistState();
  renderMessages(conversationEntry);
  try {
    await ensureRuntimes({ quiet: true });
    if (!engine.address) throw new Error("Generate or import a wallet before starting a new conversation.");
    const envelope = await engine.createEncryptedHandshakeEnvelope({
      conversationId: conversationEntry.id,
      contactId: contact.id,
      toAddress: contact.address,
      fromAddress: engine.address,
      isResponse: accepting,
      createdAt,
    });
    updateMessageStatus(conversationEntry.id, message.id, { status: MESSAGE_STATUSES.SIGNING, protocolString: envelope.protocolString, payloadHex: envelope.payloadHex, payloadBytes: envelope.payloadBytes });
    const result = await engine.sendHandshakeOnchain({
      envelope,
      // iOS and Android both use a fixed 0.2 KAS carrier amount for every
      // handshake transaction, fresh or response (KaChatTransactionBuilder.swift's
      // `handshakeAmount` / WalletService.kt's `HANDSHAKE_AMOUNT_SOMPI`, both
      // 20_000_000 sompi) — not the user's configurable message amount, and
      // not a reduced amount for responses.
      amountKas: "0.2",
      feeKas: "0",
      onStatus: (patch) => updateMessageStatus(conversationEntry.id, message.id, patch),
    });
    contact.handshakeTxid = result.txid || "";
    contact.relationshipState = accepting ? "established" : "outgoing-request";
    updateMessageStatus(conversationEntry.id, message.id, {
      status: MESSAGE_STATUSES.CONFIRMED,
      txid: result.txid || message.txid || "",
      confirmations: Math.max(1, Number(message.confirmations || 0)),
      note: "Communication request confirmed on-chain",
      messageType: "handshake",
      transport: "onchain",
    });
    refreshSubscriptionAddresses({ restart: true });
    persistState();
    setStatus(accepting ? "Communication request accepted" : "Communication request sent");
    stashHandshakeForRecovery(contact, { isResponse: accepting, createdAt });
    return true;
  } catch (error) {
    updateMessageStatus(conversationEntry.id, message.id, { status: MESSAGE_STATUSES.FAILED });
    // Preserve an incoming request on response failure so Accept can be retried
    // and incoming evidence can still establish the relationship.
    contact.relationshipState = accepting ? "incoming-request" : "request-failed";
    persistState();
    setStatus(`Communication request failed: ${error.message}`);
    return false;
  }
}

// Best-effort, fire-and-forget: mirrors iOS's sendOrQueueSelfStash, sending a
// second self-payment transaction whose payload is this conversation's
// alias/partner metadata encrypted to our own address. This lets conversations
// be recovered from chain history alone (seed phrase + "Recover Conversations
// from Blockchain" in Settings) with no local backup file. A failure here
// must never surface as a handshake failure to the user — the handshake
// itself already succeeded.
async function stashHandshakeForRecovery(contact, { isResponse = false, createdAt = Date.now() } = {}) {
  try {
    const aliases = await engine.deriveConversationAliases(contact.address);
    const envelope = await engine.createSelfStashEnvelope({
      ourAlias: aliases.myAlias,
      theirAlias: aliases.theirAlias,
      partnerAddress: contact.address,
      isResponse,
      createdAt,
    });
    const result = await engine.sendSelfStashOnchain({ envelope });
    appendEngineLog(`Conversation recovery data stashed on-chain: ${result.txid || ""}`);
  } catch (error) {
    appendEngineLog(`Self-stash skipped (non-fatal): ${error.message}`);
  }
}

async function sendHandshakeFromComposer() {
  if (handshakeSendInFlight || !activeConversationId) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) return;
  handshakeSendInFlight = true;
  try {
    await sendOutgoingHandshake(contact, conversationEntry);
  } finally {
    handshakeSendInFlight = false;
  }
}

document.querySelectorAll(".js-open-contact").forEach((button) => {
  button.addEventListener("click", showContactModal);
});

document.querySelectorAll("[data-close-contact]").forEach((button) => {
  button.addEventListener("click", closeContactModal);
});

document.querySelectorAll("[data-open-account-view]").forEach((button) => {
  button.addEventListener("click", () => {
    openAccountOverlay();
    showSettingsCategory(null); // always land on the hub, matching iOS
  });
});

// ---------------------------------------------------------------------------
// 4.0 settings HUB (matches iOS/Android): the settings screen opens as a flat
// list of category rows; picking one shows just that category's group with a
// back affordance. The existing group markup is untouched — only gated.
// ---------------------------------------------------------------------------

const settingsScreenEl = document.querySelector('[data-screen="settings"]');
const settingsGroupsEls = settingsScreenEl
  ? [...settingsScreenEl.querySelectorAll(":scope > .settings-group")]
  : [];
// The engineering diagnostics <details> rides along with the Diagnostics page only.
const settingsDiagnosticsDetailsEl = settingsScreenEl?.querySelector(":scope > .diagnostics-panel") || null;
const settingsDiagnosticsIndex = settingsGroupsEls.findIndex(
  (group) => group.querySelector(".settings-group-label")?.textContent?.trim() === "Diagnostics"
);

// iOS SettingsView category icons (SF-symbol equivalents as inline SVGs), keyed by
// the .settings-group-label text.
const SETTINGS_HUB_ICONS = {
  "Customization": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 4 6 6-8.5 8.5L6 20l1.5-5.5z"/><path d="m12.5 5.5 6 6"/></svg>',
  "Security": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 2.8v5.4c0 4.5-3 8.2-7 9.8-4-1.6-7-5.3-7-9.8V5.8z"/><circle cx="12" cy="10.6" r="1.6"/><path d="M12 12.2v2.8"/></svg>',
  "Connection": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="1.8"/><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>',
  "Chats": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.3 4.5h9.1a3.8 3.8 0 0 1 3.8 3.8v2.7a3.8 3.8 0 0 1-3.8 3.8H8.7l-4.45 3.05.02-3.44A3.78 3.78 0 0 1 .5 10.65V8.3a3.8 3.8 0 0 1 3.8-3.8Z"/><path d="M9.65 8.15h6.1a3.75 3.75 0 0 1 3.75 3.75v1.95a3.75 3.75 0 0 1-3.75 3.75h-2.7L9.5 20.1v-2.5"/></svg>',
  "Contacts": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.9-3 2.9-4.5 5.5-4.5s4.6 1.5 5.5 4.5"/><path d="M15.2 5.9a2.9 2.9 0 1 1 1.3 5.5M17.3 14.7c1.7.7 2.8 2 3.2 4.3"/></svg>',
  "Storage": '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="8" width="18" height="8" rx="2.2"/><path d="M6.5 12h.01M10 12h.01"/><circle cx="17.4" cy="12" r=".4"/></svg>',
  "Chat History": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path d="M12 7.5V12l3 1.8"/></svg>',
  "Diagnostics": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2.5-6 4 12L16 12h5"/></svg>',
  "Danger Zone": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 21 19.5H3z"/><path d="M12 10v4.2"/><circle cx="12" cy="16.6" r=".3"/></svg>',
};

const settingsHubEl = (() => {
  if (!settingsScreenEl || settingsGroupsEls.length === 0) return null;
  const hub = document.createElement("section");
  hub.className = "settings-group settings-hub";
  const chevron = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>`;
  const rows = [];
  settingsGroupsEls.forEach((group, index) => {
    if (group.dataset.settingsSubscreen) return; // sub-screens open from their parent page, not the hub
    const label = group.querySelector(".settings-group-label")?.textContent?.trim() || `Section ${index + 1}`;
    const danger = group.classList.contains("danger-zone-group");
    if (danger) {
      // View Seed Phrase: a direct action right above Danger Zone, not a sub-page (matches iOS).
      rows.push(`<button class="settings-list-row settings-hub-row seed" type="button" data-settings-hub-seed>
        <span class="settings-hub-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z"/></svg></span>
        <span class="settings-hub-label">View Seed Phrase</span>
        ${chevron}
      </button>`);
    }
    rows.push(`<button class="settings-list-row settings-hub-row${danger ? " danger" : ""}" type="button" data-settings-hub-row="${index}">
      <span class="settings-hub-icon" aria-hidden="true">${SETTINGS_HUB_ICONS[label] || ""}</span>
      <span class="settings-hub-label">${label}</span>
      ${chevron}
    </button>`);
  });
  hub.innerHTML = `<div class="settings-list-card">${rows.join("")}</div>`;
  settingsScreenEl.prepend(hub);

  const backBar = document.createElement("button");
  backBar.type = "button";
  backBar.className = "settings-hub-back";
  backBar.dataset.settingsHubBack = "";
  backBar.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/></svg><span data-settings-hub-back-label>Settings</span>`;
  backBar.hidden = true;
  settingsScreenEl.prepend(backBar);
  return hub;
})();

// When a sub-screen (e.g. Storage > Nextcloud) is showing, back returns to its
// parent category instead of the hub.
let settingsSubscreenParentIndex = null;

function setSettingsBackBar(visible, label) {
  const backBar = settingsScreenEl?.querySelector("[data-settings-hub-back]");
  if (!backBar) return;
  backBar.hidden = !visible;
  const labelEl = backBar.querySelector("[data-settings-hub-back-label]");
  if (labelEl) labelEl.textContent = label || "Settings";
}

function showSettingsCategory(index) {
  if (!settingsScreenEl || !settingsHubEl) return;
  const inCategory = Number.isInteger(index);
  settingsSubscreenParentIndex = null;
  settingsHubEl.hidden = inCategory;
  setSettingsBackBar(inCategory, "Settings");
  settingsGroupsEls.forEach((group, i) => { group.hidden = !inCategory || i !== index; });
  if (settingsDiagnosticsDetailsEl) settingsDiagnosticsDetailsEl.hidden = !inCategory || index !== settingsDiagnosticsIndex;
  settingsScreenEl.scrollTop = 0;
}

function showSettingsSubscreen(name, parentIndex) {
  if (!settingsScreenEl || !settingsHubEl) return;
  const target = settingsGroupsEls.find((group) => group.dataset.settingsSubscreen === name);
  if (!target) return;
  settingsSubscreenParentIndex = Number.isInteger(parentIndex) && parentIndex >= 0 ? parentIndex : null;
  settingsHubEl.hidden = true;
  settingsGroupsEls.forEach((group) => { group.hidden = group !== target; });
  if (settingsDiagnosticsDetailsEl) settingsDiagnosticsDetailsEl.hidden = true;
  const parentLabel = settingsSubscreenParentIndex != null
    ? settingsGroupsEls[settingsSubscreenParentIndex]?.querySelector(".settings-group-label")?.textContent?.trim()
    : null;
  setSettingsBackBar(true, parentLabel || "Settings");
  settingsScreenEl.scrollTop = 0;
}

settingsScreenEl?.addEventListener("click", (event) => {
  const sub = event.target.closest("[data-settings-open-subscreen]");
  if (sub) {
    showSettingsSubscreen(sub.dataset.settingsOpenSubscreen, settingsGroupsEls.indexOf(sub.closest(".settings-group")));
    return;
  }
  const row = event.target.closest("[data-settings-hub-row]");
  if (row) { showSettingsCategory(Number(row.dataset.settingsHubRow)); return; }
  if (event.target.closest("[data-settings-hub-back]")) {
    showSettingsCategory(settingsSubscreenParentIndex != null ? settingsSubscreenParentIndex : null);
    return;
  }
  if (event.target.closest("[data-settings-hub-seed]")) {
    document.querySelector('[data-shell-action="view-recovery"]')?.click();
  }
});
showSettingsCategory(null);

contactModal.addEventListener("click", (event) => {
  if (event.target === contactModal) closeContactModal();
});

contactAddressInput?.addEventListener("input", () => {
  setCreateChatError("");
  updateCreateChatAddState();
});

contactPasteButton?.addEventListener("click", async () => {
  setCreateChatError("");

  try {
    if (!navigator.clipboard?.readText) return;

    // Clipboard access must be requested directly inside this user click.
    // Safari does not reliably support querying clipboard-read permission first;
    // the prior permission check caused every paste attempt to return early.
    const pasted = String(await navigator.clipboard.readText() || "").trim();
    if (!pasted) return;

    setContactAddressValue(pasted);
  } catch {
    // Permission denied, unavailable clipboard, or empty clipboard:
    // leave the form unchanged and do not show an error.
  }
});

contactImportButton?.addEventListener("click", async () => {
  setCreateChatError("");
  try {
    if (navigator.contacts?.select) {
      const selected = await navigator.contacts.select(["name", "address", "email", "tel"], { multiple: false });
      const entry = selected?.[0];
      if (!entry) return;
      const serialized = JSON.stringify(entry);
      const addressMatch = serialized.match(/kaspa:[a-z0-9]+/i);
      if (!addressMatch) throw new Error("The selected contact does not contain a Kaspa address.");
      setContactAddressValue(addressMatch[0]);
      const selectedName = Array.isArray(entry.name) ? entry.name[0] : entry.name;
      if (selectedName && contactNameInput && !contactNameInput.value.trim()) contactNameInput.value = selectedName;
      return;
    }
    contactImportFile?.click();
  } catch (error) {
    setCreateChatError(error?.message || "Contact import was not available.");
  }
});

contactImportFile?.addEventListener("change", async () => {
  const file = contactImportFile.files?.[0];
  contactImportFile.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const addressMatch = text.match(/kaspa:[a-z0-9]+/i);
    if (!addressMatch) throw new Error("That contact file does not contain a Kaspa address.");
    setContactAddressValue(addressMatch[0]);
    const nameMatch = text.match(/^FN(?:;[^:]*)?:(.+)$/im);
    if (nameMatch?.[1] && contactNameInput && !contactNameInput.value.trim()) {
      contactNameInput.value = nameMatch[1].trim();
    }
  } catch (error) {
    setCreateChatError(error?.message || "The contact file could not be imported.");
  }
});

contactScanButton?.addEventListener("click", () => {
  setCreateChatError("QR scanning will be added in a later step.");
});

contactForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(contactForm);
  const name = String(formData.get("name") || "").trim();
  const addressInput = contactForm.elements.address;
  const rawAddress = String(formData.get("address") || "").trim();

  addressInput?.setCustomValidity("");
  setCreateChatError("");
  if (!rawAddress) {
    updateCreateChatAddState();
    return;
  }

  try {
    await ensureRuntimes({ quiet: true });
    if (!engine.address) throw new Error("Generate or import a wallet before starting a new conversation.");

    let address;
    let resolvedDomain = null;
    if (engine.knsLooksLikeDomain(rawAddress) && !rawAddress.startsWith("kaspa:")) {
      setCreateChatError("Resolving KNS domain…");
      const resolution = await engine.resolveKnsDomain(rawAddress);
      if (!resolution) throw new Error(`Could not resolve ${engine.knsNormalizeDomainName(rawAddress) || rawAddress}. Check the domain name and try again.`);
      address = validateContactAddress(resolution.ownerAddress);
      resolvedDomain = resolution.domain;
      setCreateChatError("");
    } else {
      address = validateContactAddress(rawAddress);
    }

    const displayName = name || resolvedDomain || shortAddress(address);
    const existing = state.contacts.find((contact) => contact.address === address);
    if (existing) {
      const existingConversation = state.conversations.find((entry) => entry.contactId === existing.id);
      closeContactModal();
      if (existingConversation) openConversation(existingConversation.id);
      return;
    }
    const createdAt = Date.now();
    const contact = {
      id: nowId(), name: displayName, nameIsCustom: Boolean(name), address, avatar: initialsFor(displayName), createdAt, updatedAt: createdAt,
      relationshipState: "legacy-manual", handshakeTxid: "",
    };
    const conversationEntry = createConversation({ contactId: contact.id, createdAt });
    state.contacts.push(contact);
    state.conversations.push(conversationEntry);
    refreshSubscriptionAddresses({ restart: true });
    persistState();
    closeContactModal();
    openConversation(conversationEntry.id);
  } catch (error) {
    const message = error?.message || "Invalid Kaspa address.";
    setCreateChatError(message);
    addressInput?.setCustomValidity(message);
    addressInput?.reportValidity();
    updateCreateChatAddState();
  }
});

chatList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-conversation-id]");
  if (!row) return;
  const conversationId = row.dataset.conversationId;
  if (chatSelectionModeActive) {
    if (selectedChatConversationIds.has(conversationId)) selectedChatConversationIds.delete(conversationId);
    else selectedChatConversationIds.add(conversationId);
    renderChats();
    updateChatSelectionBar();
    return;
  }
  openConversation(conversationId);
});

function updateChatSelectionBar() {
  if (chatSelectionBar) chatSelectionBar.hidden = !chatSelectionModeActive;
  const markRead = document.querySelector("[data-chat-mark-read]");
  const markUnread = document.querySelector("[data-chat-mark-unread]");
  const deleteButton = document.querySelector("[data-chat-delete-selected]");
  const disabled = selectedChatConversationIds.size === 0;
  if (markRead) markRead.disabled = disabled;
  if (markUnread) markUnread.disabled = disabled;
  if (deleteButton) deleteButton.disabled = disabled;
}

function setChatSelectionMode(active) {
  chatSelectionModeActive = active;
  if (!active) selectedChatConversationIds.clear();
  if (chatSelectToggle) chatSelectToggle.textContent = active ? "Cancel" : "Select";
  if (appSidebar) appSidebar.classList.toggle("selecting-chats", active);
  updateChatSelectionBar();
  renderChats();
}

chatSelectToggle?.addEventListener("click", () => setChatSelectionMode(!chatSelectionModeActive));

chatsListTabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.chatsListTab;
    if (tab === activeChatsListTab) return;
    activeChatsListTab = tab;
    chatsListTabButtons.forEach((entry) => entry.classList.toggle("active", entry === button));
    if (chatSelectionModeActive) setChatSelectionMode(false);
    else renderChats();
  });
});

document.querySelector("[data-chat-mark-read]")?.addEventListener("click", () => {
  for (const conversationEntry of state.conversations) {
    if (selectedChatConversationIds.has(conversationEntry.id)) conversationEntry.unreadCount = 0;
  }
  persistState();
  setChatSelectionMode(false);
  showCopyToast("Marked as read");
});

document.querySelector("[data-chat-mark-unread]")?.addEventListener("click", () => {
  for (const conversationEntry of state.conversations) {
    if (selectedChatConversationIds.has(conversationEntry.id) && Number(conversationEntry.unreadCount || 0) === 0) {
      conversationEntry.unreadCount = 1;
    }
  }
  persistState();
  setChatSelectionMode(false);
  showCopyToast("Marked as unread");
});

document.querySelector("[data-chat-delete-selected]")?.addEventListener("click", () => {
  const count = selectedChatConversationIds.size;
  if (!count) return;
  if (!confirm(`Delete ${count} chat${count === 1 ? "" : "s"}? This removes the conversation and contact locally. This cannot be undone.`)) return;
  const idsToDelete = new Set(selectedChatConversationIds);
  const contactIdsToDelete = new Set(
    state.conversations.filter((entry) => idsToDelete.has(entry.id)).map((entry) => entry.contactId),
  );
  state.conversations = state.conversations.filter((entry) => !idsToDelete.has(entry.id));
  state.contacts = state.contacts.filter((contact) => !contactIdsToDelete.has(contact.id));
  if (activeConversationId && idsToDelete.has(activeConversationId)) setActiveConversationId(null);
  refreshSubscriptionAddresses({ restart: true });
  persistState();
  setChatSelectionMode(false);
  showCopyToast(`Deleted ${count} chat${count === 1 ? "" : "s"}`);
});

document.querySelector("[data-back-to-chats]").addEventListener("click", () => {
  if (isWideLayout) setActiveConversationId(null);
  else renderChats();
});

copyContactAddressButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
    const contact = contactForConversation(conversationEntry);
    const contactAddress = String(contact?.address || "").trim();
    if (!contactAddress) return;

    try {
      await copyTextToClipboard(contactAddress);
      showCopyToast("Kaspa address copied");
    } catch (error) {
      appendEngineLog(error?.message || "Could not copy contact address");
    }
  });
});

messageArea.addEventListener("click", async (event) => {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) return;
  if (event.target.closest("[data-accept-handshake]")) {
    if (contact.relationshipState !== "incoming-request") return;
    const button = event.target.closest("[data-accept-handshake]");
    button.disabled = true;
    setStatus("Accepting communication request…");
    const ok = await sendOutgoingHandshake(contact, conversationEntry, { accepting: true });
    if (ok) {
      contact.relationshipState = "established";
      contact.updatedAt = Date.now();
      persistState();
      refreshSubscriptionAddresses({ restart: true });
      renderMessages(conversationEntry);
      setStatus("Communication request accepted");
    } else {
      button.disabled = false;
    }
    return;
  }
  if (event.target.closest("[data-decline-handshake]")) {
    const txid = contact.incomingHandshakeTxid || "";
    contact.relationshipState = "declined";
    contact.updatedAt = Date.now();
    if (txid) handshakeSyncState.declinedTxids = [...new Set([...handshakeSyncState.declinedTxids, txid])];
    persistHandshakeSyncState();
    persistState();
    renderMessages(conversationEntry);
    setStatus("Communication request declined locally");
  }
});

clearChatButton.addEventListener("click", () => {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  if (!conversationEntry) return;
  conversationEntry.messages = [];
  conversationEntry.updatedAt = Date.now();
  conversationEntry.lastActivityAt = conversationEntry.updatedAt;
  persistState();
  renderMessages(conversationEntry);
  setStatus("Local chat cleared");
});

function queueIncomingPreview(conversationId) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) return;

  const createdAt = Date.now();
  const incomingText = `Preview reply from ${contact.name}`;
  const envelope = engine.createMessageEnvelope({
    conversationId,
    contactId: contact.id,
    toAddress: engine.address || contact.address,
    fromAddress: contact.address,
    text: incomingText,
    alias: contact.name,
    localNonce: nowId(),
    createdAt,
  });
  const parsed = engine.parseKasiaPayloadHex(envelope.payloadHex);

  const message = createMessage({
    conversationId: conversationEntry.id,
    contactId: contact.id,
    direction: "incoming",
    text: parsed?.bodyText || incomingText,
    sender: contact.address,
    receiver: engine.address || contact.address,
    status: MESSAGE_STATUSES.CONFIRMED,
    transport: "incoming-preview",
    createdAt,
  });
  applyMessagePatch(message, {
    txid: `preview-inbound-${String(envelope.localNonce || nowId()).slice(-8)}`,
    daaScore: String(Math.floor(createdAt / 1000)),
    payloadHex: envelope.payloadHex,
    payloadBytes: envelope.payloadBytes,
    messageType: envelope.messageType,
    protocolString: envelope.protocolString,
    confirmations: 1,
  });

  appendIncomingOrReactionMessage(conversationEntry, message);
  persistState();
  renderMessages(conversationEntry);
  setStatus("Incoming Kasia preview decoded");
}

simulateIncomingButton?.addEventListener("click", () => {
  if (!activeConversationId) return;
  queueIncomingPreview(activeConversationId);
});

async function runSyncPreview(conversationId) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) return;

  try {
    syncPreviewButton.disabled = true;
    setStatus("Querying Kasia indexer and decrypting messages…");
    const knownTxids = conversationEntry.messages.map((message) => message.txid).filter(Boolean);
    const indexerUrl = indexerUrlInput?.value?.trim() || getEndpoint("kasiaIndexer");
    const result = await engine.syncConversationFromIndexer({
      conversationId,
      contact,
      knownTxids,
      cursor: conversationEntry.sync?.cursor || 0,
      indexerUrl,
    });

    for (const incoming of result.messages) {
      const hiddenKeys = new Set((conversationEntry.hiddenMessageKeys || []).map(String));
      if ((incoming.txid && hiddenKeys.has(String(incoming.txid))) || (incoming.id && hiddenKeys.has(String(incoming.id)))) continue;
      const message = createMessage({
        ...incoming,
        conversationId: conversationEntry.id,
        contactId: contact.id,
      });
      applyMessagePatch(message, incoming);
      appendIncomingOrReactionMessage(conversationEntry, message);
    }
    promoteRelationshipFromIncomingEvidence(contact, conversationEntry, { persist: false });

    conversationEntry.sync = {
      ...(conversationEntry.sync || {}),
      lastSyncAt: Date.now(),
      lastFound: Number(result.found || 0),
      runs: Number(conversationEntry.sync?.runs || 0) + 1,
      cursor: Number(result.nextCursor || conversationEntry.sync?.cursor || 0),
      lastNote: result.note || "Real Kasia sync complete.",
      scannedCount: Number(result.scannedCount || 0),
      decryptFailures: Number(result.decryptFailures || 0),
      indexerUrl,
    };

    persistState();
    renderMessages(conversationEntry);
    if (syncStatus) syncStatus.textContent = syncLabel(conversationEntry);
    setStatus(result.note || `Real sync complete: ${result.found || 0} new`);
    appendEngineLog(`${result.note} Scanned ${result.scannedCount || 0}; filtered ${result.decryptFailures || 0}.`);
  } catch (error) {
    setStatus(`Real sync failed: ${error.message}`);
    appendEngineLog(`Real sync failed: ${error.message}`);
  } finally {
    syncPreviewButton.disabled = false;
  }
}

syncPreviewButton?.addEventListener("click", () => {
  if (!activeConversationId) return;
  runSyncPreview(activeConversationId);
});

importPayloadButton?.addEventListener("click", showImportPayloadModal);

document.querySelectorAll("[data-close-import-payload]").forEach((button) => {
  button.addEventListener("click", closeImportPayloadModal);
});

importPayloadModal?.addEventListener("click", (event) => {
  if (event.target === importPayloadModal) closeImportPayloadModal();
});

importPayloadForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    importPayloadIntoConversation(importPayloadInput?.value || "");
    closeImportPayloadModal();
  } catch (error) {
    setStatus(`Payload import failed: ${error.message}`);
  }
});


searchInput.addEventListener("input", renderChats);

messageArea.addEventListener("click", (event) => {
  const bubble = event.target.closest("[data-message-id]");
  if (!bubble) return;
  if (messageSelectionMode) toggleSelectedMessage(bubble.dataset.messageId);
  else openMessageDetails(bubble.dataset.messageId);
});

messageArea.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const bubble = event.target.closest("[data-message-id]");
  if (!bubble) return;
  event.preventDefault();
  if (messageSelectionMode) toggleSelectedMessage(bubble.dataset.messageId);
  else openMessageDetails(bubble.dataset.messageId);
});

document.querySelectorAll("[data-close-message-details]").forEach((button) => {
  button.addEventListener("click", closeMessageDetails);
});

messageDetailsModal?.addEventListener("click", async (event) => {
  if (event.target === messageDetailsModal) {
    closeMessageDetails();
    return;
  }
  const action = event.target.closest("[data-message-action]")?.dataset.messageAction;
  if (!action) return;
  const { message } = activeMessageRecord();
  if (!message) return;
  try {
    if (action === "copy-message") {
      await copyTextToClipboard(displayTextForMessage(message));
      closeMessageDetails();
      showCopyToast("Message copied");
    } else if (action === "reply") {
      closeMessageDetails();
      startReplyTo(message.id);
    } else if (action === "view-explorer") {
      if (message.txid) window.open(explorerTxUrl(message.txid), "_blank", "noopener,noreferrer");
      closeMessageDetails();
    } else if (action === "select") {
      enterMessageSelection(message.id);
    }
  } catch (error) {
    setStatus(`Message action failed: ${error.message}`);
  }
});

document.querySelectorAll("[data-close-export-choice]").forEach((button) => button.addEventListener("click", closeExportChoice));
exportChoiceModal?.addEventListener("click", (event) => {
  if (event.target === exportChoiceModal) closeExportChoice();
});
document.querySelectorAll("[data-export-format]").forEach((button) => {
  button.addEventListener("click", () => {
    const { message } = activeMessageRecord();
    if (!message) return;
    try {
      if (button.dataset.exportFormat === "csv") exportMessageCsv(message);
      else exportMessagePdf(message);
      closeExportChoice();
    } catch (error) {
      setStatus(`Export failed: ${error.message}`);
    }
  });
});

document.querySelector("[data-cancel-selection]")?.addEventListener("click", exitMessageSelection);
document.querySelector("[data-select-all-messages]")?.addEventListener("click", () => {
  if (!messageSelectionMode) return;
  // Toggle: everything already selected -> deselect all (matches iOS's Select All/Deselect All).
  const allIds = Array.from(messageArea?.querySelectorAll("[data-message-id]") || [])
    .map((el) => String(el.dataset.messageId))
    .filter(Boolean);
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedMessageIds.has(id));
  selectedMessageIds.clear();
  if (!allSelected) for (const id of allIds) selectedMessageIds.add(id);
  updateSelectionUi();
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  if (conversationEntry) renderMessages(conversationEntry);
});
document.querySelector("[data-delete-selected]")?.addEventListener("click", openDeleteSelectedConfirmation);
document.querySelector("[data-cancel-delete-selected]")?.addEventListener("click", closeDeleteSelectedConfirmation);
document.querySelector("[data-confirm-delete-selected]")?.addEventListener("click", deleteSelectedMessages);
deleteConfirmModal?.addEventListener("click", (event) => {
  if (event.target === deleteConfirmModal) closeDeleteSelectedConfirmation();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !contactModal.hidden) closeContactModal();
  if (event.key === "Escape" && messageDetailsModal && !messageDetailsModal.hidden) closeMessageDetails();
  if (event.key === "Escape" && exportChoiceModal && !exportChoiceModal.hidden) closeExportChoice();
  if (event.key === "Escape" && messageSelectionMode) exitMessageSelection();
  if (event.key === "Escape" && onchainConfirmModal && !onchainConfirmModal.hidden) closeOnchainConfirm();
  if (event.key === "Escape" && importPayloadModal && !importPayloadModal.hidden) closeImportPayloadModal();
});

function updateMessageStatus(conversationId, messageId, patch) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const message = conversationEntry?.messages.find((entry) => entry.id === messageId);
  if (!conversationEntry || !message) return;
  applyMessagePatch(message, patch);
  conversationEntry.updatedAt = Date.now();
  conversationEntry.lastActivityAt = Math.max(conversationEntry.lastActivityAt, message.updatedAt);
  persistState();
  if (activeConversationId === conversationId) renderMessages(conversationEntry);
  if (activeConversationId !== conversationId) renderChats();
}

async function runEngineSendPipeline(conversationId, messageId) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  const message = conversationEntry?.messages.find((entry) => entry.id === messageId);
  if (!conversationEntry || !contact || !message) return;

  try {
    updateMessageStatus(conversationId, messageId, { status: MESSAGE_STATUSES.BUILDING });
    const envelopeDetails = {
      conversationId,
      contactId: contact.id,
      toAddress: contact.address,
      fromAddress: engine.address || null,
      text: message.text,
      localNonce: message.localNonce,
      createdAt: message.createdAt,
    };
    const envelope = await engine.createEncryptedMessageEnvelope(envelopeDetails);

    updateMessageStatus(conversationId, messageId, { status: MESSAGE_STATUSES.SIGNING });
    await engine.sendMessageOnchain({
      envelope,
      amountKas: onchainAmountKas(),
      feeKas: "0",
      onStatus: (patch) => {
        updateMessageStatus(conversationId, messageId, patch);
        if (patch.protocolString) updateMessageStatus(conversationId, messageId, { protocolString: patch.protocolString });
        if (patch.transport) updateMessageStatus(conversationId, messageId, { transport: patch.transport });
        if (patch.note) setStatus(patch.note);
      },
    });
  } catch (error) {
    updateMessageStatus(conversationId, messageId, { status: MESSAGE_STATUSES.FAILED });
    setStatus(`Message failed: ${error.message}`);
  }
}

function queueConversationMessage(conversationId, text) {
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  if (!conversationEntry) return;

  const createdAt = Date.now();
  const contact = contactForConversation(conversationEntry);
  promoteRelationshipFromIncomingEvidence(contact, conversationEntry);
  if (["outgoing-request", "incoming-request", "declined", "request-failed"].includes(contact?.relationshipState)) {
    setStatus(contact.relationshipState === "incoming-request" ? "Accept the communication request before replying" : contact.relationshipState === "declined" ? "Communication request declined" : contact.relationshipState === "outgoing-request" ? "Waiting for communication request acceptance" : "Communication request failed");
    return;
  }
  let finalText = text;
  if (replyingToMessageId) {
    const replyTarget = conversationEntry.messages.find((entry) => entry.id === replyingToMessageId);
    if (replyTarget) {
      finalText = JSON.stringify({
        type: "reply",
        replyToId: replyTarget.txid || replyTarget.id,
        replyToSender: replyTarget.direction === "outgoing" ? (engine.address || "") : (contact?.address || ""),
        replyToPreview: replyPreviewTextFor(replyTarget),
        text,
      });
    }
    cancelReply();
  }

  const message = createMessage({
    conversationId: conversationEntry.id,
    contactId: conversationEntry.contactId,
    direction: "outgoing",
    text: finalText,
    sender: engine.address || null,
    receiver: contact?.address || null,
    status: MESSAGE_STATUSES.PENDING,
    transport: transportMode,
    createdAt,
  });
  appendIncomingOrReactionMessage(conversationEntry, message);

  persistState();
  renderMessages(conversationEntry);
  setStatus("Queued for real Kaspa payload transaction");
  runEngineSendPipeline(conversationEntry.id, message.id);
}


function closeComposerMenu() {
  if (composerPlusMenu) composerPlusMenu.hidden = true;
}

function setComposerHint(message) {
  const input = composer?.elements?.message;
  if (!input) return;
  input.placeholder = message;
  input.focus();
}

function hideAvailableBalanceBanner() {
  if (availableBalanceHideTimer) window.clearTimeout(availableBalanceHideTimer);
  availableBalanceHideTimer = null;
  if (availableBalanceBanner) availableBalanceBanner.hidden = true;
}

function showAvailableBalanceBanner(balanceKas) {
  if (!availableBalanceBanner) return;
  availableBalanceBanner.textContent = `Available ${balanceKas} KAS`;
  availableBalanceBanner.hidden = false;
  if (availableBalanceHideTimer) window.clearTimeout(availableBalanceHideTimer);
  availableBalanceHideTimer = window.setTimeout(() => {
    if (composerMode === "kas") availableBalanceBanner.hidden = true;
    availableBalanceHideTimer = null;
  }, 2000);
}

async function activateComposerMode(mode) {
  const input = composer?.elements?.message;
  if (!input) return;
  composerMode = mode === "kas" ? "kas" : "message";
  composer.classList.toggle("payment-mode", composerMode === "kas");
  input.value = "";
  input.inputMode = composerMode === "kas" ? "decimal" : "text";
  input.setAttribute("aria-label", composerMode === "kas" ? "KAS amount" : "Message");
  setComposerHint(composerMode === "kas" ? "Amount (KAS)" : "Message");
  hideFeeEstimateBanner();
  hideHandshakeWarningBanner();
  if (composerMode === "kas") clearPendingPhoto();
  if (composerMode !== "kas") {
    hideAvailableBalanceBanner();
    setStatus("Text message mode");
    return;
  }
  setStatus("KAS payment mode selected");
  try {
    const balance = await engine.balance();
    currentBalanceKas = balance.totalKas;
    showAvailableBalanceBanner(balance.totalKas);
  } catch (error) {
    hideAvailableBalanceBanner();
    setStatus(`Balance unavailable: ${error.message}`);
  }
}


function showKasPaymentAlert({ title, message, primaryLabel = "OK", cancelLabel = "", allowCancel = false } = {}) {
  return new Promise((resolve) => {
    if (!kasPaymentAlert) return resolve(true);
    kasPaymentAlertTitle.textContent = title || "Payment Alert";
    kasPaymentAlertMessage.textContent = message || "";
    kasPaymentAlertPrimary.textContent = primaryLabel;
    kasPaymentAlertCancel.textContent = cancelLabel || "Cancel";
    kasPaymentAlertCancel.hidden = !allowCancel;
    kasPaymentAlert.hidden = false;
    const finish = (value) => {
      kasPaymentAlert.hidden = true;
      kasPaymentAlertPrimary.onclick = null;
      kasPaymentAlertCancel.onclick = null;
      resolve(value);
    };
    kasPaymentAlertPrimary.onclick = () => finish(true);
    kasPaymentAlertCancel.onclick = () => finish(false);
  });
}

function normalizeKaspaTransactions(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.transactions)) return body.transactions;
  if (Array.isArray(body?.result)) return body.result;
  return body && typeof body === "object" ? [body] : [];
}

function kaspaOutputAddress(output) {
  return String(
    output?.script_public_key_address || output?.scriptPublicKeyAddress || output?.address ||
    output?.verbose_data?.script_public_key_address || output?.verboseData?.scriptPublicKeyAddress ||
    output?.script_public_key?.address || output?.scriptPublicKey?.address ||
    output?.script_public_key?.verbose_data?.script_public_key_address ||
    output?.scriptPublicKey?.verboseData?.scriptPublicKeyAddress || "",
  ).trim();
}

function kaspaOutputAmount(output) {
  try { return BigInt(output?.amount ?? output?.value ?? output?.sompi ?? 0); }
  catch { return 0n; }
}

async function transactionPaysRecipient(txid, recipientAddress, amountKas) {
  const expected = BigInt(Math.round(Number(amountKas) * 1e8));
  const urls = [
    `${getEndpoint("kaspaApi")}/transactions/${encodeURIComponent(txid)}?resolve_previous_outpoints=light`,
    `${getEndpoint("kaspaApi")}/addresses/${encodeURIComponent(recipientAddress)}/full-transactions?limit=100&offset=0&resolve_previous_outpoints=light`,
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const transactions = normalizeKaspaTransactions(await response.json());
      for (const tx of transactions) {
        const candidateTxid = String(tx?.transaction_id || tx?.transactionId || tx?.hash || tx?.id || "").trim();
        if (candidateTxid && candidateTxid !== txid) continue;
        let received = 0n;
        for (const output of (Array.isArray(tx?.outputs) ? tx.outputs : [])) {
          if (kaspaOutputAddress(output) === recipientAddress) received += kaspaOutputAmount(output);
        }
        if (received >= expected) return true;
      }
    } catch {}
  }
  return false;
}

async function verifyKasPaymentBroadcast(txids, recipientAddress, amountKas) {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    for (const txid of (txids || [])) {
      if (await transactionPaysRecipient(txid, recipientAddress, amountKas)) return txid;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  return null;
}

function paymentAmountForMessage(message) {
  const stored = String(message?.paymentAmountKas || "").trim();
  if (stored && Number.isFinite(Number(stored)) && Number(stored) > 0) return stored;
  const match = String(message?.text || "").match(/^Sent\s+([0-9]+(?:\.[0-9]{1,8})?)\s+KAS$/i);
  return match ? match[1] : "";
}

async function refreshPendingPaymentStatuses(conversationEntry, contact) {
  let changed = false;
  const pendingPayments = (conversationEntry.messages || []).filter((message) =>
    message.direction === "outgoing" && message.messageType === "payment" && message.txid &&
    message.status !== MESSAGE_STATUSES.CONFIRMED && message.status !== MESSAGE_STATUSES.FAILED
  );
  for (const message of pendingPayments) {
    const amountKas = paymentAmountForMessage(message);
    let recipientVerified = false;
    if (amountKas) {
      try {
        recipientVerified = await transactionPaysRecipient(message.txid, contact.address, amountKas);
      } catch (error) {
        appendEngineLog(`Payment verification failed for ${message.txid}: ${error.message}`);
      }
    }

    // A txid is assigned only after pending.submit(rpc) resolves successfully.
    // Therefore an existing outgoing payment with a txid has been accepted by a
    // Kaspa node even if the public REST index has not exposed the transaction yet.
    applyMessagePatch(message, {
      status: MESSAGE_STATUSES.CONFIRMED,
      confirmations: recipientVerified ? 1 : Math.max(1, Number(message.confirmations || 0)),
      paymentAmountKas: amountKas || message.paymentAmountKas || null,
      note: recipientVerified
        ? "Kaspa payment verified at recipient output."
        : "Kaspa node accepted and broadcast the payment transaction.",
    });
    changed = true;
  }
  return changed;
}

function normalizeKasAmount(value) {
  const cleaned = String(value || "").trim().replace(",", ".");
  if (!/^\d*(?:\.\d{0,8})?$/.test(cleaned)) throw new Error("Enter a valid KAS amount with up to 8 decimals.");
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be greater than 0.");
  return cleaned;
}

async function sendKasPayment(conversationId, rawAmount) {
  if (paymentSendInFlight) return;
  const conversationEntry = state.conversations.find((entry) => entry.id === conversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) throw new Error("Conversation contact was unavailable.");
  const amountKas = normalizeKasAmount(rawAmount);
  paymentSendInFlight = true;
  const input = composer.elements.message;
  const submitButton = composer.querySelector(".composer-send");
  if (submitButton) submitButton.disabled = true;
  try {
    const balance = await engine.balance();
    currentBalanceKas = balance.totalKas;
    const requestedSompi = BigInt(Math.round(Number(amountKas) * 1e8));
    const feeReserveSompi = 10000n;
    if (requestedSompi + feeReserveSompi > balance.totalSompi) {
      await showKasPaymentAlert({
        title: "Not Enough KAS",
        message: `Planned spend ${amountKas} KAS, but available balance ${balance.totalKas} KAS is less than required after the network fee.`,
        primaryLabel: "OK",
      });
      return;
    }
    if (Number(amountKas) < 0.1) {
      const proceed = await showKasPaymentAlert({
        title: "Small Amount",
        message: "Sending less than 0.1 KAS may fail due to the network dust protection limit.",
        primaryLabel: "Send Anyway", cancelLabel: "Cancel", allowCancel: true,
      });
      if (!proceed) return;
    }
    const createdAt = Date.now();
    const message = createMessage({
      conversationId: conversationEntry.id,
      contactId: contact.id,
      direction: "outgoing",
      text: `Sent ${amountKas} KAS`,
      sender: engine.address || null,
      receiver: contact.address,
      status: MESSAGE_STATUSES.PENDING,
      transport: "kaspa-payment",
      createdAt,
    });
    applyMessagePatch(message, { messageType: "payment", paymentAmountKas: amountKas });
    appendIncomingOrReactionMessage(conversationEntry, message);
    persistState();
    renderMessages(conversationEntry);
    // renderMessages hydrates and replaces message objects. Keep working with
    // the canonical object now stored in the conversation, not the stale local
    // reference created above.
    const liveMessage = conversationEntry.messages.find((entry) => entry.id === message.id) || message;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    setStatus(`Sending ${amountKas} KAS…`);

    try {
      const result = await engine.send(contact.address, amountKas, "0");
      const submittedTxids = (result?.txids || []).map((value) => String(value || "").trim()).filter(Boolean);
      const txid = submittedTxids.at(-1) || submittedTxids[0] || null;
      if (!txid) throw new Error("Kaspa node accepted the send request but did not return a transaction ID.");
      const verifiedTxid = await verifyKasPaymentBroadcast(submittedTxids, contact.address, amountKas);
      applyMessagePatch(liveMessage, {
        status: MESSAGE_STATUSES.CONFIRMED,
        txid: verifiedTxid || txid,
        confirmations: verifiedTxid ? 1 : 0,
        network: "mainnet",
        note: verifiedTxid
          ? "Kaspa payment verified at recipient output."
          : "Kaspa node accepted and broadcast the payment transaction.",
      });
      setStatus(`Payment sent · ${(verifiedTxid || txid).slice(0, 12)}…`);
      await refreshBalanceOnly({ quiet: true });
    } catch (error) {
      applyMessagePatch(liveMessage, { status: MESSAGE_STATUSES.FAILED, note: error.message });
      setStatus(`Payment failed: ${error.message}`);
    }
    conversationEntry.updatedAt = Date.now();
    persistState();
    renderMessages(conversationEntry);
  } finally {
    paymentSendInFlight = false;
    if (submitButton) submitButton.disabled = false;
    input?.focus();
  }
}

if (composerPlusButton && composerPlusMenu) {
  composerPlusButton.addEventListener("click", () => {
    composerPlusMenu.hidden = !composerPlusMenu.hidden;
  });
}

// --- Chess over chat (Stage 3): game state is re-derived from the conversation's
// chess-envelope messages via engine/chess.js; moves/invite/response/resign are
// sent as ordinary encrypted messages. ---
const chessOverlay = document.querySelector("[data-chess-overlay]");
const chessBoardEl = document.querySelector("[data-chess-board]");
const chessFilesTop = document.querySelector("[data-chess-files-top]");
const chessFilesBottom = document.querySelector("[data-chess-files-bottom]");
const chessRanksLeft = document.querySelector("[data-chess-ranks-left]");
const chessRanksRight = document.querySelector("[data-chess-ranks-right]");
const chessWaitingEl = document.querySelector("[data-chess-waiting]");
const chessWaitingTextEl = document.querySelector("[data-chess-waiting-text]");
let chessWaitingTimer = 0;
let chessWaitingDots = 1;
function updateChessWaiting() {
  if (!chessWaitingEl) return;
  const s = chessState?.summary;
  const waiting = !!s && s.status.kind === "inProgress" && s.viewerColor && s.board.sideToMove !== s.viewerColor;
  if (waiting) {
    chessWaitingEl.hidden = false;
    if (!chessWaitingTimer) {
      chessWaitingDots = 1;
      if (chessWaitingTextEl) chessWaitingTextEl.textContent = "Waiting on opponent" + ".".repeat(chessWaitingDots);
      // Cycle 1→2→3 dots like a typing indicator so it doesn't look frozen.
      chessWaitingTimer = window.setInterval(() => {
        chessWaitingDots = (chessWaitingDots % 3) + 1;
        if (chessWaitingTextEl) chessWaitingTextEl.textContent = "Waiting on opponent" + ".".repeat(chessWaitingDots);
      }, 500);
    }
  } else {
    chessWaitingEl.hidden = true;
    if (chessWaitingTimer) { clearInterval(chessWaitingTimer); chessWaitingTimer = 0; }
  }
}
const chessStatusEl = document.querySelector("[data-chess-status]");
const chessCapturedTop = document.querySelector("[data-chess-captured-top]");
const chessCapturedBottom = document.querySelector("[data-chess-captured-bottom]");
const chessResignBtn = document.querySelector("[data-chess-resign]");
const chessPromoEl = document.querySelector("[data-chess-promo]");
const chessPromoOptions = document.querySelector("[data-chess-promo-options]");
const chessActionsEl = document.querySelector("[data-chess-actions]");
const chessRecordEl = document.querySelector("[data-chess-record]");
const chessChatEl = document.querySelector("[data-chess-chat]");
const chessChatForm = document.querySelector("[data-chess-composer]");
const chessChatInput = document.querySelector("[data-chess-chat-input]");
let chessState = null; // { gameId, summary, selected, legalDests, pendingPromo }

// Recent conversation messages (chess envelopes excluded) shown inside the board
// so you can keep chatting while playing.
function renderChessChat() {
  if (!chessChatEl) return;
  const conv = state.conversations.find((entry) => entry.id === activeConversationId);
  chessChatEl.replaceChildren();
  if (!conv) return;
  const recent = (conv.messages || [])
    .filter((m) => m.text && !Chess.isChessEnvelope(Chess.unwrapReplyText(m.text)))
    .slice(-40);
  for (const m of recent) {
    const row = document.createElement("div");
    row.className = `chess-chat-msg ${m.direction === "outgoing" ? "outgoing" : "incoming"}`;
    row.textContent = displayTextForMessage(m);
    chessChatEl.appendChild(row);
  }
  chessChatEl.scrollTop = chessChatEl.scrollHeight;
}
chessChatForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = String(chessChatInput?.value || "").trim();
  if (!text || !activeConversationId) return;
  chessChatInput.value = "";
  queueConversationMessage(activeConversationId, text);
  renderChessChat();
});

function renderChessRecord() {
  if (!chessRecordEl) return;
  const { contact, messages } = chessConversationContext();
  if (!contact || !engine.address) { chessRecordEl.hidden = true; return; }
  const rec = Chess.chessRecord(messages, engine.address, contact.address);
  chessRecordEl.textContent = `W ${rec.wins} · L ${rec.losses}`;
  chessRecordEl.hidden = false;
}

function chessConversationContext() {
  const conv = state.conversations.find((entry) => entry.id === activeConversationId);
  if (!conv) return { conv: null, contact: null, messages: [] };
  const contact = contactForConversation(conv);
  const messages = (conv.messages || []).map((m) => ({
    text: m.text, outgoing: m.direction === "outgoing", txid: m.txid || m.id, at: m.createdAt || 0,
  }));
  return { conv, contact, messages };
}
function chessSendEnvelope(content) {
  if (!activeConversationId || !content) return;
  queueConversationMessage(activeConversationId, content);
}

function openChessGame(preferGameId = null) {
  const { contact, messages } = chessConversationContext();
  if (!contact?.address || !engine.address) { showCopyToast("Open a 1:1 chat to play chess."); return; }
  let summary = preferGameId
    ? Chess.summarizeChessGame(preferGameId, messages, engine.address, contact.address)
    : Chess.activeChessGame(messages, engine.address, contact.address);
  if (!summary && !preferGameId) {
    // No active game — invite the contact (random color), then open the pending board.
    const gameId = Chess.newGameId();
    chessSendEnvelope(Chess.chessInvite(gameId, Math.random() < 0.5 ? "white" : "black"));
    const after = chessConversationContext();
    summary = Chess.summarizeChessGame(gameId, after.messages, engine.address, contact.address);
  }
  if (!summary) { showCopyToast("Could not open the chess game."); return; }
  chessState = { gameId: summary.gameId, summary, selected: null, legalDests: [], pendingPromo: null };
  if (chessPromoEl) chessPromoEl.hidden = true;
  renderChess();
  if (chessOverlay) chessOverlay.hidden = false;
}
function closeChess() {
  if (chessOverlay) chessOverlay.hidden = true;
  chessState = null;
  if (chessWaitingTimer) { clearInterval(chessWaitingTimer); chessWaitingTimer = 0; }
  if (chessWaitingEl) chessWaitingEl.hidden = true;
}

// Small live board thumbnail for the latest chess message in the chat.
function buildChessThumb(summary, gameId) {
  const wrap = document.createElement("button");
  wrap.type = "button";
  wrap.className = "chess-thumb";
  const boardEl = document.createElement("div");
  boardEl.className = "chess-thumb-board";
  const orient = summary.viewerColor || "white";
  const ranks = orient === "white" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const files = orient === "white" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  for (const rank of ranks) {
    for (const file of files) {
      const cell = document.createElement("div");
      cell.className = `chess-thumb-sq ${(file + rank) % 2 !== 0 ? "light" : "dark"}`;
      const piece = summary.board.squares[rank][file];
      if (piece) {
        const span = document.createElement("span");
        span.className = `chess-piece ${piece.color}`;
        span.textContent = Chess.PIECE_GLYPHS[piece.type];
        cell.appendChild(span);
      }
      boardEl.appendChild(cell);
    }
  }
  const status = document.createElement("span");
  status.className = "chess-thumb-status";
  status.textContent = Chess.chessSummaryStatusText(summary);
  if (summary.status.kind === "inProgress" && summary.viewerColor && summary.board.sideToMove === summary.viewerColor) status.classList.add("you");
  wrap.append(boardEl, status);
  wrap.addEventListener("click", (event) => { event.stopPropagation(); openChessGame(gameId); });
  return wrap;
}

function chessInteractive() {
  const s = chessState?.summary;
  return !!s && s.status.kind === "inProgress" && s.viewerColor && s.board.sideToMove === s.viewerColor;
}
function chessOrientation() { return chessState?.summary?.viewerColor || "white"; }

function renderChessStatus() {
  const s = chessState.summary;
  const over = Chess.isChessGameOver(s.status);
  if (chessStatusEl) {
    chessStatusEl.textContent = Chess.chessSummaryStatusText(s);
    chessStatusEl.classList.toggle("over", over);
    chessStatusEl.classList.toggle("check", !over && s.status.kind === "inProgress" && Chess.isKingInCheck(s.board, s.board.sideToMove));
  }
  if (chessResignBtn) chessResignBtn.disabled = over || s.status.kind === "pendingResponse";
  // Accept/Decline only when an incoming invite awaits my response.
  const awaitingMyResponse = s.status.kind === "pendingResponse" && !s.iAmInviter;
  if (chessActionsEl) chessActionsEl.hidden = !awaitingMyResponse;
}
function renderChessBoard() {
  if (!chessBoardEl) return;
  chessBoardEl.replaceChildren();
  const b = chessState.summary.board;
  const orient = chessOrientation();
  const ranks = orient === "white" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const files = orient === "white" ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  // Coordinate labels around the board (a–h top & bottom, 1–8 left & right), in
  // the current orientation's order — matches iOS's board frame.
  const fillLabels = (el, values, toLabel) => {
    if (!el) return;
    el.replaceChildren();
    for (const v of values) { const span = document.createElement("span"); span.textContent = toLabel(v); el.appendChild(span); }
  };
  fillLabels(chessFilesTop, files, (f) => String.fromCharCode(97 + f));
  fillLabels(chessFilesBottom, files, (f) => String.fromCharCode(97 + f));
  fillLabels(chessRanksLeft, ranks, (r) => String(r + 1));
  fillLabels(chessRanksRight, ranks, (r) => String(r + 1));
  const legalKeys = new Set(chessState.legalDests.map((sqr) => `${sqr.file},${sqr.rank}`));
  const last = chessState.summary.moveHistory.at(-1);
  const sel = chessState.selected;
  for (const rank of ranks) {
    for (const file of files) {
      const cell = document.createElement("div");
      cell.className = `chess-sq ${(file + rank) % 2 !== 0 ? "light" : "dark"}`;
      if (sel && sel.file === file && sel.rank === rank) cell.classList.add("selected");
      if (last && ((last.from.file === file && last.from.rank === rank) || (last.to.file === file && last.to.rank === rank))) cell.classList.add("last");
      const piece = b.squares[rank][file];
      if (piece) {
        const span = document.createElement("span");
        span.className = `chess-piece ${piece.color}`;
        span.textContent = Chess.PIECE_GLYPHS[piece.type];
        cell.appendChild(span);
      }
      if (legalKeys.has(`${file},${rank}`)) {
        const dot = document.createElement("span");
        dot.className = "chess-dot" + (piece ? " capture" : "");
        cell.appendChild(dot);
      }
      const square = { file, rank };
      cell.addEventListener("click", () => handleChessTap(square));
      chessBoardEl.appendChild(cell);
    }
  }
}
function renderChessCaptured() {
  const s = chessState.summary;
  const viewer = s.viewerColor || "white";
  const takenFromMe = viewer === "white" ? s.capturedByBlack : s.capturedByWhite;
  const takenByMe = viewer === "white" ? s.capturedByWhite : s.capturedByBlack;
  const fill = (el, pieces, color) => {
    if (!el) return;
    el.replaceChildren();
    for (const t of pieces) { const span = document.createElement("span"); span.className = `cap-piece ${color}`; span.textContent = Chess.PIECE_GLYPHS[t]; el.appendChild(span); }
  };
  fill(chessCapturedTop, takenFromMe, opposite2(viewer));   // opponent's captures (my lost pieces)
  fill(chessCapturedBottom, takenByMe, viewer);
}
function opposite2(c) { return c === "white" ? "black" : "white"; }
function renderChess() { renderChessStatus(); renderChessRecord(); renderChessCaptured(); renderChessBoard(); updateChessWaiting(); renderChessChat(); }

function selectChessSquare(square) {
  chessState.selected = square;
  chessState.legalDests = Chess.legalMovesFrom(chessState.summary.board, square).map((m) => m.to);
  renderChessBoard();
}
function doChessMove(move) {
  const from = Chess.algebraic(move.from);
  const to = Chess.algebraic(move.to);
  const promo = move.promotion ? Chess.promotionLetter(move.promotion) : null;
  chessState.selected = null;
  chessState.legalDests = [];
  chessSendEnvelope(Chess.chessMove(chessState.gameId, from, to, promo));
  refreshChessOverlay();
}
function showChessPromo(color) {
  if (!chessPromoOptions || !chessPromoEl) return;
  chessPromoOptions.replaceChildren();
  for (const t of ["queen", "rook", "bishop", "knight"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = color;
    btn.textContent = Chess.PIECE_GLYPHS[t];
    btn.addEventListener("click", () => {
      const move = { ...chessState.pendingPromo, promotion: t };
      chessState.pendingPromo = null;
      chessPromoEl.hidden = true;
      doChessMove(move);
    });
    chessPromoOptions.appendChild(btn);
  }
  chessPromoEl.hidden = false;
}
function handleChessTap(square) {
  if (!chessState || chessState.pendingPromo || !chessInteractive()) return;
  const b = chessState.summary.board;
  const legalKeys = new Set(chessState.legalDests.map((sqr) => `${sqr.file},${sqr.rank}`));
  if (chessState.selected) {
    if (legalKeys.has(`${square.file},${square.rank}`)) {
      const piece = Chess.pieceAt(b, chessState.selected);
      const backRank = piece.color === "white" ? 7 : 0;
      const candidate = { from: chessState.selected, to: square, promotion: null };
      if (piece.type === "pawn" && square.rank === backRank) {
        chessState.pendingPromo = candidate;
        chessState.selected = null; chessState.legalDests = [];
        renderChessBoard();
        showChessPromo(piece.color);
        return;
      }
      doChessMove(candidate);
      return;
    }
    const piece = Chess.pieceAt(b, square);
    if (piece && piece.color === b.sideToMove) selectChessSquare(square);
    else { chessState.selected = null; chessState.legalDests = []; renderChessBoard(); }
    return;
  }
  const piece = Chess.pieceAt(b, square);
  if (piece && piece.color === b.sideToMove) selectChessSquare(square);
}
function resignChess() {
  if (!chessState) return;
  const s = chessState.summary;
  if (Chess.isChessGameOver(s.status) || s.status.kind === "pendingResponse") return;
  chessSendEnvelope(Chess.chessResign(chessState.gameId));
  refreshChessOverlay();
}
// Re-derive the bound game from the latest conversation messages and re-render.
function refreshChessOverlay() {
  if (!chessState || !chessOverlay || chessOverlay.hidden) return;
  const { contact, messages } = chessConversationContext();
  if (!contact) return;
  const summary = Chess.summarizeChessGame(chessState.gameId, messages, engine.address, contact.address);
  if (summary) { chessState.summary = summary; renderChess(); }
}

document.querySelectorAll("[data-chess-open]").forEach((btn) => btn.addEventListener("click", () => {
  if (composerPlusMenu) composerPlusMenu.hidden = true;
  openChessGame();
}));
document.querySelector("[data-chess-close]")?.addEventListener("click", closeChess);
chessResignBtn?.addEventListener("click", resignChess);
document.querySelector("[data-chess-accept]")?.addEventListener("click", () => {
  if (chessState) { chessSendEnvelope(Chess.chessResponse(chessState.gameId, true)); refreshChessOverlay(); }
});
document.querySelector("[data-chess-decline]")?.addEventListener("click", () => {
  if (chessState) { chessSendEnvelope(Chess.chessResponse(chessState.gameId, false)); refreshChessOverlay(); }
});
chessOverlay?.addEventListener("click", (event) => { if (event.target === chessOverlay) closeChess(); });

// Photos ride the ordinary ciph_msg:1:comm: COMM payload as a JSON envelope
// (see buildImageEnvelopeJson below) — there is no separate wire type, and
// this compression pipeline matches iOS/Android's ImagePrep exactly: JPEG
// only (WebP/AVIF were deliberately rejected upstream for cross-platform
// decode reliability), longest edge capped at 1280px, quality binary-searched
// down to a byte budget, and if even the lowest quality still overshoots,
// the longest edge is shrunk by 0.7x (up to 4 times) and retried. Unlike text
// messages there is no rejection path — the lowest-quality result is sent
// even if it's still over budget, matching iOS's explicit "never reject" design.
const PHOTO_MAX_DIMENSION = 1280;
const PHOTO_DEFAULT_TARGET_BYTES = 15000;
const PHOTO_MAX_SHRINK_ATTEMPTS = 4;
const PHOTO_SHRINK_FACTOR = 0.7;

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
    img.src = url;
  });
}

function dataUrlByteLength(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Math.ceil(base64.length * 3 / 4);
}

function drawScaledCanvas(image, longestEdge) {
  const scale = Math.min(1, longestEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  return { canvas, width, height };
}

// Binary-searches JPEG quality in [0.05, 0.95] over 8 iterations for the
// highest quality that still fits targetBytes. Returns the best-effort
// result (possibly still over budget) rather than null, since the caller
// always needs something to shrink-and-retry or send as a last resort.
function compressCanvasToBudget(canvas, targetBytes) {
  let low = 0.05;
  let high = 0.95;
  let best = { dataUrl: canvas.toDataURL("image/jpeg", low), quality: low };
  best.bytes = dataUrlByteLength(best.dataUrl);
  if (best.bytes > targetBytes) return best;
  for (let i = 0; i < 8; i += 1) {
    const mid = (low + high) / 2;
    const dataUrl = canvas.toDataURL("image/jpeg", mid);
    const bytes = dataUrlByteLength(dataUrl);
    if (bytes <= targetBytes) { best = { dataUrl, bytes, quality: mid }; low = mid; }
    else high = mid;
  }
  return best;
}

async function compressImageBlob(blob, { targetBytes = PHOTO_DEFAULT_TARGET_BYTES, maxDimension = PHOTO_MAX_DIMENSION } = {}) {
  const image = await loadImageFromBlob(blob);
  let dimension = maxDimension;
  let result = null;

  for (let attempt = 0; attempt <= PHOTO_MAX_SHRINK_ATTEMPTS; attempt += 1) {
    const { canvas, width, height } = drawScaledCanvas(image, dimension);
    const compressed = compressCanvasToBudget(canvas, targetBytes);
    result = { dataUrl: compressed.dataUrl, bytes: compressed.bytes, width, height };
    if (compressed.bytes <= targetBytes || attempt === PHOTO_MAX_SHRINK_ATTEMPTS) break;
    dimension = Math.round(dimension * PHOTO_SHRINK_FACTOR);
  }
  return result;
}

function clearPendingPhoto() {
  pendingPhotoAttachment = null;
  if (pendingPhotoPreview) pendingPhotoPreview.hidden = true;
  if (pendingPhotoThumb) pendingPhotoThumb.src = "";
  if (photoFileInput) photoFileInput.value = "";
}

function setPendingPhoto(attachment) {
  pendingPhotoAttachment = attachment;
  if (pendingPhotoThumb) pendingPhotoThumb.src = attachment.dataUrl;
  const overBudget = attachment.bytes > PHOTO_DEFAULT_TARGET_BYTES;
  if (pendingPhotoMeta) {
    pendingPhotoMeta.textContent = `Photo · ${attachment.width}×${attachment.height} · ${(attachment.bytes / 1024).toFixed(1)} KB${overBudget ? " · larger fee" : ""}`;
  }
  if (pendingPhotoPreview) pendingPhotoPreview.hidden = false;
  composer.elements.message?.focus();
}

async function attachPhotoBlob(blob) {
  setStatus("Compressing photo…");
  try {
    const attachment = await compressImageBlob(blob);
    // Kept alongside the compressed envelope version so "Send Media via Nextcloud" can
    // upload the ORIGINAL full-quality file instead of the payload-sized recompression.
    attachment.originalBlob = blob;
    attachment.originalName = blob.name || "photo.jpg";
    setPendingPhoto(attachment);
    setStatus(`Photo ready · ${(attachment.bytes / 1024).toFixed(1)} KB`);
  } catch (error) {
    showCopyToast(error.message || "Could not attach that photo.");
  }
}

// Matches iOS's ChatService+Conversations.sendImage / Android's ImageMessage
// exactly: photos are NOT a distinct wire type. This JSON string is sent as
// the plaintext of an ordinary ciph_msg:1:comm: COMM message, the same way a
// text message is — only the JSON shape signals "this is a photo" to the
// receiving client. `type` must be the literal string "file".
function buildImageEnvelopeJson(attachment, fileName = "photo.jpg") {
  return JSON.stringify({
    type: "file",
    name: fileName,
    size: attachment.bytes,
    mimeType: "image/jpeg",
    content: attachment.dataUrl,
  });
}

// --- Voice messages ----------------------------------------------------
// Matches iOS's sendAudio exactly: reuses the same {type:"file",...} JSON
// envelope as photos — the mimeType prefix ("audio/" vs "image/") is the
// only thing that distinguishes a voice message, there is no separate wire
// type. Recording uses the browser's native MediaRecorder producing real
// audio/webm;codecs=opus, which iOS's own custom WebM/Opus muxer can decode
// and play — the formats are wire-compatible even though this side doesn't
// need a hand-rolled encoder to produce them.

const VOICE_MAX_DURATION_SECONDS = 10; // on-chain payload cap
// Nextcloud-uploaded voice notes aren't payload-bound — the server carries them.
const VOICE_MAX_DURATION_NEXTCLOUD_SECONDS = 600;
function voiceMaxDurationSeconds() {
  return isNextcloudMediaSendActive() ? VOICE_MAX_DURATION_NEXTCLOUD_SECONDS : VOICE_MAX_DURATION_SECONDS;
}
const VOICE_AUDIO_BITS_PER_SECOND = 8000;

const voiceRecordingPanel = document.querySelector("[data-voice-recording-panel]");
const voiceRecordingTimeEl = document.querySelector("[data-voice-recording-time]");

function formatRecordingTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pickVoiceMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const candidate of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(candidate)) return candidate;
  }
  return "";
}

// Generic MediaRecorder wrapper shared by the 1:1 composer and the broadcast
// composer (handed to initBroadcasts via deps). Owns the stream, chunk
// collection, the elapsed timer and the max-duration auto-stop; presentation
// (panel visibility, timer text) and what happens to the finished blob stay
// with the caller.
function createVoiceRecorder({ maxDurationSeconds, onElapsed, onFinish }) {
  let recorder = null;
  let stream = null;
  let chunks = [];
  let startedAt = 0;
  let timer = null;
  let cancelled = false;

  function clearTimer() {
    if (timer) { window.clearInterval(timer); timer = null; }
  }

  function handleStopped() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    clearTimer();
    const mimeType = recorder?.mimeType || "audio/webm";
    const recorded = chunks;
    recorder = null;
    chunks = [];
    const blob = recorded.length ? new Blob(recorded, { type: mimeType }) : null;
    onFinish?.({ blob, mimeType, cancelled });
  }

  /** Starts recording. Returns an error string for the caller to toast, or null on success. */
  async function start() {
    if (recorder) return null;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return "Voice recording isn't supported in this browser.";
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return "Microphone access was denied.";
    }
    const mimeType = pickVoiceMimeType();
    chunks = [];
    cancelled = false;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND } : undefined);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      return "Could not start voice recording.";
    }
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("stop", handleStopped);
    recorder.start();
    startedAt = Date.now();
    onElapsed?.(0);
    timer = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      onElapsed?.(elapsed);
      if (elapsed >= maxDurationSeconds()) stop(false);
    }, 200);
    return null;
  }

  function stop(cancel) {
    cancelled = Boolean(cancel);
    clearTimer();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else handleStopped();
  }

  return { start, stop, isRecording: () => recorder != null };
}

const chatVoiceRecorder = createVoiceRecorder({
  maxDurationSeconds: voiceMaxDurationSeconds,
  onElapsed: (elapsed) => {
    if (voiceRecordingTimeEl) voiceRecordingTimeEl.textContent = formatRecordingTime(elapsed);
  },
  onFinish: handleChatVoiceRecordingFinished,
});

async function startVoiceRecording() {
  if (chatVoiceRecorder.isRecording()) return;
  const error = await chatVoiceRecorder.start();
  if (error) {
    showCopyToast(error);
    return;
  }
  if (voiceRecordingTimeEl) voiceRecordingTimeEl.textContent = "0:00";
  if (voiceRecordingPanel) voiceRecordingPanel.hidden = false;
}

function stopVoiceRecording(cancelled) {
  chatVoiceRecorder.stop(cancelled);
}

async function handleChatVoiceRecordingFinished({ blob, mimeType, cancelled }) {
  if (voiceRecordingPanel) voiceRecordingPanel.hidden = true;
  if (cancelled || !blob || !activeConversationId) return;

  // "Send Media via Nextcloud": upload the recording and send its share link (renders as an
  // audio card + player on the recipient's side). Failure falls back to the on-chain envelope.
  if (isNextcloudMediaSendActive()) {
    const conversationId = activeConversationId;
    setStatus("Uploading voice note to Nextcloud…");
    try {
      const url = await uploadNextcloudMedia(blob, `voice_${Date.now()}.webm`, mimeType);
      queueConversationMessage(conversationId, url);
      setStatus("Voice note sent via Nextcloud.");
      return;
    } catch (error) {
      showCopyToast(`Nextcloud upload failed — sending on-chain instead. (${error.message})`);
    }
  }

  const reader = new FileReader();
  const dataUrl = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  }).catch(() => null);
  if (!dataUrl) { showCopyToast("Could not process the recording."); return; }

  const envelope = JSON.stringify({
    type: "file",
    name: "voice-message.webm",
    size: blob.size,
    mimeType,
    content: dataUrl,
  });
  queueConversationMessage(activeConversationId, envelope);
}

document.querySelector("[data-voice-recording-stop]")?.addEventListener("click", () => stopVoiceRecording(false));
document.querySelector("[data-voice-recording-cancel]")?.addEventListener("click", () => stopVoiceRecording(true));

// Receivers (including our own render path) detect an image purely by
// sniffing decrypted content, exactly as iOS/Android do — there is no
// wire-level flag. Guards against parsing arbitrary long text as JSON.
function parseImageEnvelope(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || trimmed.length > 200000) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || parsed.type !== "file") return null;
    const mimeType = String(parsed.mimeType || "");
    if (!mimeType.startsWith("image/")) return null;
    const content = String(parsed.content || "");
    if (!content.startsWith("data:")) return null;
    return { name: String(parsed.name || "photo.jpg"), size: Number(parsed.size || 0), mimeType, content };
  } catch {
    return null;
  }
}

// Matches iOS's MediaFile: photo and voice messages share this exact
// envelope shape — only the mimeType prefix ("image/" vs "audio/")
// distinguishes them, there's no separate wire type for audio.
function parseAudioEnvelope(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || trimmed.length > 200000) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || parsed.type !== "file") return null;
    const mimeType = String(parsed.mimeType || "");
    if (!mimeType.startsWith("audio/")) return null;
    const content = String(parsed.content || "");
    if (!content.startsWith("data:")) return null;
    return { name: String(parsed.name || "audio.webm"), size: Number(parsed.size || 0), mimeType, content, duration: Number(parsed.duration || 0) };
  } catch {
    return null;
  }
}

// Matches iOS's MessageReplyContent (Models.swift): a reply is the entire
// message content becoming this JSON envelope, not a field bolted onto a
// normal message — the actual typed reply text lives in .text.
function parseReplyEnvelope(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || trimmed.length > 200000) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || parsed.type !== "reply") return null;
    return {
      replyToId: String(parsed.replyToId || ""),
      replyToSender: String(parsed.replyToSender || ""),
      replyToPreview: String(parsed.replyToPreview || ""),
      text: String(parsed.text ?? ""),
    };
  } catch {
    return null;
  }
}

const REPLY_PREVIEW_MAX_LENGTH = 80;

// Builds the short quoted-preview text for a reply, unwrapping exactly one
// level of nesting (a reply-to-a-reply quotes the original reply's own typed
// text, not raw JSON) and substituting friendly placeholders for media —
// matches iOS's MessageReplyCodec.previewText.
function replyPreviewTextFor(message) {
  if (!message) return "";
  const asReply = parseReplyEnvelope(message.text);
  if (asReply) return asReply.text.slice(0, REPLY_PREVIEW_MAX_LENGTH);
  if (parseImageEnvelope(message.text)) return "📷 Photo";
  if (parseAudioEnvelope(message.text)) return "🎤 Audio message";
  return String(message.text || "").slice(0, REPLY_PREVIEW_MAX_LENGTH);
}

// Matches iOS's MessageReactionContent: reactions are sent as a normal
// message but intercepted before ever being appended to the conversation —
// they only ever update the reactions store, never render as their own bubble.
function parseReactionEnvelope(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || trimmed.length > 200000) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || parsed.type !== "reaction") return null;
    const targetTxId = String(parsed.targetTxId || "");
    const emoji = String(parsed.emoji || "");
    if (!targetTxId || !emoji) return null;
    return { targetTxId, emoji, action: parsed.action === "remove" ? "remove" : "add" };
  } catch {
    return null;
  }
}

// Fixed 6-emoji tapback set, byte-for-byte the same as iOS/Android — not a
// full emoji keyboard, keeps reactions identical across every client.
const QUICK_REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

function applyLocalReaction(conversationEntry, targetTxId, reactorAddress, emoji) {
  if (!conversationEntry.reactionsByTxId) conversationEntry.reactionsByTxId = {};
  const list = conversationEntry.reactionsByTxId[targetTxId] || [];
  const filtered = list.filter((entry) => entry.reactorAddress !== reactorAddress);
  filtered.push({ reactorAddress, emoji });
  conversationEntry.reactionsByTxId[targetTxId] = filtered;

  // Reactions count as real conversation activity — bumps the chat to the
  // top of the sidebar and drives its preview text, same as a new message.
  const timestamp = Date.now();
  conversationEntry.lastReactionEvent = { targetTxId, reactorAddress, emoji, timestamp };
  conversationEntry.lastActivityAt = Math.max(Number(conversationEntry.lastActivityAt || 0), timestamp);
  conversationEntry.updatedAt = timestamp;
}

function removeLocalReaction(conversationEntry, targetTxId, reactorAddress) {
  if (!conversationEntry.reactionsByTxId) return;
  const list = conversationEntry.reactionsByTxId[targetTxId];
  if (!list) return;
  conversationEntry.reactionsByTxId[targetTxId] = list.filter((entry) => entry.reactorAddress !== reactorAddress);
  // Don't let the sidebar keep advertising a reaction that was just undone.
  if (conversationEntry.lastReactionEvent?.targetTxId === targetTxId && conversationEntry.lastReactionEvent?.reactorAddress === reactorAddress) {
    conversationEntry.lastReactionEvent = null;
  }
}

// Matches iOS's ChatService+Fetching interception: a reaction is delivered
// as a normal message but is checked for *before* any normal conversation
// append — it only ever updates the reactions store, never becomes its own
// chat bubble. Every real addMessageToConversation call in this file goes
// through this wrapper instead, so reactions arriving via any path (real
// sync, preview simulation, self-stash recovery, etc.) are always caught.
function appendIncomingOrReactionMessage(conversationEntry, message) {
  const reaction = parseReactionEnvelope(message.text);
  if (reaction) {
    const reactorAddress = message.direction === "outgoing" ? (engine.address || "") : (message.sender || "");
    if (reaction.action === "add") applyLocalReaction(conversationEntry, reaction.targetTxId, reactorAddress, reaction.emoji);
    else removeLocalReaction(conversationEntry, reaction.targetTxId, reactorAddress);
    persistState();
    if (activeConversationId === conversationEntry.id) renderMessages(conversationEntry);
    renderChats();
    return message;
  }
  return addMessageToConversation(conversationEntry, message);
}

// ---------------------------------------------------------------------------
// Phone (iOS/Android) chat-history archive import — used by the Nextcloud
// restore flow. The phone apps back up `kachat-backup.json` in the shared
// ChatHistoryArchive schema ({schemaVersion, exportedAt, walletAddress,
// conversations: [{contactAddress, contactAlias, unreadCount, messages}]}),
// which is NOT the desktop backup format. Unlike importBackupPayload (which
// REPLACES local state), this MERGES into the existing desktop conversations:
// find-or-create per contact address, dedupe by txid, reactions go through the
// same reactionsByTxId store as live messages, and base64 voice bodies become
// small placeholders (desktop can't play the iOS Opus envelopes anyway). With
// chat state in IndexedDB the oversize threshold is generous — it only guards
// against pathological single messages, not the archive's total size.
// ---------------------------------------------------------------------------

const PHONE_ARCHIVE_MAX_CONTENT_CHARS = 1_000_000;

// iOS deliveryStatus -> desktop MESSAGE_STATUSES. "warning" is iOS's
// "broadcast but unverified", which is exactly the desktop BROADCAST state.
const PHONE_ARCHIVE_STATUSES = {
  pending: MESSAGE_STATUSES.PENDING,
  sent: MESSAGE_STATUSES.CONFIRMED,
  failed: MESSAGE_STATUSES.FAILED,
  warning: MESSAGE_STATUSES.BROADCAST,
};

// The archive's timestamps are ISO8601 strings when exported normally, but a
// numeric epoch can appear when a message was encoded without the iso strategy:
// ms since 1970, seconds since 1970, or Swift's seconds-since-2001 reference
// date. blockTime (ms) wins when it looks like a plausible epoch.
function phoneArchiveTimestampMs(archiveMessage) {
  const blockTime = Number(archiveMessage?.blockTime || 0);
  if (Number.isFinite(blockTime) && blockTime > 1e12) return blockTime;
  const raw = archiveMessage?.timestamp;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric >= 1e12) return numeric;              // already ms since 1970
    if (numeric >= 1e9) return numeric * 1000;        // seconds since 1970
    return (numeric + 978307200) * 1000;              // Swift reference date (2001)
  }
  return Number.isFinite(blockTime) && blockTime > 0 ? blockTime : Date.now();
}

function phoneArchiveMessageText(archiveMessage, rawContent) {
  const messageType = String(archiveMessage?.messageType || "");
  // Voice notes carry the whole base64 Opus envelope as content — desktop
  // can't decode the iOS envelope, so store a placeholder; same for any
  // pathologically oversized payload.
  if (messageType === "audio") return "🎤 Voice message (from phone backup)";
  if (rawContent.length > PHONE_ARCHIVE_MAX_CONTENT_CHARS) return "📎 Media message (from phone backup)";
  if (rawContent.trim()) return rawContent; // payments arrive as "Sent/Received X KAS" text already
  if (messageType === "handshake") return "Communication request";
  if (messageType === "payment") return "[Payment]";
  return "";
}

function importPhoneChatArchive(json) {
  const archive = JSON.parse(json);
  if (!archive || !Array.isArray(archive.conversations)) {
    throw new Error("That file is not a KaChat phone chat backup.");
  }
  const archiveWallet = String(archive.walletAddress || "").trim();
  if (archiveWallet && engine.address && archiveWallet !== engine.address) {
    throw new Error(`That phone backup belongs to a different wallet (${shortAddress(archiveWallet)}).`);
  }

  // Merge against what is actually persisted right now (the desktop restore may
  // have just replaced storage).
  reloadStateFromBrowserStorage();

  const addedMessageIds = new Set();
  const touchedConversationIds = new Set();

  for (const archived of archive.conversations) {
    const contactAddress = String(archived?.contactAddress || "").trim();
    if (!contactAddress) continue;
    const archivedMessages = Array.isArray(archived?.messages) ? archived.messages : [];
    if (!archivedMessages.length) continue;

    const alias = String(archived?.contactAlias || "").trim();
    let contact = state.contacts.find((entry) => entry.address === contactAddress);
    let conversationEntry = contact ? state.conversations.find((entry) => entry.contactId === contact.id) : null;
    if (!contact) {
      const createdAt = phoneArchiveTimestampMs(archivedMessages[0]);
      const displayName = alias || shortAddress(contactAddress);
      contact = {
        id: nowId(), name: displayName, nameIsCustom: false, address: contactAddress,
        avatar: initialsFor(displayName), createdAt, updatedAt: createdAt,
        relationshipState: "legacy-manual", handshakeTxid: "", incomingHandshakeTxid: "", peerConversationId: "",
      };
      state.contacts.push(contact);
    } else if (alias && !contact.nameIsCustom) {
      // Only fill in a name the desktop side never chose — placeholder names
      // derived from the raw address; a custom alias is never overwritten.
      const isPlaceholderName = !contact.name || contact.name === "Unnamed"
        || contact.name === shortAddress(contact.address) || contact.name.startsWith("kaspa");
      if (isPlaceholderName) {
        contact.name = alias;
        contact.avatar = initialsFor(alias);
      }
    }
    if (!conversationEntry) {
      conversationEntry = createConversation({ contactId: contact.id, createdAt: Number(contact.createdAt || Date.now()) });
      state.conversations.push(conversationEntry);
    }

    const hidden = new Set((conversationEntry.hiddenMessageKeys || []).map(String));
    const knownTxids = new Set((conversationEntry.messages || []).map((m) => m.txid).filter(Boolean).map(String));
    const knownIds = new Set((conversationEntry.messages || []).map((m) => String(m.id)));
    const preLastActivityAt = Number(conversationEntry.lastActivityAt || 0);
    const preUpdatedAt = Number(conversationEntry.updatedAt || 0);
    const preReactionEvent = conversationEntry.lastReactionEvent ?? null;
    let changed = false;

    for (const archiveMessage of archivedMessages) {
      const txid = String(archiveMessage?.txId || "").trim();
      const id = String(archiveMessage?.id || "").trim() || nowId();
      if (txid && (knownTxids.has(txid) || hidden.has(txid))) continue;
      if (knownIds.has(id) || hidden.has(id)) continue;

      const rawContent = String(archiveMessage?.content || "");
      const reaction = parseReactionEnvelope(rawContent);
      if (reaction) {
        // Same interception as live sync: a reaction only ever updates the
        // reactions store — it never becomes a visible chat row.
        const reactor = String(archiveMessage?.senderAddress || (archiveMessage?.isOutgoing ? engine.address || "" : contactAddress));
        if (reaction.action === "add") applyLocalReaction(conversationEntry, reaction.targetTxId, reactor, reaction.emoji);
        else removeLocalReaction(conversationEntry, reaction.targetTxId, reactor);
        if (txid) knownTxids.add(txid);
        changed = true;
        continue;
      }

      const text = phoneArchiveMessageText(archiveMessage, rawContent);
      if (!text) continue;
      const createdAt = phoneArchiveTimestampMs(archiveMessage);
      const message = createMessage({
        conversationId: conversationEntry.id,
        contactId: contact.id,
        direction: archiveMessage?.isOutgoing ? "outgoing" : "incoming",
        text,
        sender: String(archiveMessage?.senderAddress || "") || null,
        receiver: String(archiveMessage?.receiverAddress || "") || null,
        status: PHONE_ARCHIVE_STATUSES[String(archiveMessage?.deliveryStatus || "")] || MESSAGE_STATUSES.CONFIRMED,
        transport: "phone-backup",
        createdAt,
      });
      message.id = id;
      message.txid = txid || null;
      message.messageType = String(archiveMessage?.messageType || "") || null;
      message.note = "Imported from phone backup";
      if (message.status === MESSAGE_STATUSES.CONFIRMED) message.confirmations = Math.max(1, Number(message.confirmations || 0));
      if (message.messageType === "payment") {
        const amount = rawContent.match(/^(?:Sent|Received)\s+([0-9][0-9.,]*)\s+KAS/i);
        if (amount) message.paymentAmountKas = amount[1].replaceAll(",", "");
      }
      conversationEntry.messages.push(message);
      knownIds.add(id);
      if (txid) knownTxids.add(txid);
      addedMessageIds.add(id);
      changed = true;
    }

    if (!changed) continue;
    touchedConversationIds.add(conversationEntry.id);
    conversationEntry.messages.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    const last = conversationEntry.messages.at(-1);
    // Historical import, not a live reaction event — don't let it fake sidebar
    // activity or advertise a years-old tapback as "new".
    conversationEntry.lastReactionEvent = preReactionEvent;
    conversationEntry.lastActivityAt = Math.max(preLastActivityAt, Number(last?.createdAt || 0));
    conversationEntry.updatedAt = Math.max(preUpdatedAt, Number(last?.updatedAt || last?.createdAt || 0));
    // Restored two-way history means the relationship was already accepted on the phone —
    // mark it established here so later handshake sync can't resurface accept/decline.
    if (contact.relationshipState !== "established") {
      const merged = conversationEntry.messages;
      const hasOutgoing = merged.some((m) => m.direction === "outgoing" && m.messageType !== "handshake" && String(m.text || "").trim().length > 0);
      const hasIncoming = merged.some((m) => m.direction === "incoming" && m.messageType !== "handshake" && String(m.text || "").trim().length > 0);
      if (hasOutgoing && hasIncoming) {
        contact.relationshipState = "established";
        contact.updatedAt = Date.now();
      }
    }
  }

  // Persist with a quota guard. In IndexedDB mode persistState never throws
  // (device-proportional quota) so this whole catch is dormant; it only fires
  // in the localStorage FALLBACK mode, where even a placeholder-reduced
  // archive can exceed the quota. There, trim only the messages imported THIS
  // run (oldest first, per conversation) until the state fits — pre-existing
  // desktop messages are never dropped.
  const isQuotaError = (error) =>
    error?.name === "QuotaExceededError" || error?.code === 22 || /quota/i.test(String(error?.message || ""));
  let quotaTrimmed = false;
  try {
    persistState();
  } catch (error) {
    if (!isQuotaError(error)) { reloadStateFromBrowserStorage(); throw error; }
    let persisted = false;
    for (const keepPerConversation of [200, 50, 10, 0]) {
      for (const conversationEntry of state.conversations || []) {
        const importedHere = (conversationEntry.messages || []).filter((m) => addedMessageIds.has(String(m.id)));
        if (importedHere.length <= keepPerConversation) continue;
        const keepIds = new Set(importedHere.slice(-keepPerConversation).map((m) => String(m.id)));
        conversationEntry.messages = conversationEntry.messages.filter(
          (m) => !addedMessageIds.has(String(m.id)) || keepIds.has(String(m.id)),
        );
      }
      try { persistState(); persisted = true; break; }
      catch (retryError) { if (!isQuotaError(retryError)) { reloadStateFromBrowserStorage(); throw retryError; } }
    }
    if (!persisted) {
      reloadStateFromBrowserStorage();
      throw new Error("Backup too large to store — not enough local storage space to merge the phone backup.");
    }
    quotaTrimmed = true;
  }

  // Count what actually survived persistence (quota trimming may have dropped some).
  let mergedMessages = 0;
  for (const conversationEntry of state.conversations || []) {
    for (const message of conversationEntry.messages || []) {
      if (addedMessageIds.has(String(message.id))) mergedMessages += 1;
    }
  }

  reloadStateFromBrowserStorage();
  renderChats();
  if (quotaTrimmed) showCopyToast("Backup too large to store fully — imported what fit.");
  return { conversations: touchedConversationIds.size, messages: mergedMessages };
}

// Sends a reaction as a real on-chain message (same encrypted pipeline as
// text), but — matching iOS — never creates a visible bubble for it: applies
// optimistically to the local reactions store first, then fires the actual
// send in the background through the same serialized send queue every other
// on-chain action uses.
async function sendReaction(conversationEntry, targetMessage, emoji) {
  const contact = contactForConversation(conversationEntry);
  if (!contact || !engine.address) return;
  const targetTxId = targetMessage.txid || targetMessage.id;
  const myAddress = engine.address;
  const existing = (conversationEntry.reactionsByTxId?.[targetTxId] || []).find((entry) => entry.reactorAddress === myAddress);
  const action = existing?.emoji === emoji ? "remove" : "add";

  if (action === "add") applyLocalReaction(conversationEntry, targetTxId, myAddress, emoji);
  else removeLocalReaction(conversationEntry, targetTxId, myAddress);
  persistState();
  renderMessages(conversationEntry);
  renderChats();

  const payload = JSON.stringify({ type: "reaction", targetTxId, emoji, action });
  try {
    const envelope = await engine.createEncryptedMessageEnvelope({
      conversationId: conversationEntry.id,
      contactId: contact.id,
      toAddress: contact.address,
      fromAddress: engine.address,
      text: payload,
      localNonce: nowId(),
      createdAt: Date.now(),
    });
    await engine.sendMessageOnchain({ envelope, amountKas: onchainAmountKas(), feeKas: "0", onStatus: () => {} });
  } catch (error) {
    appendEngineLog(`Reaction send failed (non-fatal, local state already applied): ${error.message}`);
  }
}

pendingPhotoRemove?.addEventListener("click", clearPendingPhoto);

photoFileInput?.addEventListener("change", async () => {
  const file = photoFileInput.files?.[0];
  if (!file) return;
  await attachPhotoBlob(file);
  photoFileInput.value = "";
});

composer.elements.message?.addEventListener("paste", async (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find((item) => item.type?.startsWith("image/"));
  if (!imageItem) return;
  event.preventDefault();
  if (composerMode === "kas") await activateComposerMode("message");
  const file = imageItem.getAsFile();
  if (file) await attachPhotoBlob(file);
});

composerModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.composerMode;
    closeComposerMenu();
    if (mode === "message") {
      activateComposerMode("message");
    } else if (mode === "kas") {
      activateComposerMode("kas");
    } else if (mode === "photo") {
      activateComposerMode("message");
      photoFileInput?.click();
    } else if (mode === "voice") {
      activateComposerMode("message");
      startVoiceRecording();
    } else if (mode === "handshake") {
      sendHandshakeFromComposer();
    }
  });
});

document.addEventListener("click", (event) => {
  if (!composerPlusMenu || composerPlusMenu.hidden) return;
  if (composerPlusMenu.contains(event.target) || composerPlusButton?.contains(event.target)) return;
  closeComposerMenu();
});

function hideFeeEstimateBanner() {
  if (feeEstimateDebounceTimer) window.clearTimeout(feeEstimateDebounceTimer);
  feeEstimateDebounceTimer = null;
  if (feeEstimateBanner) feeEstimateBanner.hidden = true;
}

function hideHandshakeWarningBanner() {
  if (handshakeWarningBanner) handshakeWarningBanner.hidden = true;
}

// Matches iOS: a contact added manually (or recovered) with no reciprocal
// handshake yet can't be sure the other side will ever see a message sent to
// them — Kasia messages rely on a completed handshake for the recipient's
// client to recognize and decrypt them. Surfaced only while actually
// composing (same trigger point as the fee-estimate banner), not as a
// persistent nag every time the conversation is opened.
function updateHandshakeWarningBanner() {
  if (!handshakeWarningBanner) return;
  if (composerMode !== "message" || !activeConversationId) {
    hideHandshakeWarningBanner();
    return;
  }
  const text = String(composer.elements.message?.value || "").trim();
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  if (!text || !contact || contact.relationshipState !== "legacy-manual") {
    hideHandshakeWarningBanner();
    return;
  }
  handshakeWarningBanner.hidden = false;
}

// Approximates the real Kasia COMM payload's byte length for this draft
// (ciph_msg:1:comm:<alias>: prefix + base64 of nonce+pubkey+ciphertext+tag),
// then asks the engine for the real SDK-calculated fee for a payload that
// size — an honest estimate built from the actual send path, not a guess.
function estimateCommPayloadBytes(text) {
  const cipherBytes = 12 + 33 + new TextEncoder().encode(text).length + 16;
  const base64Len = Math.ceil(cipherBytes / 3) * 4;
  const prefixLen = "ciph_msg:1:comm:".length + 12 + 1;
  return prefixLen + base64Len;
}

function scheduleFeeEstimate() {
  if (!feeEstimateBanner || !accountShellPrefs.estimateFees || composerMode !== "message") {
    hideFeeEstimateBanner();
    return;
  }
  const text = String(composer.elements.message?.value || "").trim();
  if (!text || !activeConversationId || !engine.address) {
    hideFeeEstimateBanner();
    return;
  }
  if (feeEstimateDebounceTimer) window.clearTimeout(feeEstimateDebounceTimer);
  const token = ++feeEstimateRequestToken;
  feeEstimateDebounceTimer = window.setTimeout(async () => {
    try {
      const payloadBytes = estimateCommPayloadBytes(text);
      const feeKas = await engine.estimateMessageFee(payloadBytes);
      if (token !== feeEstimateRequestToken || !feeEstimateBanner) return;
      if (feeKas == null) { feeEstimateBanner.hidden = true; return; }
      feeEstimateBanner.textContent = `Estimated fee ${feeKas} KAS`;
      feeEstimateBanner.hidden = false;
    } catch {
      if (token === feeEstimateRequestToken && feeEstimateBanner) feeEstimateBanner.hidden = true;
    }
  }, 450);
}

composer.elements.message?.addEventListener("input", scheduleFeeEstimate);
composer.elements.message?.addEventListener("input", updateHandshakeWarningBanner);

document.querySelector("[data-handshake-warning-send]")?.addEventListener("click", async () => {
  hideHandshakeWarningBanner();
  await sendHandshakeFromComposer();
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeConversationId) return;

  const input = composer.elements.message;
  const text = String(input.value || "").trim();

  if (pendingPhotoAttachment) {
    const attachment = pendingPhotoAttachment;
    input.value = "";
    clearPendingPhoto();
    hideFeeEstimateBanner();
    // "Send Media via Nextcloud": upload the full-quality original and send its share link
    // (renders as a media bubble on the recipient's side). Any failure falls back to the
    // on-chain envelope so the message never silently vanishes.
    if (isNextcloudMediaSendActive() && attachment.originalBlob) {
      const conversationId = activeConversationId;
      setStatus("Uploading photo to Nextcloud…");
      try {
        const url = await uploadNextcloudMedia(
          attachment.originalBlob,
          attachment.originalName || "photo.jpg",
          attachment.originalBlob.type || "image/jpeg"
        );
        queueConversationMessage(conversationId, url);
        setStatus("Photo sent via Nextcloud.");
        return;
      } catch (error) {
        showCopyToast(`Nextcloud upload failed — sending on-chain instead. (${error.message})`);
      }
    }
    queueConversationMessage(activeConversationId, buildImageEnvelopeJson(attachment));
    return;
  }

  if (!text) return;

  if (composerMode === "kas") {
    try {
      await sendKasPayment(activeConversationId, text);
    } catch (error) {
      setStatus(`Payment failed: ${error.message}`);
    }
    return;
  }

  input.value = "";
  hideFeeEstimateBanner();
  queueConversationMessage(activeConversationId, text);
});


if (indexerUrlInput) {
  indexerUrlInput.value = localStorage.getItem(INDEXER_URL_KEY) || indexerUrlInput.value || getEndpoint("kasiaIndexer");
  indexerUrlInput.addEventListener("change", () => {
    localStorage.setItem(INDEXER_URL_KEY, indexerUrlInput.value.trim());
    renderTransportReadiness();
  });
}

testIndexerButton?.addEventListener("click", async () => {
  try {
    testIndexerButton.disabled = true;
    setStatus("Testing Kasia indexer…");
    const result = await engine.testKasiaIndexer(indexerUrlInput?.value?.trim());
    setStatus("Kasia indexer connected");
    appendEngineLog(`Kasia indexer online: ${result.baseUrl}`);
  } catch (error) {
    setStatus("Kasia indexer test failed");
    appendEngineLog(`Indexer failed: ${error.message}`);
  } finally {
    testIndexerButton.disabled = false;
  }
});

document.querySelectorAll("[data-cancel-onchain-send]").forEach((button) => {
  button.addEventListener("click", closeOnchainConfirm);
});

document.querySelector("[data-confirm-onchain-send]")?.addEventListener("click", () => {
  const draft = pendingOnchainDraft;
  if (!draft) return closeOnchainConfirm();
  if (composer?.elements?.message) composer.elements.message.value = "";
  closeOnchainConfirm();
  queueConversationMessage(draft.conversationId, draft.text);
});

onchainConfirmModal?.addEventListener("click", (event) => {
  if (event.target === onchainConfirmModal) closeOnchainConfirm();
});

document.querySelector("[data-load-wasm]").addEventListener("click", async () => {
  await ensureRuntimes();
});


document.querySelector("[data-load-kasia-cipher]")?.addEventListener("click", async () => {
  await ensureRuntimes();
});

function openSavedAccounts() {
  localStorage.setItem(SESSION_LOGGED_OUT_KEY, "true");
  clearSessionActive();
  showLoggedOutScreen();
}

document.querySelectorAll("[data-open-account-manager]").forEach((button) => {
  const label = button.textContent?.trim().toLowerCase() || "";
  button.addEventListener("click", () => {
    if (label.includes("add") || button.classList.contains("profile-account-add")) openCreateAccountModal();
    else openSavedAccounts();
  });
});

document.querySelector("[data-open-profile-account]")?.addEventListener("click", () => {
  closeAccountOverlay();
  setActiveAppTab("profile");
});

const createAccountModal = document.querySelector("[data-create-account-modal]");
const createAccountError = document.querySelector("[data-create-account-error]");
const createAccountErrorSeed = document.querySelector("[data-create-account-error-seed]");
const createNameInput = document.querySelector("[data-create-name]");
const createPassphraseInput = document.querySelector("[data-create-passphrase]");
const createSeedGrid = document.querySelector("[data-seed-grid]");
const createSeedReveal = document.querySelector("[data-seed-reveal]");
const createSeedConfirm = document.querySelector("[data-seed-confirm]");
const createContinueBtn = document.querySelector("[data-continue-to-passphrase]");
const generateAccountBtn = document.querySelector("[data-generate-account]");
const createPassphraseConfirm = document.querySelector("[data-create-passphrase-confirm]");
const createPassphraseError = document.querySelector("[data-create-passphrase-error]");
const passphraseToggleBtn = document.querySelector("[data-passphrase-toggle]");
const continueWithPassphraseBtn = document.querySelector("[data-continue-with-passphrase]");
const skipPassphraseBtn = document.querySelector("[data-skip-passphrase]");
const recoveryModal = document.querySelector("[data-recovery-modal]");
const recoveryPhraseBox = document.querySelector("[data-recovery-phrase]");
const revealRecoveryButton = document.querySelector("[data-reveal-recovery]");
const recoveryProgressFill = document.querySelector("[data-recovery-progress]");

// Pending new account carried between the setup step and the seed-confirm step.
let pendingNewAccount = null;

function showCreateStep(step) {
  document.querySelectorAll("[data-create-step]").forEach((el) => { el.hidden = el.dataset.createStep !== step; });
}
function openCreateAccountModal() {
  pendingNewAccount = null;
  if (createAccountError) { createAccountError.hidden = true; createAccountError.textContent = ""; }
  if (createAccountErrorSeed) createAccountErrorSeed.hidden = true;
  if (createNameInput) createNameInput.value = "My Account";
  if (createPassphraseInput) { createPassphraseInput.value = ""; createPassphraseInput.type = "password"; }
  if (createPassphraseConfirm) createPassphraseConfirm.value = "";
  if (createPassphraseError) createPassphraseError.hidden = true;
  const w24 = document.querySelector('input[name="wordCount"][value="24"]');
  if (w24) w24.checked = true;
  showCreateStep("setup");
  if (createAccountModal) createAccountModal.hidden = false;
  queueMicrotask(() => createNameInput?.focus());
}
function closeCreateAccountModal() {
  if (createAccountModal) createAccountModal.hidden = true;
  pendingNewAccount = null;
  if (!engine.address || localStorage.getItem(SESSION_LOGGED_OUT_KEY) === "true") showLoggedOutScreen();
}
document.querySelectorAll("[data-close-create-account]").forEach((button) => button.addEventListener("click", closeCreateAccountModal));
createAccountModal?.addEventListener("click", (event) => { if (event.target === createAccountModal) closeCreateAccountModal(); });

function renderSeedGrid(phrase) {
  if (!createSeedGrid) return;
  createSeedGrid.replaceChildren();
  phrase.split(/\s+/).filter(Boolean).forEach((word, index) => {
    const cell = document.createElement("div");
    cell.className = "seed-grid-cell";
    cell.innerHTML = `<span class="seed-grid-index">${index + 1}.</span><span class="seed-grid-word"></span>`;
    cell.querySelector(".seed-grid-word").textContent = word;
    createSeedGrid.appendChild(cell);
  });
}

// STEP 1 → STEP 2: generate a phrase and show it for backup (no derivation yet).
generateAccountBtn?.addEventListener("click", async () => {
  const name = String(createNameInput?.value || "").trim();
  const wordCount = Number(document.querySelector('input[name="wordCount"]:checked')?.value || 24);
  if (!name) { if (createAccountError) { createAccountError.textContent = "Enter an account name."; createAccountError.hidden = false; } return; }
  if (![12, 24].includes(wordCount)) { if (createAccountError) { createAccountError.textContent = "Choose a 12 or 24 word seed phrase."; createAccountError.hidden = false; } return; }
  generateAccountBtn.disabled = true;
  if (createAccountError) createAccountError.hidden = true;
  try {
    if (!engine.kaspa) await ensureRuntimes();
    const phrase = engine.generateMnemonicPhrase(wordCount);
    const words = phrase.split(/\s+/).filter(Boolean);
    if (words.length !== wordCount) throw new Error(`Expected ${wordCount} words but generated ${words.length}.`);
    pendingNewAccount = { name, wordCount, phrase, passphrase: "" };
    renderSeedGrid(phrase);
    // Reset the reveal/confirm gate each time.
    if (createSeedGrid) createSeedGrid.hidden = true;
    if (createSeedReveal) createSeedReveal.hidden = false;
    if (createSeedConfirm) createSeedConfirm.checked = false;
    if (createContinueBtn) createContinueBtn.disabled = true;
    if (createAccountErrorSeed) createAccountErrorSeed.hidden = true;
    showCreateStep("seed");
  } catch (error) {
    if (createAccountError) { createAccountError.textContent = error.message; createAccountError.hidden = false; }
  } finally {
    generateAccountBtn.disabled = false;
  }
});

createSeedReveal?.addEventListener("click", () => {
  if (createSeedGrid) createSeedGrid.hidden = false;
  if (createSeedReveal) createSeedReveal.hidden = true;
});
createSeedConfirm?.addEventListener("change", () => {
  if (createContinueBtn) createContinueBtn.disabled = !createSeedConfirm.checked;
});

// STEP 2 → enter app: derive the wallet (with optional passphrase), persist, and
// launch the setup guide (new accounts only), matching iOS's justCreatedNewWallet.
async function finalizeNewAccount({ name, phrase, passphrase, wordCount }) {
  if (!engine.kaspa) await ensureRuntimes();
  const wallet = engine.importMnemonic(phrase, passphrase);
  if (!wallet?.privateKeyHex || !wallet?.address?.startsWith("kaspa:") || !wallet?.mnemonic) {
    engine.clearSession();
    throw new Error("Wallet generation did not produce a valid mainnet identity.");
  }

  const createdAt = new Date().toISOString();
  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  metadata[wallet.address] = { name, createdAt };
  localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(metadata));

  activateWalletDataScope(wallet.address, { migrateLegacy: false });
  state = { contacts: [], conversations: [] };
  persistState();
  persistTestingWallet({ mnemonic: wallet.mnemonic, passphrase, derivationPath: wallet.derivationPath, wordCount });

  if (accountShellPrefs.saveAccount !== false) {
    const saved = loadSavedAccounts().find((entry) => entry.address === wallet.address);
    if (!saved?.privateKeyHex || !saved?.mnemonic || saved?.name !== name) {
      engine.clearSession();
      throw new Error("The new account could not be verified after saving.");
    }
  }

  localStorage.removeItem(SESSION_LOGGED_OUT_KEY);
  markSessionActive();
  hideLoggedOutScreen();
  currentBalanceKas = "--";
  updateWalletUi();
  updateServiceSummary();
  refreshSubscriptionAddresses({ restart: false });
  appendEngineLog(`Created ${wordCount}-word account ${name}: ${wallet.address}${wallet.hasPassphrase ? " (passphrase set)" : ""}`);
  renderChats();
  void connectAndRefresh({ quiet: true }).catch((error) => {
    appendEngineLog(`Post-create RPC startup failed: ${error.message}`);
    setStatus(`Account created. Network connection failed: ${error.message}`);
  });
  return wallet;
}

// STEP 2 → STEP 3: after backing up the seed, advance to the optional passphrase
// step (the wallet isn't derived until a passphrase is chosen or skipped).
createContinueBtn?.addEventListener("click", () => {
  if (!pendingNewAccount || !createSeedConfirm?.checked) return;
  if (createPassphraseInput) { createPassphraseInput.value = ""; createPassphraseInput.type = "password"; }
  if (createPassphraseConfirm) createPassphraseConfirm.value = "";
  if (createPassphraseError) createPassphraseError.hidden = true;
  if (passphraseToggleBtn) passphraseToggleBtn.textContent = "Show";
  showCreateStep("passphrase");
  queueMicrotask(() => createPassphraseInput?.focus());
});

passphraseToggleBtn?.addEventListener("click", () => {
  if (!createPassphraseInput) return;
  const show = createPassphraseInput.type === "password";
  createPassphraseInput.type = show ? "text" : "password";
  if (createPassphraseConfirm) createPassphraseConfirm.type = show ? "text" : "password";
  passphraseToggleBtn.textContent = show ? "Hide" : "Show";
});

// STEP 3 → enter app: derive with the chosen passphrase ("" when skipped),
// persist, and launch the setup guide.
async function commitPendingAccount(passphrase) {
  if (!pendingNewAccount) return;
  const account = { ...pendingNewAccount, passphrase };
  const buttons = [continueWithPassphraseBtn, skipPassphraseBtn];
  buttons.forEach((b) => { if (b) b.disabled = true; });
  if (createPassphraseError) createPassphraseError.hidden = true;
  try {
    await finalizeNewAccount(account);
    pendingNewAccount = null;
    if (createAccountModal) createAccountModal.hidden = true;
    showCopyToast("Account created");
    openSetupGuide();
  } catch (error) {
    appendEngineLog(`Create account failed: ${error.message}`);
    if (createPassphraseError) { createPassphraseError.textContent = error.message; createPassphraseError.hidden = false; }
  } finally {
    buttons.forEach((b) => { if (b) b.disabled = false; });
  }
}

continueWithPassphraseBtn?.addEventListener("click", () => {
  const pass = String(createPassphraseInput?.value || "");
  if (!pass) {
    if (createPassphraseError) { createPassphraseError.textContent = "Enter a passphrase, or tap Skip to continue without one."; createPassphraseError.hidden = false; }
    return;
  }
  if (pass !== String(createPassphraseConfirm?.value || "")) {
    if (createPassphraseError) { createPassphraseError.textContent = "The passphrases don't match. Please re-enter them."; createPassphraseError.hidden = false; }
    return;
  }
  void commitPendingAccount(pass);
});
skipPassphraseBtn?.addEventListener("click", () => void commitPendingAccount(""));

// --- Setup Guide wizard (iOS WelcomeGuideView). Pops up after creating a new
// account; also reopenable from Profile. 8 forward steps + Skip. ---
const setupGuideModal = document.querySelector("[data-setup-guide-modal]");
const setupIconEl = document.querySelector("[data-setup-icon]");
const setupTitleEl = document.querySelector("[data-setup-title]");
const setupBodyEl = document.querySelector("[data-setup-body]");
const setupExtraEl = document.querySelector("[data-setup-extra]");
const setupNextBtn = document.querySelector("[data-setup-next]");
const setupSkipBtn = document.querySelector("[data-setup-skip]");
const setupProgressEl = document.querySelector("[data-setup-progress]");

const SETUP_STEPS = [
  { icon: "👋", title: "Welcome to KaChat", body: "Let's walk through the basics so you're ready to send your first message." },
  { icon: "🌐", title: "Choose Your Language", body: "Select the language you'd like to use in KaChat.", extra: "language" },
  { icon: "💲", title: "Choose Your Currency", body: "Select the currency you'd like prices displayed in.", extra: "currency" },
  { icon: "🛰️", title: "How KaChat Uses Kaspa", body: "KaChat lets you send and receive messages on the Kaspa network itself. Kaspa is required to pay fees when sending your messages. The fee you pay goes to miners which secure the network." },
  { icon: "🔳", qr: true, title: "Fund Your Chatting Address", body: "Let's fund your chatting address so that you can start chatting with people. 5-10 Kaspa is enough. (1 KAS is about ~500 messages)", extra: "funding" },
  { icon: "🖥️", title: "Connect to a Node", body: "KaChat needs to connect to a node. How would you like to connect?", extra: "node" },
  { icon: "🪪", title: "Chatting vs. Spending Address", body: "", extra: "addresses" },
  { icon: "💬", title: "Starting a Conversation", body: "To chat with someone, press Create Chat and enter their Kaspa address or KNS domain. If you send a message, they will not see it unless you send a handshake first, or you both decide to message each other around the same time - doing the latter increases your privacy." },
];
let setupStepIndex = 0;

function wizardSetCurrency(key) {
  if (!CURRENCIES[key]) return;
  selectedCurrency = key;
  localStorage.setItem(CURRENCY_PREF_KEY, key);
  refreshCurrencyUi();
  document.dispatchEvent(new CustomEvent("kachat:currency-changed"));
}
function wizardSetLanguage(key) {
  if (!LANGUAGES[key]) return;
  selectedLanguage = key;
  localStorage.setItem(LANGUAGE_PREF_KEY, key);
  applyLanguage();
  refreshLanguageUi();
}

function buildSetupChoiceList(entries, isSelected, onPick) {
  const list = document.createElement("div");
  list.className = "setup-choice-list";
  for (const [key, label] of entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "setup-choice-row" + (isSelected(key) ? " selected" : "");
    row.innerHTML = `<span></span><svg class="setup-choice-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-11"/></svg>`;
    row.querySelector("span").textContent = label;
    row.addEventListener("click", () => { onPick(key); renderSetupStep(); });
    list.appendChild(row);
  }
  return list;
}

function renderSetupExtra(kind) {
  if (!setupExtraEl) return;
  setupExtraEl.replaceChildren();
  setupExtraEl.hidden = !kind;
  if (kind === "language") {
    setupExtraEl.appendChild(buildSetupChoiceList(Object.entries(LANGUAGES), (k) => k === selectedLanguage, wizardSetLanguage));
  } else if (kind === "currency") {
    setupExtraEl.appendChild(buildSetupChoiceList(Object.entries(CURRENCIES).map(([k, v]) => [k, v.name]), (k) => k === selectedCurrency, wizardSetCurrency));
  } else if (kind === "funding") {
    const addr = engine.address || "No wallet loaded";
    const wrap = document.createElement("div");
    wrap.className = "setup-funding";
    const addrBtn = document.createElement("button");
    addrBtn.type = "button";
    addrBtn.className = "setup-funding-address";
    addrBtn.textContent = addr;
    addrBtn.addEventListener("click", async () => { if (engine.address) { await copyTextToClipboard(engine.address); showCopyToast("Address copied to clipboard."); } });
    const qrBtn = document.createElement("button");
    qrBtn.type = "button";
    qrBtn.className = "secondary-button";
    qrBtn.textContent = "Show QR Code";
    // Don't close the guide — the address screen (z-index 1500) layers above it,
    // so backing out of the QR returns here on the funding step.
    qrBtn.addEventListener("click", () => { openChattingAddressScreen(); });
    // No gift row: desktop deliberately has no free-gift program (mobile-only).
    wrap.append(addrBtn, qrBtn);
    setupExtraEl.appendChild(wrap);
  } else if (kind === "node") {
    // Desktop connects via auto-discovery (wRPC resolver) by default; "own node"
    // lets the user paste a trusted endpoint.
    const opts = [
      { key: "auto", title: "Auto Search for Nodes", badge: "Recommended", sub: "Automatically finds and connects to public Kaspa nodes over wRPC. No setup needed." },
      { key: "own", title: "Connect Your Own Node", badge: "Best", sub: "Enter a node address you trust for the most reliable, private connection.", input: true },
    ];
    let current = accountShellPrefs.nodeChoice;
    if (current !== "auto" && current !== "own") current = "auto"; // normalize legacy/default
    const list = document.createElement("div");
    list.className = "setup-choice-list";
    for (const o of opts) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "setup-node-row" + (current === o.key ? " selected" : "");
      row.innerHTML = `<span class="setup-node-dot"></span><span class="setup-node-copy"><strong></strong><small></small></span>${o.badge ? `<span class="setup-node-badge"></span>` : ""}`;
      row.querySelector("strong").textContent = o.title;
      row.querySelector("small").textContent = o.sub;
      if (o.badge) row.querySelector(".setup-node-badge").textContent = o.badge;
      row.addEventListener("click", () => { accountShellPrefs.nodeChoice = o.key; persistAccountShellPreferences(); renderSetupStep(); });
      list.appendChild(row);
      if (o.input && current === o.key) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "field-input setup-node-input";
        input.placeholder = "host:port or grpcs://host";
        input.value = accountShellPrefs.nodeAddress || "";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.addEventListener("input", () => { accountShellPrefs.nodeAddress = input.value.trim(); persistAccountShellPreferences(); });
        list.appendChild(input);
      }
    }
    setupExtraEl.appendChild(list);
  } else if (kind === "addresses") {
    const spendingAddr = deriveSpendingAddressAt(getActiveSpendingIndex());
    const rows = [
      { title: "Chatting Address", value: engine.address || "—", caption: "Your public messaging identity. Fund it with a small amount to pay message fees and KNS profile creation fees — never send money here that you intend to spend." },
      { title: "Spending Address", value: spendingAddr || "Import a recovery phrase to use spending addresses", caption: "A separate address for the Kaspa you actually spend and receive. Manage it, view its balance, send and receive from your Profile — the same recovery phrase restores it identically on any device." },
    ];
    for (const r of rows) {
      const box = document.createElement("div");
      box.className = "setup-address-row";
      box.innerHTML = `<strong></strong><span class="setup-address-value"></span><small></small>`;
      box.querySelector("strong").textContent = r.title;
      box.querySelector(".setup-address-value").textContent = r.value;
      box.querySelector("small").textContent = r.caption;
      setupExtraEl.appendChild(box);
    }
  }
}

function renderSetupStep() {
  const step = SETUP_STEPS[setupStepIndex];
  if (!step) return;
  if (setupIconEl) {
    if (step.qr && engine.address) {
      // Real QR of the chatting address, rendered in the teal (kaspa) scheme.
      setupIconEl.replaceChildren();
      const canvas = document.createElement("canvas");
      canvas.width = 320; canvas.height = 320;
      canvas.className = "setup-guide-qr";
      setupIconEl.appendChild(canvas);
      Promise.resolve(engine.drawQr(canvas, { dark: "#62f4d0", light: "#00000000" }))
        .catch(() => { setupIconEl.textContent = step.icon; });
    } else {
      setupIconEl.textContent = step.icon;
    }
  }
  if (setupTitleEl) setupTitleEl.textContent = step.title;
  if (setupBodyEl) { setupBodyEl.textContent = step.body || ""; setupBodyEl.hidden = !step.body; }
  renderSetupExtra(step.extra);
  if (setupNextBtn) setupNextBtn.textContent = setupStepIndex === SETUP_STEPS.length - 1 ? "Finish" : "Next";
  if (setupProgressEl) setupProgressEl.textContent = `${setupStepIndex + 1} / ${SETUP_STEPS.length}`;
}
function openSetupGuide() {
  setupStepIndex = 0;
  renderSetupStep();
  if (setupGuideModal) setupGuideModal.hidden = false;
}
function closeSetupGuide() {
  if (setupGuideModal) setupGuideModal.hidden = true;
}
setupNextBtn?.addEventListener("click", () => {
  if (setupStepIndex >= SETUP_STEPS.length - 1) { closeSetupGuide(); return; }
  setupStepIndex += 1;
  renderSetupStep();
});
setupSkipBtn?.addEventListener("click", closeSetupGuide);
setupGuideModal?.addEventListener("click", (event) => { if (event.target === setupGuideModal) closeSetupGuide(); });
document.querySelectorAll("[data-open-setup-guide]").forEach((b) => b.addEventListener("click", openSetupGuide));

const importAccountModal = document.querySelector("[data-import-account-modal]");
const importNameInput = document.querySelector("[data-import-name]");
const importPhraseInput = document.querySelector("[data-import-phrase]");
const importAccountError = document.querySelector("[data-import-account-error]");
const importContinueBtn = document.querySelector("[data-import-continue]");
const importPassphraseInput = document.querySelector("[data-import-passphrase]");
const importPassphraseToggle = document.querySelector("[data-import-passphrase-toggle]");
const importPassphraseError = document.querySelector("[data-import-passphrase-error]");
const importWithPassphraseBtn = document.querySelector("[data-import-with-passphrase]");
const importSkipPassphraseBtn = document.querySelector("[data-import-skip-passphrase]");
let pendingImport = null;

function showImportStep(step) {
  document.querySelectorAll("[data-import-step]").forEach((el) => { el.hidden = el.dataset.importStep !== step; });
}
function showImportError(message) {
  if (importAccountError) { importAccountError.textContent = message; importAccountError.hidden = false; }
}
function openImportAccountModal() {
  pendingImport = null;
  if (importAccountError) { importAccountError.hidden = true; importAccountError.textContent = ""; }
  if (importPassphraseError) importPassphraseError.hidden = true;
  if (importNameInput) importNameInput.value = "Imported Account";
  if (importPhraseInput) importPhraseInput.value = "";
  if (importPassphraseInput) { importPassphraseInput.value = ""; importPassphraseInput.type = "password"; }
  showImportStep("form");
  if (importAccountModal) importAccountModal.hidden = false;
  queueMicrotask(() => importPhraseInput?.focus());
}
function closeImportAccountModal() {
  if (importAccountModal) importAccountModal.hidden = true;
  pendingImport = null;
  if (!engine.address || localStorage.getItem(SESSION_LOGGED_OUT_KEY) === "true") showLoggedOutScreen();
}
document.querySelectorAll("[data-close-import-account]").forEach((button) => button.addEventListener("click", closeImportAccountModal));
importAccountModal?.addEventListener("click", (event) => { if (event.target === importAccountModal) closeImportAccountModal(); });

async function importAndEnterAccount({ name, recoveryPhrase, passphrase = "" }) {
  if (!engine.kaspa) await ensureRuntimes();
  const cleanName = String(name || "").trim();
  const cleanPhrase = String(recoveryPhrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!cleanName) throw new Error("Enter an account name.");
  const words = cleanPhrase.split(" ").filter(Boolean);
  if (![12, 24].includes(words.length)) throw new Error("Recovery phrase must contain exactly 12 or 24 words.");

  let wallet;
  try {
    wallet = engine.importMnemonic(cleanPhrase, passphrase);
  } catch (error) {
    engine.clearSession();
    throw new Error(`Invalid recovery phrase: ${error?.message || "word list or checksum validation failed."}`);
  }
  if (!wallet?.privateKeyHex || !wallet?.address?.startsWith("kaspa:") || !wallet?.mnemonic) {
    engine.clearSession();
    throw new Error("Recovery phrase did not produce a valid Kaspa mainnet account.");
  }

  const createdAt = new Date().toISOString();
  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  metadata[wallet.address] = { name: cleanName, createdAt };
  localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(metadata));

  activateWalletDataScope(wallet.address, { migrateLegacy: false });
  state = { contacts: [], conversations: [] };
  persistState();
  persistTestingWallet({ mnemonic: wallet.mnemonic, passphrase, derivationPath: wallet.derivationPath, wordCount: words.length });

  if (accountShellPrefs.saveAccount !== false) {
    const saved = loadSavedAccounts().find((entry) => entry.address === wallet.address);
    if (!saved?.privateKeyHex || saved?.mnemonic !== cleanPhrase || saved?.name !== cleanName) {
      engine.clearSession();
      throw new Error("Imported account could not be verified after saving.");
    }
  }

  markSessionActive();
  localStorage.removeItem(SESSION_LOGGED_OUT_KEY);
  hideLoggedOutScreen();
  currentBalanceKas = "--";
  updateWalletUi();
  updateServiceSummary();
  refreshSubscriptionAddresses({ restart: false });
  appendEngineLog(`Imported ${words.length}-word account ${cleanName}: ${wallet.address}`);
  renderChats();
  void connectAndRefresh({ quiet: true }).catch((error) => {
    appendEngineLog(`Post-import RPC startup failed: ${error.message}`);
    setStatus(`Account imported. Network connection failed: ${error.message}`);
  });
  return wallet;
}

// STEP 1 → STEP 2: validate the phrase up front (so typos surface before the
// passphrase step), then advance to the optional passphrase screen.
importContinueBtn?.addEventListener("click", async () => {
  const name = String(importNameInput?.value || "").trim();
  const phrase = String(importPhraseInput?.value || "").trim().toLowerCase().replace(/\s+/g, " ");
  const words = phrase.split(" ").filter(Boolean);
  if (importAccountError) importAccountError.hidden = true;
  if (!name) { showImportError("Enter an account name."); return; }
  if (![12, 24].includes(words.length)) { showImportError("Recovery phrase must contain exactly 12 or 24 words."); return; }
  importContinueBtn.disabled = true;
  try {
    if (!engine.kaspa) await ensureRuntimes();
    try { new engine.kaspa.Mnemonic(phrase); }
    catch { showImportError("Invalid recovery phrase — check the words and their order."); return; }
    pendingImport = { name, recoveryPhrase: phrase };
    if (importPassphraseInput) { importPassphraseInput.value = ""; importPassphraseInput.type = "password"; }
    if (importPassphraseError) importPassphraseError.hidden = true;
    if (importPassphraseToggle) importPassphraseToggle.textContent = "Show";
    showImportStep("passphrase");
    queueMicrotask(() => importPassphraseInput?.focus());
  } finally {
    importContinueBtn.disabled = false;
  }
});

importPassphraseToggle?.addEventListener("click", () => {
  if (!importPassphraseInput) return;
  const show = importPassphraseInput.type === "password";
  importPassphraseInput.type = show ? "text" : "password";
  importPassphraseToggle.textContent = show ? "Hide" : "Show";
});

// STEP 2 → enter app: import with the chosen passphrase ("" when skipped). Import
// never shows the Welcome Guide (only brand-new accounts do).
async function commitImport(passphrase) {
  if (!pendingImport) return;
  const buttons = [importWithPassphraseBtn, importSkipPassphraseBtn];
  buttons.forEach((b) => { if (b) b.disabled = true; });
  if (importPassphraseError) importPassphraseError.hidden = true;
  try {
    await importAndEnterAccount({ ...pendingImport, passphrase });
    pendingImport = null;
    if (importAccountModal) importAccountModal.hidden = true;
    showCopyToast("Account imported");
  } catch (error) {
    appendEngineLog(`Import account failed: ${error.message}`);
    if (importPassphraseError) { importPassphraseError.textContent = error.message; importPassphraseError.hidden = false; }
  } finally {
    buttons.forEach((b) => { if (b) b.disabled = false; });
  }
}
importWithPassphraseBtn?.addEventListener("click", () => {
  const pass = String(importPassphraseInput?.value || "");
  if (!pass) {
    if (importPassphraseError) { importPassphraseError.textContent = "Enter a passphrase, or tap Skip to continue without one."; importPassphraseError.hidden = false; }
    return;
  }
  void commitImport(pass);
});
importSkipPassphraseBtn?.addEventListener("click", () => void commitImport(""));

function activeSavedAccountRecord() {
  const address = String(engine.address || localStorage.getItem(ACTIVE_ACCOUNT_KEY) || "").trim();
  return loadSavedAccounts().find((entry) => entry.address === address) || null;
}
let recoveryHoldStartedAt = 0;
let recoveryHoldFrame = 0;
let recoveryHoldPointerId = null;
const RECOVERY_HOLD_MS = 5000;

function resetRecoveryHold() {
  if (recoveryHoldFrame) cancelAnimationFrame(recoveryHoldFrame);
  recoveryHoldFrame = 0;
  recoveryHoldStartedAt = 0;
  recoveryHoldPointerId = null;
  revealRecoveryButton?.classList.remove("is-holding");
  if (recoveryProgressFill) recoveryProgressFill.style.width = "0%";
}

function revealRecoveryPhraseAfterHold() {
  const account = activeSavedAccountRecord();
  if (!account?.mnemonic || !recoveryPhraseBox) {
    resetRecoveryHold();
    return;
  }

  recoveryPhraseBox.textContent = account.mnemonic;
  recoveryPhraseBox.hidden = false;
  if (revealRecoveryButton) revealRecoveryButton.hidden = true;
  resetRecoveryHold();
}

function updateRecoveryHold(now) {
  if (!recoveryHoldStartedAt) return;
  const elapsed = Math.max(0, now - recoveryHoldStartedAt);
  const progress = Math.min(1, elapsed / RECOVERY_HOLD_MS);
  if (recoveryProgressFill) recoveryProgressFill.style.width = `${progress * 100}%`;

  if (progress >= 1) {
    revealRecoveryPhraseAfterHold();
    return;
  }

  recoveryHoldFrame = requestAnimationFrame(updateRecoveryHold);
}

function beginRecoveryHold(event) {
  if (!revealRecoveryButton || revealRecoveryButton.hidden || recoveryHoldStartedAt) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;

  event.preventDefault();
  recoveryHoldPointerId = event.pointerId;
  try { revealRecoveryButton.setPointerCapture(event.pointerId); } catch {}
  revealRecoveryButton.classList.add("is-holding");
  recoveryHoldStartedAt = performance.now();
  recoveryHoldFrame = requestAnimationFrame(updateRecoveryHold);
}

function cancelRecoveryHold(event) {
  if (event && recoveryHoldPointerId !== null && event.pointerId !== recoveryHoldPointerId) return;
  resetRecoveryHold();
}

function closeRecoveryModal() {
  resetRecoveryHold();
  if (recoveryModal) recoveryModal.hidden = true;
  if (recoveryPhraseBox) { recoveryPhraseBox.hidden = true; recoveryPhraseBox.textContent = ""; }
  if (revealRecoveryButton) revealRecoveryButton.hidden = false;
}
function openRecoveryModal() {
  const account = activeSavedAccountRecord();
  if (!account?.mnemonic) { showCopyToast("No recovery phrase stored for this account"); return; }
  resetRecoveryHold();
  if (recoveryPhraseBox) { recoveryPhraseBox.hidden = true; recoveryPhraseBox.textContent = ""; }
  if (revealRecoveryButton) revealRecoveryButton.hidden = false;
  if (recoveryModal) recoveryModal.hidden = false;
}
document.querySelectorAll("[data-close-recovery]").forEach((button) => button.addEventListener("click", closeRecoveryModal));
recoveryModal?.addEventListener("click", (event) => { if (event.target === recoveryModal) closeRecoveryModal(); });

// Click-to-view (no longer hold): password-gated when the seed-phrase
// protection is on.
revealRecoveryButton?.addEventListener("click", async () => {
  if (accountShellPrefs.passwordForSeed && hasAppPassword()) {
    const ok = await requestPassword({ mode: "verify", title: "Enter Password", message: "Enter your password to view the seed phrase." });
    if (!ok) return;
  }
  revealRecoveryPhraseAfterHold();
});

const logoutModal = document.querySelector("[data-logout-modal]");
function openLogoutModal() { if (logoutModal) logoutModal.hidden = false; }
function closeLogoutModal() { if (logoutModal) logoutModal.hidden = true; }

document.querySelectorAll('[data-shell-action="logout"]').forEach((button) => button.addEventListener("click", openLogoutModal));
document.querySelectorAll("[data-close-logout]").forEach((button) => button.addEventListener("click", closeLogoutModal));
logoutModal?.addEventListener("click", (event) => { if (event.target === logoutModal) closeLogoutModal(); });

document.querySelector("[data-confirm-logout]")?.addEventListener("click", async () => {
  try {
    persistState();
    if (engine.privateKeyHex) persistTestingWallet();
    localStorage.setItem(SESSION_LOGGED_OUT_KEY, "true");
    clearSessionActive();
    closeLogoutModal();
    await engine.disconnect?.();
    engine.clearSession();
    setActiveConversationId(null);
    state = { contacts: [], conversations: [] };
    currentBalanceKas = "--";
    updateWalletUi();
    updateServiceSummary();
    renderChats();
    showLoggedOutScreen();
  } catch (error) {
    appendEngineLog(`Logout failed: ${error.message}`);
  }
});

document.querySelectorAll('[data-shell-action]:not([data-shell-action="logout"]):not([data-shell-action="view-recovery"])').forEach((button) => button.addEventListener("click", () => {
  const label = button.querySelector("strong")?.textContent?.trim() || "This control";
  showCopyToast(`${label} frame ready`);
}));

document.querySelector("[data-logged-out-create]")?.addEventListener("click", openCreateAccountModal);

document.querySelector("[data-logged-out-import]")?.addEventListener("click", openImportAccountModal);

document.querySelector("[data-copy-balance]")?.addEventListener("click", async () => {
  try { await copyTextToClipboard(String(currentBalanceKas)); showCopyToast("Balance copied to clipboard."); } catch (error) { appendEngineLog(error.message); }
});

document.querySelectorAll('[data-shell-action="view-recovery"]').forEach((button) => button.addEventListener("click", openRecoveryModal));

// The profile "Welcome Guide" row is gated by the Show Setup Guides pref, like
// iOS (walletManager.showSetupGuides).
function refreshSetupGuideRow() {
  const show = accountShellPrefs.showSetupGuides ?? true;
  document.querySelectorAll("[data-setup-guide-row]").forEach((el) => { el.hidden = !show; });
}

const prefBindings = [
  ["[data-pref-save-account]", "saveAccount", true],
  ["[data-pref-keep-signed-in]", "keepSignedIn", true],
  ["[data-pref-estimate-fees]", "estimateFees", false],
  ["[data-pref-hide-payment-chats]", "hidePaymentChats", false],
  ["[data-pref-show-contact-balance]", "showContactBalance", true],
  ["[data-pref-store-messages]", "storeMessages", true],
  ["[data-pref-show-setup-guides]", "showSetupGuides", true],
];
prefBindings.forEach(([selector, key, fallback]) => {
  const input = document.querySelector(selector);
  if (!input) return;
  input.checked = accountShellPrefs[key] ?? fallback;
  input.addEventListener("change", () => {
    accountShellPrefs[key] = input.checked;
    persistAccountShellPreferences();
    if (key === "estimateFees") scheduleFeeEstimate();
    if (key === "showSetupGuides") refreshSetupGuideRow();
    if (key === "saveAccount") showCopyToast(input.checked ? "New accounts will be saved on this device." : "New accounts will stay in memory only (not saved).");
    if (key === "keepSignedIn") showCopyToast(input.checked ? "You'll stay signed in on next launch." : "You'll be asked to sign in on next launch.");
  });
});
refreshSetupGuideRow();

document.querySelector("[data-generate-wallet]")?.addEventListener("click", openCreateAccountModal);

document.querySelector("[data-import-wallet]")?.addEventListener("click", openImportAccountModal);

document.querySelector("[data-clear-wallet]")?.addEventListener("click", () => {
  engine.clearSession();
  clearPersistedTestingWallet();
  privateKeyInput.value = "";
  currentBalanceKas = "--";
  updateWalletUi();
  updateServiceSummary();
  appendEngineLog("Session cleared.");
});

document.querySelector("[data-connect-rpc]").addEventListener("click", async () => {
  await connectAndRefresh();
});



document.querySelector("[data-refresh-balance]").addEventListener("click", async () => {
  await connectAndRefresh();
});

document.querySelector("[data-export-local-state]")?.addEventListener("click", async () => {
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), step: window.__kaspaEngineStep, state }, null, 2);
  await navigator.clipboard.writeText(payload);
  appendEngineLog("Local contacts/conversations JSON copied to clipboard.");
  setStatus("Local data exported");
});

document.querySelector("[data-clear-local-state]")?.addEventListener("click", () => {
  if (!confirm("Clear local contacts and message previews? Wallet/private keys are not saved and will not be affected.")) return;
  state = { contacts: [], conversations: [] };
  persistState();
  renderChats();
  appendEngineLog("Local contacts/conversations cleared.");
  setStatus("Local data cleared");
});

profileQrCard?.addEventListener("click", () => {
  if (!engine.address || !profileQrOverlay || !profileQrOverlayCanvas) return;
  const overlayContext = profileQrOverlayCanvas.getContext("2d");
  overlayContext.clearRect(0, 0, profileQrOverlayCanvas.width, profileQrOverlayCanvas.height);
  overlayContext.drawImage(profileQr, 0, 0, profileQrOverlayCanvas.width, profileQrOverlayCanvas.height);
  profileQrOverlay.hidden = false;
});

profileQrOverlay?.addEventListener("click", () => {
  profileQrOverlay.hidden = true;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && profileQrOverlay && !profileQrOverlay.hidden) {
    profileQrOverlay.hidden = true;
  }
});

document.querySelectorAll("[data-copy-engine-address]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!engine.address) {
      appendEngineLog("Copy failed: no wallet loaded.");
      return;
    }
    try {
      await copyTextToClipboard(engine.address);
      appendEngineLog("Copied current wallet address.");
      showCopyToast("Address copied");
    } catch (error) {
      appendEngineLog(`Copy failed: ${error.message}`);
      showCopyToast("Copy failed");
    }
  });
});

const hasSavedAccounts = loadSavedAccounts().length > 0;
if (localStorage.getItem(SESSION_LOGGED_OUT_KEY) === "true" || !hasSavedAccounts) {
  localStorage.setItem(SESSION_LOGGED_OUT_KEY, "true");
  showLoggedOutScreen();
} else {
  hideLoggedOutScreen();
  renderChats();
  restoreLastAppTab();
}
updateWalletUi();
updateServiceSummary();
appendEngineLog("Step 75: fixed signed-out account dialog layering; account logic remains Step 73.");
renderTransportReadiness();

window.addEventListener("beforeunload", () => {
  try {
    if (engine.privateKeyHex) persistTestingWallet();
    persistState();
    // Best-effort: start the pending IndexedDB write NOW instead of waiting
    // out the debounce the page is about to tear down.
    flushChatStorage();
  } catch (error) { console.error(error); }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    try {
      if (engine.privateKeyHex) persistTestingWallet();
      persistState();
      flushChatStorage();
    } catch (error) { console.error(error); }
    return;
  }
  refreshBalanceOnly({ quiet: true });
  refreshAllConversations({ quiet: true });
});

// Step 50: start independent services in parallel. Rusty Kaspa gates wallet restore and RPC,
// while the Kasia cipher loads independently so a slow public node cannot hold messaging startup hostage.
queueMicrotask(async () => {
  setStatus("Starting KaChat services…");
  setService(runtimeIndicator, runtimeStatus, "busy", "Loading Rusty Kaspa…");
  setService(messagingIndicator, messagingStatus, "busy", "Loading encryption runtime…");
  setArchitectureBadge(networkBadge, "", "Waiting");
  setArchitectureBadge(messagingBadge, "busy", "Starting");

  const wasmTask = (async () => {
    if (!engine.kaspa) await engine.loadWasm();
    appendEngineLog(`WASM loaded ${engine.version() || ""}`);
    setService(runtimeIndicator, runtimeStatus, "ready", `Rusty Kaspa ${engine.version?.() || "ready"}`);
    return true;
  })();

  const cipherTask = (async () => {
    if (!engine.isKasiaCipherLoaded?.()) await engine.loadKasiaCipher();
    appendEngineLog("Kasia cipher loaded.");
    setService(messagingIndicator, messagingStatus, "ready", "Encryption runtime ready");
    setArchitectureBadge(messagingBadge, "ready", "Ready");
    return true;
  })();

  const [wasmResult, cipherResult] = await Promise.allSettled([wasmTask, cipherTask]);
  const wasmReady = wasmResult.status === "fulfilled";
  const cipherReady = cipherResult.status === "fulfilled";

  if (!wasmReady) {
    appendEngineLog(`WASM failed: ${wasmResult.reason?.message || wasmResult.reason}`);
    setService(runtimeIndicator, runtimeStatus, "error", "Rusty Kaspa failed to load");
  }
  if (!cipherReady) {
    appendEngineLog(`Cipher failed: ${cipherResult.reason?.message || cipherResult.reason}`);
    setService(messagingIndicator, messagingStatus, "error", "Kasia cipher failed to load");
    setArchitectureBadge(messagingBadge, "error", "Error");
  }

  if (wasmReady) {
    const restored = restorePersistedTestingWallet();
    updateWalletUi();
    updateServiceSummary();
    if (restored) {
      await connectAndRefresh({ quiet: true });
    } else if (!engine.address && loggedOutScreen && loggedOutScreen.hidden) {
      // Wallet wasn't restored (e.g. "Keep me signed in" is off) — fall back to
      // the sign-in screen instead of an empty main app.
      showLoggedOutScreen();
    }
  }

  if (wasmReady && engine.address) {
    await refreshBalanceOnly({ quiet: true });
    if (cipherReady) await refreshAllConversations({ quiet: true });
    startAutomaticRefresh();
  }

  initKaPosts({
    engine,
    escapeHtml,
    shortAddress,
    accountScopedKey,
    isChattingBalanceZero,
    showFundingGate: showFundingGateModal,
    showToast: showCopyToast,
    appendEngineLog,
    explorerTxUrl,
  });

  initBroadcasts({
    engine,
    escapeHtml,
    shortAddress,
    accountScopedKey,
    isChattingBalanceZero,
    showFundingGate: showFundingGateModal,
    showToast: showCopyToast,
    appendEngineLog,
    // Link previews: the exact same renderers as 1:1 bubbles (linkify + the
    // progressive Nextcloud video→audio→img→attachment probe).
    renderTextWithLinks,
    buildLinkPreviewCard,
    isPreviewableUrl,
    // Voice notes: same MediaRecorder wrapper + Nextcloud upload as the 1:1 composer.
    createVoiceRecorder,
    formatRecordingTime,
    isNextcloudMediaSendActive,
    uploadNextcloudMedia,
    // Reactions: identical wire parser and fixed tapback set across all clients.
    parseReactionEnvelope,
    quickReactionEmojis: QUICK_REACTION_EMOJIS,
  });

  initPortfolio({ engine, escapeHtml, accountScopedKey, showToast: showCopyToast });
  initColdStorage({
    engine, escapeHtml, shortAddress, accountScopedKey,
    showToast: showCopyToast, appendEngineLog,
    explorerAddressUrl, explorerTxUrl,
    txDirectionForAddress: manageAddressTxDirection,
    // Fiat toggle in the send flow: live KAS price in the user's selected currency,
    // plus the same symbol/format helpers the manage-address send screen uses.
    fetchKasPrice: () => fetchKasPrice(selectedCurrency),
    currencySymbol: () => currencyMeta().symbol.trim(),
    currencyCode: () => selectedCurrency.toUpperCase(),
    formatFiatValue,
  });
  initSwaps({ engine, escapeHtml, accountScopedKey, showToast: showCopyToast, appendEngineLog });
  initNextcloud({
    accountScopedKey, escapeHtml, appendEngineLog,
    showToast: showCopyToast,
    getActiveConversationId: () => activeConversationId,
    queueConversationMessage,
    // "Send from Nextcloud" staging: the picked file's share link lands in the composer for
    // review instead of auto-sending — the user presses send themselves.
    stageComposerText: (text) => {
      activateComposerMode("message");
      const input = composer?.elements?.message;
      if (!input) return;
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    },
    // The backup payload is the desktop's own persisted state (conversations + contacts +
    // message history), NOT the iOS archive schema — hence the platform-distinct filename.
    exportBackupPayload: () => JSON.stringify({
      kind: "kachat-desktop-backup",
      version: 1,
      savedAt: new Date().toISOString(),
      state: JSON.parse(chatStorageGetSync(accountScopedKey(STORAGE_KEY)) || "null"),
      history: JSON.parse(chatStorageGetSync(accountScopedKey(MESSAGE_HISTORY_KEY)) || "null"),
    }),
    importBackupPayload: (json) => {
      const parsed = JSON.parse(json);
      if (parsed?.kind !== "kachat-desktop-backup" || !parsed.state) {
        throw new Error("That file is not a KaChat desktop backup.");
      }
      // Write-through the same storage the live persist path uses (IndexedDB
      // cache when available, localStorage fallback otherwise), then reload
      // synchronously from that cache.
      const serialized = JSON.stringify(parsed.state);
      chatStorageSetSync(accountScopedKey(STORAGE_KEY), serialized);
      chatStorageSetSync(accountScopedKey(STATE_BACKUP_KEY), serialized);
      if (parsed.history) {
        chatStorageSetSync(accountScopedKey(MESSAGE_HISTORY_KEY), JSON.stringify(parsed.history));
      }
      reloadStateFromBrowserStorage();
      renderChats();
    },
    // Phone (iOS/Android) `kachat-backup.json` found in the same folder:
    // merged into the desktop conversations, never a state replace.
    importPhoneArchive: importPhoneChatArchive,
  });

  // Per-account dock prefs may differ from the pre-login defaults rendered at load.
  reloadDockPrefsForAccount();
  window.setTimeout(maybeShowDockWizard, 1200);

  reloadStateFromBrowserStorage();
  reconcileEstablishedRelationships();
  if (activeConversationId) {
    const active = state.conversations.find((entry) => entry.id === activeConversationId);
    if (active) renderMessages(active);
  } else {
    renderChats();
  }

  setStatus(wasmReady ? "Services ready" : "Open Diagnostics for setup help");
  updateServiceSummary();
});
