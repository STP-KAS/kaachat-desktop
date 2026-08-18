// Group-chat state + orchestration (the "GroupBag/roster store" + service layer,
// mirroring iOS's GroupStore + GroupChatService). Persists per-wallet group state
// in localStorage, drives key distribution over the 1:1 ECIES channel, and turns
// on-chain payloads into decoded messages. Pure of DOM/UI; the app layer renders
// what syncGroups() returns and calls createGroup/sendGroupMessage/etc.
//
// The injected `engine` must provide: address, privateKeyHex, xOnlyPubKeyForAddress,
// sendGroupPayload, encryptGroupControl, decryptGroupControl, and the scanGroup*
// methods (see engine/index.js).
import * as G from "./group.js";

const GROUPS_KEY = "kachat-groups-v1";

// Deep-ish clone via JSON is fine — records are plain data (hex strings, numbers).
function loadAll() {
  try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || "{}") || {}; }
  catch { return {}; }
}
function saveAll(all) {
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(all)); } catch {}
}

export class GroupManager {
  constructor(engine) {
    this.engine = engine;
    this._selfPubHex = null;
  }

  get walletAddress() { return this.engine.address || ""; }

  // Our own x-only signing pubkey, derived once from the wallet key.
  selfPubHex() {
    if (!this._selfPubHex) this._selfPubHex = G.bytesToHex(G.xOnlyPublicKey(this.engine.privateKeyHex));
    return this._selfPubHex;
  }

