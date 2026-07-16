// Conversation engine for KaChat/Kasia shell.
// This module keeps message/conversation objects consistent across preview mode,
// local inbound previews, and future real Kasia on-chain sync.

export const MESSAGE_STATUSES = Object.freeze({
  DRAFT: "draft",
  BUILDING: "building",
  SIGNING: "signing",
  BROADCASTING: "broadcasting",
  PENDING: "pending",
  BROADCAST: "broadcast",
  CONFIRMED: "confirmed",
  FAILED: "failed",
});

export function createId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createConversation({ contactId, createdAt = Date.now() }) {
  return {
    id: createId(),
    type: "direct",
    contactId,
    createdAt,
    updatedAt: createdAt,
    lastActivityAt: createdAt,
    unreadCount: 0,
    pinned: false,
    muted: false,
    archived: false,
    messages: [],
  };
}

export function createMessage({
  conversationId,
  contactId,
  direction = "outgoing",
  text,
  sender = null,
  receiver = null,
  status = MESSAGE_STATUSES.DRAFT,
  transport = "preview",
  createdAt = Date.now(),
  protocol = "kasia",
  protocolVersion = 1,
}) {
  return {
    id: createId(),
    conversationId,
    contactId,
    direction: direction === "incoming" ? "incoming" : "outgoing",
    text: String(text || ""),
    sender,
    receiver,
    status,
    txid: null,
    daaScore: null,
    confirmations: 0,
    network: "mainnet",
    payloadHex: null,
    payloadBytes: null,
    messageType: null,
    localNonce: createId(),
    transport,
    protocol,
    protocolVersion,
    protocolString: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function normalizeMessage(message, conversationId) {
  const createdAt = Number(message?.createdAt || Date.now());
  const status = String(message?.status || MESSAGE_STATUSES.DRAFT);
  return {
    id: String(message?.id || createId()),
    conversationId: String(message?.conversationId || conversationId),
    contactId: message?.contactId ? String(message.contactId) : null,
    direction: message?.direction === "incoming" ? "incoming" : "outgoing",
    text: String(message?.text || ""),
    sender: message?.sender ? String(message.sender) : null,
    receiver: message?.receiver ? String(message.receiver) : null,
    status: status === "local" || status === "local-draft" ? MESSAGE_STATUSES.DRAFT : status,
    txid: message?.txid ? String(message.txid) : null,
    daaScore: message?.daaScore ? String(message.daaScore) : null,
    confirmations: Number(message?.confirmations || 0),
    network: String(message?.network || "mainnet"),
    payloadHex: message?.payloadHex ? String(message.payloadHex) : null,
    payloadBytes: message?.payloadBytes ? Number(message.payloadBytes) : null,
    messageType: message?.messageType ? String(message.messageType) : null,
    paymentAmountKas: message?.paymentAmountKas != null ? String(message.paymentAmountKas) : null,
    note: message?.note ? String(message.note) : null,
    localNonce: String(message?.localNonce || createId()),
    transport: String(message?.transport || "preview"),
    protocol: String(message?.protocol || "kasia"),
    protocolVersion: Number(message?.protocolVersion || 1),
    protocolString: message?.protocolString ? String(message.protocolString) : null,
    createdAt,
    updatedAt: Number(message?.updatedAt || createdAt),
  };
}

export function applyMessagePatch(message, patch = {}) {
  Object.assign(message, patch, { updatedAt: Date.now() });
  if (message.status === MESSAGE_STATUSES.CONFIRMED && !message.confirmations) {
    message.confirmations = 1;
  }
  return message;
}

export function touchConversation(conversation, timestamp = Date.now()) {
  conversation.updatedAt = timestamp;
  conversation.lastActivityAt = Math.max(Number(conversation.lastActivityAt || 0), timestamp);
  return conversation;
}

export function addMessageToConversation(conversation, message) {
  conversation.messages.push(message);
  touchConversation(conversation, message.createdAt || Date.now());
  return message;
}

export function lastMessage(conversation) {
  return conversation?.messages?.length ? conversation.messages[conversation.messages.length - 1] : null;
}

export function statusLabel(status) {
  const labels = {
    [MESSAGE_STATUSES.DRAFT]: "Draft",
    [MESSAGE_STATUSES.BUILDING]: "Building",
    [MESSAGE_STATUSES.SIGNING]: "Signing",
    [MESSAGE_STATUSES.BROADCASTING]: "Broadcasting",
    [MESSAGE_STATUSES.PENDING]: "Pending",
    [MESSAGE_STATUSES.BROADCAST]: "Broadcast",
    [MESSAGE_STATUSES.CONFIRMED]: "Confirmed",
    [MESSAGE_STATUSES.FAILED]: "Failed",
  };
  return labels[status] || status || "Draft";
}

export function conversationSummary(conversation) {
  const last = lastMessage(conversation);
  return {
    id: conversation.id,
    contactId: conversation.contactId,
    unreadCount: Number(conversation.unreadCount || 0),
    lastActivityAt: Number(conversation.lastActivityAt || conversation.updatedAt || conversation.createdAt || 0),
    lastMessage: last,
    messageCount: conversation.messages?.length || 0,
  };
}
