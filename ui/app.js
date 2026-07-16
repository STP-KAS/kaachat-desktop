import { KaspaEngine } from "../engine/index.js";
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
const BALANCE_REFRESH_MS = 15000;
const MESSAGE_REFRESH_MS = 5000;
const TRANSPORT_MODE_KEY = "kachat-shell-step25-transport-mode";
const ONCHAIN_AMOUNT_KEY = "kachat-shell-step26-onchain-amount";
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
let transportMode = localStorage.getItem(TRANSPORT_MODE_KEY) === "onchain" ? "onchain" : "preview";
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

function upsertSavedAccount({ address, privateKeyHex, mnemonic = "", derivationPath = "", wordCount = 0, name, createdAt, savedAt = new Date().toISOString() }) {
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
    derivationPath: String(account.derivationPath || ""),
    wordCount: Number(account.wordCount || 0),
    address: account.address,
    savedAt: account.savedAt || new Date().toISOString(),
  }));
  localStorage.removeItem(SESSION_LOGGED_OUT_KEY);
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
    signInButton.addEventListener("click", () => {
      try {
        activateSavedAccount(account.address);
        location.reload();
      } catch (error) {
        showCopyToast(error.message);
      }
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "saved-account-delete";
    deleteButton.setAttribute("aria-label", `Remove ${account.name} from this device`);
    deleteButton.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>`;
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openSavedAccountDelete(account);
    });

    row.append(signInButton, deleteButton);
    savedAccountList.append(row);
  }
}

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

const screens = document.querySelectorAll("[data-screen]");
const tabButtons = document.querySelectorAll("[data-tab]");
const searchWrap = document.querySelector("[data-search-wrap]");
const headerNewMessageButton = document.querySelector(".chat-toolbar .js-open-contact");
const serviceHealthButton = document.querySelector("[data-service-health-button]");
const serviceHealthLed = document.querySelector("[data-service-health-led]");
let latestServiceStatusText = "Starting services";
const toolbarBalance = document.querySelector("[data-toolbar-balance]");
const toolbarBalanceValue = document.querySelector("[data-toolbar-balance-value]");
const profileAddress = document.querySelector("[data-profile-address]");
const profileBalance = document.querySelector("[data-profile-balance]");
const profileInitial = document.querySelector("[data-profile-initial]");
const profileQr = document.querySelector("[data-profile-qr]");
const profileQrCard = document.querySelector("[data-profile-qr-card]");
const profileQrOverlay = document.querySelector("[data-profile-qr-overlay]");
const profileQrOverlayCanvas = document.querySelector("[data-profile-qr-overlay-canvas]");
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
const onchainToggle = document.querySelector("[data-onchain-toggle]");
const transportPill = document.querySelector("[data-transport-pill]");
const onchainAmountInput = document.querySelector("[data-onchain-amount]");
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

const chatContent = document.querySelector(".chat-content");
const emptyState = document.querySelector("[data-empty-state]");
const chatList = document.querySelector("[data-chat-list]");
const conversation = document.querySelector("[data-conversation]");
const conversationName = document.querySelector("[data-conversation-name]");
const conversationAddress = document.querySelector("[data-conversation-address]");
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
const composerModeButtons = Array.from(document.querySelectorAll("[data-composer-mode]"));
const availableBalanceBanner = document.querySelector("[data-available-balance-banner]");
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

function persistTestingWallet({ mnemonic = "", derivationPath = "", wordCount = 0 } = {}) {
  const privateKeyHex = String(engine.privateKeyHex || "").trim();
  if (!privateKeyHex) throw new Error("Wallet private key was unavailable for browser storage.");
  const address = String(engine.address || "").trim();
  const meta = activeAccountMetadata();
  const existingAccount = loadSavedAccounts().find((entry) => entry.address === address);
  const payload = {
    version: 3,
    privateKeyHex,
    mnemonic: String(mnemonic || existingAccount?.mnemonic || ""),
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
  const privateKeyHex = getStoredTestingWalletHex();
  if (!privateKeyHex) {
    appendEngineLog("No persistent testing wallet was found in this browser origin.");
    return false;
  }

  try {
    const wallet = engine.importPrivateKey(privateKeyHex);
    persistTestingWallet();
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
  if (contact.relationshipState !== "outgoing-request") return false;

  const reciprocalMessage = (conversationEntry.messages || []).find((message) =>
    message?.direction === "incoming" &&
    message?.messageType !== "handshake" &&
    String(message?.sender || "") === String(contact.address || "") &&
    String(message?.text || "").trim().length > 0
  );
  if (!reciprocalMessage) return false;

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
    const raw = localStorage.getItem(accountScopedKey(STORAGE_KEY));
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
        localStorage.setItem(accountScopedKey(STORAGE_KEY), JSON.stringify(migrated));
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
    const parsed = JSON.parse(localStorage.getItem(accountScopedKey(MESSAGE_HISTORY_KEY)) || "{}");
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
    const backup = JSON.parse(localStorage.getItem(accountScopedKey(STATE_BACKUP_KEY)) || "null");
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
    activeConversationId = null;
  }
  return state;
}

function persistState() {
  const serialized = JSON.stringify(state);
  localStorage.setItem(accountScopedKey(STORAGE_KEY), serialized);
  localStorage.setItem(accountScopedKey(STATE_BACKUP_KEY), serialized);
  const history = Object.fromEntries((state.conversations || []).map((entry) => [entry.id, entry.messages || []]));
  localStorage.setItem(accountScopedKey(MESSAGE_HISTORY_KEY), JSON.stringify(history));
  const verified = localStorage.getItem(accountScopedKey(STORAGE_KEY));
  if (verified !== serialized) throw new Error("Local conversation storage verification failed.");
}

function activateWalletDataScope(address, { migrateLegacy = true } = {}) {
  const clean = String(address || "").trim();
  if (!clean) {
    state = { contacts: [], conversations: [] };
    activeConversationId = null;
    return state;
  }

  const scopedStateKey = accountScopedKey(STORAGE_KEY, clean);
  if (migrateLegacy && !localStorage.getItem(scopedStateKey)) {
    const legacy = localStorage.getItem(STORAGE_KEY);
    if (legacy) {
      localStorage.setItem(scopedStateKey, legacy);
      const legacyBackup = localStorage.getItem(STATE_BACKUP_KEY);
      const legacyHistory = localStorage.getItem(MESSAGE_HISTORY_KEY);
      if (legacyBackup) localStorage.setItem(accountScopedKey(STATE_BACKUP_KEY, clean), legacyBackup);
      if (legacyHistory) localStorage.setItem(accountScopedKey(MESSAGE_HISTORY_KEY, clean), legacyHistory);
      appendEngineLog(`Migrated existing chats into wallet scope ${shortAddress(clean)}.`);
    }
  }

  activeConversationId = null;
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
  const raw = String(onchainAmountInput?.value || "0.2").trim();
  return raw || "0.2";
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

function openMessageDetails(messageId) {
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const message = conversationEntry?.messages.find((entry) => entry.id === messageId);
  if (!message || !messageDetailsModal) return;
  activeMessageActionId = messageId;
  if (messageDetailsBody) messageDetailsBody.textContent = message.text || "Message";
  messageDetailsModal.hidden = false;
}

function conversationPreview(conversationEntry) {
  const contact = contactForConversation(conversationEntry);
  const last = lastMessageFor(conversationEntry);
  if (!last) return shortAddress(contact?.address || "");
  const prefix = last.direction === "outgoing" ? "You: " : "";
  return `${prefix}${last.text}`;
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

  const connection = engine.connectionSnapshot?.() || {};
  const subscription = engine.subscriptionSnapshot?.() || { status: "idle", active: false };
  const runtimeReady = Boolean(engine.kaspa);
  const walletReady = Boolean(engine.address);
  const cipherReady = engine.isKasiaCipherLoaded?.() === true;
  const primaryReady = Boolean(engine.rpc) && connection.primary === "ready";
  const standbyReady = Boolean(engine.standbyRpc) && connection.standby === "ready";
  const subscriptionReady = subscription.status === "ready" && subscription.active;
  const failoverBusy = connection.failover && connection.failover !== "idle";
  const criticalError = [runtimeIndicator, networkIndicator, messagingIndicator, subscriptionIndicator].some((indicator) => indicator?.classList.contains("error"))
    || (!engine.rpc && connection.primary === "error")
    || connection.failover === "failed";

  let stateName = "busy";
  if (criticalError) stateName = "error";
  else if (runtimeReady && walletReady && cipherReady && primaryReady && standbyReady && subscriptionReady && !failoverBusy) stateName = "ready";

  serviceHealthLed.classList.remove("ready", "busy", "error");
  serviceHealthLed.classList.add(stateName);
  if (serviceHealthButton) {
    const stateLabel = stateName === "ready"
      ? "Primary, standby, Kasia, and live wallet subscription healthy"
      : stateName === "error"
        ? "Connection, runtime, or subscription error"
        : primaryReady
          ? "RPC connected; standby or live subscription still becoming ready"
          : "Services starting or reconnecting";
    serviceHealthButton.setAttribute("aria-label", `${stateLabel}. Open Settings`);
    serviceHealthButton.title = stateLabel;
  }
}

function setStatus(text) {
  latestServiceStatusText = String(text || "Service status");
  updateGlobalHealthIndicator();
  renderTransportReadiness();
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
  const indexerUrl = indexerUrlInput?.value?.trim() || "https://indexer.kasia.fyi";
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
    addMessageToConversation(conversationEntry, message);
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
      addMessageToConversation(conversationEntry, message);
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
    if (!contact) {
      const createdAt = Number(request.createdAt || Date.now());
      const displayName = request.alias || shortAddress(request.sender);
      contact = {
        id: nowId(), name: displayName, address: request.sender, avatar: initialsFor(displayName),
        createdAt, updatedAt: createdAt, relationshipState: "incoming-request", handshakeTxid: "",
        incomingHandshakeTxid: request.txid, peerConversationId: request.conversationId || "",
      };
      conversationEntry = createConversation({ contactId: contact.id, createdAt });
      state.contacts.push(contact);
      state.conversations.push(conversationEntry);
    } else {
      const wasOutgoingRequest = contact.relationshipState === "outgoing-request";
      contact.incomingHandshakeTxid = request.txid;
      contact.peerConversationId = request.conversationId || contact.peerConversationId || "";
      if (wasOutgoingRequest) {
        contact.relationshipState = "established";
        for (const existingMessage of conversationEntry?.messages || []) {
          if (existingMessage.messageType === "handshake" && existingMessage.direction === "outgoing" && existingMessage.status !== MESSAGE_STATUSES.FAILED) {
            applyMessagePatch(existingMessage, { status: MESSAGE_STATUSES.CONFIRMED, note: "Reciprocal handshake received", confirmations: Math.max(1, Number(existingMessage.confirmations || 0)) });
          }
        }
      } else if (contact.relationshipState !== "established") {
        contact.relationshipState = "incoming-request";
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
        text: "Communication request received", sender: request.sender, receiver: engine.address,
        status: MESSAGE_STATUSES.CONFIRMED, transport: "kasia-indexer", createdAt: Number(request.createdAt || Date.now()),
      });
      applyMessagePatch(message, {
        txid: request.txid, messageType: "handshake", protocol: "kasia", protocolVersion: 1,
        payloadHex: request.payloadHex || "", encryptedHex: request.encryptedHex || "",
        daaScore: request.daaScore || null, acceptingBlock: request.acceptingBlock || null, confirmations: 1,
        note: "Incoming communication request",
      });
      addMessageToConversation(conversationEntry, message);
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
  if (onchainToggle) onchainToggle.checked = transportMode === "onchain";
  if (transportPill) transportPill.textContent = transportMode === "onchain" ? "On-chain" : "Preview";
  const items = [
    { label: "Engine message facade", ready: typeof engine.createMessageEnvelope === "function" && typeof engine.sendMessagePreview === "function" },
    { label: "Kasia COMM protocol builder", ready: typeof engine.buildCommMessage === "function", note: "matched wire container" },
    { label: "Official Kasia cipher WASM", ready: engine.isKasiaCipherLoaded?.() === true, note: engine.isKasiaCipherLoaded?.() ? "loaded / encrypted direct messages" : "run setup:cipher, then load" },
    { label: "Rusty Kaspa WASM loaded", ready: Boolean(engine.kaspa) },
    { label: "Session wallet loaded", ready: Boolean(engine.address) },
    { label: "Mainnet RPC connected", ready: Boolean(engine.rpc) },
    { label: "Live wallet and contact UTXO subscriptions", ready: engine.subscriptionSnapshot?.().status === "ready", note: `${engine.subscriptionSnapshot?.().contactCount || 0} contacts · ${engine.subscriptionSnapshot?.().status || "idle"}` },
    { label: "Real on-chain payload transport", ready: typeof engine.sendMessageOnchain === "function", note: transportMode === "onchain" ? "enabled / 0.2 KAS default" : "available" },
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

function showTab(tabName, { renderChatsList = true } = {}) {
  screens.forEach((screen) => {
    screen.hidden = screen.dataset.screen !== tabName;
  });

  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("active", isActive);
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  searchWrap.hidden = tabName !== "chats";
  if (headerNewMessageButton) headerNewMessageButton.hidden = tabName === "settings" || tabName === "profile";
  if (tabName === "chats" && renderChatsList) renderChats();
  if (tabName === "profile") drawProfileQr();
  if (tabName === "settings") renderTransportReadiness();
}

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
  renderSavedAccounts();
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

function updateWalletUi() {
  const address = engine.address;
  const meta = activeAccountMetadata();
  const accountName = meta?.name || (address ? "Current Account" : "No Active Account");
  if (toolbarBalanceValue) toolbarBalanceValue.textContent = `${currentBalanceKas} KAS`;
  else toolbarBalance.textContent = `${currentBalanceKas} KAS`;
  if (profileBalance) profileBalance.textContent = `${currentBalanceKas} KAS`;
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
  if (profileQrCard) profileQrCard.hidden = !address;
  drawProfileQr();
}

async function drawProfileQr() {
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

function updateCreateChatAddState() {
  if (!createChatAddButton || !contactAddressInput) return;
  const raw = String(contactAddressInput.value || "").trim();
  let enabled = false;
  if (raw) {
    if (/^[a-z0-9][a-z0-9.-]*\.kas$/i.test(raw)) {
      enabled = true;
    } else if (engine.kaspa) {
      try {
        validateContactAddress(raw);
        enabled = true;
      } catch {}
    } else {
      enabled = raw.startsWith("kaspa:") && raw.length > 20;
    }
  }
  createChatAddButton.disabled = !enabled;
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

  addMessageToConversation(conversationEntry, message);
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

function renderChats() {
  // Keep one stable in-memory state object during the session. Browser storage is
  // for startup/recovery only; reloading it here used to replace live conversation
  // references and make message history disappear until another mutation rerendered it.
  activeConversationId = null;
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

  conversation.hidden = true;

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
      return `
        <button class="chat-row" type="button" data-conversation-id="${escapeHtml(conversationEntry.id)}">
          <span class="chat-avatar">${escapeHtml(initialsFor(contact.name))}</span>
          <span class="chat-meta">
            <strong>${escapeHtml(contact.name)}</strong>
            <span>${escapeHtml(preview)}</span>
          </span>
          <span class="chat-side">
            <small>${escapeHtml(time)}</small>
            ${conversationEntry.unreadCount > 0 ? `<b class="unread-badge">${conversationEntry.unreadCount}</b>` : ``}
          </span>
        </button>
      `;
    })
    .join("");
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

  for (const message of messages) {
    const row = document.createElement("div");
    row.className = `message-row ${message.direction === "incoming" ? "incoming" : "local"}`;

    const selector = document.createElement("span");
    selector.className = "message-selector";
    selector.setAttribute("aria-hidden", "true");
    selector.innerHTML = '<svg viewBox="0 0 20 20"><path d="m5.1 10.1 3.1 3.1 6.7-7"/></svg>';

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

    const text = document.createElement("span");
    text.className = "message-text";
    text.textContent = message.text;

    bubble.append(text);
    const deliveryIcon = createDeliveryStatusIcon(message);
    row.append(selector, bubble);
    if (deliveryIcon) row.append(deliveryIcon);
    messageArea.appendChild(row);
  }

  messageArea.scrollTop = messageArea.scrollHeight;
}

function openConversation(conversationId) {
  messageSelectionMode = false;
  selectedMessageIds.clear();
  updateSelectionUi();

  // Switch to the Chats screen without rendering the list. renderChats() reloads
  // browser storage and replaces the global state object, which previously made
  // this function keep rendering an obsolete conversation reference. That stale
  // reference is why history appeared only after sending a message forced a new render.
  showTab("chats", { renderChatsList: false });

  // The shared viewport may still hold a Settings/Profile scroll offset. Reset
  // it before the thread switches to its own internal message scroller.
  if (chatContent) chatContent.scrollTop = 0;

  // Use the existing canonical in-memory state. Replacing state from localStorage
  // during navigation invalidated live conversation references and caused blank chats.
  activeConversationId = conversationId;
  const conversationEntry = state.conversations.find((entry) => entry.id === activeConversationId);
  const contact = contactForConversation(conversationEntry);
  if (!conversationEntry || !contact) {
    activeConversationId = null;
    renderChats();
    return;
  }

  hydrateConversationMessages(conversationEntry);
  conversationEntry.unreadCount = 0;
  persistState();

  emptyState.hidden = true;
  chatList.hidden = true;
  conversation.hidden = false;
  searchWrap.hidden = true;
  conversationName.textContent = contact.name;
  if (conversationAddress) conversationAddress.textContent = contact.address;
  if (syncStatus) syncStatus.textContent = syncLabel(conversationEntry);
  renderMessages(conversationEntry);
  activateComposerMode("message");
  window.setTimeout(() => composer.elements.message?.focus(), 0);
}

function addContact({ name, address, relationshipState = "legacy-manual" }) {
  const createdAt = Date.now();
  const contact = {
    id: nowId(),
    name: name.trim(),
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
    text: accepting ? "Communication request accepted" : "Communication request sent",
    sender: engine.address,
    receiver: contact.address,
    status: MESSAGE_STATUSES.PENDING,
    transport: "onchain",
    createdAt,
  });
  applyMessagePatch(message, { messageType: "handshake", protocol: "kasia", transport: "onchain" });
  addMessageToConversation(conversationEntry, message);
  persistState();
  renderMessages(conversationEntry);
  try {
    await ensureRuntimes({ quiet: true });
    if (!engine.address) throw new Error("Generate or import a wallet before starting a new conversation.");
    const localAlias = String(activeAccountMetadata()?.name || "KaChat").trim() || "KaChat";
    const envelope = await engine.createEncryptedHandshakeEnvelope({
      conversationId: conversationEntry.id,
      contactId: contact.id,
      toAddress: contact.address,
      fromAddress: engine.address,
      alias: localAlias,
      isResponse: accepting,
      createdAt,
    });
    updateMessageStatus(conversationEntry.id, message.id, { status: MESSAGE_STATUSES.SIGNING, protocolString: envelope.protocolString, payloadHex: envelope.payloadHex, payloadBytes: envelope.payloadBytes });
    const result = await engine.sendHandshakeOnchain({
      envelope,
      // A response handshake is identified by its encrypted payload, not by a
      // required 0.2 KAS value. Use a small carrier amount so the 0.2 KAS
      // received with the original request can fund the response plus fees.
      amountKas: accepting ? "0.0001" : onchainAmountKas(),
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

document.querySelectorAll(".js-open-contact").forEach((button) => {
  button.addEventListener("click", showContactModal);
});

document.querySelectorAll("[data-close-contact]").forEach((button) => {
  button.addEventListener("click", closeContactModal);
});

document.querySelectorAll("[data-open-tab]").forEach((button) => {
  button.addEventListener("click", () => showTab(button.dataset.openTab));
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => showTab(button.dataset.tab));
});

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
    if (/^[a-z0-9][a-z0-9.-]*\.kas$/i.test(rawAddress)) {
      throw new Error("KNS resolution is not connected in this desktop build yet. Enter a kaspa: address.");
    }
    await ensureRuntimes({ quiet: true });
    const address = validateContactAddress(rawAddress);
    if (!engine.address) throw new Error("Generate or import a wallet before starting a new conversation.");
    const displayName = name || shortAddress(address);
    const existing = state.contacts.find((contact) => contact.address === address);
    if (existing) {
      const existingConversation = state.conversations.find((entry) => entry.contactId === existing.id);
      closeContactModal();
      if (existingConversation) openConversation(existingConversation.id);
      return;
    }
    const createdAt = Date.now();
    const contact = {
      id: nowId(), name: displayName, address, avatar: initialsFor(displayName), createdAt, updatedAt: createdAt,
      relationshipState: "outgoing-request", handshakeTxid: "",
    };
    const conversationEntry = createConversation({ contactId: contact.id, createdAt });
    state.contacts.push(contact);
    state.conversations.push(conversationEntry);
    persistState();
    closeContactModal();
    openConversation(conversationEntry.id);
    await sendOutgoingHandshake(contact, conversationEntry);
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
  openConversation(row.dataset.conversationId);
});

document.querySelector("[data-back-to-chats]").addEventListener("click", () => showTab("chats"));

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

  addMessageToConversation(conversationEntry, message);
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
    const indexerUrl = indexerUrlInput?.value?.trim() || "https://indexer.kasia.fyi";
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
      addMessageToConversation(conversationEntry, message);
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
      await copyTextToClipboard(message.text || "");
      closeMessageDetails();
      showCopyToast("Message copied");
    } else if (action === "copy-raw") {
      await copyTextToClipboard(rawMessageText(message));
      closeMessageDetails();
      showCopyToast("Raw data copied");
    } else if (action === "export") {
      closeMessageDetails();
      activeMessageActionId = message.id;
      openExportChoice();
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
  if (!document.querySelector('[data-screen="chats"]').hidden && activeConversationId !== conversationId) renderChats();
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
    const envelope = transportMode === "onchain"
      ? await engine.createEncryptedMessageEnvelope(envelopeDetails)
      : engine.createMessageEnvelope(envelopeDetails);

    updateMessageStatus(conversationId, messageId, { status: transportMode === "onchain" ? MESSAGE_STATUSES.SIGNING : MESSAGE_STATUSES.PENDING });
    const sender = transportMode === "onchain" ? engine.sendMessageOnchain.bind(engine) : engine.sendMessagePreview.bind(engine);
    await sender({
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
  const message = createMessage({
    conversationId: conversationEntry.id,
    contactId: conversationEntry.contactId,
    direction: "outgoing",
    text,
    sender: engine.address || null,
    receiver: contact?.address || null,
    status: MESSAGE_STATUSES.PENDING,
    transport: transportMode,
    createdAt,
  });
  addMessageToConversation(conversationEntry, message);

  persistState();
  renderMessages(conversationEntry);
  setStatus(transportMode === "onchain" ? "Queued for real Kaspa payload transaction" : "Queued through KaspaEngine Kasia preview transport");
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
    `https://api.kaspa.org/transactions/${encodeURIComponent(txid)}?resolve_previous_outpoints=light`,
    `https://api.kaspa.org/addresses/${encodeURIComponent(recipientAddress)}/full-transactions?limit=100&offset=0&resolve_previous_outpoints=light`,
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
    addMessageToConversation(conversationEntry, message);
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

composerModeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.composerMode;
    closeComposerMenu();
    if (mode === "message") {
      activateComposerMode("message");
    } else if (mode === "kas") {
      activateComposerMode("kas");
    } else if (mode === "photo") {
      setComposerHint("Photo sending — coming next");
      setStatus("Photo control selected");
    } else if (mode === "voice") {
      setComposerHint("Voice recording — desktop capture coming next");
      setStatus("Voice recording mode selected");
    }
  });
});

