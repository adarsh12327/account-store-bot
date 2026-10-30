"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.GLOBAL_PAYMENT_API_URL = "https://global-lock.example.workers.dev/";
process.env.GLOBAL_PAYMENT_SECRET = "unit-test-secret";

const calls = [];
global.fetch = async (url, options) => {
  calls.push({ url, options });
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, claimed: true })
  };
};

const lock = require("../utils/globalPaymentLock");

test("claim sends normalized identifiers and amount in minor units", async () => {
  calls.length = 0;
  const result = await lock.claim({
    botId: "KAP_SMS",
    depositId: "dummy-deposit-1",
    userId: "dummy-user",
    amount: 12.34,
    identifiers: [
      { type: "UTR", value: " abc123 " },
      { type: "TRANSACTION_ID", value: " tx987 " }
    ]
  });
  assert.equal(result.claimed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://global-lock.example.workers.dev/global-payment/claim");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.amount_minor, 1234);
  assert.deepEqual(body.identifiers, [
    { type: "UTR", value: "ABC123" },
    { type: "TRANSACTION_ID", value: "TX987" }
  ]);
  assert.equal(calls[0].options.headers.authorization, "Bearer unit-test-secret");
});

test("commit calls the commit endpoint with the payment key", async () => {
  calls.length = 0;
  await lock.commit("synthetic-payment-key");
  assert.equal(calls[0].url, "https://global-lock.example.workers.dev/global-payment/commit");
  assert.deepEqual(JSON.parse(calls[0].options.body), { payment_key: "synthetic-payment-key" });
});

test("HTTP/API rejection is surfaced to the caller", async () => {
  global.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ ok: false, reason: "DUPLICATE_PAYMENT" })
  });
  await assert.rejects(
    lock.claim({ botId: "KAP_SMS", depositId: "d2", userId: "u2", amount: 1, identifiers: [{type:"UTR",value:"DUMMY"}] }),
    error => error.code === "DUPLICATE_PAYMENT" && error.status === 409
  );
});
