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
  kasiaIndexer: "https://indexer.kasia.fyi",
  kapostIndexer: "https://kachat.duckdns.org",
  broadcastIndexer: "https://kachat.duckdns.org",
  pushIndexer: "https://indexer.kasia.fyi",
  knsApi: "https://api.knsdomains.org/mainnet/api/v1",
  trustedNode: "",
});

function loadStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(ENDPOINTS_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

let overrides = loadStored();

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