document.addEventListener("click", (event) => {
  if (!composerPlusMenu || composerPlusMenu.hidden) return;
  if (composerPlusMenu.contains(event.target) || composerPlusButton?.contains(event.target)) return;
  closeComposerMenu();
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeConversationId) return;

  const input = composer.elements.message;
  const text = String(input.value || "").trim();
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
  queueConversationMessage(activeConversationId, text);
});


if (onchainToggle) {
  onchainToggle.checked = transportMode === "onchain";
  onchainToggle.addEventListener("change", () => {
    transportMode = onchainToggle.checked ? "onchain" : "preview";
    localStorage.setItem(TRANSPORT_MODE_KEY, transportMode);
    setStatus(transportMode === "onchain" ? "On-chain message transport enabled" : "Preview message transport enabled");
    renderTransportReadiness();
  });
}

if (onchainAmountInput) {
  onchainAmountInput.value = localStorage.getItem(ONCHAIN_AMOUNT_KEY) || onchainAmountInput.value || "0.2";
  onchainAmountInput.addEventListener("input", () => {
    localStorage.setItem(ONCHAIN_AMOUNT_KEY, onchainAmountInput.value.trim());
  });
}

if (indexerUrlInput) {
  indexerUrlInput.value = localStorage.getItem(INDEXER_URL_KEY) || indexerUrlInput.value || "https://indexer.kasia.fyi";
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
  showLoggedOutScreen();
}

