/**
 * config.js
 * ------------------------------------------------------------------
 * Centralized configuration loader. Reads secrets from .env only —
 * never hard-code credentials here.
 * ------------------------------------------------------------------
 */

require("dotenv").config();

const config = {
  botToken: process.env.BOT_TOKEN,
  adminId: process.env.ADMIN_ID,
  auditChannelId: process.env.AUDIT_CHANNEL_ID || "",
};

if (!config.botToken) {
  console.error("Missing BOT_TOKEN in .env — see .env.example");
  process.exit(1);
}

if (!config.adminId) {
  console.error("Missing ADMIN_ID in .env — see .env.example");
  process.exit(1);
}

module.exports = config;
