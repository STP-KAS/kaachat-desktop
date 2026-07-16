// Message transport facade for KaChat/Kasia integration.
// Step 16 adds two transport paths:
// 1. preview: no chain write, simulated status pipeline
// 2. onchain: real Kaspa transaction call with a Kasia-shaped COMM payload
//
// The UI still defaults to preview mode. On-chain mode is intentionally explicit.

import { buildCommMessage, buildEncryptedCommMessage, buildEncryptedHandshake, parseKasiaPayloadHex, KASIA_INTEGRATION_STATUS } from "./kasia-protocol.js";
import { encryptKasiaMessage } from "./kasia-cipher.js";
import { sendPayloadTransaction } from "./transactions.js";

function simpleHash(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

export function createMessageEnvelope({ conversationId, contactId, toAddress, fromAddress = null, text, localNonce, createdAt = Date.now(), alias = "kachat" }) {
  const kasiaPayload = buildCommMessage({
    alias,
    text,
    sender: fromAddress,
    receiver: toAddress,
    createdAt,
    conversationId,
    contactId,
    localNonce,
  });
  return {
    conversationId,
    contactId,
    toAddress,
    fromAddress,
    text,
    localNonce,
    createdAt,
    protocol: kasiaPayload.protocol,
    version: kasiaPayload.version,
    messageType: kasiaPayload.type,
    payloadHex: kasiaPayload.payloadHex,
    payloadBytes: kasiaPayload.payloadBytes,
    protocolBytes: kasiaPayload.protocolBytes,
    wireShape: kasiaPayload.wireShape,
    encryptionMode: kasiaPayload.encryptionMode,
    encrypted: kasiaPayload.encrypted,
    transport: kasiaPayload.transport,
    protocolString: kasiaPayload.protocolString,
    recipientAlias: kasiaPayload.recipientAlias,
    sender: kasiaPayload.sender,
    receiver: kasiaPayload.receiver,
    checksum: kasiaPayload.checksum,
    parsedPayload: parseKasiaPayloadHex(kasiaPayload.payloadHex),
  };
}


export async function createEncryptedMessageEnvelope({ conversationId, contactId, toAddress, fromAddress = null, text, localNonce, createdAt = Date.now(), alias = "kachat" }) {
  const kasiaPayload = await buildEncryptedCommMessage({
    alias,
    text,
    sender: fromAddress,
    receiver: toAddress,
    createdAt,
    conversationId,
    contactId,
    localNonce,
    encryptMessage: encryptKasiaMessage,
  });
  return {
    conversationId,
    contactId,
    toAddress,
    fromAddress,
    text,
    localNonce,
    createdAt,
    protocol: kasiaPayload.protocol,
    version: kasiaPayload.version,
    messageType: kasiaPayload.type,
    payloadHex: kasiaPayload.payloadHex,
    payloadBytes: kasiaPayload.payloadBytes,
    protocolBytes: kasiaPayload.protocolBytes,
    wireShape: kasiaPayload.wireShape,
    encryptionMode: kasiaPayload.encryptionMode,
    encrypted: kasiaPayload.encrypted,
    transport: kasiaPayload.transport,
    protocolString: kasiaPayload.protocolString,
    recipientAlias: kasiaPayload.recipientAlias,
    sender: kasiaPayload.sender,
    receiver: kasiaPayload.receiver,
    checksum: kasiaPayload.checksum,
    encryptedHex: kasiaPayload.encryptedHex,
  };
}

export async function sendMessagePreview({ envelope, onStatus = () => {} }) {
  if (!envelope?.text?.trim()) throw new Error("Message text is required.");
  if (!envelope?.toAddress?.startsWith("kaspa:")) throw new Error("A valid kaspa: contact address is required.");

  onStatus({
    status: "pending",
    note: "Kasia COMM payload created in KaspaEngine preview transport.",
    payloadHex: envelope.payloadHex,
    payloadBytes: envelope.payloadBytes,
    wireShape: envelope.wireShape,
    encryptionMode: envelope.encryptionMode,
    messageType: envelope.messageType,
    transport: "preview",
    protocolString: envelope.protocolString,
    sender: envelope.sender || envelope.fromAddress || null,
    receiver: envelope.receiver || envelope.toAddress || null,
  });

  await new Promise((resolve) => window.setTimeout(resolve, 650));
  const txid = `engine-preview-${simpleHash(`${envelope.localNonce}:${envelope.createdAt}:${envelope.text}:${envelope.toAddress}`)}`;
  onStatus({ status: "broadcast", txid, note: "Preview broadcast complete. Payload is not on-chain yet." });

  await new Promise((resolve) => window.setTimeout(resolve, 850));
  const daaScore = String(Math.floor(Date.now() / 1000));
  onStatus({ status: "confirmed", txid, daaScore, note: "Preview confirmation complete." });

  return { status: "confirmed", txid, daaScore, envelope };
}

export async function sendMessageOnchain({ engine, envelope, amountKas = KASIA_INTEGRATION_STATUS.defaultMessageAmountKas, feeKas = "0", onStatus = () => {} }) {
  if (!engine?.kaspa || !engine?.privateKey || !engine?.address) throw new Error("Load WASM and generate/import a wallet first.");
  if (!envelope?.toAddress?.startsWith("kaspa:")) throw new Error("A valid kaspa: contact address is required.");

  onStatus({
    status: "pending",
    note: "Creating real Kaspa transaction with Kasia COMM payload.",
    payloadHex: envelope.payloadHex,
    payloadBytes: envelope.payloadBytes,
    wireShape: envelope.wireShape,
    encryptionMode: envelope.encryptionMode,
    messageType: envelope.messageType,
    transport: "onchain",
    protocolString: envelope.protocolString,
    sender: envelope.sender || envelope.fromAddress || null,
    receiver: envelope.receiver || envelope.toAddress || null,
  });

  await engine.connect();
  const sendResult = await sendPayloadTransaction({
    kaspa: engine.kaspa,
    rpc: engine.rpc,
    withRpc: engine.withRpc.bind(engine),
    privateKey: engine.privateKey,
    sourceAddress: engine.address,
    destinationAddress: envelope.toAddress,
    amountKas,
    feeKas,
    payload: envelope.protocolBytes || envelope.protocolString || envelope.payloadHex,
    log: engine.log,
  });

  const txid = sendResult.txids?.[0] || "";
  onStatus({ status: "broadcast", txid, note: "Real Kaspa transaction broadcast." });

  const daaScore = String(Math.floor(Date.now() / 1000));
  onStatus({ status: "confirmed", txid, daaScore, note: "On-chain message transaction submitted." });
  return { status: "confirmed", txid, daaScore, envelope, sendResult };
}


export async function createEncryptedHandshakeEnvelope({
  conversationId,
  contactId,
  toAddress,
  fromAddress,
  alias = "KaChat",
  isResponse = false,
  createdAt = Date.now(),
  encryptMessage,
} = {}) {
  const payload = await buildEncryptedHandshake({
    alias,
    sender: fromAddress,
    receiver: toAddress,
    conversationId,
    isResponse,
    createdAt,
    encryptMessage,
  });
  return {
    conversationId,
    contactId,
    toAddress,
    fromAddress,
    createdAt,
    protocol: payload.protocol,
    version: payload.version,
    messageType: payload.messageType,
    payloadHex: payload.payloadHex,
    payloadBytes: payload.payloadBytes,
    protocolBytes: payload.protocolBytes,
    protocolString: payload.protocolString,
    wireShape: payload.wireShape,
    encryptionMode: payload.encryptionMode,
    encrypted: true,
    transport: payload.transport,
    sender: payload.sender,
    receiver: payload.receiver,
    encryptedHex: payload.encryptedHex,
  };
}

export async function sendHandshakeOnchain({ engine, envelope, amountKas = "0.2", feeKas = "0", onStatus = () => {} }) {
  if (!engine?.kaspa || !engine?.privateKey || !engine?.address) throw new Error("Load a wallet before sending a communication request.");
  if (!envelope?.toAddress?.startsWith("kaspa:")) throw new Error("A valid kaspa: recipient address is required.");
  onStatus({ status: "pending", note: "Creating encrypted KaChat communication request.", messageType: "handshake", transport: "onchain" });
  await engine.connect();
  const sendResult = await sendPayloadTransaction({
    kaspa: engine.kaspa,
    rpc: engine.rpc,
    withRpc: engine.withRpc.bind(engine),
    privateKey: engine.privateKey,
    sourceAddress: engine.address,
    destinationAddress: envelope.toAddress,
    amountKas,
    feeKas,
    payload: envelope.protocolBytes,
    log: engine.log,
  });
  const txid = sendResult.txids?.[0] || "";
  onStatus({ status: "broadcast", txid, note: "Communication request submitted on-chain.", messageType: "handshake", transport: "onchain" });
  return { status: "confirmed", txid, envelope, sendResult };
}
