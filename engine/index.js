import { loadKaspaModule } from "./wasm-loader.js";
import { clearNodeRegistry, connectRpc, createStandbyRpc, disconnectRpc, getNodeRegistrySnapshot, isRpcConnectionError, probeRpc, recordFailover } from "./rpc.js";
import { generateWallet, generateMnemonicWallet, generateMnemonicPhrase, importMnemonic, importMnemonicWithFamily, deriveIdentityAddressRange, importPrivateKey, deriveSpendingWallet, spendingDerivationPath, normalizeSourceFamily, sourceFamilyPathDescription, WALLET_SOURCE_FAMILIES } from "./wallet.js";
import { getBalance, sendKaspa, estimateOnchainFee, sendPayloadTransaction } from "./transactions.js";
import { makeQrPayload, drawKaspaQr } from "./qr.js";
import { createMessageEnvelope, createEncryptedMessageEnvelope, createEncryptedHandshakeEnvelope, createSelfStashEnvelope, sendMessagePreview, sendMessageOnchain, sendHandshakeOnchain, sendSelfStashOnchain } from "./messages.js";
import { buildConversationSyncPlan, syncConversationPreview, syncConversationFromIndexer, syncIncomingHandshakesFromIndexer, syncIncomingPaymentsFromRest, syncSelfStashFromChain, testKasiaIndexer, DEFAULT_KASIA_INDEXER_URL } from "./sync.js";
import { KASIA_PROTOCOL, KASIA_INTEGRATION_STATUS, buildCommMessage, buildEncryptedCommMessage, makeKasiaCommPayload, parseKasiaPayloadHex, decodePayload } from "./kasia-protocol.js";
import { loadKasiaCipher, isKasiaCipherLoaded, encryptKasiaMessage, decryptKasiaMessage, deriveKasiaAliases } from "./kasia-cipher.js";
import { requireKaspa, NETWORK_ID } from "./utils.js";
import { getEndpoint } from "./endpoints.js";
import { queryGroupMessages, queryGroupControlByRecipient, queryGroupControlBySender } from "./group-indexer.js";
import {
  KNS_DEFAULT_MAINNET_URL,
  normalizeDomainName as knsNormalizeDomainName,
  looksLikeDomain as knsLooksLikeDomain,
  resolveDomain as knsResolveDomain,
  fetchAddressInfo as knsFetchAddressInfo,
  getAddressInfo as knsGetAddressInfo,
  fetchAddressProfile as knsFetchAddressProfile,
  getAddressProfile as knsGetAddressProfile,
  refreshIfNeeded as knsRefreshIfNeeded,
  peekAddressInfo as knsPeekAddressInfo,
  peekAddressProfile as knsPeekAddressProfile,
  clearKnsCache,
  clearAllKnsCache,
  checkDomainAvailability as knsCheckDomainAvailability,
  fetchInscribeFeeTiers as knsFetchInscribeFeeTiers,
} from "./kns.js";
import {
  inscribeDomain as knsInscribeDomain,
  transferDomain as knsTransferDomain,
  submitProfileFields as knsSubmitProfileFields,
  submitProfileField as knsSubmitProfileField,
  validateProfileFields as knsValidateProfileFields,
  uploadKnsProfileImage as knsUploadProfileImage,
  peekPendingKnsCommit,
  clearPendingKnsCommit,
  KNS_ECONOMICS,
} from "./kns-write.js";

