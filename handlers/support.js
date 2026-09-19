/**
 * handlers/support.js
 * ------------------------------------------------------------------
 * 🆘 Support: shows the configured support username (never hard-coded).
 * ------------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");
const { escapeHtml } = require("../utils/helpers");
const { backToMenu } = require("../keyboards/user");

function registerSupportHandler(bot) {
  bot.action("menu_support", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const settings =
        typeof db.getSettingsSnapshot === "function"
          ? db.getSettingsSnapshot()
          : {};

      const text = settings.supportUsername
        ? `🆘 <b>Support</b>\n\nNeed help? Contact us: @${escapeHtml(settings.supportUsername)}`
        : `🆘 <b>Support</b>\n\nSupport contact hasn't been configured yet. Please check back later.`;

      await ctx.reply(text, { parse_mode: "HTML", ...backToMenu() });
    } catch (err) {
      logger.error("Error in menu_support action", err);
      await ctx.answerCbQuery("Something went wrong.", { show_alert: true }).catch(() => {});
    }
  });
}

module.exports = { registerSupportHandler };
