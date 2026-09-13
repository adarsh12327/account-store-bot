/**
 * utils/logger.js
 * ------------------------------------------------------------------
 * Centralized logging. NEVER pass secrets (tokens, API keys,
 * service account contents) into these functions.
 * ------------------------------------------------------------------
 */

function info(message, meta = {}) {
  console.log(`[INFO] ${message}`, Object.keys(meta).length ? meta : "");
}

function warn(message, meta = {}) {
  console.warn(`[WARN] ${message}`, Object.keys(meta).length ? meta : "");
}

function error(message, err) {
  console.error(`[ERROR] ${message}`, err ? err.stack || err.message || err : "");
}

module.exports = { info, warn, error };
