// Portfolio tab — desktop port of iOS 4.0's single continuous portfolio page: portfolio
// picker (multi-portfolio, per account), summary card, KAS price chart with range selector,
// portfolio value chart, and the buy/sell transaction ledger. Charts are hand-drawn SVG —
// no chart library, matching the app's zero-dependency approach.

import { fetchKasPrice, fetchKasPriceHistory } from "../engine/prices.js";

const PORTFOLIO_KEY = "kachat-portfolios-v1"; // account-scoped: { activeId, portfolios: [{id, name, transactions: [...] }] }
const RANGES = [
  { days: 1, label: "1D" },
  { days: 7, label: "7D" },
  { days: 30, label: "1M" },
  { days: 90, label: "3M" },
  { days: 365, label: "1Y" },
];

let deps = null;
let rootEl = null;
let state = { activeId: null, portfolios: [] };
let price = null;          // { usd, change24h }
let history = [];          // [[ts, usd]]
let rangeDays = 7;
let loading = false;

function nowId() {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `p-${Date.now()}-${Math.random()}`;
}

// ---------------------------------------------------------------------------
// Persistence (per account)
// ---------------------------------------------------------------------------

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(deps.accountScopedKey(PORTFOLIO_KEY)) || "null");
    if (parsed?.portfolios?.length) { state = parsed; return; }
  } catch { /* fall through */ }
  state = { activeId: null, portfolios: [] };
}

function saveState() {
  localStorage.setItem(deps.accountScopedKey(PORTFOLIO_KEY), JSON.stringify(state));
}

function ensureDefaultPortfolio() {
  if (state.portfolios.length === 0) {
    const p = { id: nowId(), name: "My Portfolio", transactions: [] };
    state.portfolios.push(p);
    state.activeId = p.id;
    saveState();
  }
  if (!state.portfolios.some((p) => p.id === state.activeId)) {
    state.activeId = state.portfolios[0].id;
  }
}

function activePortfolio() {
  ensureDefaultPortfolio();
  return state.portfolios.find((p) => p.id === state.activeId);
}

function holdingsKas(portfolio) {
  return (portfolio.transactions || []).reduce(
    (sum, tx) => sum + (tx.type === "sell" ? -tx.amountKas : tx.amountKas), 0);
}

// ---------------------------------------------------------------------------
// Charts (plain SVG)
// ---------------------------------------------------------------------------

