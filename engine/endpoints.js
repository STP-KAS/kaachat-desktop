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
  pushIndexer: "https://kachat.duckdns.org",
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

// In the Vite dev browser, the Kasia indexer (indexer.kasia.wtf) sends no CORS headers,
// so direct fetch() calls are blocked. Group chat and 1:1 sync REQUIRE this host, so we
// transparently reroute every kasia.wtf request through the same-origin /nc-proxy
// middleware (see vite.config.mjs), which forwards it server-side where CORS does not
// apply. Wrapping fetch once — rather than rewriting URLs in getEndpoint() — covers ALL
// call sites (sync.js, group-indexer.js, messages.js, and the settings input path) and
// keeps the URLs real https:// everywhere else, so normalizeBaseUrl and native/packaged
// builds (which have no CORS) still hit the host directly. No-op outside dev.
function installDevIndexerProxy() {
  // NOTE: Vite string-replaces the literal token `import.meta.env.DEV` at transform time.
  // Optional chaining (import.meta?.env?.DEV) does NOT match that token, so it would be
  // left to evaluate at runtime where `import.meta.env` doesn't exist — silently yielding
  // false and disabling the proxy. Keep this as the exact literal token.
  let dev = false;
  try { dev = Boolean(import.meta.env.DEV); } catch { dev = false; }
  if (!dev || typeof window === "undefined" || typeof window.fetch !== "function" || window.__kasiaDevProxyInstalled) return;
  window.__kasiaDevProxyInstalled = true;
  console.info("[kachat] indexer dev-proxy active — kasia.wtf requests routed through /nc-proxy");
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
      if (rawUrl) {
        const parsed = new URL(rawUrl, window.location.origin);
        if (/(^|\.)kasia\.wtf$/i.test(parsed.hostname)) {
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
