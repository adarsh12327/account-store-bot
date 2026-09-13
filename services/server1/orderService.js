/**
 * services/server1/orderService.js
 * ------------------------------------------------------------
 * Server 1 Order Service
 *
 * Handles Server 1 order creation and access.
 * Firestore access stays inside database.js.
 * ------------------------------------------------------------
 */

const db = require("../../database");

/**
 * Create a new Server 1 order.
 */
async function createOrder({
  userId,
  serviceId,
  serviceName = "",
  countryId,
  countryName = "",
  amount,
  externalId = null,
}) {
  if (!userId) {
    const err = new Error("User ID is required");
    err.code = "USER_ID_REQUIRED";
    throw err;
  }

  if (!serviceId) {
    const err = new Error("Service ID is required");
    err.code = "SERVICE_ID_REQUIRED";
    throw err;
  }

  const price = Number(amount);

  if (!Number.isFinite(price) || price <= 0) {
    const err = new Error("Invalid order amount");
    err.code = "INVALID_AMOUNT";
    throw err;
  }

  return db.createServer1Order({
    userId,
    serviceId,
    serviceName,
    countryId,
    countryName,
    amount: price,

    provider: "grizzly",
    status: "processing",

    externalId,
  });
}


/**
 * Get one Server 1 order.
 */
async function getOrder(orderId) {
  if (!orderId) {
    return null;
  }

  return db.getServer1Order(orderId);
}


/**
 * Get user's Server 1 orders.
 */
async function getUserOrders(
  userId,
  limit = 10,
  offset = 0
) {
  if (!userId) {
    return [];
  }

  return db.listUserServer1Orders(
    userId,
    limit,
    offset
  );
}


/**
 * Update Server 1 order.
 */
async function updateOrder(orderId, updates) {
  if (!orderId) {
    const err = new Error("Order ID is required");
    err.code = "ORDER_ID_REQUIRED";
    throw err;
  }

  return db.updateServer1Order(
    orderId,
    updates
  );
}


module.exports = {
  createOrder,
  getOrder,
  getUserOrders,
  updateOrder,
};