function sparklineSvg(points, { width = 560, height = 130, stroke = "var(--kaspa)" } = {}) {
  if (!points || points.length < 2) return `<div class="portfolio-chart-empty">No data yet</div>`;
  const values = points.map((p) => p[1]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = (i * step).toFixed(1);
    const y = (height - 8 - ((p[1] - min) / span) * (height - 16)).toFixed(1);
    return `${x},${y}`;
  });
  return `
    <svg class="portfolio-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${coords.join(" ")}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtUsd(value, digits = 2) {
  return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtKas(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function render() {
  if (!rootEl) return;
  const portfolio = activePortfolio();
  const kas = holdingsKas(portfolio);
  const usdValue = price ? kas * price.usd : null;
  const change = price?.change24h ?? null;
  const valuePoints = history.map(([ts, p]) => [ts, kas * p]);
  const transactions = [...(portfolio.transactions || [])].sort((a, b) => b.timestamp - a.timestamp);

  rootEl.innerHTML = `
    <div class="kaposts-header">
      <h1 class="kaposts-title">Portfolio</h1>
      <div class="kaposts-header-actions">
        <button class="kaposts-icon-button" type="button" data-portfolio-refresh title="Refresh">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>
        </button>
      </div>
    </div>

    <div class="portfolio-picker">
      ${state.portfolios.map((p) => `
        <button class="portfolio-chip${p.id === state.activeId ? " active" : ""}" type="button" data-portfolio-select="${p.id}">
          ${deps.escapeHtml(p.name)}
        </button>`).join("")}
      <button class="portfolio-chip portfolio-chip-add" type="button" data-portfolio-add>+</button>
      ${state.portfolios.length > 1 ? `<button class="portfolio-chip portfolio-chip-danger" type="button" data-portfolio-delete>Delete</button>` : ""}
      <button class="portfolio-chip" type="button" data-portfolio-rename>Rename</button>
    </div>

    <div class="profile-card portfolio-summary">
      <p class="profile-card-label">${deps.escapeHtml(portfolio.name)}</p>
      <div class="portfolio-summary-value">${usdValue === null ? "—" : `$${fmtUsd(usdValue)}`}</div>
      <div class="portfolio-summary-sub">
        <span>${fmtKas(kas)} KAS</span>
        ${price ? `<span>· $${fmtUsd(price.usd, 4)}/KAS</span>` : ""}
        ${change !== null ? `<span class="${change >= 0 ? "gain" : "loss"}">${change >= 0 ? "▲" : "▼"} ${Math.abs(change).toFixed(2)}% 24h</span>` : ""}
      </div>
    </div>

    <div class="profile-card">
      <p class="profile-card-label">KAS Price</p>
      ${sparklineSvg(history)}
      <div class="portfolio-ranges">
        ${RANGES.map((r) => `<button class="portfolio-range${r.days === rangeDays ? " active" : ""}" type="button" data-portfolio-range="${r.days}">${r.label}</button>`).join("")}
      </div>
    </div>

    ${kas > 0 ? `
      <div class="profile-card">
        <p class="profile-card-label">Portfolio Value</p>
        ${sparklineSvg(valuePoints, { stroke: "var(--kaspa-ink)" })}
      </div>` : ""}

    <div class="profile-card">
      <p class="profile-card-label">Transactions</p>
      <form class="portfolio-add-form" data-portfolio-add-form>
        <select data-portfolio-tx-type>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
        <input type="number" step="any" min="0" placeholder="Amount KAS" data-portfolio-tx-amount required />
        <input type="number" step="any" min="0" placeholder="Fiat value $" data-portfolio-tx-fiat />
        <input type="text" placeholder="Notes" data-portfolio-tx-notes maxlength="80" />
        <button class="primary-button" type="submit">Add</button>
      </form>
      ${transactions.length === 0
        ? `<div class="portfolio-chart-empty">No transactions yet — add your first buy above.</div>`
        : transactions.map((tx) => `
            <div class="portfolio-tx-row">
              <span class="portfolio-tx-type ${tx.type}">${tx.type === "sell" ? "Sell" : "Buy"}</span>
              <span class="portfolio-tx-amount">${fmtKas(tx.amountKas)} KAS</span>
              <span class="portfolio-tx-fiat">${tx.fiatValue ? `$${fmtUsd(tx.fiatValue)}` : ""}</span>
              <span class="portfolio-tx-date">${new Date(tx.timestamp).toLocaleDateString()}</span>
              ${tx.notes ? `<span class="portfolio-tx-notes">${deps.escapeHtml(tx.notes)}</span>` : ""}
              <button class="kaposts-view-link" type="button" data-portfolio-tx-delete="${tx.id}">Delete</button>
            </div>`).join("")}
    </div>
    ${loading ? `<div class="portfolio-chart-empty">Refreshing…</div>` : ""}`;
}

// ---------------------------------------------------------------------------
// Data refresh
// ---------------------------------------------------------------------------

async function refreshData({ force = false } = {}) {
  if (loading) return;
  loading = true;
  render();
  try {
    const [priceResult, historyResult] = await Promise.all([
      fetchKasPrice({ force }).catch(() => price),
      fetchKasPriceHistory(rangeDays).catch(() => history),
    ]);
    price = priceResult || price;
    history = historyResult || history;
  } finally {
    loading = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/** For the swap screen's "Add to Portfolio": the available portfolios (id + name). */
export function listPortfolios() {
  ensureDefaultPortfolio();
  return state.portfolios.map((p) => ({ id: p.id, name: p.name }));
}

/** Appends a transaction to a specific portfolio (used by completed swaps). */
export function addTransactionToPortfolio(portfolioId, { type, amountKas, fiatValue = null, notes = null }) {
  const portfolio = state.portfolios.find((p) => p.id === portfolioId) || activePortfolio();
  (portfolio.transactions ||= []).push({
    id: nowId(),
    type: type === "sell" ? "sell" : "buy",
    amountKas: Number(amountKas) || 0,
    fiatValue: Number(fiatValue) || null,
    notes: notes || null,
    timestamp: Date.now(),
  });
  saveState();
  render();
}

export function refreshPortfolio() {
  ensureDefaultPortfolio();
  render();
  refreshData();
}

export function resetPortfolioForAccount() {
  loadState();
  ensureDefaultPortfolio();
  render();
}

export function initPortfolio(dependencies) {
  deps = dependencies;
  rootEl = document.querySelector("[data-portfolio-root]");
  loadState();
  ensureDefaultPortfolio();

  rootEl?.addEventListener("click", (event) => {
    const select = event.target.closest("[data-portfolio-select]");
    if (select) { state.activeId = select.dataset.portfolioSelect; saveState(); render(); return; }

    if (event.target.closest("[data-portfolio-add]")) {
      const name = window.prompt("Portfolio name:", `Portfolio ${state.portfolios.length + 1}`);
      if (name?.trim()) {
        const p = { id: nowId(), name: name.trim(), transactions: [] };
        state.portfolios.push(p);
        state.activeId = p.id;
        saveState(); render();
      }
      return;
    }

    if (event.target.closest("[data-portfolio-rename]")) {
      const portfolio = activePortfolio();
      const name = window.prompt("Rename portfolio:", portfolio.name);
      if (name?.trim()) { portfolio.name = name.trim(); saveState(); render(); }
      return;
    }

    if (event.target.closest("[data-portfolio-delete]")) {
      const portfolio = activePortfolio();
      if (state.portfolios.length > 1 &&
          window.confirm(`Delete "${portfolio.name}" and its ${portfolio.transactions.length} transactions?`)) {
        state.portfolios = state.portfolios.filter((p) => p.id !== portfolio.id);
        state.activeId = state.portfolios[0].id;
        saveState(); render();
      }
      return;
    }

    const range = event.target.closest("[data-portfolio-range]");
    if (range) { rangeDays = Number(range.dataset.portfolioRange) || 7; refreshData(); return; }

    if (event.target.closest("[data-portfolio-refresh]")) { refreshData({ force: true }); return; }

    const txDelete = event.target.closest("[data-portfolio-tx-delete]");
    if (txDelete) {
      const portfolio = activePortfolio();
      portfolio.transactions = (portfolio.transactions || []).filter((t) => t.id !== txDelete.dataset.portfolioTxDelete);
      saveState(); render();
    }
  });

  rootEl?.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-portfolio-add-form]");
    if (!form) return;
    event.preventDefault();
    const amount = Number(rootEl.querySelector("[data-portfolio-tx-amount]")?.value);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const portfolio = activePortfolio();
    (portfolio.transactions ||= []).push({
      id: nowId(),
      type: rootEl.querySelector("[data-portfolio-tx-type]")?.value === "sell" ? "sell" : "buy",
      amountKas: amount,
      fiatValue: Number(rootEl.querySelector("[data-portfolio-tx-fiat]")?.value) || null,
      notes: rootEl.querySelector("[data-portfolio-tx-notes]")?.value?.trim() || null,
      timestamp: Date.now(),
    });
    saveState();
    render();
  });

  render();
}
