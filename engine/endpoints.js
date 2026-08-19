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
  // KaChat's own indexer (kachat.duckdns.org) is now the default chat/message + group-chat
  // indexer, matching iOS/Android. In the Vite dev browser it's routed through the same-origin
  // dev proxy (see vite.config.mjs / installDevIndexerProxy) in case any endpoint lacks CORS.
  kasiaIndexer: "https://kachat.duckdns.org",
  kapostIndexer: "https://kachat.duckdns.org",
  broadcastIndexer: "https://kachat.duckdns.org",
  pushIndexer: "https://kachat.duckdns.org",
  knsApi: "https://api.knsdomains.org/mainnet/api/v1",
  trustedNode: "",
});

// Retired / superseded chat-indexer defaults. Drop any stored override still pointing at one of
// these so it falls back to the current default (kachat.duckdns.org): indexer.kasia.fyi is offline,
// and indexer.kasia.wtf was the previous default now replaced by KaChat's own indexer.
const RETIRED_INDEXER_URLS = ["https://indexer.kasia.fyi", "https://indexer.kasia.wtf"];

function loadStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(ENDPOINTS_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

let overrides = loadStored();

(function migrateRetiredIndexer() {
  const current = overrides.kasiaIndexer;
  if (current != null && RETIRED_INDEXER_URLS.includes(String(current).trim().replace(/\/+$/, ""))) {
    delete overrides.kasiaIndexer;
    try { localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(overrides)); } catch {}
  }
})();

// In the Vite dev browser, the chat indexers may send no CORS headers, so direct fetch() calls
// would be blocked. Group chat and 1:1 sync REQUIRE these hosts, so we transparently reroute every
// request to the indexer hosts (kachat.duckdns.org — the current default — and the legacy
// kasia.wtf, still valid as a manual override) through the same-origin /nc-proxy middleware (see
// vite.config.mjs), which forwards it server-side where CORS does not apply. Wrapping fetch once —
// rather than rewriting URLs in getEndpoint() — covers ALL call sites (sync.js, group-indexer.js,
// messages.js, kaposts.js, broadcasts.js, and the settings input path) and keeps the URLs real
// https:// everywhere else, so normalizeBaseUrl and native/packaged builds (which have no CORS)
// still hit the host directly. No-op outside dev.
// api.kaspa.org rides through the proxy too: its RATE-LIMIT/error responses carry no CORS
// headers, so direct browser fetches degrade into a wall of red CORS noise the moment a
// balance-lookup burst trips its limiter. Server-side forwarding has no CORS at all.
const INDEXER_PROXY_HOST_RE = /(^|\.)kasia\.wtf$|(^|\.)kachat\.duckdns\.org$|^api\.kaspa\.org$/i;
function installDevIndexerProxy() {
  // NOTE: Vite string-replaces the literal token `import.meta.env.DEV` at transform time.
  // Optional chaining (import.meta?.env?.DEV) does NOT match that token, so it would be
  // left to evaluate at runtime where `import.meta.env` doesn't exist — silently yielding
  // false and disabling the proxy. Keep this as the exact literal token.
  let dev = false;
  try { dev = Boolean(import.meta.env.DEV); } catch { dev = false; }
  if (!dev || typeof window === "undefined" || typeof window.fetch !== "function" || window.__kasiaDevProxyInstalled) return;
  window.__kasiaDevProxyInstalled = true;
  console.info("[kachat] indexer dev-proxy active — indexer requests routed through /nc-proxy");
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
      if (rawUrl) {
        const parsed = new URL(rawUrl, window.location.origin);
        if (INDEXER_PROXY_HOST_RE.test(parsed.hostname)) {
          const proxied = `/nc-proxy/${encodeURIComponent(parsed.origin)}${parsed.pathname}${parsed.search}`;
          if (typeof input === "string") return nativeFetch(proxied, init);
          return nativeFetch(new Request(proxied, input), init);
        }
      }
    } catch { /* fall through to native fetch */ }
    return nativeFetch(input, init);
  };
}
installDevIndexerProxy();

function persist() {
  try { localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(overrides)); } catch {}
}

// Returns the effective endpoint for a key (override if set and non-empty, else
// the default). Trailing slashes are trimmed so callers can append paths safely.
export function getEndpoint(key) {
  const value = overrides[key];
  const resolved = (value != null && String(value).trim()) ? String(value).trim() : (ENDPOINT_DEFAULTS[key] || "");
  return resolved.replace(/\/+$/, "");
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