document.querySelectorAll("[data-open-account-manager]").forEach((button) => {
  const label = button.textContent?.trim().toLowerCase() || "";
  button.addEventListener("click", () => {
    if (label.includes("add") || button.classList.contains("profile-account-add")) openCreateAccountModal();
    else openSavedAccounts();
  });
});

document.querySelector("[data-open-profile-account]")?.addEventListener("click", () => showTab("profile"));

const createAccountModal = document.querySelector("[data-create-account-modal]");
const createAccountForm = document.querySelector("[data-create-account-form]");
const createAccountError = document.querySelector("[data-create-account-error]");
const createAccountSubmit = document.querySelector("[data-submit-create-account]");
const recoveryModal = document.querySelector("[data-recovery-modal]");
const recoveryPhraseBox = document.querySelector("[data-recovery-phrase]");
const revealRecoveryButton = document.querySelector("[data-reveal-recovery]");
const recoveryProgressFill = document.querySelector("[data-recovery-progress]");
const copyRecoveryButton = document.querySelector("[data-copy-recovery]");

function openCreateAccountModal() {
  if (createAccountError) { createAccountError.hidden = true; createAccountError.textContent = ""; }
  if (createAccountForm?.elements?.accountName) createAccountForm.elements.accountName.value = "My Account";
  if (createAccountModal) createAccountModal.hidden = false;
  queueMicrotask(() => createAccountForm?.elements?.accountName?.focus());
}
function closeCreateAccountModal() {
  if (createAccountModal) createAccountModal.hidden = true;
  if (!engine.address || localStorage.getItem(SESSION_LOGGED_OUT_KEY) === "true") showLoggedOutScreen();
}
document.querySelectorAll("[data-close-create-account]").forEach((button) => button.addEventListener("click", closeCreateAccountModal));
createAccountModal?.addEventListener("click", (event) => { if (event.target === createAccountModal) closeCreateAccountModal(); });

