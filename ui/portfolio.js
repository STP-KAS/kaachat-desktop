// Portfolio tab — desktop port of iOS 4.0's single continuous portfolio page: Robinhood-style
// portfolio picker cards (multi-portfolio, per account, today's change per card), iOS summary
// card (Holdings / Current Value / Total Invested / Total P&L / Avg. Buy Price), scrubbable
// KAS price chart with range selector, ledger-replayed Value Over Time chart, and a full
// buy/sell transaction ledger with an edit sheet, CoinMarketCap-compatible CSV import/export,
// and on-chain Kaspa address import. Charts are hand-drawn SVG — no chart library, matching
// the app's zero-dependency approach.

import { fetchKasPrice, fetchKasPriceHistory } from "../engine/prices.js";
import { getEndpoint } from "../engine/endpoints.js";
import { validateMainnetAddress } from "../engine/utils.js";

const PORTFOLIO_KEY = "kachat-portfolios-v1"; // account-scoped: { activeId, portfolios: [{id, name, transactions: [...] }] }
const DAILY_PRICE_CACHE_KEY = "kachat-kas-daily-price-v1"; // global: { "DD-MM-YYYY": priceUsd }
const MAX_PORTFOLIOS = 5;
// Mirrors iOS PortfolioAddressImporter.priceUnavailableNote — rows imported without a
// historical price carry this note and show a warning until the user sets one.
const PRICE_UNAVAILABLE_NOTE = "Price unavailable — set manually";
const RANGES = [
  { days: 1, label: "1D" },
  { days: 7, label: "7D" },
  { days: 30, label: "1M" },
  { days: 90, label: "3M" },
  { days: 365, label: "1Y" },
];

let deps = null;
let rootEl = null;
let modalsEl = null;
let state = { activeId: null, portfolios: [] };
let price = null;          // { usd, change24h }
let history = [];          // [[ts, usd]] for the selected range
let sevenDayHistory = [];  // fixed 7d window for per-card "today's change" (independent of range)
let valuePoints = [];      // ledger replay of `history` — rebuilt every render
let rangeDays = 7;
let loading = false;
let editingTx = null;      // null = closed; { id } editing; { id: null } adding
let addressImport = null;  // null = closed; { busy, progress, result, error }

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

// ---------------------------------------------------------------------------
// Pure math — direct ports of PortfolioViewModel's static functions
// ---------------------------------------------------------------------------

function computeSummary(transactions, priceUsd) {
  let holdingsKas = 0;
  let totalInvested = 0;
  let totalProceeds = 0;
  let totalBoughtKas = 0;
  for (const tx of transactions) {
    const amount = Number(tx.amountKas) || 0;
    const fiat = Number(tx.fiatValue) || 0;
    if (tx.type === "sell") {
      holdingsKas -= amount;
      totalProceeds += fiat;
    } else {
      holdingsKas += amount;
      totalInvested += fiat;
      totalBoughtKas += amount;
    }
  }
  const currentValue = holdingsKas * (priceUsd || 0);
  const totalPL = (currentValue + totalProceeds) - totalInvested;
  const totalPLPercent = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;
  const averageBuyPriceUsd = totalBoughtKas > 0 ? totalInvested / totalBoughtKas : null;
  return { holdingsKas, totalInvested, totalProceeds, currentValue, totalPL, totalPLPercent, averageBuyPriceUsd };
}

/** Replays the ledger against each price point to get holdings *as of that moment* — a
 *  buy/sell partway through the window changes the curve's shape from that point on, not
 *  retroactively. A transaction exactly at a point's timestamp counts as included. */
function computeValueHistory(transactions, pricePoints) {
  if (!pricePoints?.length) return [];
  const sorted = [...transactions].sort((a, b) => a.timestamp - b.timestamp);
  let holdings = 0;
  let txIndex = 0;
  return pricePoints.map(([ts, p]) => {
    while (txIndex < sorted.length && sorted[txIndex].timestamp <= ts) {
      const tx = sorted[txIndex];
      holdings += (tx.type === "sell" ? -1 : 1) * (Number(tx.amountKas) || 0);
      txIndex += 1;
    }
    return [ts, holdings * p];
  });
}

/** Real today-only $ and % change: latest value sample minus the sample closest to (but not
 *  after) 24h before it. Null when no sample exists that far back (e.g. created today). */
function computeTodayChange(points) {
  if (!points?.length) return null;
  const [latestTs, latestValue] = points[points.length - 1];
  const dayAgo = latestTs - 86_400_000;
  let base = null;
  for (const point of points) {
    if (point[0] <= dayAgo) base = point;
    else break;
  }
  if (!base) return null;
  const amount = latestValue - base[1];
  const percent = base[1] === 0 ? 0 : (amount / base[1]) * 100;
  return { amount, percent };
}

// ---------------------------------------------------------------------------
// Formatting (USD — desktop is USD-only throughout)
// ---------------------------------------------------------------------------

