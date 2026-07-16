import { loadKaspaModule } from "./wasm-loader.js";
import { connectRpc, createStandbyRpc, disconnectRpc, getNodeRegistrySnapshot, isRpcConnectionError, probeRpc, recordFailover } from "./rpc.js";
import { generateWallet, generateMnemonicWallet, importMnemonic, importPrivateKey } from "./wallet.js";
import { getBalance, sendKaspa } from "./transactions.js";
import { makeQrPayload, drawKaspaQr } from "./qr.js";
import { createMessageEnvelope, createEncryptedMessageEnvelope, createEncryptedHandshakeEnvelope, sendMessagePreview, sendMessageOnchain, sendHandshakeOnchain } from "./messages.js";
import { buildConversationSyncPlan, syncConversationPreview, syncConversationFromIndexer, syncIncomingHandshakesFromIndexer, syncIncomingPaymentsFromRest, testKasiaIndexer, DEFAULT_KASIA_INDEXER_URL } from "./sync.js";
import { KASIA_PROTOCOL, KASIA_INTEGRATION_STATUS, buildCommMessage, buildEncryptedCommMessage, makeKasiaCommPayload, parseKasiaPayloadHex, decodePayload } from "./kasia-protocol.js";
import { loadKasiaCipher, isKasiaCipherLoaded, decryptKasiaMessage, deriveKasiaAliases } from "./kasia-cipher.js";
import { requireKaspa, NETWORK_ID } from "./utils.js";

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
    this.rpcHeartbeatMs = 20000;
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
        throw error;
      }
    })();

    try {
      return await this.rpcConnectPromise;
    } finally {
      this.rpcConnectPromise = null;
    }
  }

  startRpcHeartbeat() {
    if (this.rpcHeartbeatTimer || typeof window === "undefined") return;
    this.rpcHeartbeatTimer = window.setInterval(async () => {
      if (!this.rpc) return;
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

  async disconnect() {
    this.stopRpcHeartbeat();
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

  generateMnemonicWallet(wordCount = 24) {
    this.requireSdk();
    return this.setWallet(generateMnemonicWallet(this.kaspa, wordCount));
  }

  importMnemonic(phrase) {
    this.requireSdk();
    return this.setWallet(importMnemonic(this.kaspa, phrase));
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

  async send(destinationAddress, amountKas, feeKas = "0") {
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
      log: this.log,
    });
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

  async createEncryptedHandshakeEnvelope(details) {
    return createEncryptedHandshakeEnvelope({ ...details, encryptMessage: async (address, text) => {
      const result = await import("./kasia-cipher.js");
      return result.encryptKasiaMessage(address, text);
    } });
  }

  async sendHandshakeOnchain(details) {
    return sendHandshakeOnchain({ engine: this, ...details });
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

  async drawQr(canvas) {
    return drawKaspaQr(canvas, this.qrPayload());
  }

  version() {
    return this.kaspa?.version ? this.kaspa.version() : "";
  }
}

export * from "./conversations.js";
export * from "./sync.js";
export * from "./kasia-protocol.js";

export * from "./kasia-cipher.js";
