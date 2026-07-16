import { NETWORK_ID } from "./utils.js";

const NODE_REGISTRY_KEY = "kachat.browser.node-registry.v1";
const DIRECT_CONNECT_TIMEOUT_MS = 8000;
const RESOLVER_CONNECT_TIMEOUT_MS = 15000;
const STANDBY_DIRECT_TIMEOUT_MS = 6000;
const STANDBY_RESOLVER_TIMEOUT_MS = 9000;
const MAX_FAILOVER_EVENTS = 24;

const CONNECTION_ERROR_PATTERNS = [
  /websocket is not connected/i,
  /websocket.*closed/i,
  /not connected/i,
  /connection.*closed/i,
  /connection.*lost/i,
  /network error/i,
  /broken pipe/i,
  /timed out/i,
  /timeout/i,
];

function now() { return Date.now(); }

function emptyRegistry() {
  return {
    version: 2,
    lastGoodEndpoint: "",
    updatedAt: 0,
    endpoints: {},
    failovers: [],
    successfulFailovers: 0,
    failedFailovers: 0,
  };
}

function loadRegistry() {
  if (typeof localStorage === "undefined") return emptyRegistry();
  try {
    const parsed = JSON.parse(localStorage.getItem(NODE_REGISTRY_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return emptyRegistry();
    return {
      version: 2,
      lastGoodEndpoint: typeof parsed.lastGoodEndpoint === "string" ? parsed.lastGoodEndpoint : "",
      updatedAt: Number(parsed.updatedAt || 0),
      endpoints: parsed.endpoints && typeof parsed.endpoints === "object" ? parsed.endpoints : {},
      failovers: Array.isArray(parsed.failovers) ? parsed.failovers.slice(0, MAX_FAILOVER_EVENTS) : [],
      successfulFailovers: Number(parsed.successfulFailovers || 0),
      failedFailovers: Number(parsed.failedFailovers || 0),
    };
  } catch {
    return emptyRegistry();
  }
}

function saveRegistry(registry) {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(NODE_REGISTRY_KEY, JSON.stringify(registry)); } catch {}
}

function endpointRecord(registry, endpoint) {
  return registry.endpoints[endpoint] || {
    endpoint,
    successes: 0,
    failures: 0,
    averageLatencyMs: 0,
    lastLatencyMs: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastError: "",
  };
}

function recordSuccess(endpoint, latencyMs, { setLastGood = true } = {}) {
  if (!endpoint) return;
  const registry = loadRegistry();
  const record = endpointRecord(registry, endpoint);
  const previousSuccesses = Number(record.successes || 0);
  const nextSuccesses = previousSuccesses + 1;
  const previousAverage = Number(record.averageLatencyMs || 0);
  record.successes = nextSuccesses;
  record.lastLatencyMs = Math.max(0, Math.round(latencyMs || 0));
  record.averageLatencyMs = Math.round(((previousAverage * previousSuccesses) + record.lastLatencyMs) / nextSuccesses);
  record.lastSuccessAt = now();
  record.lastError = "";
  registry.endpoints[endpoint] = record;
  if (setLastGood) registry.lastGoodEndpoint = endpoint;
  registry.updatedAt = now();
  saveRegistry(registry);
}

function recordFailure(endpoint, error) {
  if (!endpoint) return;
  const registry = loadRegistry();
  const record = endpointRecord(registry, endpoint);
  record.failures = Number(record.failures || 0) + 1;
  record.lastFailureAt = now();
  record.lastError = String(error?.message || error || "Connection failed").slice(0, 240);
  registry.endpoints[endpoint] = record;
  registry.updatedAt = now();
  saveRegistry(registry);
}

export function recordFailover({ from = "", to = "", success = false, error = "" } = {}) {
  const registry = loadRegistry();
  registry.failovers.unshift({ from, to, success: Boolean(success), error: String(error || "").slice(0, 240), at: now() });
  registry.failovers = registry.failovers.slice(0, MAX_FAILOVER_EVENTS);
  if (success) registry.successfulFailovers += 1;
  else registry.failedFailovers += 1;
  if (success && to) registry.lastGoodEndpoint = to;
  registry.updatedAt = now();
  saveRegistry(registry);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function makeRpc(kaspa, { endpoint = "" } = {}) {
  const { RpcClient, Resolver, Encoding } = kaspa;
  if (endpoint) {
    return new RpcClient({ url: endpoint, encoding: Encoding?.Borsh, networkId: NETWORK_ID });
  }
  return new RpcClient({ resolver: new Resolver(), encoding: Encoding?.Borsh, networkId: NETWORK_ID });
}

async function connectCandidate(kaspa, {
  endpoint = "",
  timeoutMs,
  log = () => {},
  role = "primary",
  excludedEndpoints = [],
} = {}) {
  const rpc = makeRpc(kaspa, { endpoint });
  const source = endpoint ? `${role} endpoint` : `Rusty Kaspa resolver for ${role}`;
  const startedAt = globalThis.performance?.now?.() ?? now();
  log(`Connecting ${role} through ${source}${endpoint ? `: ${endpoint}` : ""}...`);
  try {
    await withTimeout(rpc.connect(), timeoutMs, source);
    const info = await withTimeout(rpc.getServerInfo(), 6000, `${role} RPC server verification`);
    if (info?.isSynced === false) throw new Error(`Connected ${role} node is not synced.`);
    const activeEndpoint = rpc.url || endpoint || "resolver-selected RPC";
    if (excludedEndpoints.includes(activeEndpoint)) {
      throw new Error(`${role} resolved to an endpoint already in use.`);
    }
    const latencyMs = (globalThis.performance?.now?.() ?? now()) - startedAt;
    recordSuccess(activeEndpoint, latencyMs, { setLastGood: role === "primary" });
    log(`${role === "primary" ? "Primary" : "Standby"} connected:`, activeEndpoint);
    return rpc;
  } catch (error) {
    const failedEndpoint = endpoint || rpc.url || `${role}-resolver`;
    if (!String(error?.message || "").includes("already in use")) recordFailure(failedEndpoint, error);
    try { await rpc.disconnect(); } catch {}
    throw error;
  }
}

export function isRpcConnectionError(error) {
  const message = String(error?.message || error || "");
  return CONNECTION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function getNodeRegistrySnapshot() {
  const registry = loadRegistry();
  const endpoints = Object.values(registry.endpoints || {}).sort((a, b) => {
    const aScore = Number(a.successes || 0) * 3 - Number(a.failures || 0) * 2;
    const bScore = Number(b.successes || 0) * 3 - Number(b.failures || 0) * 2;
    return bScore - aScore || Number(b.lastSuccessAt || 0) - Number(a.lastSuccessAt || 0);
  });
  return {
    ...registry,
    endpoints,
    endpointCount: endpoints.length,
    totalSuccesses: endpoints.reduce((sum, item) => sum + Number(item.successes || 0), 0),
    totalFailures: endpoints.reduce((sum, item) => sum + Number(item.failures || 0), 0),
  };
}

export async function createRpc(kaspa, log = () => {}) {
  const registry = loadRegistry();
  const lastGoodEndpoint = registry.lastGoodEndpoint;

  if (lastGoodEndpoint) {
    try {
      return await connectCandidate(kaspa, {
        endpoint: lastGoodEndpoint,
        timeoutMs: DIRECT_CONNECT_TIMEOUT_MS,
        log,
        role: "primary",
      });
    } catch (error) {
      log(`Last-known-good RPC failed: ${error?.message || error}`);
      log("Falling back to the Rusty Kaspa resolver...");
    }
  }

  return connectCandidate(kaspa, {
    timeoutMs: RESOLVER_CONNECT_TIMEOUT_MS,
    log,
    role: "primary",
  });
}

export async function createStandbyRpc(kaspa, primaryEndpoint = "", log = () => {}) {
  const registry = getNodeRegistrySnapshot();
  const directCandidates = registry.endpoints
    .map((entry) => entry.endpoint)
    .filter((endpoint) => endpoint && endpoint !== primaryEndpoint && !endpoint.includes("resolver"))
    .slice(0, 3);

  for (const endpoint of directCandidates) {
    try {
      return await connectCandidate(kaspa, {
        endpoint,
        timeoutMs: STANDBY_DIRECT_TIMEOUT_MS,
        log,
        role: "standby",
        excludedEndpoints: [primaryEndpoint],
      });
    } catch (error) {
      log(`Standby candidate failed (${endpoint}): ${error?.message || error}`);
    }
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await connectCandidate(kaspa, {
        timeoutMs: STANDBY_RESOLVER_TIMEOUT_MS,
        log,
        role: "standby",
        excludedEndpoints: [primaryEndpoint],
      });
    } catch (error) {
      log(`Standby resolver attempt ${attempt} failed: ${error?.message || error}`);
    }
  }

  return null;
}

export async function probeRpc(rpc) {
  if (!rpc) return false;
  try {
    const info = await withTimeout(rpc.getServerInfo(), 5000, "RPC heartbeat");
    return info?.isSynced !== false;
  } catch {
    return false;
  }
}

export async function connectRpc(kaspa, existingRpc = null, log = () => {}) {
  if (existingRpc && await probeRpc(existingRpc)) return existingRpc;
  if (existingRpc) {
    try { await existingRpc.disconnect(); } catch {}
    log("RPC connection was stale; reconnecting...");
  }
  return createRpc(kaspa, log);
}

export async function disconnectRpc(rpc) {
  if (!rpc) return;
  try { await rpc.disconnect(); } catch {}
}