export class KaspaEngine {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.kaspa = null;
    this.rpc = null;
    this.standbyRpc = null;
    this.privateKey = null;
    this.privateKeyHex = null;
    this.address = null;
    this.currentUtxos = [];
    this.cipher = null;
    this.rpcConnectPromise = null;
    this.standbyConnectPromise = null;
    this.failoverPromise = null;
    this.rpcHeartbeatTimer = null;
    // Backstop poll that catches a silently-wedged node. The primary "node dropped"
    // signal is now the subscription disconnect event (see scheduleImmediateFailover),
    // so this can be relatively relaxed without hurting recovery speed.
    this.rpcHeartbeatMs = 10000;
    this.immediateFailoverTimer = null;
    this.connectionListeners = new Set();
    this.subscriptionListeners = new Set();
    this.walletActivityListeners = new Set();
    this.utxoProcessor = null;
    this.utxoContext = null;
    this.utxoSubscriptionRpc = null;
    this.subscriptionAddresses = [];
    this.subscriptionState = {
      status: "idle",
      address: "",
      addresses: [],
      contactCount: 0,
      endpoint: "",
      lastEventType: "",
      lastEventAt: 0,
      lastError: "",
      updatedAt: Date.now(),
    };
    this.connectionState = {
      primary: "idle",
      standby: "idle",
      failover: "idle",
      primaryEndpoint: "",
      standbyEndpoint: "",
      lastError: "",
      updatedAt: Date.now(),
    };
  }


  onSubscriptionState(listener) {
    if (typeof listener !== "function") return () => {};
    this.subscriptionListeners.add(listener);
    try { listener(this.subscriptionSnapshot()); } catch {}
    return () => this.subscriptionListeners.delete(listener);
  }

  onWalletActivity(listener) {
    if (typeof listener !== "function") return () => {};
    this.walletActivityListeners.add(listener);
    return () => this.walletActivityListeners.delete(listener);
  }

  setSubscriptionState(patch = {}) {
    this.subscriptionState = { ...this.subscriptionState, ...patch, updatedAt: Date.now() };
    for (const listener of this.subscriptionListeners) {
      try { listener(this.subscriptionSnapshot()); } catch {}
    }
  }

  subscriptionSnapshot() {
    return {
      ...this.subscriptionState,
      active: Boolean(this.utxoProcessor && this.utxoContext && this.subscriptionState.status === "ready"),
    };
  }

  emitWalletActivity(event) {
    const type = String(event?.type || "activity");
    this.setSubscriptionState({ status: "ready", lastEventType: type, lastEventAt: Date.now(), lastError: "" });
    for (const listener of this.walletActivityListeners) {
      try { listener(event); } catch {}
    }
  }

  setSubscriptionAddresses(addresses = [], { restart = true } = {}) {
    const normalized = [...new Set((Array.isArray(addresses) ? addresses : [])
      .map((address) => String(address || "").trim())
      .filter((address) => address.startsWith("kaspa:") && address !== this.address))];
    const changed = normalized.length !== this.subscriptionAddresses.length
      || normalized.some((address, index) => address !== this.subscriptionAddresses[index]);
    this.subscriptionAddresses = normalized;
    this.setSubscriptionState({
      addresses: this.address ? [this.address, ...normalized] : [...normalized],
      contactCount: normalized.length,
    });
    if (changed && restart && this.rpc && this.address) queueMicrotask(() => this.rebuildWalletSubscription());
    return this.subscriptionSnapshot();
  }

  trackedSubscriptionAddresses() {
    return [...new Set([this.address, ...this.subscriptionAddresses].filter(Boolean))];
  }

  async stopWalletSubscription({ preserveState = false } = {}) {
    const context = this.utxoContext;
    const processor = this.utxoProcessor;
    this.utxoContext = null;
    this.utxoProcessor = null;
    this.utxoSubscriptionRpc = null;
    try { await context?.clear?.(); } catch {}
    try { await processor?.stop?.(); } catch {}
    if (!preserveState) this.setSubscriptionState({ status: "idle", endpoint: "", lastError: "" });
  }

  async startWalletSubscription({ force = false } = {}) {
    this.requireWallet();
    const rpc = await this.connect();
    const endpoint = rpc?.url || "";
    if (!force && this.subscriptionState.status === "ready" && this.utxoSubscriptionRpc === rpc && this.subscriptionState.address === this.address) {
      return this.subscriptionSnapshot();
    }
    if (!this.kaspa?.UtxoProcessor || !this.kaspa?.UtxoContext) {
      const error = new Error("Rusty Kaspa UTXO subscription classes are unavailable in this WASM build.");
      this.setSubscriptionState({ status: "error", address: this.address || "", endpoint, lastError: error.message });
      throw error;
    }

    await this.stopWalletSubscription({ preserveState: true });
    this.setSubscriptionState({ status: "connecting", address: this.address, endpoint, lastError: "" });
    try {
      const processor = new this.kaspa.UtxoProcessor({ rpc, networkId: NETWORK_ID });
      processor.addEventListener((event) => {
        const type = String(event?.type || "");
        if (["balance", "pending", "reorg", "stasis", "maturity", "discovery"].includes(type)) {
          this.emitWalletActivity(event);
        } else if (["disconnect", "utxo-proc-error", "error", "utxo-index-not-enabled"].includes(type)) {
          this.setSubscriptionState({ status: "error", lastEventType: type, lastEventAt: Date.now(), lastError: event?.data?.message || type });
          // A dropped subscription socket is the earliest signal the node died, well
          // before the periodic heartbeat would notice. Hop to the warm standby (or
          // re-resolve a fresh node) right away instead of waiting up to a full poll.
          if (type === "disconnect" || type === "utxo-proc-error" || type === "error") {
            this.scheduleImmediateFailover(`Wallet subscription ${type}`);
          }
        }
      });
      await processor.start();
      const context = new this.kaspa.UtxoContext({ processor });
      const trackedAddresses = this.trackedSubscriptionAddresses();
      await context.trackAddresses(trackedAddresses);
      this.utxoProcessor = processor;
      this.utxoContext = context;
      this.utxoSubscriptionRpc = rpc;
      this.setSubscriptionState({ status: "ready", address: this.address, addresses: trackedAddresses, contactCount: Math.max(0, trackedAddresses.length - 1), endpoint, lastEventType: "subscription-ready", lastEventAt: Date.now(), lastError: "" });
      this.log(`Live UTXO subscription ready for ${trackedAddresses.length} address(es) via ${endpoint}`);
      return this.subscriptionSnapshot();
    } catch (error) {
      await this.stopWalletSubscription({ preserveState: true });
      this.setSubscriptionState({ status: "error", address: this.address || "", endpoint, lastError: error?.message || String(error) });
      throw error;
    }
  }

  async rebuildWalletSubscription() {
    if (!this.address || !this.rpc) return null;
    try { return await this.startWalletSubscription({ force: true }); }
    catch (error) { this.log("Wallet subscription rebuild failed:", error?.message || error); return null; }
  }

  onConnectionState(listener) {
    if (typeof listener !== "function") return () => {};
    this.connectionListeners.add(listener);
    try { listener(this.connectionSnapshot()); } catch {}
    return () => this.connectionListeners.delete(listener);
  }

  setConnectionState(patch = {}) {
    this.connectionState = { ...this.connectionState, ...patch, updatedAt: Date.now() };
    for (const listener of this.connectionListeners) {
      try { listener(this.connectionSnapshot()); } catch {}
    }
  }

  connectionSnapshot() {
    return {
      ...this.connectionState,
      primaryEndpoint: this.rpc?.url || this.connectionState.primaryEndpoint || "",
      standbyEndpoint: this.standbyRpc?.url || this.connectionState.standbyEndpoint || "",
      hasPrimary: Boolean(this.rpc),
      hasStandby: Boolean(this.standbyRpc),
    };
  }

  async ensureStandby() {
    if (!this.kaspa || !this.rpc) return null;
    // In strict custom-node mode there is no public backup by design: a warm standby
    // would be a public node, which contradicts "use only my node". Failover in this
    // mode just retries the custom node.
    if (getEndpoint("trustedNode")) {
      if (this.standbyRpc) { await disconnectRpc(this.standbyRpc); this.standbyRpc = null; }
      this.setConnectionState({ standby: "unavailable", standbyEndpoint: "" });
      return null;
    }
    if (this.standbyRpc && await probeRpc(this.standbyRpc)) {
      this.setConnectionState({ standby: "ready", standbyEndpoint: this.standbyRpc.url || "", lastError: "" });
      return this.standbyRpc;
    }
    if (this.standbyConnectPromise) return this.standbyConnectPromise;

    const primaryEndpoint = this.rpc?.url || "";
    this.setConnectionState({ standby: "connecting", standbyEndpoint: "" });
    this.standbyConnectPromise = (async () => {
      if (this.standbyRpc) await disconnectRpc(this.standbyRpc);
      this.standbyRpc = await createStandbyRpc(this.kaspa, primaryEndpoint, this.log);
      if (this.standbyRpc) {
        this.setConnectionState({ standby: "ready", standbyEndpoint: this.standbyRpc.url || "", lastError: "" });
      } else {
        this.setConnectionState({ standby: "unavailable", standbyEndpoint: "" });
      }
      return this.standbyRpc;
    })();

    try {
      return await this.standbyConnectPromise;
    } catch (error) {
      this.setConnectionState({ standby: "error", standbyEndpoint: "", lastError: error?.message || String(error) });
      return null;
    } finally {
      this.standbyConnectPromise = null;
    }
  }

  async handlePrimaryFailure(reason = "Primary RPC unavailable") {
    if (this.failoverPromise) return this.failoverPromise;
    this.failoverPromise = (async () => {
      const failedPrimary = this.rpc;
      const failedEndpoint = failedPrimary?.url || this.connectionState.primaryEndpoint || "";
      this.setConnectionState({ primary: "error", failover: "checking-standby", lastError: String(reason || "Primary RPC unavailable") });

      const standbyHealthy = this.standbyRpc ? await probeRpc(this.standbyRpc) : false;
      if (standbyHealthy) {
        const promoted = this.standbyRpc;
        const promotedEndpoint = promoted?.url || this.connectionState.standbyEndpoint || "";
        this.standbyRpc = null;
        this.rpc = promoted;
        await disconnectRpc(failedPrimary);
        recordFailover({ from: failedEndpoint, to: promotedEndpoint, success: true });
        this.log(`Standby promoted to primary: ${promotedEndpoint}`);
        this.setConnectionState({
          primary: "ready",
          standby: "connecting",
          failover: "promoted",
          primaryEndpoint: promotedEndpoint,
          standbyEndpoint: "",
          lastError: "",
        });
        queueMicrotask(() => this.ensureStandby());
        queueMicrotask(() => this.rebuildWalletSubscription());
        return this.rpc;
      }

      await disconnectRpc(this.standbyRpc);
      this.standbyRpc = null;
      await disconnectRpc(failedPrimary);
      this.rpc = null;
      this.setConnectionState({ primary: "connecting", standby: "unavailable", failover: "reconnecting", primaryEndpoint: "", standbyEndpoint: "" });
      try {
        const rpc = await this.connect({ force: false });
        await this.rebuildWalletSubscription();
        recordFailover({ from: failedEndpoint, to: rpc?.url || "", success: true });
        return rpc;
      } catch (error) {
        recordFailover({ from: failedEndpoint, to: "", success: false, error: error?.message || error });
        this.setConnectionState({ primary: "error", failover: "failed", lastError: error?.message || String(error) });
        throw error;
      }
    })();

    try {
      return await this.failoverPromise;
    } finally {
      this.failoverPromise = null;
      if (this.rpc) this.setConnectionState({ failover: "idle" });
    }
  }

  requireSdk() { requireKaspa(this.kaspa); }
  requireWallet() {
    this.requireSdk();
    if (!this.privateKey || !this.address) throw new Error("Generate or import a private key first.");
  }

  async loadWasm() {
    this.kaspa = await loadKaspaModule();
    this.kaspa.initConsolePanicHook?.();
    return this.kaspa;
  }

  // Strict reachability check for a user-supplied wRPC endpoint. Connects DIRECTLY to
  // the given URL (no resolver, no last-good, no fallback), confirms the node answers
  // and is a synced mainnet node, then disconnects. Throws a clear error if the node
  // can't be used, so the UI can tell the user their own node is down instead of
  // silently connecting them to a public one.
  async verifyNode(url, { timeoutMs = 8000 } = {}) {
    this.requireSdk();
    const endpoint = String(url || "").trim();
    if (!/^wss?:\/\/.+/i.test(endpoint)) throw new Error("Enter a valid wRPC URL that starts with wss:// or ws://.");
    const { RpcClient, Encoding, ConnectStrategy } = this.kaspa;
    const rpc = new RpcClient({ url: endpoint, encoding: Encoding?.Borsh, networkId: NETWORK_ID });
    const withTimeout = (promise, ms, label) => {
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms); });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };
    try {
      // Single-shot connect: ConnectStrategy.Fallback returns on the FIRST failed attempt
      // instead of retrying the socket forever, so a bad URL fails fast and cleanly (one
      // WebSocket error in the console, not a storm).
      await withTimeout(
        rpc.connect({ blockAsyncConnect: true, strategy: ConnectStrategy?.Fallback ?? 1, timeoutDuration: timeoutMs }),
        timeoutMs + 1500,
        "Node connection",
      );
      const info = await withTimeout(rpc.getServerInfo(), 6000, "Node verification");
      if (info?.isSynced === false) throw new Error("That node is reachable but not fully synced yet.");
      const net = String(info?.networkId ?? "").toLowerCase();
      if (net && !net.includes("mainnet")) throw new Error(`That node is on ${info.networkId}, not mainnet.`);
      return { ok: true, url: rpc.url || endpoint };
    } catch (error) {
      // A missing wRPC port is the most common cause of a timeout: a bare wss://host
      // resolves to :443, but Borsh wRPC usually listens on :17110. Add a hint when the
      // URL carries no explicit port.
      const message = String(error?.message || error || "");
      const hasPort = /:\d{2,5}(\/|$)/.test(endpoint);
      if (!hasPort && /timed out|failed|refused|closed|unreachable|connect/i.test(message)) {
        throw new Error(`${message} If your node uses a specific wRPC port, include it, for example wss://host:17110.`);
      }
      throw new Error(message || "Could not reach that node.");
    } finally {
      try { await rpc.disconnect(); } catch {}
    }
  }

  async connect({ force = false } = {}) {
    this.requireSdk();
    if (!force && this.rpc && await probeRpc(this.rpc)) {
      this.setConnectionState({ primary: "ready", primaryEndpoint: this.rpc.url || "", lastError: "" });
      this.startRpcHeartbeat();
      queueMicrotask(() => this.ensureStandby());
      return this.rpc;
    }
    if (this.rpcConnectPromise) return this.rpcConnectPromise;

    this.rpcConnectPromise = (async () => {
      if (force) {
        await disconnectRpc(this.rpc);
        await disconnectRpc(this.standbyRpc);
        this.rpc = null;
        this.standbyRpc = null;
        this.setConnectionState({ primary: "connecting", standby: "idle", failover: "idle", primaryEndpoint: "", standbyEndpoint: "" });
      } else {
        this.setConnectionState({ primary: "connecting", failover: this.connectionState.failover === "reconnecting" ? "reconnecting" : "idle" });
      }
      try {
        this.rpc = await connectRpc(this.kaspa, this.rpc, this.log);
        this.setConnectionState({ primary: "ready", primaryEndpoint: this.rpc?.url || "", lastError: "" });
        this.startRpcHeartbeat();
        queueMicrotask(() => this.ensureStandby());
        return this.rpc;
      } catch (error) {
        this.rpc = null;
        this.setConnectionState({ primary: "error", failover: "failed", primaryEndpoint: "", lastError: error?.message || String(error) });
        // Keep the heartbeat running even though this attempt failed, so its
        // reconnect loop keeps retrying and recovers automatically once a healthy
        // node is reachable (matters most for a strict custom node that is down).
        this.startRpcHeartbeat();
        throw error;
      }
    })();

    try {
      return await this.rpcConnectPromise;
    } finally {
      this.rpcConnectPromise = null;
    }
  }

  // Fast-path failover triggered by a subscription drop event. Debounced (coalesces
  // a burst of disconnect/error events) and probe-confirmed (so a transient blip
  // while the node is actually fine doesn't needlessly switch nodes). This is what
  // makes a dropped node reconnect to a healthy one right away rather than after the
  // next heartbeat tick.
  scheduleImmediateFailover(reason = "Node connection dropped") {
    if (typeof window === "undefined") return;
    if (this.failoverPromise || this.immediateFailoverTimer) return;
    this.immediateFailoverTimer = window.setTimeout(async () => {
      this.immediateFailoverTimer = null;
      if (!this.rpc || this.failoverPromise) return;
      // Confirm the primary is genuinely unreachable before switching.
      let healthy = false;
      try { healthy = await probeRpc(this.rpc); } catch { healthy = false; }
      if (healthy) {
        this.setConnectionState({ primary: "ready", primaryEndpoint: this.rpc?.url || "", lastError: "" });
        return;
      }
      this.log(`Immediate failover: ${reason}`);
      try { await this.handlePrimaryFailure(reason); }
      catch (error) { this.log("Immediate failover failed:", error?.message || error); }
    }, 400);
  }

  startRpcHeartbeat() {
    if (this.rpcHeartbeatTimer || typeof window === "undefined") return;
    this.rpcHeartbeatTimer = window.setInterval(async () => {
      if (this.failoverPromise) return; // a failover is already working the problem
      if (!this.rpc) {
        // Fully disconnected (e.g. a strict custom node that went down and had no public
        // backup to promote). Keep trying to reconnect so we recover automatically the
        // moment a healthy node is reachable again, instead of staying dark.
        if (!this.address) return;
        try { await this.connect({ force: true }); await this.rebuildWalletSubscription(); }
        catch { /* still unreachable; retry on the next tick */ }
        return;
      }
      const [primaryHealthy, standbyHealthy] = await Promise.all([
        probeRpc(this.rpc),
        this.standbyRpc ? probeRpc(this.standbyRpc) : Promise.resolve(false),
      ]);

      if (!primaryHealthy) {
        this.log("RPC heartbeat detected a stale primary; starting failover...");
        try { await this.handlePrimaryFailure("Primary RPC heartbeat failed"); }
        catch (error) { this.log("RPC failover failed:", error?.message || error); }
        return;
      }

      this.setConnectionState({ primary: "ready", primaryEndpoint: this.rpc?.url || "", lastError: "" });
      if (this.standbyRpc && standbyHealthy) {
        this.setConnectionState({ standby: "ready", standbyEndpoint: this.standbyRpc.url || "" });
      } else {
        if (this.standbyRpc) await disconnectRpc(this.standbyRpc);
        this.standbyRpc = null;
        this.setConnectionState({ standby: "unavailable", standbyEndpoint: "" });
        await this.ensureStandby();
      }
    }, this.rpcHeartbeatMs);
  }

  stopRpcHeartbeat() {
    if (this.rpcHeartbeatTimer && typeof window !== "undefined") {
      window.clearInterval(this.rpcHeartbeatTimer);
    }
    this.rpcHeartbeatTimer = null;
  }

  async withRpc(operation, { retries = 1, label = "RPC operation" } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const rpc = await this.connect();
        return await operation(rpc);
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !isRpcConnectionError(error)) throw error;
        this.log(`${label} lost RPC connection; attempting standby failover...`);
        await this.handlePrimaryFailure(error?.message || `${label} connection failed`);
      }
    }
    throw lastError;
  }

  nodeRegistrySnapshot() {
    return getNodeRegistrySnapshot();
  }

  clearNodeRegistry() {
    return clearNodeRegistry();
  }

  async disconnect() {
    this.stopRpcHeartbeat();
    if (this.immediateFailoverTimer && typeof window !== "undefined") {
      window.clearTimeout(this.immediateFailoverTimer);
      this.immediateFailoverTimer = null;
    }
    await this.stopWalletSubscription();
    await disconnectRpc(this.rpc);
    await disconnectRpc(this.standbyRpc);
    this.rpc = null;
    this.standbyRpc = null;
    this.setConnectionState({ primary: "idle", standby: "idle", failover: "idle", primaryEndpoint: "", standbyEndpoint: "", lastError: "" });
  }

  generateWallet() {
    this.requireSdk();
    return this.setWallet(generateWallet(this.kaspa));
  }

  generateMnemonicWallet(wordCount = 24, passphrase = "") {
    this.requireSdk();
    return this.setWallet(generateMnemonicWallet(this.kaspa, wordCount, passphrase));
  }

  // Fresh phrase without deriving/setting a wallet — used by the creation flow to
  // show the seed for backup before applying an (optional) passphrase.
  generateMnemonicPhrase(wordCount = 24) {
    this.requireSdk();
    return generateMnemonicPhrase(this.kaspa, wordCount);
  }

  importMnemonic(phrase, passphrase = "") {
    this.requireSdk();
    return this.setWallet(importMnemonic(this.kaspa, phrase, passphrase));
  }

  // Family-aware identity import (iOS WalletSourceFamily port): derives the
  // chatting identity where the seed's source wallet actually kept it
  // (standard / legacy-972 / OneKey-tweaked), optionally at a nonzero index
  // (the import-time chatting-address picker). Async — OneKey needs WebCrypto.
  async importMnemonicWithFamily(phrase, passphrase = "", { family = "kaspaStandard", index = 0 } = {}) {
    this.requireSdk();
    const wallet = await importMnemonicWithFamily(this.kaspa, phrase, passphrase, { family, index });
    return this.setWallet(wallet);
  }

  // Derives one family identity address WITHOUT touching the engine's active
  // wallet — the chatting-address picker's batch scanner.
  async deriveIdentityCandidate(phrase, passphrase = "", { family = "kaspaStandard", index = 0 } = {}) {
    this.requireSdk();
    return importMnemonicWithFamily(this.kaspa, phrase, passphrase, { family, index });
  }

  // One batch of identity addresses for the chatting-address picker, derived
  // off a single master key — never touches the engine's active wallet.
  async deriveIdentityAddressRange(phrase, passphrase = "", options = {}) {
    this.requireSdk();
    return deriveIdentityAddressRange(this.kaspa, phrase, passphrase, options);
  }

  importPrivateKey(hex) {
    this.requireSdk();
    return this.setWallet(importPrivateKey(this.kaspa, hex));
  }

  setWallet(wallet) {
    const previousAddress = this.address;
    this.privateKey = wallet.privateKey;
    this.privateKeyHex = wallet.privateKeyHex;
    this.address = wallet.address;
    this.currentUtxos = [];
    if (previousAddress && previousAddress !== this.address) queueMicrotask(() => this.stopWalletSubscription());
    if (this.rpc) queueMicrotask(() => this.rebuildWalletSubscription());
    return wallet;
  }

  clearSession() {
    queueMicrotask(() => this.stopWalletSubscription());
    this.privateKey = null;
    this.privateKeyHex = null;
    this.address = null;
    this.currentUtxos = [];
  }

  async balance() {
    this.requireWallet();
    const balance = await this.withRpc(
      (rpc) => getBalance(this.kaspa, rpc, this.address),
      { retries: 1, label: "Balance refresh" },
    );
    this.currentUtxos = balance.entries;
    return balance;
  }

  async send(destinationAddress, amountKas, feeKas = "0", options = {}) {
    this.requireWallet();
    await this.connect();
    return sendKaspa({
      kaspa: this.kaspa,
      rpc: this.rpc,
      withRpc: this.withRpc.bind(this),
      privateKey: this.privateKey,
      sourceAddress: this.address,
      destinationAddress,
      amountKas,
      feeKas,
      selectedOutpoints: options.selectedOutpoints || null,
      log: this.log,
    });
  }

  // --- Spending-address chain (m/44'/111111'/1'/0/<index>) ---
  // Derive a spending address/key from the account's recovery phrase. Does NOT
  // change the active (chatting) wallet. `passphrase` must match what the seed
  // was created with ("" for the common no-passphrase case).
  deriveSpendingWallet(mnemonic, index, passphrase = "") {
    this.requireSdk();
    return deriveSpendingWallet(this.kaspa, mnemonic, index, passphrase);
  }
  spendingDerivationPath(index) { return spendingDerivationPath(index); }

  async balanceForAddress(address) {
    this.requireSdk();
    await this.connect();
    return this.withRpc((rpc) => getBalance(this.kaspa, rpc, address), { retries: 1, label: "Spending balance" });
  }

  // Send from a spending address, signing with its derived key.
  async sendFromSpending({ mnemonic, index, passphrase = "", destinationAddress, amountKas, feeKas = "0", selectedOutpoints = null }) {
    this.requireSdk();
    await this.connect();
    const spending = deriveSpendingWallet(this.kaspa, mnemonic, index, passphrase);
    return sendKaspa({
      kaspa: this.kaspa,
      rpc: this.rpc,
      withRpc: this.withRpc.bind(this),
      privateKey: spending.privateKey,
      sourceAddress: spending.address,
      destinationAddress,
      amountKas,
      feeKas,
      selectedOutpoints,
      log: this.log,
    });
  }

  async drawQrFor(canvas, payload, colorOptions) {
    return drawKaspaQr(canvas, payload, colorOptions);
  }

  createMessageEnvelope(details) {
    return createMessageEnvelope(details);
  }

  async loadKasiaCipher() {
    this.cipher = await loadKasiaCipher();
    return this.cipher;
  }

  isKasiaCipherLoaded() {
    return isKasiaCipherLoaded();
  }

  async deriveConversationAliases(peerAddress) {
    if (!this.privateKeyHex) throw new Error("Generate or import a private key first.");
    if (!this.isKasiaCipherLoaded()) throw new Error("Load Kasia Cipher WASM first.");
    return deriveKasiaAliases(this.privateKeyHex, peerAddress);
  }

  async createEncryptedMessageEnvelope(details) {
    const peerAddress = details?.toAddress;
    const aliases = await this.deriveConversationAliases(peerAddress);
    return createEncryptedMessageEnvelope({
      ...details,
      alias: aliases.theirAlias,
      deterministicAliases: aliases,
    });
  }

  async decryptKasiaMessage(encryptedHex) {
    if (!this.privateKeyHex) throw new Error("Generate or import a private key first.");
    return decryptKasiaMessage(encryptedHex, this.privateKeyHex);
  }

  // --- Group chat adapters (thin wiring over the wallet, cipher, and indexer;
  // the crypto/codec lives in group.js, orchestration/state in group-store.js). ---

  // x-only (32-byte) Schnorr pubkey hex for a kaspa: address, used to derive a
  // member's blinded group id and to address gctl control messages. The cipher
  // WASM already needs this for ECIES, so we reuse its extractor and normalize a
  // 33-byte compressed key down to x-only.
  async xOnlyPubKeyForAddress(address) {
    const cipher = await loadKasiaCipher();
    if (typeof cipher.debug_address_to_pubkey !== "function") {
      throw new Error("Kasia cipher runtime is missing address to pubkey support. Re-run npm run setup:cipher.");
    }
    let hex = String(cipher.debug_address_to_pubkey(String(address)) || "").trim().toLowerCase().replace(/^0x/, "");
    if (hex.length === 66 && (hex.startsWith("02") || hex.startsWith("03"))) hex = hex.slice(2); // compressed to x-only
    if (hex.length !== 64) throw new Error(`Unexpected pubkey length for ${address}.`);
    return hex;
  }

  // Broadcasts a group payload string (ciph_msg:1:gcomm: or :gctl:) as a
  // pay-to-self transaction with the string in the native payload field, the
  // same self-stash mechanism 1:1 COMM messages use.
  async sendGroupPayload(payloadString, { amountKas = KASIA_INTEGRATION_STATUS.defaultMessageAmountKas, feeKas = "0" } = {}) {
    this.requireWallet();
    await this.connect();
    return sendPayloadTransaction({
      kaspa: this.kaspa,
      rpc: this.rpc,
      withRpc: this.withRpc.bind(this),
      privateKey: this.privateKey,
      sourceAddress: this.address,
      destinationAddress: this.address,
      amountKas,
      feeKas,
      payload: new TextEncoder().encode(String(payloadString)),
      log: this.log,
    });
  }

  // gctl control messages ride the existing 1:1 ECIES channel: encrypt the JSON
  // to a member's address, decrypt an incoming one with our own key.
  async encryptGroupControl(memberAddress, json) {
    const { encryptedHex } = await encryptKasiaMessage(memberAddress, json);
    return encryptedHex;
  }
  async decryptGroupControl(encryptedHex) {
    this.requireWallet();
    return decryptKasiaMessage(encryptedHex, this.privateKeyHex);
  }

  // Indexer scans (delegate to group-indexer, defaulting to the configured indexer).
  async scanGroupMessages(blindedGroupIdHex, cursor = null, limit = 50) {
    return queryGroupMessages({ indexerUrl: getEndpoint("kasiaIndexer"), blindedGroupIdHex, cursor, limit });
  }
  async scanGroupControlByRecipient(cursor = null, limit = 50) {
    this.requireWallet();
    return queryGroupControlByRecipient({ indexerUrl: getEndpoint("kasiaIndexer"), recipient: this.address, cursor, limit });
  }
  async scanGroupControlBySender(sender, cursor = null, limit = 50) {
    return queryGroupControlBySender({ indexerUrl: getEndpoint("kasiaIndexer"), sender, cursor, limit });
  }

  kasiaProtocol() {
    return KASIA_PROTOCOL;
  }

  kasiaIntegrationStatus() {
    return KASIA_INTEGRATION_STATUS;
  }

  buildCommMessage(details) {
    return buildCommMessage(details);
  }

  async buildEncryptedCommMessage(details) {
    return buildEncryptedCommMessage({ ...details, encryptMessage: async (address, text) => {
      const envelope = await createEncryptedMessageEnvelope({ toAddress: address, text, ...details });
      return { encryptedHex: envelope.encryptedHex };
    } });
  }

  makeKasiaCommPayload(details) {
    return makeKasiaCommPayload(details);
  }

  parseKasiaPayloadHex(payloadHex) {
    return parseKasiaPayloadHex(payloadHex);
  }

  decodeKasiaPayload(payloadHexOrProtocolString) {
    return decodePayload(payloadHexOrProtocolString);
  }

  async sendMessagePreview(details) {
    return sendMessagePreview(details);
  }

  async sendMessageOnchain(details) {
    return sendMessageOnchain({ engine: this, ...details });
  }

  async estimateMessageFee(payloadBytes = 0) {
    if (!this.kaspa || !this.address) return null;
    await this.connect();
    return estimateOnchainFee({
      kaspa: this.kaspa,
      rpc: this.rpc,
      withRpc: this.withRpc.bind(this),
      sourceAddress: this.address,
      amountKas: "0.2",
      payloadBytes,
    });
  }

  async createEncryptedHandshakeEnvelope(details) {
    const peerAddress = details?.toAddress;
    const aliases = await this.deriveConversationAliases(peerAddress);
    return createEncryptedHandshakeEnvelope({
      ...details,
      alias: aliases.theirAlias,
      encryptMessage: async (address, text) => {
        const result = await import("./kasia-cipher.js");
        return result.encryptKasiaMessage(address, text);
      },
    });
  }

  async sendHandshakeOnchain(details) {
    return sendHandshakeOnchain({ engine: this, ...details });
  }

  async createSelfStashEnvelope(details) {
    return createSelfStashEnvelope({
      ...details,
      encryptToSelf: async (text) => {
        const result = await import("./kasia-cipher.js");
        return result.encryptKasiaMessage(this.address, text);
      },
    });
  }

  async sendSelfStashOnchain(details) {
    return sendSelfStashOnchain({ engine: this, ...details });
  }

  async syncSelfStashFromChain(details = {}) {
    this.requireWallet();
    if (!this.isKasiaCipherLoaded()) await this.loadKasiaCipher();
    return syncSelfStashFromChain({
      ...details,
      walletAddress: this.address,
      privateKeyHex: this.privateKeyHex,
      decryptMessage: async (encryptedHex) => this.decryptKasiaMessage(encryptedHex),
    });
  }

  buildConversationSyncPlan(details) {
    return buildConversationSyncPlan(details);
  }

  async syncConversationPreview(details) {
    return syncConversationPreview(details);
  }

  async testKasiaIndexer(indexerUrl = DEFAULT_KASIA_INDEXER_URL) {
    return testKasiaIndexer(indexerUrl);
  }

  async syncIncomingHandshakesFromIndexer(details = {}) {
    this.requireWallet();
    if (!this.isKasiaCipherLoaded()) await this.loadKasiaCipher();
    return syncIncomingHandshakesFromIndexer({
      ...details,
      walletAddress: this.address,
      privateKeyHex: this.privateKeyHex,
      decryptMessage: async (encryptedHex) => this.decryptKasiaMessage(encryptedHex),
    });
  }

  async syncIncomingPayments(details) {
    if (!this.address) throw new Error("Generate or import a wallet before payment sync.");
    return syncIncomingPaymentsFromRest({ ...details, walletAddress: this.address });
  }

  async syncConversationFromIndexer(details) {
    if (!this.privateKeyHex || !this.address) throw new Error("Generate or import a wallet before real sync.");
    if (!this.isKasiaCipherLoaded()) throw new Error("Load Kasia Cipher WASM before real sync.");
    const peerAddress = details?.contact?.address;
    const aliases = await this.deriveConversationAliases(peerAddress);
    return syncConversationFromIndexer({
      ...details,
      alias: aliases.myAlias,
      deterministicAliases: aliases,
      walletAddress: this.address,
      privateKeyHex: this.privateKeyHex,
      decryptMessage: async (encryptedHex) => this.decryptKasiaMessage(encryptedHex),
    });
  }

  qrPayload() {
    this.requireWallet();
    return makeQrPayload(this.address);
  }

  async drawQr(canvas, colorOptions) {
    return drawKaspaQr(canvas, this.qrPayload(), colorOptions);
  }

  version() {
    return this.kaspa?.version ? this.kaspa.version() : "";
  }

  knsNormalizeDomainName(raw) {
    return knsNormalizeDomainName(raw);
  }

  knsLooksLikeDomain(input) {
    return knsLooksLikeDomain(input);
  }

  async resolveKnsDomain(domain, options = {}) {
    return knsResolveDomain(domain, { baseUrl: getEndpoint("knsApi"), ...options });
  }

  async fetchKnsAddressInfo(address, options = {}) {
    return knsFetchAddressInfo(address, { baseUrl: getEndpoint("knsApi"), ...options });
  }

  async getKnsAddressInfo(address, options = {}) {
    return knsGetAddressInfo(address, { baseUrl: getEndpoint("knsApi"), ...options });
  }

  async fetchKnsAddressProfile(address, options = {}) {
    return knsFetchAddressProfile(address, { baseUrl: getEndpoint("knsApi"), ...options });
  }

  async getKnsAddressProfile(address, options = {}) {
    return knsGetAddressProfile(address, { baseUrl: getEndpoint("knsApi"), ...options });
  }

  async refreshKnsIfNeeded(addresses, options = {}) {
    return knsRefreshIfNeeded(addresses, { baseUrl: getEndpoint("knsApi"), ...options });
  }

  peekKnsAddressInfo(address) {
    return knsPeekAddressInfo(address);
  }

  peekKnsAddressProfile(address) {
    return knsPeekAddressProfile(address);
  }

  clearKnsCache(address) {
    return clearKnsCache(address);
  }

  clearAllKnsCache() {
    return clearAllKnsCache();
  }

  async checkKnsDomainAvailability(domainInput, options = {}) {
    this.requireWallet();
    return knsCheckDomainAvailability(this.address, domainInput, { baseUrl: getEndpoint("knsApi"), ...options });
  }

  async fetchKnsFeeTiers(options = {}) {
    return knsFetchInscribeFeeTiers({ baseUrl: getEndpoint("knsApi"), ...options });
  }

  knsEconomics() {
    return KNS_ECONOMICS;
  }

  validateKnsProfileFields(fields) {
    return knsValidateProfileFields(fields);
  }

  peekPendingKnsCommit() {
    return peekPendingKnsCommit();
  }

  clearPendingKnsCommit() {
    return clearPendingKnsCommit();
  }

  async inscribeKnsDomain(label, { onStatus = () => {} } = {}) {
    this.requireWallet();
    await this.connect();
    return knsInscribeDomain({ engine: this, label, onStatus, log: this.log });
  }

  // Transfers a KNS domain. `spendingIndex` (with the account's mnemonic/
  // passphrase) makes a derived spending address the owner/funder/signer of
  // the commit/reveal pair — iOS's fromSpendingAddressIndex analog; omitted,
  // the chatting identity transfers its own domain.
  async transferKnsDomain({ domain, assetId, toAddress, mnemonic = null, spendingIndex = null, passphrase = "", onStatus = () => {} }) {
    this.requireWallet();
    await this.connect();
    let signer = null;
    if (spendingIndex != null) {
      if (!mnemonic) throw new Error("The account mnemonic is required to sign from a spending address.");
      const spending = this.deriveSpendingWallet(mnemonic, spendingIndex, passphrase);
      signer = { privateKey: spending.privateKey, address: spending.address };
    }
    return knsTransferDomain({ engine: this, domain, assetId, toAddress, signer, onStatus, log: this.log });
  }

  async submitKnsProfileField(assetId, key, value, { onStatus = () => {} } = {}) {
    this.requireWallet();
    await this.connect();
    return knsSubmitProfileField({ engine: this, assetId, key, value, onStatus, log: this.log });
  }

  async submitKnsProfileFields(assetId, fields, { onStatus = () => {} } = {}) {
    this.requireWallet();
    await this.connect();
    return knsSubmitProfileFields({ engine: this, assetId, fields, onStatus, log: this.log });
  }

  async uploadKnsProfileImage(assetId, uploadType, blob) {
    this.requireWallet();
    return knsUploadProfileImage({ engine: this, assetId, uploadType, blob, baseUrl: getEndpoint("knsApi") });
  }
}

export { normalizeSourceFamily, sourceFamilyPathDescription, WALLET_SOURCE_FAMILIES } from "./wallet.js";
export * from "./conversations.js";
export * from "./sync.js";
export * from "./kasia-protocol.js";

export * from "./kasia-cipher.js";
export * from "./kaposts.js";