function fmtUsd(value) {
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(Number(value) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return `${sign}$${magnitude}`;
}

// iOS formatPrice: 5 decimals under a dollar, else 2.
function fmtPrice(value) {
  const v = Number(value) || 0;
  return `$${v.toLocaleString(undefined, {
    minimumFractionDigits: v < 1 ? 5 : 2, maximumFractionDigits: v < 1 ? 5 : 2,
  })}`;
}

function fmtKas(value) {
  return `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} KAS`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Charts (plain SVG polyline + HTML crosshair overlay for scrubbing)
// ---------------------------------------------------------------------------

/** yFractions[i] = distance from the wrapper's top as a 0..1 fraction, for the crosshair dot. */
function chartGeometry(points, height) {
  const values = points.map((p) => p[1]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((v) => (height - 8 - ((v - min) / span) * (height - 16)) / height);
}

function sparklineSvg(points, { height = 130, stroke = "var(--kaspa)", chart = null, lineWidth = 2 } = {}) {
  if (!points || points.length < 2) return `<div class="portfolio-chart-empty">No data yet</div>`;
  const width = 560;
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
  const scrubAttr = chart ? ` data-portfolio-chart="${chart}"` : "";
  return `
    <div class="portfolio-chart-wrap"${scrubAttr} style="height:${height}px">
      <svg class="portfolio-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="${coords.join(" ")}" fill="none" stroke="${stroke}" stroke-width="${lineWidth}" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      ${chart ? `<div class="portfolio-scrub-line" hidden></div><div class="portfolio-scrub-dot" hidden style="background:${stroke}"></div>` : ""}
    </div>`;
}

/** Hover-to-scrub, matching iOS SparklineChart's drag crosshair: a vertical line + dot track
 *  the pointer, and the associated readout labels update live. Direct DOM updates only — no
 *  re-render per pointer event. */
function attachScrub(wrap, points, onScrub, onEnd) {
  if (!wrap || !points || points.length < 2) return;
  const line = wrap.querySelector(".portfolio-scrub-line");
  const dot = wrap.querySelector(".portfolio-scrub-dot");
  const fractions = chartGeometry(points, wrap.clientHeight || 130);

  const move = (event) => {
    const rect = wrap.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const index = Math.round((x / (rect.width || 1)) * (points.length - 1));
    const clamped = Math.min(Math.max(index, 0), points.length - 1);
    const px = (clamped / (points.length - 1)) * rect.width;
    const py = fractions[clamped] * rect.height;
    if (line) { line.hidden = false; line.style.left = `${px}px`; }
    if (dot) { dot.hidden = false; dot.style.left = `${px}px`; dot.style.top = `${py}px`; }
    onScrub(points[clamped]);
  };
  const leave = () => {
    if (line) line.hidden = true;
    if (dot) dot.hidden = true;
    onEnd();
  };
  wrap.addEventListener("pointermove", move);
  wrap.addEventListener("pointerdown", move);
  wrap.addEventListener("pointerleave", leave);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pickerCard(portfolio) {
  const isActive = portfolio.id === state.activeId;
  const summary = computeSummary(portfolio.transactions || [], price?.usd || 0);
  const change = computeTodayChange(computeValueHistory(portfolio.transactions || [], sevenDayHistory));
  const positive = (change?.amount ?? 0) >= 0;
  return `
    <div class="portfolio-card${isActive ? " active" : ""}" data-portfolio-select="${portfolio.id}" role="button" tabindex="0">
      <div class="portfolio-card-top">
        <span class="portfolio-card-name">${deps.escapeHtml(portfolio.name)}</span>
        <button class="portfolio-card-menu-btn" type="button" data-portfolio-card-menu="${portfolio.id}" aria-label="Portfolio options">⋯</button>
      </div>
      <div class="portfolio-card-value">${price ? fmtUsd(summary.currentValue) : "—"}</div>
      ${change
        ? `<div class="portfolio-card-change ${positive ? "gain" : "loss"}">${positive ? "↑" : "↓"} ${Math.abs(change.percent).toFixed(2)}%</div>`
        : `<div class="portfolio-card-change muted">—</div>`}
      <div class="portfolio-card-actions" data-portfolio-card-actions="${portfolio.id}" hidden>
        <button type="button" data-portfolio-rename="${portfolio.id}">Rename</button>
        ${state.portfolios.length > 1 ? `<button type="button" class="danger" data-portfolio-delete="${portfolio.id}">Delete</button>` : ""}
      </div>
    </div>`;
}

function summaryCardHtml(summary) {
  const change = price?.change24h ?? null;
  const positive = (change ?? 0) >= 0;
  return `
    <div class="profile-card portfolio-summary">
      <div class="portfolio-summary-head">
        <div>
          <p class="profile-card-label" data-portfolio-price-label>KAS Price</p>
          <div class="portfolio-summary-price" data-portfolio-price-value>${price ? fmtPrice(price.usd) : "—"}</div>
        </div>
        ${change !== null ? `
          <div class="portfolio-summary-24h ${positive ? "gain" : "loss"}" data-portfolio-price-24h>
            ${positive ? "↑" : "↓"} ${Math.abs(change).toFixed(2)}%<span class="muted"> 24h</span>
          </div>` : ""}
      </div>
      <div class="portfolio-summary-grid">
        <div class="portfolio-stat">
          <span class="portfolio-stat-label">Holdings</span>
          <span class="portfolio-stat-value">${fmtKas(summary.holdingsKas)}</span>
        </div>
        <div class="portfolio-stat right">
          <span class="portfolio-stat-label">Current Value</span>
          <span class="portfolio-stat-value">${fmtUsd(summary.currentValue)}</span>
        </div>
      </div>
      <div class="portfolio-summary-divider"></div>
      <div class="portfolio-summary-grid">
        <div class="portfolio-stat">
          <span class="portfolio-stat-label">Total Invested</span>
          <span class="portfolio-stat-value">${fmtUsd(summary.totalInvested)}</span>
        </div>
        <div class="portfolio-stat right">
          <span class="portfolio-stat-label">Total P&amp;L</span>
          <span class="portfolio-stat-value ${summary.totalPL >= 0 ? "gain" : "loss"}">
            ${summary.totalPL >= 0 ? "↗" : "↘"} ${fmtUsd(summary.totalPL)} (${summary.totalPLPercent.toFixed(1)}%)
          </span>
        </div>
      </div>
      ${summary.averageBuyPriceUsd !== null ? `
        <div class="portfolio-summary-divider"></div>
        <div class="portfolio-summary-grid">
          <div class="portfolio-stat">
            <span class="portfolio-stat-label">Avg. Buy Price</span>
            <span class="portfolio-stat-value">${fmtPrice(summary.averageBuyPriceUsd)}</span>
          </div>
        </div>` : ""}
    </div>`;
}

function transactionRowHtml(tx) {
  const isBuy = tx.type !== "sell";
  const needsPrice = tx.notes === PRICE_UNAVAILABLE_NOTE;
  return `
    <div class="portfolio-tx-row" data-portfolio-tx-edit="${tx.id}" role="button" tabindex="0">
      <span class="portfolio-tx-icon ${isBuy ? "buy" : "sell"}">${isBuy ? "↓" : "↑"}</span>
      <div class="portfolio-tx-main">
        <span class="portfolio-tx-type ${isBuy ? "buy" : "sell"}">${isBuy ? "Buy" : "Sell"}${needsPrice ? ' <span class="portfolio-tx-warn" title="Price needed — click to set">⚠</span>' : ""}</span>
        <span class="portfolio-tx-date">${fmtDate(tx.timestamp)}</span>
        ${tx.notes && !needsPrice ? `<span class="portfolio-tx-notes">${deps.escapeHtml(tx.notes)}</span>` : ""}
      </div>
      <div class="portfolio-tx-amounts">
        <span class="portfolio-tx-amount">${fmtKas(tx.amountKas)}</span>
        <span class="portfolio-tx-fiat">${fmtUsd(tx.fiatValue || 0)}</span>
      </div>
      <button class="portfolio-tx-delete" type="button" data-portfolio-tx-delete="${tx.id}" aria-label="Delete transaction">×</button>
    </div>`;
}

function render() {
  if (!rootEl) return;
  const portfolio = activePortfolio();
  const scoped = portfolio.transactions || [];
  const summary = computeSummary(scoped, price?.usd || 0);
  valuePoints = computeValueHistory(scoped, history);
  const transactions = [...scoped].sort((a, b) => b.timestamp - a.timestamp);
  const showValueChart = scoped.length > 0 && valuePoints.length >= 2;
  const latestValue = valuePoints.length ? valuePoints[valuePoints.length - 1][1] : summary.currentValue;

  rootEl.innerHTML = `
    <div class="kaposts-header">
      <h1 class="kaposts-title">Portfolio</h1>
      <div class="kaposts-header-actions">
        <button class="kaposts-icon-button" type="button" data-portfolio-refresh title="Refresh">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>
        </button>
      </div>
    </div>

    <div class="portfolio-cards">
      ${state.portfolios.map(pickerCard).join("")}
      ${state.portfolios.length < MAX_PORTFOLIOS ? `
        <button class="portfolio-card portfolio-card-add" type="button" data-portfolio-add>
          <span class="portfolio-card-add-plus">+</span>
          <span>Add</span>
        </button>` : ""}
    </div>

    ${summaryCardHtml(summary)}

    <div class="profile-card portfolio-price-card">
      <div class="portfolio-price-row">
        <p class="profile-card-label">Price</p>
        <div class="portfolio-ranges">
          ${RANGES.map((r) => `<button class="portfolio-range${r.days === rangeDays ? " active" : ""}" type="button" data-portfolio-range="${r.days}">${r.label}</button>`).join("")}
        </div>
      </div>
      ${sparklineSvg(history, { height: 90, chart: "price" })}
    </div>

    ${showValueChart ? `
      <div class="profile-card">
        <p class="profile-card-label" data-portfolio-value-label>Value Over Time</p>
        <div class="portfolio-value-readout" data-portfolio-value-readout>${fmtUsd(latestValue)}</div>
        ${sparklineSvg(valuePoints, { height: 110, stroke: "var(--kaspa-ink)", chart: "value", lineWidth: 3 })}
      </div>` : ""}

    <div class="profile-card">
      <div class="portfolio-tx-header">
        <p class="profile-card-label">Transactions</p>
        <div class="portfolio-tx-header-actions">
          <button class="cold-inline-link" type="button" data-portfolio-tx-add>+ Add</button>
          <button class="cold-inline-link" type="button" data-portfolio-io-menu>Import/Export ▾</button>
          <div class="portfolio-menu" data-portfolio-io-dropdown hidden>
            <button type="button" data-portfolio-io-address>Add Kaspa Address</button>
            <button type="button" data-portfolio-import-csv>Import CSV</button>
            <button type="button" data-portfolio-export-csv>Export CSV</button>
          </div>
        </div>
      </div>
      ${transactions.length === 0
        ? `<div class="portfolio-chart-empty">No transactions yet — add your first buy, import a CSV, or add a Kaspa address.</div>`
        : transactions.map(transactionRowHtml).join("")}
    </div>
    ${loading ? `<div class="portfolio-chart-empty">Refreshing…</div>` : ""}`;

  wireScrubbing();
}

function wireScrubbing() {
  const priceWrap = rootEl.querySelector('[data-portfolio-chart="price"]');
  attachScrub(priceWrap, history, ([ts, p]) => {
    const label = rootEl.querySelector("[data-portfolio-price-label]");
    const value = rootEl.querySelector("[data-portfolio-price-value]");
    const change = rootEl.querySelector("[data-portfolio-price-24h]");
    if (label) label.textContent = new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    if (value) value.textContent = fmtPrice(p);
    if (change) change.style.visibility = "hidden";
  }, () => {
    const label = rootEl.querySelector("[data-portfolio-price-label]");
    const value = rootEl.querySelector("[data-portfolio-price-value]");
    const change = rootEl.querySelector("[data-portfolio-price-24h]");
    if (label) label.textContent = "KAS Price";
    if (value) value.textContent = price ? fmtPrice(price.usd) : "—";
    if (change) change.style.visibility = "";
  });

  const valueWrap = rootEl.querySelector('[data-portfolio-chart="value"]');
  attachScrub(valueWrap, valuePoints, ([ts, v]) => {
    const label = rootEl.querySelector("[data-portfolio-value-label]");
    const readout = rootEl.querySelector("[data-portfolio-value-readout]");
    if (label) label.textContent = `Value on ${new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
    if (readout) readout.textContent = fmtUsd(v);
  }, () => {
    const label = rootEl.querySelector("[data-portfolio-value-label]");
    const readout = rootEl.querySelector("[data-portfolio-value-readout]");
    if (label) label.textContent = "Value Over Time";
    if (readout) readout.textContent = fmtUsd(valuePoints.length ? valuePoints[valuePoints.length - 1][1] : 0);
  });
}

// ---------------------------------------------------------------------------
// Transaction editor modal (iOS PortfolioTransactionEditor)
// ---------------------------------------------------------------------------

function toDatetimeLocal(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openTxEditor(txId) {
  const portfolio = activePortfolio();
  const tx = txId ? (portfolio.transactions || []).find((t) => t.id === txId) : null;
  editingTx = { id: tx?.id || null };
  const backdrop = modalsEl.querySelector("[data-portfolio-editor-modal]");
  modalsEl.querySelector("[data-portfolio-editor-title]").textContent = tx ? "Edit Transaction" : "Add Transaction";
  modalsEl.querySelector("[data-portfolio-editor-type]").value = tx?.type === "sell" ? "sell" : "buy";
  modalsEl.querySelector("[data-portfolio-editor-amount]").value = tx ? String(tx.amountKas) : "";
  modalsEl.querySelector("[data-portfolio-editor-fiat]").value = tx && tx.fiatValue ? String(tx.fiatValue) : "";
  modalsEl.querySelector("[data-portfolio-editor-date]").value = toDatetimeLocal(tx?.timestamp ?? Date.now());
  const notes = tx?.notes === PRICE_UNAVAILABLE_NOTE ? "" : (tx?.notes || "");
  modalsEl.querySelector("[data-portfolio-editor-notes]").value = notes;
  modalsEl.querySelector("[data-portfolio-editor-delete]").hidden = !tx;
  updateEditorHint();
  backdrop.hidden = false;
}

function closeTxEditor() {
  editingTx = null;
  modalsEl.querySelector("[data-portfolio-editor-modal]").hidden = true;
}

/** "≈ $0.12345 / KAS" helper under the fiat field, plus a one-click "use current price" fill. */
function updateEditorHint() {
  const amount = Number(modalsEl.querySelector("[data-portfolio-editor-amount]")?.value);
  const fiat = Number(modalsEl.querySelector("[data-portfolio-editor-fiat]")?.value);
  const hint = modalsEl.querySelector("[data-portfolio-editor-hint]");
  if (!hint) return;
  if (Number.isFinite(amount) && amount > 0 && Number.isFinite(fiat) && fiat > 0) {
    hint.textContent = `≈ ${fmtPrice(fiat / amount)} / KAS`;
  } else if (price && Number.isFinite(amount) && amount > 0) {
    hint.textContent = `At current price: ${fmtUsd(amount * price.usd)}`;
  } else {
    hint.textContent = "";
  }
}

function saveTxEditor() {
  const amount = Number(modalsEl.querySelector("[data-portfolio-editor-amount]")?.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    deps.showToast?.("Enter a KAS amount.");
    return;
  }
  const type = modalsEl.querySelector("[data-portfolio-editor-type]")?.value === "sell" ? "sell" : "buy";
  const fiatValue = Number(modalsEl.querySelector("[data-portfolio-editor-fiat]")?.value) || 0;
  const dateRaw = modalsEl.querySelector("[data-portfolio-editor-date]")?.value;
  const timestamp = dateRaw ? new Date(dateRaw).getTime() : Date.now();
  const notes = modalsEl.querySelector("[data-portfolio-editor-notes]")?.value?.trim() || null;

  const portfolio = activePortfolio();
  portfolio.transactions ||= [];
  if (editingTx?.id) {
    const index = portfolio.transactions.findIndex((t) => t.id === editingTx.id);
    if (index >= 0) {
      // Preserve on-chain provenance fields; a manual edit clears the needs-price warning.
      const existing = portfolio.transactions[index];
      portfolio.transactions[index] = { ...existing, type, amountKas: amount, fiatValue, timestamp, notes };
    }
  } else {
    portfolio.transactions.push({ id: nowId(), type, amountKas: amount, fiatValue, timestamp, notes });
  }
  saveState();
  closeTxEditor();
  render();
}

// ---------------------------------------------------------------------------
// CSV import/export (CoinMarketCap "Transaction History" format — matches iOS)
// ---------------------------------------------------------------------------

/** Splits on commas outside double quotes, unescapes "" back to " within a quoted field. */
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes && c === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
    else if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) { fields.push(current); current = ""; }
    else current += c;
  }
  fields.push(current);
  return fields;
}

function parseLenientDouble(raw) {
  const value = Number(String(raw ?? "").trim().replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** CoinMarketCap bakes the exporter's UTC offset into the date column header, e.g.
 *  "Date (UTC-4:00)" — parsed once so every row's timestamp is interpreted correctly. */
function parseHeaderUtcOffsetMinutes(header) {
  const match = /UTC([+-]?\d+):(\d+)/i.exec(header || "");
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const sign = hours < 0 || match[1].startsWith("-") ? -1 : 1;
  return sign * (Math.abs(hours) * 60 + minutes);
}

function exportCsv() {
  const portfolio = activePortfolio();
  const rows = [...(portfolio.transactions || [])].sort((a, b) => a.timestamp - b.timestamp);
  const pad = (n) => String(n).padStart(2, "0");
  let csv = "Date (UTC+0:00),Token,Type,Price (USD),Amount,Total value (USD),Fee,Fee Currency,Notes\n";
  for (const tx of rows) {
    const d = new Date(tx.timestamp);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const amount = Number(tx.amountKas) || 0;
    const fiat = Number(tx.fiatValue) || 0;
    const perKas = amount !== 0 ? fiat / amount : 0;
    const notes = String(tx.notes || "").replace(/"/g, '""');
    csv += `"${date}","KAS","${tx.type === "sell" ? "sell" : "buy"}","${perKas}","${amount}","${fiat}","0.00","USD","${notes}"\n`;
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kachat-portfolio-${new Date().toISOString().replace(/:/g, "-").slice(0, 19)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Same replace-by-timestamp dedup as iOS: a row whose timestamp exactly matches an existing
 *  transaction in the active portfolio replaces it in place rather than piling up copies. */
function importCsvText(content) {
  const lines = content.split(/\r?\n/);
  if (!lines.length) return 0;
  const header = lines.shift();
  const offsetMinutes = parseHeaderUtcOffsetMinutes(header);

  const portfolio = activePortfolio();
  portfolio.transactions ||= [];
  const indexByTimestamp = new Map();
  portfolio.transactions.forEach((tx, index) => indexByTimestamp.set(tx.timestamp, index));

  let imported = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (fields.length < 6) continue;
    if (String(fields[1]).trim().toUpperCase() !== "KAS") continue;
    const type = String(fields[2]).trim().toLowerCase();
    if (type !== "buy" && type !== "sell") continue;
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(fields[0]).trim());
    if (!dateMatch) continue;
    const [, y, mo, d, h, mi, s] = dateMatch.map(Number);
    const timestamp = Date.UTC(y, mo - 1, d, h, mi, s) - offsetMinutes * 60_000;
    const kas = parseLenientDouble(fields[4]);
    const totalValue = parseLenientDouble(fields[5]);
    if (kas === null || totalValue === null) continue;

    // Fee folded into total when USD-denominated: added for buys, subtracted for sells.
    let fiatValue = totalValue;
    if (fields.length > 7 && String(fields[7]).trim().toUpperCase() === "USD") {
      const fee = parseLenientDouble(fields[6]);
      if (fee !== null) fiatValue = type === "buy" ? fiatValue + fee : Math.max(fiatValue - fee, 0);
    }
    const notes = fields.length > 8 && fields[8] ? fields[8] : null;

    const existingIndex = indexByTimestamp.get(timestamp);
    if (existingIndex !== undefined) {
      const existing = portfolio.transactions[existingIndex];
      portfolio.transactions[existingIndex] = { ...existing, type, amountKas: kas, fiatValue, timestamp, notes };
    } else {
      portfolio.transactions.push({ id: nowId(), type, amountKas: kas, fiatValue, timestamp, notes });
      indexByTimestamp.set(timestamp, portfolio.transactions.length - 1);
    }
    imported += 1;
  }

  if (imported > 0) { saveState(); render(); }
  return imported;
}

// ---------------------------------------------------------------------------
// On-chain address import (iOS PortfolioAddressImporter): every received tx becomes a buy,
// every sent tx a sell, priced at that day's historical KAS price.
// ---------------------------------------------------------------------------

const IMPORT_MAX_TRANSACTIONS = 500;
const PRICE_REQUEST_SPACING_MS = 1200; // CoinGecko free tier rate-limits aggressively

function txDirectionForAddress(tx, address) {
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

function dayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  // CoinGecko's /history endpoint takes DD-MM-YYYY (UTC-day granularity).
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

async function fetchHistoricalDayPrice(key) {
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(DAILY_PRICE_CACHE_KEY) || "{}"); } catch { /* fresh */ }
  if (Number.isFinite(cache[key])) return cache[key];
  const url = `https://api.coingecko.com/api/v3/coins/kaspa/history?date=${encodeURIComponent(key)}&localization=false`;
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) return null;
  const json = await response.json();
  const value = Number(json?.market_data?.current_price?.usd);
  if (!Number.isFinite(value)) return null;
  cache[key] = value;
  try { localStorage.setItem(DAILY_PRICE_CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setImportProgress(text) {
  if (addressImport) addressImport.progress = text;
  const el = modalsEl.querySelector("[data-portfolio-import-progress]");
  if (el) el.textContent = text || "";
}

async function runAddressImport(addressRaw) {
  const address = String(addressRaw || "").trim();
  try {
    validateMainnetAddress(address);
    // validateMainnetAddress only checks the prefix — also require a plausible bech32 payload
    // so obvious typos fail here instead of as an opaque Kaspa API error.
    if (!/^kaspa:[a-z0-9]{50,90}$/.test(address)) throw new Error("bad payload");
  } catch {
    setImportProgress("That doesn't look like a valid mainnet Kaspa address.");
    return;
  }
  addressImport.busy = true;
  modalsEl.querySelector("[data-portfolio-import-start]").disabled = true;

  try {
    // Re-importing the same address only adds transactions not already present anywhere in
    // this account's ledgers (deduped by on-chain tx id, matching iOS's whole-wallet dedup).
    const existingTxIds = new Set();
    for (const p of state.portfolios) {
      for (const tx of p.transactions || []) {
        if (tx.sourceAddress === address && tx.sourceTxId) existingTxIds.add(tx.sourceTxId);
      }
    }

    setImportProgress("Fetching transactions…");
    const base = String(getEndpoint("kaspaApi") || "https://api.kaspa.org").replace(/\/+$/, "");
    const fullTransactions = [];
    for (let offset = 0; fullTransactions.length < IMPORT_MAX_TRANSACTIONS; offset += 50) {
      const url = `${base}/addresses/${encodeURIComponent(address)}/full-transactions?limit=50&offset=${offset}&resolve_previous_outpoints=light`;
      const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error(`Kaspa API returned ${response.status}`);
      const page = await response.json();
      if (!Array.isArray(page) || !page.length) break;
      fullTransactions.push(...page);
      if (page.length < 50) break;
      setImportProgress(`Fetching transactions… (${fullTransactions.length})`);
    }

    const candidates = [];
    for (const tx of fullTransactions.slice(0, IMPORT_MAX_TRANSACTIONS)) {
      const txId = tx.transaction_id;
      const blockTime = Number(tx.block_time);
      if (!txId || existingTxIds.has(txId) || !Number.isFinite(blockTime) || blockTime <= 0) continue;
      const direction = txDirectionForAddress(tx, address);
      if (!direction) continue;
      candidates.push({
        txId,
        isOutgoing: direction.isOutgoing,
        amountKas: Number(direction.amountSompi) / 1e8,
        timestamp: blockTime,
        day: dayKey(blockTime),
      });
    }
    if (!candidates.length) {
      setImportProgress("No new transactions found for this address.");
      return;
    }

    // One historical-price fetch per unique day, paced sequentially for the free-tier limit.
    const uniqueDays = [...new Set(candidates.map((c) => c.day))];
    const priceByDay = {};
    for (let i = 0; i < uniqueDays.length; i += 1) {
      setImportProgress(`Pricing ${i + 1}/${uniqueDays.length} days…`);
      let dayPrice = await fetchHistoricalDayPrice(uniqueDays[i]);
      if (dayPrice === null) {
        await sleep(PRICE_REQUEST_SPACING_MS);
        dayPrice = await fetchHistoricalDayPrice(uniqueDays[i]);
      }
      priceByDay[uniqueDays[i]] = dayPrice;
      if (i < uniqueDays.length - 1) await sleep(PRICE_REQUEST_SPACING_MS);
    }

    // Every candidate is imported even if its day couldn't be priced — a row with no price is
    // still real ledger data the user can fill in via the edit sheet, not silently dropped.
    const portfolio = activePortfolio();
    portfolio.transactions ||= [];
    let missingPriceCount = 0;
    for (const c of candidates) {
      const dayPrice = priceByDay[c.day];
      if (dayPrice === null || dayPrice === undefined) missingPriceCount += 1;
      portfolio.transactions.push({
        id: nowId(),
        type: c.isOutgoing ? "sell" : "buy",
        amountKas: c.amountKas,
        fiatValue: c.amountKas * (dayPrice || 0),
        timestamp: c.timestamp,
        notes: dayPrice === null || dayPrice === undefined ? PRICE_UNAVAILABLE_NOTE : null,
        sourceAddress: address,
        sourceTxId: c.txId,
      });
    }
    saveState();
    render();
    setImportProgress(
      `Imported ${candidates.length} transaction${candidates.length === 1 ? "" : "s"}` +
      (missingPriceCount ? ` (${missingPriceCount} still need a price — marked with ⚠).` : "."),
    );
  } catch (error) {
    setImportProgress(`Import failed: ${error.message}`);
  } finally {
    addressImport.busy = false;
    const startBtn = modalsEl.querySelector("[data-portfolio-import-start]");
    if (startBtn) startBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Modals (transaction editor + address import) — live outside rootEl so render() can't wipe them
// ---------------------------------------------------------------------------

function buildModals() {
  modalsEl = document.createElement("div");
  modalsEl.innerHTML = `
    <div class="modal-backdrop" data-portfolio-editor-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Transaction">
        <div class="modal-header">
          <div><p class="modal-kicker">Portfolio</p><h2 data-portfolio-editor-title>Add Transaction</h2></div>
          <button class="modal-close" type="button" data-portfolio-editor-close aria-label="Close">×</button>
        </div>
        <div class="portfolio-editor-body">
          <label class="portfolio-editor-field">
            <span>Type</span>
            <select data-portfolio-editor-type>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </label>
          <label class="portfolio-editor-field">
            <span>Amount (KAS)</span>
            <input type="number" step="any" min="0" placeholder="0.0" data-portfolio-editor-amount />
          </label>
          <label class="portfolio-editor-field">
            <span>Total Value (USD)</span>
            <input type="number" step="any" min="0" placeholder="0.00" data-portfolio-editor-fiat />
          </label>
          <p class="portfolio-editor-hint" data-portfolio-editor-hint></p>
          <label class="portfolio-editor-field">
            <span>Date</span>
            <input type="datetime-local" data-portfolio-editor-date />
          </label>
          <label class="portfolio-editor-field">
            <span>Notes</span>
            <input type="text" maxlength="120" placeholder="Optional" data-portfolio-editor-notes />
          </label>
        </div>
        <div class="modal-actions portfolio-editor-actions">
          <button class="secondary-button" type="button" data-portfolio-editor-delete hidden>Delete</button>
          <button class="primary-button" type="button" data-portfolio-editor-save>Save</button>
        </div>
      </div>
    </div>

    <div class="modal-backdrop" data-portfolio-import-modal hidden>
      <div class="contact-modal portfolio-editor-modal" role="dialog" aria-modal="true" aria-label="Add Kaspa Address">
        <div class="modal-header">
          <div><p class="modal-kicker">Portfolio</p><h2>Add Kaspa Address</h2></div>
          <button class="modal-close" type="button" data-portfolio-import-close aria-label="Close">×</button>
        </div>
        <div class="portfolio-editor-body">
          <p class="portfolio-import-note">Imports this address's on-chain history: every received transaction becomes a buy and every sent one a sell, priced at that day's KAS price. Re-running later only adds new activity.</p>
          <label class="portfolio-editor-field">
            <span>Kaspa Address</span>
            <input type="text" placeholder="kaspa:…" data-portfolio-import-address spellcheck="false" autocomplete="off" />
          </label>
          <p class="portfolio-import-progress" data-portfolio-import-progress></p>
        </div>
        <div class="modal-actions">
          <button class="primary-button" type="button" data-portfolio-import-start>Import</button>
        </div>
      </div>
    </div>

    <input type="file" accept=".csv,text/csv" data-portfolio-csv-input hidden />`;
  document.body.appendChild(modalsEl);

  modalsEl.addEventListener("click", (event) => {
    if (event.target.closest("[data-portfolio-editor-close]")) { closeTxEditor(); return; }
    if (event.target.closest("[data-portfolio-editor-save]")) { saveTxEditor(); return; }
    if (event.target.closest("[data-portfolio-editor-delete]")) {
      if (editingTx?.id && window.confirm("Delete this transaction?")) {
        const portfolio = activePortfolio();
        portfolio.transactions = (portfolio.transactions || []).filter((t) => t.id !== editingTx.id);
        saveState();
        closeTxEditor();
        render();
      }
      return;
    }
    if (event.target.closest("[data-portfolio-import-close]")) {
      if (!addressImport?.busy) {
        addressImport = null;
        modalsEl.querySelector("[data-portfolio-import-modal]").hidden = true;
      }
      return;
    }
    if (event.target.closest("[data-portfolio-import-start]")) {
      if (addressImport && !addressImport.busy) {
        runAddressImport(modalsEl.querySelector("[data-portfolio-import-address]")?.value);
      }
    }
  });

  modalsEl.addEventListener("input", (event) => {
    if (event.target.closest("[data-portfolio-editor-amount], [data-portfolio-editor-fiat]")) updateEditorHint();
  });

  modalsEl.querySelector("[data-portfolio-csv-input]").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    const imported = importCsvText(text);
    deps.showToast?.(imported > 0 ? `Imported ${imported} row${imported === 1 ? "" : "s"}.` : "No KAS rows found in that CSV.");
  });
}

// ---------------------------------------------------------------------------
// Data refresh
// ---------------------------------------------------------------------------

async function refreshData({ force = false } = {}) {
  if (loading) return;
  loading = true;
  render();
  try {
    const [priceResult, historyResult, sevenDayResult] = await Promise.all([
      fetchKasPrice({ force }).catch(() => price),
      fetchKasPriceHistory(rangeDays).catch(() => history),
      rangeDays === 7 ? null : fetchKasPriceHistory(7).catch(() => sevenDayHistory),
    ]);
    price = priceResult || price;
    history = historyResult || history;
    sevenDayHistory = rangeDays === 7 ? (historyResult || sevenDayHistory) : (sevenDayResult || sevenDayHistory);
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
    fiatValue: Number(fiatValue) || 0,
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

function closeCardMenus(except = null) {
  rootEl.querySelectorAll("[data-portfolio-card-actions]").forEach((el) => {
    if (el.dataset.portfolioCardActions !== except) el.hidden = true;
  });
  const io = rootEl.querySelector("[data-portfolio-io-dropdown]");
  if (io && except !== "io") io.hidden = true;
}

export function initPortfolio(dependencies) {
  deps = dependencies;
  rootEl = document.querySelector("[data-portfolio-root]");
  loadState();
  ensureDefaultPortfolio();
  buildModals();

  document.addEventListener("click", (event) => {
    // Any click outside the portfolio pane's menus closes them.
    if (!rootEl || rootEl.contains(event.target)) return;
    closeCardMenus();
  });

  rootEl?.addEventListener("click", (event) => {
    const cardMenu = event.target.closest("[data-portfolio-card-menu]");
    if (cardMenu) {
      const id = cardMenu.dataset.portfolioCardMenu;
      const actions = rootEl.querySelector(`[data-portfolio-card-actions="${id}"]`);
      const wasHidden = actions?.hidden;
      closeCardMenus();
      if (actions) actions.hidden = !wasHidden;
      return;
    }

    const rename = event.target.closest("[data-portfolio-rename]");
    if (rename) {
      const portfolio = state.portfolios.find((p) => p.id === rename.dataset.portfolioRename);
      if (portfolio) {
        const name = window.prompt("Rename portfolio:", portfolio.name);
        if (name?.trim()) { portfolio.name = name.trim(); saveState(); }
      }
      render();
      return;
    }

    const del = event.target.closest("[data-portfolio-delete]");
    if (del) {
      const portfolio = state.portfolios.find((p) => p.id === del.dataset.portfolioDelete);
      if (portfolio && state.portfolios.length > 1 &&
          window.confirm(`Delete "${portfolio.name}" and its ${(portfolio.transactions || []).length} transactions? This can't be undone.`)) {
        state.portfolios = state.portfolios.filter((p) => p.id !== portfolio.id);
        if (state.activeId === portfolio.id) state.activeId = state.portfolios[0].id;
        saveState();
      }
      render();
      return;
    }

    if (event.target.closest("[data-portfolio-add]")) {
      if (state.portfolios.length >= MAX_PORTFOLIOS) return;
      const name = window.prompt("Portfolio name:", `Portfolio ${state.portfolios.length + 1}`);
      if (name?.trim()) {
        const p = { id: nowId(), name: name.trim(), transactions: [] };
        state.portfolios.push(p);
        state.activeId = p.id;
        saveState(); render();
      }
      return;
    }

    const select = event.target.closest("[data-portfolio-select]");
    if (select) { state.activeId = select.dataset.portfolioSelect; saveState(); render(); return; }

    const range = event.target.closest("[data-portfolio-range]");
    if (range) { rangeDays = Number(range.dataset.portfolioRange) || 7; refreshData(); return; }

    if (event.target.closest("[data-portfolio-refresh]")) { refreshData({ force: true }); return; }

    if (event.target.closest("[data-portfolio-tx-add]")) { openTxEditor(null); return; }

    if (event.target.closest("[data-portfolio-io-menu]")) {
      const dropdown = rootEl.querySelector("[data-portfolio-io-dropdown]");
      const wasHidden = dropdown?.hidden;
      closeCardMenus("io");
      if (dropdown) dropdown.hidden = !wasHidden;
      return;
    }
    if (event.target.closest("[data-portfolio-export-csv]")) { closeCardMenus(); exportCsv(); return; }
    if (event.target.closest("[data-portfolio-import-csv]")) {
      closeCardMenus();
      modalsEl.querySelector("[data-portfolio-csv-input]")?.click();
      return;
    }
    if (event.target.closest("[data-portfolio-io-address]")) {
      closeCardMenus();
      addressImport = { busy: false, progress: "" };
      modalsEl.querySelector("[data-portfolio-import-address]").value = "";
      setImportProgress("");
      modalsEl.querySelector("[data-portfolio-import-modal]").hidden = false;
      return;
    }

    const txDelete = event.target.closest("[data-portfolio-tx-delete]");
    if (txDelete) {
      if (window.confirm("Delete this transaction?")) {
        const portfolio = activePortfolio();
        portfolio.transactions = (portfolio.transactions || []).filter((t) => t.id !== txDelete.dataset.portfolioTxDelete);
        saveState(); render();
      }
      return;
    }

    const txEdit = event.target.closest("[data-portfolio-tx-edit]");
    if (txEdit) { openTxEditor(txEdit.dataset.portfolioTxEdit); return; }

    closeCardMenus();
  });

  render();
}