async function createAndEnterNewAccount({ name, wordCount }) {
  if (!engine.kaspa) await ensureRuntimes();
  const cleanName = String(name || "").trim();
  const count = Number(wordCount);
  if (!cleanName) throw new Error("Enter an account name.");
  if (![12, 24].includes(count)) throw new Error("Choose a 12 or 24 word seed phrase.");

  const wallet = engine.generateMnemonicWallet(count);
  if (!wallet?.privateKeyHex || !wallet?.address?.startsWith("kaspa:") || !wallet?.mnemonic) {
    engine.clearSession();
    throw new Error("Wallet generation did not produce a valid mainnet identity.");
  }
  const words = wallet.mnemonic.split(/\s+/).filter(Boolean);
  if (words.length !== count) {
    engine.clearSession();
    throw new Error(`Expected ${count} recovery words but generated ${words.length}.`);
  }

  const createdAt = new Date().toISOString();
  let metadata = {};
  try { metadata = JSON.parse(localStorage.getItem(ACCOUNT_SHELL_META_KEY) || "{}"); } catch {}
  metadata[wallet.address] = { name: cleanName, createdAt };
  localStorage.setItem(ACCOUNT_SHELL_META_KEY, JSON.stringify(metadata));

  activateWalletDataScope(wallet.address, { migrateLegacy: false });
  state = { contacts: [], conversations: [] };
  persistState();
  persistTestingWallet({ mnemonic: wallet.mnemonic, derivationPath: wallet.derivationPath, wordCount: count });

  const saved = loadSavedAccounts().find((entry) => entry.address === wallet.address);
  if (!saved?.privateKeyHex || !saved?.mnemonic || saved?.name !== cleanName) {
    engine.clearSession();
    throw new Error("The new account could not be verified after saving.");
  }

  localStorage.removeItem(SESSION_LOGGED_OUT_KEY);
  hideLoggedOutScreen();
  currentBalanceKas = "--";
  updateWalletUi();
  updateServiceSummary();
  refreshSubscriptionAddresses({ restart: false });
  appendEngineLog(`Created ${count}-word account ${cleanName}: ${wallet.address}`);
  showTab("chats");
  void connectAndRefresh({ quiet: true }).catch((error) => {
    appendEngineLog(`Post-create RPC startup failed: ${error.message}`);
    setStatus(`Account created. Network connection failed: ${error.message}`);
  });
  return wallet;
}

createAccountForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = String(createAccountForm.elements.accountName?.value || "").trim();
  const wordCount = Number(createAccountForm.elements.wordCount?.value);

  if (!name) {
    if (createAccountError) { createAccountError.textContent = "Enter an account name."; createAccountError.hidden = false; }
    return;
  }
  if (![12, 24].includes(wordCount)) {
    if (createAccountError) { createAccountError.textContent = "Choose a 12 or 24 word seed phrase."; createAccountError.hidden = false; }
    return;
  }

  createAccountSubmit.disabled = true;
  if (createAccountError) { createAccountError.hidden = true; createAccountError.textContent = ""; }
  closeCreateAccountModal();
  showCopyToast("Creating account…");

  try {
    await createAndEnterNewAccount({ name, wordCount });
    showCopyToast("Account created");
  } catch (error) {
    appendEngineLog(`Create account failed: ${error.message}`);
    showLoggedOutScreen();
    openCreateAccountModal();
    if (createAccountForm?.elements?.accountName) createAccountForm.elements.accountName.value = name;
    const radio = createAccountForm?.querySelector(`input[name="wordCount"][value="${wordCount}"]`);
    if (radio) radio.checked = true;
    if (createAccountError) { createAccountError.textContent = error.message; createAccountError.hidden = false; }
  } finally {
    createAccountSubmit.disabled = false;
  }
});

