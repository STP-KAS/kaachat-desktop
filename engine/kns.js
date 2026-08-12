// KNS (Kaspa Name Service) read-path integration — resolution, reverse
// resolution, domain listing, and profile fetching against the real,
// centralized KNS indexer API. Ported to match KaChat iOS/Android exactly
// (verified against KNSService.swift and KnsService.kt): every endpoint
// returns {success, data, message?, error?}; HTTP 404 means "not found", not
// an error; all field names are camelCase.
//
// Domain REGISTRATION and profile EDITING (on-chain commit/reveal
// inscriptions that spend real KAS) are a separate, later module — this file
// is read-only and makes no on-chain transactions.

export const KNS_DEFAULT_MAINNET_URL = "https://api.knsdomains.org/mainnet/api/v1";
export const KNS_DEFAULT_TESTNET_URL = "https://api.knsdomains.org/tn10/api/v1";

const DOMAIN_CACHE_KEY = "kachat-kns-domain-cache-v1";
const PROFILE_CACHE_KEY = "kachat-kns-profile-cache-v1";
const MIN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_BACKOFF_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

export const KNS_PROFILE_FIELD_KEYS = Object.freeze([
  "avatarUrl", "bannerUrl", "bio", "x", "website", "telegram", "discord", "contactEmail", "github", "redirectUrl",
]);

export const KNS_PROFILE_FIELD_LABELS = Object.freeze({
  redirectUrl: "Redirect",
  avatarUrl: "Avatar",
  bannerUrl: "Banner",
  bio: "Bio",
  x: "X",
  website: "Website",
  telegram: "Telegram",
  discord: "Discord",
  contactEmail: "Email",
  github: "GitHub",
});

// --- domain name / input normalization ------------------------------------

// Strips scheme/path/query/fragment/trailing dots and lowercases, ensuring a
// .kas suffix — matches iOS's normalizeDomainName exactly (needed since some
// legacy cached values look like "http://name.kas").
export function normalizeDomainName(raw) {
  if (!raw) return null;
  let value = String(raw).trim().toLowerCase();
  if (!value) return null;

  const schemeIndex = value.indexOf("://");
  if (schemeIndex !== -1) value = value.slice(schemeIndex + 3);
  const slash = value.indexOf("/");
  if (slash !== -1) value = value.slice(0, slash);
  const query = value.indexOf("?");
  if (query !== -1) value = value.slice(0, query);
  const hash = value.indexOf("#");
  if (hash !== -1) value = value.slice(0, hash);
  while (value.endsWith(".")) value = value.slice(0, -1);
  if (!value) return null;
  if (!value.endsWith(".kas")) value += ".kas";
  return value;
}

// A conservative label charset (matches iOS, not Android's Unicode-accepting one).
const LABEL_CHARSET = /^[a-z0-9-]+$/;

// Normalizes user input to a KNS label (without .kas) for inscription/lookup use.
export function normalizeDomainLabel(raw) {
  let value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  if (value.endsWith(".kas")) value = value.slice(0, -4);
  if (!value) return null;
  if (value.startsWith("-") || value.endsWith("-")) return null;
  if (!LABEL_CHARSET.test(value)) return null;
  return value;
}

// Heuristic: is this input a KNS domain (vs. a raw kaspa: address)?
export function looksLikeDomain(input) {
  const trimmed = String(input || "").trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith("kaspa:") || trimmed.startsWith("kaspatest:")) return false;
  if (trimmed.endsWith(".kas")) return true;
  return /^[a-z0-9-_]+$/.test(trimmed);
}

// --- low-level HTTP ---------------------------------------------------------

async function fetchJson(url, { method = "GET", body = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    if (response.status === 404) return { ok: true, notFound: true, status: 404, json: null };
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: response.ok, notFound: false, status: response.status, json, rawText: text };
  } catch (error) {
    return { ok: false, notFound: false, status: 0, json: null, error };
  } finally {
    clearTimeout(timer);
  }
}

function apiUrl(baseUrl, path) {
  const base = String(baseUrl || KNS_DEFAULT_MAINNET_URL).replace(/\/+$/, "");
  return `${base}${path}`;
}

// --- forward resolution: "alice.kas" -> address ----------------------------

