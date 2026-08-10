// KAS price data via CoinGecko's public API, with a localStorage cache so the portfolio
// doesn't hammer the endpoint (10-minute refresh floor, mirroring the KNS cache policy).

const PRICE_CACHE_KEY = "kachat-kas-price-cache-v1";
const HISTORY_CACHE_KEY = "kachat-kas-price-history-cache-v1";
const MIN_REFRESH_MS = 10 * 60 * 1000;

function readCache(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function writeCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

/** Current KAS price. Returns `{ usd, change24h, fetchedAt }` (cached up to 10 minutes). */
export async function fetchKasPrice({ force = false } = {}) {
  const cached = readCache(PRICE_CACHE_KEY);
  if (!force && cached && Date.now() - cached.fetchedAt < MIN_REFRESH_MS) return cached;
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=kaspa&vs_currencies=usd&include_24hr_change=true";
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) {
    if (cached) return cached; // stale beats nothing
    throw new Error(`Price lookup failed (${response.status}).`);
  }
  const json = await response.json();
  const result = {
    usd: Number(json?.kaspa?.usd) || 0,
    change24h: Number(json?.kaspa?.usd_24h_change) || 0,
    fetchedAt: Date.now(),
  };
  writeCache(PRICE_CACHE_KEY, result);
  return result;
}

/** Price history for `days` (1|7|30|90|365). Returns `[[timestampMs, priceUsd], ...]`. */
export async function fetchKasPriceHistory(days = 7) {
  const cacheAll = readCache(HISTORY_CACHE_KEY) || {};
  const cached = cacheAll[String(days)];
  if (cached && Date.now() - cached.fetchedAt < MIN_REFRESH_MS) return cached.points;
  const url = `https://api.coingecko.com/api/v3/coins/kaspa/market_chart?vs_currency=usd&days=${encodeURIComponent(days)}`;
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) {
    if (cached) return cached.points;
    throw new Error(`Price history lookup failed (${response.status}).`);
  }
  const json = await response.json();
  const points = Array.isArray(json?.prices) ? json.prices : [];
  cacheAll[String(days)] = { points, fetchedAt: Date.now() };
  writeCache(HISTORY_CACHE_KEY, cacheAll);
  return points;
}