const importAccountModal = document.querySelector("[data-import-account-modal]");
const importAccountForm = document.querySelector("[data-import-account-form]");
const importAccountError = document.querySelector("[data-import-account-error]");
const importAccountSubmit = document.querySelector("[data-submit-import-account]");

function openImportAccountModal() {
  if (importAccountError) { importAccountError.hidden = true; importAccountError.textContent = ""; }
  if (importAccountForm?.elements?.accountName) importAccountForm.elements.accountName.value = "Imported Account";
  if (importAccountForm?.elements?.recoveryPhrase) importAccountForm.elements.recoveryPhrase.value = "";
  if (importAccountModal) importAccountModal.hidden = false;
  queueMicrotask(() => importAccountForm?.elements?.recoveryPhrase?.focus());
}
function closeImportAccountModal() {
  if (importAccountModal) importAccountModal.hidden = true;
  if (!engine.address || localStorage.getItem(SESSION_LOGGED_OUT_KEY) === "true") showLoggedOutScreen();
}
document.querySelectorAll("[data-close-import-account]").forEach((button) => button.addEventListener("click", closeImportAccountModal));
importAccountModal?.addEventListener("click", (event) => { if (event.target === importAccountModal) closeImportAccountModal(); });

async function importAndEnterAccount({ name, recoveryPhrase }) {
  if (!engine.kaspa) await ensureRuntimes();
  const cleanName = String(name || "").trim();
  const cleanPhrase = String(recoveryPhrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!cleanName) throw new Error("Enter an account name.");
  const words = cleanPhrase.split(" ").filter(Boolean);
  if (![12, 24].includes(words.length)) throw new Error("Recovery phrase must contain exactly 12 or 24 words.");

  let wallet;
  try {
    wallet = engine.importMnemonic(cleanPhrase);
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
  persistTestingWallet({ mnemonic: wallet.mnemonic, derivationPath: wallet.derivationPath, wordCount: words.length });

  const saved = loadSavedAccounts().find((entry) => entry.address === wallet.address);
  if (!saved?.privateKeyHex || saved?.mnemonic !== cleanPhrase || saved?.name !== cleanName) {
    engine.clearSession();
    throw new Error("Imported account could not be verified after saving.");
  }

  localStorage.removeItem(SESSION_LOGGED_OUT_KEY);
  hideLoggedOutScreen();
  currentBalanceKas = "--";
  updateWalletUi();
  updateServiceSummary();
  refreshSubscriptionAddresses({ restart: false });
  appendEngineLog(`Imported ${words.length}-word account ${cleanName}: ${wallet.address}`);
  showTab("chats");
  void connectAndRefresh({ quiet: true }).catch((error) => {
    appendEngineLog(`Post-import RPC startup failed: ${error.message}`);
    setStatus(`Account imported. Network connection failed: ${error.message}`);
  });
  return wallet;
}

importAccountForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = String(importAccountForm.elements.accountName?.value || "").trim();
  const recoveryPhrase = String(importAccountForm.elements.recoveryPhrase?.value || "").trim().toLowerCase().replace(/\s+/g, " ");
  const wordCount = recoveryPhrase ? recoveryPhrase.split(" ").filter(Boolean).length : 0;

  if (!name) {
    if (importAccountError) { importAccountError.textContent = "Enter an account name."; importAccountError.hidden = false; }
    return;
  }
  if (![12, 24].includes(wordCount)) {
    if (importAccountError) { importAccountError.textContent = "Recovery phrase must contain exactly 12 or 24 words."; importAccountError.hidden = false; }
    return;
  }

  importAccountSubmit.disabled = true;
  if (importAccountError) { importAccountError.hidden = true; importAccountError.textContent = ""; }
  closeImportAccountModal();
  showCopyToast("Importing account…");

  try {
    await importAndEnterAccount({ name, recoveryPhrase });
    showCopyToast("Account imported");
  } catch (error) {
    appendEngineLog(`Import account failed: ${error.message}`);
    showLoggedOutScreen();
    openImportAccountModal();
    if (importAccountForm?.elements?.accountName) importAccountForm.elements.accountName.value = name;
    if (importAccountForm?.elements?.recoveryPhrase) importAccountForm.elements.recoveryPhrase.value = recoveryPhrase;
    if (importAccountError) { importAccountError.textContent = error.message; importAccountError.hidden = false; }
  } finally {
    importAccountSubmit.disabled = false;
  }
});

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
  if (copyRecoveryButton) copyRecoveryButton.hidden = false;
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
  if (copyRecoveryButton) copyRecoveryButton.hidden = true;
  if (revealRecoveryButton) revealRecoveryButton.hidden = false;
}
function openRecoveryModal() {
  const account = activeSavedAccountRecord();
  if (!account?.mnemonic) { showCopyToast("No recovery phrase stored for this account"); return; }
  resetRecoveryHold();
  if (recoveryPhraseBox) { recoveryPhraseBox.hidden = true; recoveryPhraseBox.textContent = ""; }
  if (copyRecoveryButton) copyRecoveryButton.hidden = true;
  if (revealRecoveryButton) revealRecoveryButton.hidden = false;
  if (recoveryModal) recoveryModal.hidden = false;
}
document.querySelectorAll("[data-close-recovery]").forEach((button) => button.addEventListener("click", closeRecoveryModal));
recoveryModal?.addEventListener("click", (event) => { if (event.target === recoveryModal) closeRecoveryModal(); });