export async function resolveDomain(domainInput, { baseUrl = KNS_DEFAULT_MAINNET_URL } = {}) {
  const fullDomain = normalizeDomainName(domainInput);
  if (!fullDomain) return null;
  const url = apiUrl(baseUrl, `/${encodeURIComponent(fullDomain)}/owner`);
  const result = await fetchJson(url);
  if (result.notFound || !result.ok || !result.json) return null;
  const data = result.json.data;
  if (!result.json.success || !data?.owner || data?.asset !== fullDomain) return null;
  return { domain: fullDomain, ownerAddress: data.owner, inscriptionId: data.id || null };
}

// --- reverse resolution: address -> explicit primary domain ----------------

async function fetchPrimaryNameResult(address, baseUrl) {
  const url = apiUrl(baseUrl, `/primary-name/${encodeURIComponent(address)}`);
  const result = await fetchJson(url);
  if (result.notFound) return { domain: null, inscriptionId: null, hadError: false };
  if (!result.ok || !result.json) return { domain: null, inscriptionId: null, hadError: true };
  if (!result.json.success || !result.json.data?.domain) return { domain: null, inscriptionId: null, hadError: false };
  const domain = normalizeDomainName(result.json.data.domain.fullName);
  const inscriptionId = String(result.json.data.inscriptionId || "").trim() || null;
  return { domain, inscriptionId, hadError: false };
}

// --- all domains owned by an address ---------------------------------------

