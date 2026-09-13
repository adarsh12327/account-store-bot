/**
 * services/server1/index.js
 * ------------------------------------------------------------
 * Server 1 service layer.
 *
 * Keeps provider communication separate from:
 * - Telegram handlers
 * - Wallet
 * - Orders
 * - Firestore
 *
 * Current mode: SANDBOX
 * ------------------------------------------------------------
 */

const ProviderAdapter = require("./providerAdapter");

const provider = new ProviderAdapter({
  name: "Server 1",
  enabled: true,
});

/**
 * Get Server 1 availability.
 */
async function getAvailability() {
  return provider.getAvailability();
}

/**
 * Get live Telegram pricing for a country.
 */
async function getTelegramPrice(countryCode) {
  return provider.getTelegramPrice(countryCode);
}

/**
 * Get live Telegram pricing for multiple countries.
 */
async function getTelegramPrices(countryCodes = []) {
  return provider.getTelegramPrices(countryCodes);
}

/**
 * Create sandbox activation.
 */
async function createActivation(data = {}) {
  return provider.createActivation(data);
}

/**
 * Get activation status.
 */
async function getActivationStatus(activationId) {
  return provider.getActivationStatus(
    activationId
  );
}

/**
 * Cancel activation.
 */
async function cancelActivation(activationId) {
  return provider.cancelActivation(
    activationId
  );
}

module.exports = {
  provider,
  getAvailability,
  getTelegramPrice,
  getTelegramPrices,
  createActivation,
  getActivationStatus,
  cancelActivation,
};