revealRecoveryButton?.addEventListener("pointerdown", beginRecoveryHold);
revealRecoveryButton?.addEventListener("pointerup", cancelRecoveryHold);
revealRecoveryButton?.addEventListener("pointercancel", cancelRecoveryHold);
revealRecoveryButton?.addEventListener("lostpointercapture", cancelRecoveryHold);
revealRecoveryButton?.addEventListener("contextmenu", (event) => event.preventDefault());
revealRecoveryButton?.addEventListener("click", (event) => event.preventDefault());

copyRecoveryButton?.addEventListener("click", async () => {
  const account = activeSavedAccountRecord();
  if (!account?.mnemonic) return;
  await copyTextToClipboard(account.mnemonic);
  showCopyToast("Recovery phrase copied");
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
    closeLogoutModal();
    await engine.disconnect?.();
    engine.clearSession();
    activeConversationId = null;
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

const prefBindings = [
  ["[data-pref-save-account]", "saveAccount", true],
  ["[data-pref-keep-signed-in]", "keepSignedIn", true],
  ["[data-pref-estimate-fees]", "estimateFees", false],
  ["[data-pref-hide-payment-chats]", "hidePaymentChats", false],
  ["[data-pref-show-contact-balance]", "showContactBalance", true],
  ["[data-pref-store-messages]", "storeMessages", true],
];
prefBindings.forEach(([selector, key, fallback]) => {
  const input = document.querySelector(selector);
  if (!input) return;
  input.checked = accountShellPrefs[key] ?? fallback;
  input.addEventListener("change", () => { accountShellPrefs[key] = input.checked; persistAccountShellPreferences(); });
});

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

document.querySelector("[data-copy-engine-address]").addEventListener("click", async () => {
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

const hasSavedAccounts = loadSavedAccounts().length > 0;
if (localStorage.getItem(SESSION_LOGGED_OUT_KEY) === "true" || !hasSavedAccounts) {
  localStorage.setItem(SESSION_LOGGED_OUT_KEY, "true");
  showLoggedOutScreen();
} else {
  hideLoggedOutScreen();
  showTab("chats");
}
updateWalletUi();
updateServiceSummary();
appendEngineLog("Step 75: fixed signed-out account dialog layering; account logic remains Step 73.");
renderTransportReadiness();

window.addEventListener("beforeunload", () => {
  try {
    if (engine.privateKeyHex) persistTestingWallet();
    persistState();
  } catch (error) { console.error(error); }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    try {
      if (engine.privateKeyHex) persistTestingWallet();
      persistState();
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
    if (restored) await connectAndRefresh({ quiet: true });
  }

  if (wasmReady && engine.address) {
    await refreshBalanceOnly({ quiet: true });
    if (cipherReady) await refreshAllConversations({ quiet: true });
    startAutomaticRefresh();
  }

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
