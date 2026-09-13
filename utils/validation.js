/**
 * utils/validation.js
 * ------------------------------------------------------------------
 * Reusable input validators for text entered by users/admins.
 * ------------------------------------------------------------------
 */

/**
 * Validate a positive numeric amount (e.g. deposit amount, balance
 * change, product price). Returns a Number or null if invalid.
 */
function parseAmount(text, { min = 0.01, max = 10000000 } = {}) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (value < min || value > max) return null;

  return value;
}

/**
 * Validate a non-empty short text field (names, UTRs, codes, etc.)
 */
function parseText(text, { minLen = 1, maxLen = 200 } = {}) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length < minLen || trimmed.length > maxLen) return null;
  return trimmed;
}

/**
 * Validate a Telegram numeric ID.
 */
function parseTelegramId(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!/^\d{4,15}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Validate a whole-number stock/quantity value (0 or more).
 */
function parseInt0Plus(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10);
}

module.exports = { parseAmount, parseText, parseTelegramId, parseInt0Plus };