async function fetchAllDomainsResult(address, baseUrl) {
  const url = `${apiUrl(baseUrl, "/assets")}?${new URLSearchParams({ owner: address, type: "domain", pageSize: "100" })}`;
  const result = await fetchJson(url);
  if (!result.ok || !result.json) return { domains: [], hadError: true };
  if (!result.json.success || !Array.isArray(result.json.data?.assets)) return { domains: [], hadError: false };

  const domains = result.json.data.assets
    .filter((asset) => asset?.isDomain && asset?.isVerifiedDomain)
    .map((asset) => {
      const fullName = normalizeDomainName(asset.asset);
      if (!fullName) return null;
      const createdAtMs = Date.parse(asset.creationBlockTime || "");
      return {
        fullName,
        inscriptionId: asset.assetId,
        createdAt: Number.isFinite(createdAtMs) ? createdAtMs : 0,
        isVerified: Boolean(asset.isVerifiedDomain),
        status: asset.status || "default",
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
  return { domains, hadError: false };
}

// --- profile fetch for a specific domain (by assetId) -----------------------

async function fetchDomainProfileResult(assetId, baseUrl, keys) {
  let url = apiUrl(baseUrl, `/domain/${encodeURIComponent(assetId)}/profile`);
  if (keys?.length) url += `?${new URLSearchParams({ keys: keys.join(",") })}`;
  const result = await fetchJson(url);
  if (result.notFound) return { profileData: null, hadError: false };
  if (!result.ok || !result.json) return { profileData: null, hadError: true };
  if (!result.json.success) return { profileData: null, hadError: false };
  return { profileData: result.json.data || null, hadError: false };
}

// Direct profile lookup by assetId (not by address) — used by the write path
// to poll for confirmation of a just-submitted profile field edit, where the
// target domain is already known and there's no need to re-resolve it.
export async function fetchProfileByAssetId(assetId, { baseUrl = KNS_DEFAULT_MAINNET_URL, keys = null } = {}) {
  const { profileData, hadError } = await fetchDomainProfileResult(assetId, baseUrl, keys);
  if (hadError) throw new Error("Could not reach the KNS indexer.");
  return profileData?.profile ? sanitizeProfile(profileData.profile) : null;
}

function sanitizeProfile(rawProfile) {
  const profile = {};
  for (const key of KNS_PROFILE_FIELD_KEYS) {
    const value = rawProfile?.[key];
    const trimmed = typeof value === "string" ? value.trim() : "";
    profile[key] = trimmed || null;
  }
  return profile;
}

export function profileHasAnyField(profile) {
  if (!profile) return false;
  return KNS_PROFILE_FIELD_KEYS.some((key) => Boolean(profile[key]));
}

// profile fields relevant to the "More Info" disclosure — excludes the two
// image URLs, which are shown separately as the avatar/banner themselves.
export function profileHasDetailFields(profile) {
  if (!profile) return false;
  return ["bio", "x", "website", "telegram", "discord", "contactEmail", "github", "redirectUrl"]
    .some((key) => Boolean(profile[key]));
}

function domainProfileFullName(profileData) {
  if (!profileData?.name) return null;
  const tld = profileData.tld || "kas";
  return `${profileData.name}.${tld}`.toLowerCase();
}

// --- persistent cache, matching iOS's debounce + exponential backoff -------

function loadJsonMap(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveJsonMap(key, map) {
  try { localStorage.setItem(key, JSON.stringify(map)); return; } catch { /* quota — prune below */ }
  // Storage is full (e.g. right after a large phone-backup import). Silently dropping the
  // write would forget every cached "this address has no domain" answer, so each reload
  // re-fires a 404 lookup per contact — keep the newest entries and retry instead.
  try {
    const pruned = Object.fromEntries(
      Object.entries(map)
        .sort((a, b) => (b[1]?.fetchedAt || 0) - (a[1]?.fetchedAt || 0))
        .slice(0, 300),
    );
    localStorage.setItem(key, JSON.stringify(pruned));
  } catch { /* still no room — the in-memory cache prevents refetches this session */ }
}

let domainCache = loadJsonMap(DOMAIN_CACHE_KEY);
let profileCache = loadJsonMap(PROFILE_CACHE_KEY);
const lastAttemptAt = new Map();
const failureCounts = new Map();
const lastProfileAttemptAt = new Map();
const profileFailureCounts = new Map();
// Map<address, Promise> rather than a Set: concurrent callers for the same
// address (e.g. the chat list's background refresh and a just-opened
// conversation's own refresh both firing near-simultaneously) must await the
// SAME in-flight request and see its real result, not short-circuit back to
// whatever was cached (possibly nothing) before that request resolves.
const pendingFetches = new Map();
const pendingProfileFetches = new Map();

function backoffFor(address, attemptMap, failureMap) {
  const last = attemptMap.get(address);
  if (!last) return true;
  const failures = failureMap.get(address) || 0;
  const backoff = Math.min(MAX_BACKOFF_INTERVAL_MS, MIN_REFRESH_INTERVAL_MS * 2 ** failures);
  return Date.now() - last >= backoff;
}

async function fetchAddressInfoWork(address, baseUrl) {
  const [primary, allDomainsResult] = await Promise.all([
    fetchPrimaryNameResult(address, baseUrl),
    fetchAllDomainsResult(address, baseUrl),
  ]);
  const hadError = primary.hadError || allDomainsResult.hadError;
  failureCounts.set(address, hadError ? (failureCounts.get(address) || 0) + 1 : 0);

  if (hadError && domainCache[address]) return domainCache[address];

  const allDomains = allDomainsResult.domains;
  if (!allDomains.length && !primary.domain) {
    const info = { address, primaryDomain: null, primaryInscriptionId: null, allDomains: [], explicitPrimaryDomain: null, explicitPrimaryInscriptionId: null, fetchedAt: Date.now() };
    domainCache[address] = info;
    saveJsonMap(DOMAIN_CACHE_KEY, domainCache);
    return info;
  }

  const finalPrimary = primary.domain || allDomains[0]?.fullName || null;
  let finalPrimaryInscriptionId = primary.inscriptionId;
  if (!finalPrimaryInscriptionId && finalPrimary) {
    finalPrimaryInscriptionId = allDomains.find((entry) => entry.fullName === finalPrimary)?.inscriptionId || null;
  }
  const info = {
    address,
    primaryDomain: finalPrimary,
    primaryInscriptionId: finalPrimaryInscriptionId,
    allDomains,
    explicitPrimaryDomain: primary.domain,
    explicitPrimaryInscriptionId: primary.inscriptionId || null,
    fetchedAt: Date.now(),
  };
  domainCache[address] = info;
  saveJsonMap(DOMAIN_CACHE_KEY, domainCache);
  return info;
}

// Fetches address info (primary domain + all owned domains), always hitting
// the network — matches iOS's fetchInfo. Concurrent calls for the same
// address share and await the same in-flight request rather than each
// starting their own or returning a possibly-stale cache snapshot. Applies
// the same fallback chain: explicit primary, or the most recently created
// owned domain.
export async function fetchAddressInfo(address, { baseUrl = KNS_DEFAULT_MAINNET_URL } = {}) {
  const existing = pendingFetches.get(address);
  if (existing) return existing;

  lastAttemptAt.set(address, Date.now());
  const promise = fetchAddressInfoWork(address, baseUrl).finally(() => {
    pendingFetches.delete(address);
  });
  pendingFetches.set(address, promise);
  return promise;
}

// Cache-first read; only hits the network if nothing is cached yet.
export async function getAddressInfo(address, options) {
  if (domainCache[address]) return domainCache[address];
  const existing = pendingFetches.get(address);
  if (existing) return existing;
  return fetchAddressInfo(address, options);
}

// How many owned domains to probe (in most-recently-created order) looking
// for one with actual profile content, when there's no explicit primary to
// anchor on. Bounds worst-case latency for addresses that own many domains.
const PROFILE_FALLBACK_SCAN_LIMIT = 8;

async function fetchAddressProfileWork(address, baseUrl) {
  let domainInfo = domainCache[address];
  if (!domainInfo) domainInfo = await fetchAddressInfo(address, { baseUrl });

  let target = null;
  if (domainInfo) {
    // Prefer the explicit, on-chain primary if one is set — that's the
    // address's own deliberate choice of "which domain represents me."
    const explicitAssetId = String(domainInfo.explicitPrimaryInscriptionId || "").trim();
    if (explicitAssetId) {
      const matched = domainInfo.allDomains.find((entry) => entry.inscriptionId === explicitAssetId);
      target = matched ? { assetId: matched.inscriptionId, domainName: matched.fullName } : { assetId: explicitAssetId, domainName: domainInfo.explicitPrimaryDomain };
    } else if (domainInfo.explicitPrimaryDomain) {
      const matched = domainInfo.allDomains.find((entry) => entry.fullName === domainInfo.explicitPrimaryDomain);
      if (matched) target = { assetId: matched.inscriptionId, domainName: matched.fullName };
    }
  }

  let profileData = null;
  let hadError = false;
  if (target) {
    ({ profileData, hadError } = await fetchDomainProfileResult(target.assetId, baseUrl));
  } else if (domainInfo?.allDomains?.length) {
    // No explicit primary — rather than guessing "most recently created"
    // (which just as easily picks a domain with no profile filled in at
    // all), check owned domains for the first one that actually has profile
    // content (an avatar, bio, or any other field set). Fetched in parallel
    // (not one at a time) so this costs one round-trip's worth of latency
    // regardless of how many domains are owned, not N round trips.
    const candidates = domainInfo.allDomains.slice(0, PROFILE_FALLBACK_SCAN_LIMIT);
    const results = await Promise.all(candidates.map((candidate) => fetchDomainProfileResult(candidate.inscriptionId, baseUrl)));
    hadError = results.some((result) => result.hadError);
    for (let i = 0; i < candidates.length; i += 1) {
      const result = results[i];
      if (result.profileData?.profile && profileHasAnyField(sanitizeProfile(result.profileData.profile))) {
        target = { assetId: candidates[i].inscriptionId, domainName: candidates[i].fullName };
        profileData = result.profileData;
        break;
      }
    }
    if (!target) {
      // Nothing had any content — fall back to the most recent domain so
      // the contact still shows as "a KNS domain owner," just with an empty profile.
      const fallback = domainInfo.allDomains[0];
      target = { assetId: fallback.inscriptionId, domainName: fallback.fullName };
      profileData = results[0]?.profileData ?? null;
    }
  }

  profileFailureCounts.set(address, hadError ? (profileFailureCounts.get(address) || 0) + 1 : 0);
  if (!target) {
    const info = { address, domainName: null, assetId: null, profile: null, fetchedAt: Date.now() };
    profileCache[address] = info;
    saveJsonMap(PROFILE_CACHE_KEY, profileCache);
    return info;
  }
  if (hadError && profileCache[address]) return profileCache[address];

  const info = {
    address,
    domainName: domainProfileFullName(profileData) || target.domainName,
    assetId: target.assetId,
    profile: profileData?.profile ? sanitizeProfile(profileData.profile) : null,
    fetchedAt: Date.now(),
  };
  profileCache[address] = info;
  saveJsonMap(PROFILE_CACHE_KEY, profileCache);
  return info;
}

// Fetches the profile for whichever domain represents this address, using
// the same priority chain as iOS: primaryInscriptionId -> primaryDomain name
// match -> first owned domain. Concurrent calls for the same address share
// and await the same in-flight request (see fetchAddressInfo).
export async function fetchAddressProfile(address, { baseUrl = KNS_DEFAULT_MAINNET_URL } = {}) {
  const existing = pendingProfileFetches.get(address);
  if (existing) return existing;

  lastProfileAttemptAt.set(address, Date.now());
  const promise = fetchAddressProfileWork(address, baseUrl).finally(() => {
    pendingProfileFetches.delete(address);
  });
  pendingProfileFetches.set(address, promise);
  return promise;
}

export async function getAddressProfile(address, options) {
  if (profileCache[address]) return profileCache[address];
  const existing = pendingProfileFetches.get(address);
  if (existing) return existing;
  return fetchAddressProfile(address, options);
}

// Refreshes info/profile for multiple addresses, but only for ones whose
// debounce+backoff window has elapsed — matches iOS's refreshIfNeeded, used
// for passive/bulk refresh (e.g. on chat-list render) as opposed to the
// force-refresh Chat Info performs on open.
// Returns how many addresses were actually (re)fetched, so callers can tell
// whether it's worth re-rendering — most calls are a no-op once everything's
// within its backoff window.
export async function refreshIfNeeded(addresses, options = {}) {
  const eligible = (addresses || []).filter((address) =>
    !pendingFetches.has(address) && backoffFor(address, lastAttemptAt, failureCounts));
  await Promise.all(eligible.map((address) => fetchAddressInfo(address, options)));
  const eligibleProfiles = (addresses || []).filter((address) =>
    !pendingProfileFetches.has(address) && backoffFor(address, lastProfileAttemptAt, profileFailureCounts));
  await Promise.all(eligibleProfiles.map((address) => fetchAddressProfile(address, options)));
  return eligible.length + eligibleProfiles.length;
}

// Synchronous, no-fetch cache read — for render paths that can't await (e.g.
// building the chat list) and instead want to render an already-cached name
// immediately, with a background refresh catching up on the next render.
export function peekAddressInfo(address) {
  return domainCache[address] || null;
}

export function peekAddressProfile(address) {
  return profileCache[address] || null;
}

export function clearKnsCache(address) {
  delete domainCache[address];
  delete profileCache[address];
  saveJsonMap(DOMAIN_CACHE_KEY, domainCache);
  saveJsonMap(PROFILE_CACHE_KEY, profileCache);
}

export function clearAllKnsCache() {
  domainCache = {};
  profileCache = {};
  saveJsonMap(DOMAIN_CACHE_KEY, domainCache);
  saveJsonMap(PROFILE_CACHE_KEY, profileCache);
}

// --- domain availability + fee tiers (read-only; used by phase 2 too) ------

export async function checkDomainAvailability(address, domainInput, { baseUrl = KNS_DEFAULT_MAINNET_URL } = {}) {
  const normalized = normalizeDomainName(domainInput);
  if (!normalized) throw new Error("Invalid domain name");
  const url = apiUrl(baseUrl, "/domains/check");
  const result = await fetchJson(url, { method: "POST", body: { address, domainNames: [normalized] } });
  if (!result.ok || !result.json?.success) throw new Error(result.json?.error || result.json?.message || "KNS domain check failed");
  const domains = result.json.data?.domains;
  if (!domains?.length) throw new Error("KNS domain check response is empty");
  const matched = domains.find((entry) => String(entry.domain || "").toLowerCase() === normalized) || domains[0];
  return { domain: String(matched.domain || "").toLowerCase(), available: Boolean(matched.available), isReservedDomain: Boolean(matched.isReservedDomain) };
}

export async function fetchInscribeFeeTiers({ baseUrl = KNS_DEFAULT_MAINNET_URL } = {}) {
  const url = apiUrl(baseUrl, "/fee");
  const result = await fetchJson(url);
  if (!result.ok || !result.json?.success) throw new Error(result.json?.error || result.json?.message || "KNS fee fetch failed");
  const rawFeeMap = result.json.data?.fee;
  if (!rawFeeMap) throw new Error("KNS fee response is missing tier data");
  const tiers = {};
  for (const [key, value] of Object.entries(rawFeeMap)) {
    const tier = Number(key);
    if (Number.isFinite(tier) && tier > 0) tiers[tier] = Number(value);
  }
  if (!Object.keys(tiers).length) throw new Error("KNS fee response has invalid tier data");
  return tiers;
}

// --- social link URL construction (KNSProfileLinkBuilder) -------------------

function normalizedLinkValue(raw) {
  const trimmed = String(raw || "").trim();
  return trimmed || null;
}

function stripUrlDecoration(value) {
  const lower = value.toLowerCase();
  if (lower.startsWith("https://")) return value.slice(8);
  if (lower.startsWith("http://")) return value.slice(7);
  return value;
}

function stripKnownHostPrefix(value, hosts) {
  const lower = value.toLowerCase();
  for (const host of hosts) {
    if (lower === host) return "";
    if (lower.startsWith(`${host}/`)) return value.slice(host.length + 1);
  }
  return null;
}

function trimmedHandle(value) {
  let output = value.trim();
  if (output.startsWith("@")) output = output.slice(1);
  output = output.split("/")[0].split("?")[0].split("#")[0];
  return output.trim();
}

function handleUrl(raw, canonicalHost, acceptedHosts) {
  let value = normalizedLinkValue(raw);
  if (!value) return null;

  try {
    const direct = new URL(value);
    const scheme = direct.protocol.replace(":", "").toLowerCase();
    if (scheme === "http" || scheme === "https") {
      if (acceptedHosts.includes(direct.host.toLowerCase())) {
        const parts = direct.pathname.split("/").filter(Boolean);
        if (!parts.length) return null;
        value = parts[0];
      } else {
        return direct.href;
      }
    } else {
      return direct.href;
    }
  } catch {
    value = stripUrlDecoration(value);
    const extracted = stripKnownHostPrefix(value, acceptedHosts);
    if (extracted !== null) value = extracted;
  }

  value = trimmedHandle(value);
  if (!value) return null;
  return `https://${canonicalHost}/${encodeURIComponent(value)}`;
}

export const KNSProfileLinkBuilder = Object.freeze({
  websiteUrl(raw) {
    const value = normalizedLinkValue(raw);
    if (!value) return null;
    try { return new URL(value).href; } catch { return `https://${value}`; }
  },
  xUrl(raw) {
    return handleUrl(raw, "x.com", ["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  },
  telegramUrl(raw) {
    return handleUrl(raw, "t.me", ["t.me", "www.t.me", "telegram.me", "www.telegram.me"]);
  },
  githubUrl(raw) {
    return handleUrl(raw, "github.com", ["github.com", "www.github.com"]);
  },
  emailUrl(raw) {
    let value = normalizedLinkValue(raw);
    if (!value) return null;
    if (value.toLowerCase().startsWith("mailto:")) value = value.slice(7);
    if (!value) return null;
    return `mailto:${value}`;
  },
  discordUrl(raw) {
    const acceptedHosts = ["discord.com", "www.discord.com", "discordapp.com", "www.discordapp.com"];
    let value = normalizedLinkValue(raw);
    if (!value) return null;
    try {
      const direct = new URL(value);
      const scheme = direct.protocol.replace(":", "").toLowerCase();
      if (scheme !== "http" && scheme !== "https") return null;
      if (!acceptedHosts.includes(direct.host.toLowerCase())) return null;
      const parts = direct.pathname.split("/").filter(Boolean);
      if (parts.length < 2 || parts[0].toLowerCase() !== "users") return null;
      value = parts[1];
    } catch {
      value = stripUrlDecoration(value);
      const extracted = stripKnownHostPrefix(value, acceptedHosts);
      if (extracted !== null) value = extracted;
      if (value.toLowerCase().startsWith("users/")) value = value.slice(6);
    }
    value = trimmedHandle(value);
    if (!/^\d{15,22}$/.test(value)) return null;
    return `https://discord.com/users/${value}`;
  },
});
