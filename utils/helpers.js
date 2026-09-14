/**
 * utils/helpers.js
 * ------------------------------------------------------------------
 * Small reusable helper functions used across handlers.
 * ------------------------------------------------------------------
 */

const config = require("../config");

function isAdmin(telegramId) {
  return String(telegramId) === String(config.adminId);
}

function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatAmount(amount) {
  const value = Number(amount) || 0;
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(value) {
  try {
    const date = value && typeof value.toDate === "function" ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return "N/A";
    return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
  } catch {
    return "N/A";
  }
}

function maskSecret(secret) {
  if (!secret) return "Not set";
  const str = String(secret);
  if (str.length <= 4) return "****";
  return `${"*".repeat(str.length - 4)}${str.slice(-4)}`;
}

/**
 * Check whether a user is a member of the configured force-join channel.
 * Fails closed (returns false) on any lookup error so misconfiguration
 * doesn't silently let people bypass the requirement.
 */
async function isChannelMember(bot, channel, userId) {
  if (!channel) return true; // force-join disabled

  try {
    const member = await bot.telegram.getChatMember(channel, userId);
    return ["creator", "administrator", "member"].includes(member.status);
  } catch (err) {
    return false;
  }
}

module.exports = { isAdmin, escapeHtml, formatAmount, formatDate, maskSecret, isChannelMember };