  // --- persistence (scoped per wallet address) ---
  _bucket() {
    const all = loadAll();
    if (!all[this.walletAddress]) all[this.walletAddress] = {};
    return { all, bucket: all[this.walletAddress] };
  }
  listGroups() {
    const { bucket } = this._bucket();
    return Object.values(bucket).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  getGroup(groupId) {
    const { bucket } = this._bucket();
    return bucket[groupId] || null;
  }
  _put(record) {
    const { all, bucket } = this._bucket();
    record.updatedAt = record.updatedAt || 0;
    bucket[record.groupId] = record;
    all[this.walletAddress] = bucket;
    saveAll(all);
    return record;
  }
  deleteGroup(groupId) {
    const { all, bucket } = this._bucket();
    delete bucket[groupId];
    all[this.walletAddress] = bucket;
    saveAll(all);
  }

  // --- roster helper: resolve each address to its x-only pubkey ---
  async _buildRoster(memberAddresses, adminAddress) {
    const seen = new Set();
    const roster = [];
    for (const address of [adminAddress, ...memberAddresses]) {
      const addr = String(address || "").trim();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      const xOnlyPubKeyHex = await this.engine.xOnlyPubKeyForAddress(addr);
      roster.push({ address: addr, xOnlyPubKeyHex, isAdmin: addr === adminAddress });
    }
    return roster;
  }

  // --- create (admin) ---
  // Generates the group, persists the admin's GroupBag, and distributes gctl_root
  // to every member (including self is skipped — we already hold the keys).
  async createGroup({ name, memberAddresses = [] }) {
    const adminAddress = this.walletAddress;
    if (!adminAddress) throw new Error("Load a wallet before creating a group.");
    const roster = await this._buildRoster(memberAddresses, adminAddress);
    if (roster.length < 2) throw new Error("A group needs at least one other member.");
    if (roster.length > 50) throw new Error("A group can have at most 50 members.");

    const groupSeed = G.generateGroupSeed();
    const groupId = G.deriveGroupId(groupSeed);
    const epoch = 0;
    const groupRootEpoch = G.deriveGroupRootEpoch(groupSeed, groupId, epoch);
    const blindingKey = G.deriveBlindingKey(groupSeed, groupId);
    const deviceId = G.generateDeviceId();
    const adminSigningPub = this.selfPubHex();

    const record = {
      groupId: G.bytesToHex(groupId),
      name: String(name || "Group"),
      isAdmin: true,
      adminAddress,
      adminSigningPub,
      groupSeedHex: G.bytesToHex(groupSeed), // admin-only: lets us re-derive any epoch
      groupRootEpochHex: G.bytesToHex(groupRootEpoch),
      blindingKeyHex: G.bytesToHex(blindingKey),
      currentEpoch: epoch,
      deviceIdHex: G.bytesToHex(deviceId),
      msgCounter: 0,
      members: roster,
      cursors: {},
      updatedAt: 0,
    };
    this._put(record);
    // The group is already created and persisted. A failed invite broadcast (transient node
    // / balance / network) must NOT block the admin from entering the new group — surface it
    // as a soft warning and let it be retried (re-adding a member re-distributes the root).
    try {
      await this._distributeRoot(record, epoch);
    } catch (error) {
      record.inviteWarning = error?.message || String(error);
      this._put(record);
    }
    return record;
  }

  // Build + encrypt + broadcast a gctl_root to every non-self member at `epoch`.
  async _distributeRoot(record, epoch) {
    const groupSeed = G.hexToBytes(record.groupSeedHex);
    const groupId = G.hexToBytes(record.groupId);
    const groupRootEpoch = G.deriveGroupRootEpoch(groupSeed, groupId, epoch);
    const blindingKey = G.hexToBytes(record.blindingKeyHex);
    const memberAddresses = record.members.map((m) => m.address);
    const payload = G.buildSignedRootPayload({
      groupId, epoch, groupRootEpoch, blindingKey,
      adminSigningPub: record.adminSigningPub, members: memberAddresses,
      name: record.name, adminPrivateKey: this.engine.privateKeyHex,
    });
    const json = JSON.stringify(payload);
    for (const member of record.members) {
      if (member.address === this.walletAddress) continue; // we already have the keys
      const encryptedHex = await this.engine.encryptGroupControl(member.address, json);
      const wire = G.buildControlPayload({ recipientXOnlyPubKey: member.xOnlyPubKeyHex, encryptedHex });
      await this.engine.sendGroupPayload(wire);
    }
  }

  // --- membership changes (admin), each bumps the epoch and re-distributes ---
  async addMember(groupId, address) {
    const record = this._requireAdmin(groupId);
    const addr = String(address || "").trim();
    if (record.members.some((m) => m.address === addr)) return record;
    if (record.members.length >= 50) throw new Error("A group can have at most 50 members.");
    const xOnlyPubKeyHex = await this.engine.xOnlyPubKeyForAddress(addr);
    record.members.push({ address: addr, xOnlyPubKeyHex, isAdmin: false });
    return this._rotateEpoch(record, "add");
  }
  async removeMember(groupId, address) {
    const record = this._requireAdmin(groupId);
    const addr = String(address || "").trim();
    if (addr === record.adminAddress) throw new Error("The admin can't be removed.");
    record.members = record.members.filter((m) => m.address !== addr);
    return this._rotateEpoch(record, "remove");
  }
  async renameGroup(groupId, name) {
    const record = this._requireAdmin(groupId);
    record.name = String(name || record.name);
    record.updatedAt = 0;
    this._put(record);
    // Rename is not a forward-secrecy event — re-send the root at the SAME epoch.
    await this._distributeRoot(record, record.currentEpoch);
    return record;
  }

  async _rotateEpoch(record, reason) {
    const groupSeed = G.hexToBytes(record.groupSeedHex);
    const groupId = G.hexToBytes(record.groupId);
    const newEpoch = record.currentEpoch + 1;
    record.currentEpoch = newEpoch;
    record.groupRootEpochHex = G.bytesToHex(G.deriveGroupRootEpoch(groupSeed, groupId, newEpoch));
    record.msgCounter = 0; // counter resets when the epoch advances
    this._put(record);
    // Announce, then hand out the new root (removed members never get it).
    const epochPayload = G.buildSignedEpochPayload({ groupId, epoch: newEpoch, reason, adminPrivateKey: this.engine.privateKeyHex });
    const epochJson = JSON.stringify(epochPayload);
    for (const member of record.members) {
      if (member.address === this.walletAddress) continue;
      const encryptedHex = await this.engine.encryptGroupControl(member.address, epochJson);
      await this.engine.sendGroupPayload(G.buildControlPayload({ recipientXOnlyPubKey: member.xOnlyPubKeyHex, encryptedHex }));
    }
    await this._distributeRoot(record, newEpoch);
    return record;
  }

  _requireAdmin(groupId) {
    const record = this.getGroup(groupId);
    if (!record) throw new Error("Group not found.");
    if (!record.isAdmin) throw new Error("Only the group admin can do that.");
    return record;
  }

  // --- send a message ---
  async sendGroupMessage(groupId, plaintext) {
    const record = this.getGroup(groupId);
    if (!record) throw new Error("Group not found.");
    if (!record.groupRootEpochHex) throw new Error("No group key for the current epoch.");
    // Reserve the counter BEFORE sending so a retry never reuses a msg_id.
    const counter = record.msgCounter;
    record.msgCounter = counter + 1;
    this._put(record);
    const payload = G.sealGroupMessage({
      plaintext,
      groupId: G.hexToBytes(record.groupId),
      epoch: record.currentEpoch,
      groupRootEpoch: G.hexToBytes(record.groupRootEpochHex),
      blindingKey: G.hexToBytes(record.blindingKeyHex),
      senderAddress: this.walletAddress,
      senderPrivateKey: this.engine.privateKeyHex,
      senderXOnlyPub: this.selfPubHex(),
      deviceId: G.hexToBytes(record.deviceIdHex),
      counter,
    });
    const msgIdHex = G.bytesToHex(G.buildMsgId(G.hexToBytes(record.deviceIdHex), counter));
    const result = await this.engine.sendGroupPayload(payload);
    return { txid: result?.txids?.[0] || null, counter, epoch: record.currentEpoch, msgIdHex };
  }

  // --- apply an incoming control message (gctl_root / gctl_epoch) ---
  // `senderAddress` comes from the indexer row. Returns a small event describing
  // what changed, or null if it wasn't for us / was invalid / was stale.
  async applyControl(payloadString, senderAddress) {
    const parsed = G.parseControlPayload(payloadString);
    if (!parsed) return null;
    // The indexer strips the recipient in REST responses, so parsed.recipientXOnlyPubKey
    // is usually null here. When it IS present (live wire / our own echo) we can fast-skip
    // controls addressed to someone else; otherwise we just try to decrypt — a control that
    // isn't ours fails ECIES and returns null, exactly as iOS relies on.
    if (parsed.recipientXOnlyPubKey && G.bytesToHex(parsed.recipientXOnlyPubKey) !== this.selfPubHex()) return null;
    let json;
    try { json = await this.engine.decryptGroupControl(parsed.encryptedHex); }
    catch { return null; } // not decryptable by us
    let payload;
    try { payload = JSON.parse(json); } catch { return null; }

    if (payload.type === "gctl_root") return this._applyRoot(payload, senderAddress);
    // gctl_epoch is a heads-up only; the real state change lands on the matching gctl_root.
    if (payload.type === "gctl_epoch") return { kind: "epoch-notice", groupId: payload.group_id, epoch: payload.epoch };
    return null;
  }

  async _applyRoot(payload, senderAddress) {
    if (!G.verifyRootPayload(payload)) return null;
    const groupId = payload.group_id;
    const existing = this.getGroup(groupId);
    // Replay guard: never apply an epoch strictly older than what we hold.
    if (existing && payload.epoch < existing.currentEpoch) return null;

    // Resolve each member address to its pubkey for the local roster.
    const roster = [];
    for (const address of payload.members || []) {
      const addr = String(address || "").trim();
      if (!addr || roster.some((m) => m.address === addr)) continue;
      let xOnlyPubKeyHex = null;
      try { xOnlyPubKeyHex = await this.engine.xOnlyPubKeyForAddress(addr); } catch { xOnlyPubKeyHex = null; }
      roster.push({ address: addr, xOnlyPubKeyHex, isAdmin: addr === senderAddress });
    }

    const isNewEpoch = !existing || payload.epoch > existing.currentEpoch;
    const record = {
      groupId,
      name: payload.name || existing?.name || "Group",
      isAdmin: false,
      adminAddress: senderAddress || existing?.adminAddress || null,
      adminSigningPub: payload.admin_signing_pub,
      groupSeedHex: null, // non-admins never hold the seed
      groupRootEpochHex: payload.group_root_epoch,
      blindingKeyHex: payload.blinding_key,
      currentEpoch: payload.epoch,
      // device_id is preserved across updates; counter resets only when the epoch advances.
      deviceIdHex: existing?.deviceIdHex || G.bytesToHex(G.generateDeviceId()),
      msgCounter: isNewEpoch ? 0 : (existing?.msgCounter || 0),
      members: roster,
      cursors: existing?.cursors || {},
      updatedAt: 0,
    };
    this._put(record);
    return { kind: existing ? "root-updated" : "joined", groupId, epoch: payload.epoch, name: record.name };
  }

  // --- process an incoming gcomm message ---
  // Trial-matches the parsed message's blinded id against each local group's
  // roster; on a match, verifies roster membership + sender_id, then decrypts.
  // Returns a decoded message or null.
  processMessage(parsed) {
    if (!parsed) return null;
    for (const record of this.listGroups()) {
      const blindingKey = G.hexToBytes(record.blindingKeyHex);
      const expected = G.bytesToHex(G.deriveBlindedGroupId(blindingKey, parsed.senderPubKey));
      if (expected !== G.bytesToHex(parsed.blindedGroupId)) continue;
      // Sender must be in the roster (matched by pubkey).
      const member = record.members.find((m) => m.xOnlyPubKeyHex === G.bytesToHex(parsed.senderPubKey));
      if (!member) return null;
      // sender_id must equal SHA256(sender_address).
      if (G.bytesToHex(G.deriveSenderId(member.address)) !== G.bytesToHex(parsed.senderId)) return null;
      // Need the epoch's root. Non-admins only hold the current epoch's root; the
      // admin can re-derive any epoch from the seed.
      let rootHex = null;
      if (parsed.epoch === record.currentEpoch) rootHex = record.groupRootEpochHex;
      else if (record.groupSeedHex) rootHex = G.bytesToHex(G.deriveGroupRootEpoch(G.hexToBytes(record.groupSeedHex), G.hexToBytes(record.groupId), parsed.epoch));
      if (!rootHex) return null;
      let plaintext;
      try { plaintext = G.openGroupMessage(parsed, { groupId: G.hexToBytes(record.groupId), groupRootEpoch: G.hexToBytes(rootHex) }); }
      catch { return null; }
      return {
        groupId: record.groupId,
        senderAddress: member.address,
        senderIsAdmin: member.isAdmin,
        epoch: parsed.epoch,
        msgIdHex: G.bytesToHex(parsed.msgId),
        plaintext,
      };
    }
    return null;
  }

  // --- sync: pull new controls (invites/rotations) then new messages ---
  // Returns { controls: [...events], messages: [...decoded] }. The app persists
  // decoded messages into its conversation state and renders control events.
  async syncGroups() {
    const events = [];
    // 1. Discover invites / rotations addressed to us.
    try {
      const recips = await this.engine.scanGroupControlByRecipient();
      for (const row of recips) {
        const ev = await this.applyControl(row.payloadString, row.sender);
        if (ev) events.push(ev);
      }
    } catch { /* indexer hiccup — try messages anyway */ }

    // 2. For each known group, pull messages under every member's blinded id.
    const messages = [];
    for (const record of this.listGroups()) {
      const blindingKey = G.hexToBytes(record.blindingKeyHex);
      record.cursors = record.cursors || {};
      for (const member of record.members) {
        if (!member.xOnlyPubKeyHex) continue;
        const blindedHex = G.bytesToHex(G.deriveBlindedGroupId(blindingKey, member.xOnlyPubKeyHex));
        let rows;
        try { rows = await this.engine.scanGroupMessages(blindedHex, record.cursors[blindedHex] || null); }
        catch { continue; }
        for (const row of rows) {
          const parsed = G.parseGroupMessagePayload(row.payloadString);
          const decoded = this.processMessage(parsed);
          if (decoded) messages.push({ ...decoded, txId: row.txId, blockTime: row.blockTime });
          if (row.cursor) record.cursors[blindedHex] = row.cursor;
        }
      }
      this._put(record);
    }
    return { controls: events, messages };
  }
}

export function createGroupManager(engine) {
  return new GroupManager(engine);
}
