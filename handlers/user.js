/**
 * handlers/user.js
 * ------------------------------------------------------------------
 * 👤 Profile: shows the user's own account summary.
 * ------------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");
const { escapeHtml, formatAmount, formatDate } = require("../utils/helpers");
const { backToMenu } = require("../keyboards/user");

function registerUserHandler(bot) {
  bot.action("menu_profile", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const user = await db.getUser(ctx.from.id);
      if (!user) return;

      const text =
        `👤 <b>Your Profile</b>\n\n` +
        `Name: ${escapeHtml(user.firstName)} ${escapeHtml(user.lastName || "")}\n` +
        `Username: ${user.username ? "@" + escapeHtml(user.username) : "N/A"}\n` +
        `Telegram ID: <code>${user.telegramId}</code>\n` +
        `Balance: ₹${formatAmount(user.balance)}\n` +
        `Total Deposited: ₹${formatAmount(user.totalDeposit)}\n` +
        `Total Orders: ${user.totalOrders || 0}\n` +
        `Joined: ${formatDate(user.joinDate)}`;

      await ctx.reply(text, { parse_mode: "HTML", ...backToMenu() });
    } catch (err) {
      logger.error("Error in menu_profile action", err);
      await ctx.answerCbQuery("Something went wrong.", { show_alert: true }).catch(() => {});
    }
  });
}

module.exports = { registerUserHandler };
