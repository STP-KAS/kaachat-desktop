// Central, user-configurable endpoint registry (Settings > Connectivity). Every
// hardcoded API base now reads through here, so the defaults below reproduce the
// exact current behavior — nothing changes unless the user edits a field.
//
// Keys mirror iOS's AppSettings connectivity fields:
//   kaspaApi     — Kaspa REST API (api.kaspa.org): balances, tx history, fees
//   kasiaIndexer — Kasia message indexer (COMM message query)
//   pushIndexer  — Kasia push/notification indexer
//   knsApi       — KNS domain/profile API
//   trustedNode  — wRPC node endpoint ("" = auto-discover via the resolver)
const ENDPOINTS_KEY = "kachat-endpoints-v1";

export const ENDPOINT_DEFAULTS = Object.freeze({
  kaspaApi: "https://api.kaspa.org",
  // indexer.kasia.wtf is now the only live Kasia indexer (and the only one with the
  // group-chat REST endpoints). It sends no CORS headers, but the desktop browser can't
  // fetch it directly anyway, so getEndpoint() routes it through the same-origin dev
  // proxy (see vite.config.mjs). Matches iOS/Android's default.
  kasiaIndexer: "https://indexer.kasia.wtf",
  kapostIndexer: "https://kachat.duckdns.org",
  broadcastIndexer: "https://kachat.duckdns.org",
  pushIndexer: "https://indexer.kasia.wtf",
  knsApi: "https://api.knsdomains.org/mainnet/api/v1",
  trustedNode: "",
});

// The retired indexer (indexer.kasia.fyi) is no longer live. Drop any stored override
// still pointing there so it falls back to the current default.
const RETIRED_INDEXER_URL = "https://indexer.kasia.fyi";

function loadStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(ENDPOINTS_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

let overrides = loadStored();

(function migrateRetiredIndexer() {
  const current = overrides.kasiaIndexer;
  if (current != null && String(current).trim().replace(/\/+$/, "") === RETIRED_INDEXER_URL) {
    delete overrides.kasiaIndexer;
    try { localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(overrides)); } catch {}
  }
})();

// In the Vite dev browser, a CORS-less indexer (indexer.kasia.wtf) can't be fetched
// directly. Route it through the same-origin /nc-proxy middleware, which forwards the
// request server-side where CORS does not apply. Left untouched outside dev (native /
// packaged builds have no CORS) and for hosts that already allow CORS.
function toDevProxy(url) {
  try {
    if (!import.meta?.env?.DEV) return url;
  } catch { return url; }
  try {
    const parsed = new URL(url);
    if (/(^|\.)kasia\.wtf$/i.test(parsed.hostname)) {
      const path = parsed.pathname === "/" ? "" : parsed.pathname;
      return `/nc-proxy/${encodeURIComponent(parsed.origin)}${path}`;
    }
  } catch { /* not an absolute URL — leave as-is */ }
  return url;
}

function persist() {
  try { localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(overrides)); } catch {}
}

// Returns the effective endpoint for a key (override if set and non-empty, else
// the default). Trailing slashes are trimmed so callers can append paths safely.
export function getEndpoint(key) {
  const value = overrides[key];
  const resolved = (value != null && String(value).trim()) ? String(value).trim() : (ENDPOINT_DEFAULTS[key] || "");
  return toDevProxy(resolved.replace(/\/+$/, ""));
}

export function getEndpoints() {
  const out = {};
  for (const key of Object.keys(ENDPOINT_DEFAULTS)) out[key] = getEndpoint(key);
  return out;
}

// Raw stored override for a key (may be "" if the user cleared it). Used by the
// settings UI to show exactly what the user typed vs. the default.
export function getEndpointOverride(key) {
  return overrides[key] != null ? String(overrides[key]) : "";
}

export function setEndpoint(key, value) {
  if (!(key in ENDPOINT_DEFAULTS)) return;
  const clean = String(value ?? "").trim();
  if (!clean || clean === ENDPOINT_DEFAULTS[key]) delete overrides[key];
  else overrides[key] = clean;
  persist();
}

export function resetEndpoints() {
  overrides = {};
  persist();
}
