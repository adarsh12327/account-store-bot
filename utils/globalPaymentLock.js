"use strict";
const crypto = require("crypto");
const API_URL = String(process.env.GLOBAL_PAYMENT_API_URL || "").replace(/\/+$/, "");
const SECRET = String(process.env.GLOBAL_PAYMENT_SECRET || "");
async function request(path, body) {
  if (!API_URL || !SECRET) throw new Error("GLOBAL_PAYMENT_LOCK_NOT_CONFIGURED");
  const response = await fetch(API_URL + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + SECRET },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.reason || data.error || "GLOBAL_PAYMENT_LOCK_FAILED");
    error.code = data.reason || "GLOBAL_PAYMENT_LOCK_FAILED";
    error.status = response.status;
    throw error;
  }
  return data;
}
function paymentKey(botId, depositId) {
  return crypto.createHash("sha256").update(String(botId) + ":" + String(depositId)).digest("hex");
}
async function claim({ botId, depositId, userId, amount, identifiers }) {
  const payment_key = paymentKey(botId, depositId);
  const ids = (identifiers || []).filter(x => x && x.value).map(x => ({ type: x.type, value: String(x.value).trim().toUpperCase() }));
  const data = await request("/global-payment/claim", {
    bot_id: botId, deposit_id: String(depositId), user_id: String(userId),
    amount_minor: Math.round(Number(amount) * 100), payment_key, identifiers: ids,
  });
  return { ...data, paymentKey: payment_key };
}
async function commit(paymentKey) {
  return request("/global-payment/commit", { payment_key: paymentKey });
}
module.exports = { claim, commit };
