import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bytesToHex,
  kasToSompi,
  parseTxid,
  detected,
  connectInjected,
  sendInjectedPayload,
} from "./injected-wallet.js";

test("bytesToHex encodes protocol payloads", () => {
  assert.equal(bytesToHex(new Uint8Array([0x6b, 0x63, 0x68, 0x61, 0x74])), "6b63686174");
  assert.equal(bytesToHex("kchat"), "6b63686174");
});

test("kasToSompi converts 0.2 KAS the way chat payments do", () => {
  assert.equal(kasToSompi("0.2"), 20_000_000);
  assert.equal(kasToSompi(1), 100_000_000);
  assert.throws(() => kasToSompi("0"), /greater than 0/);
});

test("parseTxid accepts strings and wallet objects", () => {
  assert.equal(parseTxid("0xabc"), "abc");
  assert.equal(parseTxid({ transactionId: "deadbeef" }), "deadbeef");
});

test("detected reports only injected wallets", () => {
  assert.deepEqual(detected({}), []);
  assert.deepEqual(detected({ kasware: {} }), ["kasware"]);
  assert.deepEqual(detected({ kasware: {}, kastle: {} }), ["kasware", "kastle"]);
});

test("connect Kasware uses a quiet account then requestAccounts", async () => {
  const win = {
    kasware: {
      getAccounts: async () => [],
      requestAccounts: async () => ["kaspa:qtestaddress"],
      getPublicKey: async () => "03ab",
    },
  };
  const session = await connectInjected("kasware", win);
  assert.equal(session.id, "kasware");
  assert.equal(session.address, "kaspa:qtestaddress");
  assert.equal(session.publicKey, "03ab");
});

test("connect Kastle uses connect then getAccount", async () => {
  const win = {
    kastle: {
      connect: async () => true,
      getAccount: async () => ({ address: "kaspa:qkastle", publicKey: "02cd" }),
    },
  };
  const session = await connectInjected("kastle", win);
  assert.equal(session.id, "kastle");
  assert.equal(session.address, "kaspa:qkastle");
});

test("sendInjectedPayload posts hex payload through sendKaspa", async () => {
  const calls = [];
  const win = {
    kasware: {
      sendKaspa: async (to, sompi, options) => {
        calls.push({ to, sompi, options });
        return "txid-1";
      },
    },
  };
  const result = await sendInjectedPayload({
    id: "kasware",
    toAddress: "kaspa:qdest",
    amountKas: "0.2",
    payload: new TextEncoder().encode("kchat:1:handshake:"),
    win,
  });
  assert.deepEqual(result.txids, ["txid-1"]);
  assert.equal(calls[0].sompi, 20_000_000);
  assert.equal(calls[0].options.payload, bytesToHex(new TextEncoder().encode("kchat:1:handshake:")));
});

test("missing Kasware throws a install-then-retry error", async () => {
  await assert.rejects(() => connectInjected("kasware", { open() {} }), /Kasware is not in this tab/);
});
