// Cold Storage tab — desktop v1: a watch-only tracker for offline/hardware wallet addresses.
// Add any kaspa: address to watch its balance (fetched from the Kaspa REST API); nothing here
// ever touches keys. Air-gapped signing flows (compound/withdraw via KasSigner) stay on
// mobile, where the camera lives.

import { getEndpoint } from "../engine/endpoints.js";

const COLD_KEY = "kachat-cold-watch-v1"; // account-scoped: [{ address, label, balanceSompi, updatedAt }]

let deps = null;
let rootEl = null;
let watched = [];
let refreshing = false;

function loadState() {
  try { watched = JSON.parse(localStorage.getItem(deps.accountScopedKey(COLD_KEY)) || "[]") || []; }
  catch { watched = []; }
}

function saveState() {
  localStorage.setItem(deps.accountScopedKey(COLD_KEY), JSON.stringify(watched));
}

function fmtKas(sompi) {
  return (Number(sompi || 0) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

async function fetchBalance(address) {
  const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
  const response = await fetch(`${base}/addresses/${encodeURIComponent(address)}/balance`, {
    headers: { Accept: "application/json" }, cache: "no-store",
  });
  if (!response.ok) throw new Error(`Balance lookup failed (${response.status}).`);
  const json = await response.json();
  return Number(json?.balance) || 0;
}

function render() {
  if (!rootEl) return;
  const totalSompi = watched.reduce((sum, w) => sum + (w.balanceSompi || 0), 0);
  rootEl.innerHTML = `
    <div class="kaposts-header">
      <h1 class="kaposts-title">Cold Storage</h1>
      <div class="kaposts-header-actions">
        <button class="kaposts-icon-button" type="button" data-cold-refresh title="Refresh balances">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>
        </button>
      </div>
    </div>
    <p class="broadcast-intro">Watch-only: track offline or hardware wallet addresses. Keys never leave your cold device — signing stays on mobile with KasSigner.</p>
    <div class="profile-card portfolio-summary">
      <p class="profile-card-label">Total watched</p>
      <div class="portfolio-summary-value">${fmtKas(totalSompi)} KAS</div>
      <div class="portfolio-summary-sub"><span>${watched.length} address${watched.length === 1 ? "" : "es"}</span>${refreshing ? "<span>· refreshing…</span>" : ""}</div>
    </div>
    <form class="broadcast-join-row" data-cold-add-form>
      <input class="kaposts-reply-input" type="text" data-cold-address placeholder="kaspa:… address to watch" required />
      <input class="kaposts-reply-input cold-label-input" type="text" data-cold-label placeholder="Label" maxlength="32" />
      <button class="primary-button" type="submit">Watch</button>
    </form>
    ${watched.length === 0
      ? `<div class="no-results-card"><strong>No watched addresses</strong><span>Add a cold wallet address above to track its balance.</span></div>`
      : watched.map((w) => `
          <div class="portfolio-tx-row cold-row">
            <span class="portfolio-tx-amount">${deps.escapeHtml(w.label || deps.shortAddress(w.address))}</span>
            <span class="portfolio-tx-notes">${deps.escapeHtml(deps.shortAddress(w.address))}</span>
            <span class="portfolio-tx-fiat">${w.balanceSompi === undefined ? "…" : `${fmtKas(w.balanceSompi)} KAS`}</span>
            <a class="kaposts-view-link" href="${deps.escapeHtml(deps.explorerAddressUrl(w.address))}" target="_blank" rel="noopener">Explorer</a>
            <button class="kaposts-view-link" type="button" data-cold-remove="${deps.escapeHtml(w.address)}">Remove</button>
          </div>`).join("")}`;
}

async function refreshBalances() {
  if (refreshing) return;
  refreshing = true;
  render();
  for (const entry of watched) {
    try {
      entry.balanceSompi = await fetchBalance(entry.address);
      entry.updatedAt = Date.now();
    } catch (error) {
      deps.appendEngineLog?.(`Cold balance failed for ${deps.shortAddress(entry.address)}: ${error.message}`);
    }
  }
  saveState();
  refreshing = false;
  render();
}

export function refreshColdStorage() {
  render();
  refreshBalances();
}

export function resetColdStorageForAccount() {
  loadState();
  render();
}

export function initColdStorage(dependencies) {
  deps = dependencies;
  rootEl = document.querySelector("[data-cold-root]");
  loadState();

  rootEl?.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-cold-add-form]");
    if (!form) return;
    event.preventDefault();
    const address = String(rootEl.querySelector("[data-cold-address]")?.value || "").trim();
    const label = String(rootEl.querySelector("[data-cold-label]")?.value || "").trim();
    if (!address.startsWith("kaspa:") || address.length < 20) {
      deps.showToast?.("Enter a full kaspa: address.");
      return;
    }
    if (!watched.some((w) => w.address === address)) {
      watched.push({ address, label: label || null });
      saveState();
    }
    render();
    refreshBalances();
  });

  rootEl?.addEventListener("click", (event) => {
    if (event.target.closest("[data-cold-refresh]")) { refreshBalances(); return; }
    const remove = event.target.closest("[data-cold-remove]");
    if (remove) {
      watched = watched.filter((w) => w.address !== remove.dataset.coldRemove);
      saveState();
      render();
    }
  });

  render();
}
