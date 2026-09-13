/**
 * handlers/adminProviders.js
 * ------------------------------------------------------------
 * Provider Manager — ENV configured provider
 *
 * Provider credentials are read from:
 *   GRIZZLY_API_URL
 *   GRIZZLY_API_KEY
 * ------------------------------------------------------------
 */

const logger = require("../utils/logger");
const { requireAdmin } = require("./admin");
const { getBalance } = require("../services/grizzlyClient");
const { escapeHtml } = require("../utils/helpers");
const {
  providersMenu,
  providerListKeyboard,
  providerDetailKeyboard,
} = require("../keyboards/admin");

function registerAdminProvidersHandler(bot) {

  // ============================================================
  // PROVIDER MENU
  // ============================================================

  bot.action("admin:providers", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      await ctx.editMessageText(
        "🔌 <b>Provider Manager</b>\n\n" +
        "ENV configured provider",
        {
          parse_mode: "HTML",
          ...providersMenu(),
        }
      );

    } catch (err) {
      logger.error("Error in admin:providers action", err);
    }
  });


  // ============================================================
  // PROVIDER BALANCE
  // ============================================================

  bot.action("admin:providers:balance", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      const result = await getBalance();

      let balanceText = String(result || "").trim();

      if (balanceText.startsWith("ACCESS_BALANCE:")) {
        balanceText = balanceText
          .replace("ACCESS_BALANCE:", "")
          .trim();
      }

      const balance = Number(balanceText);

      if (!Number.isFinite(balance)) {
        await ctx.editMessageText(
          `❌ <b>Provider Balance Error</b>\n\n` +
          `Response:\n<code>${escapeHtml(String(result))}</code>`,
          {
            parse_mode: "HTML",
            ...providerListKeyboard(),
          }
        );
        return;
      }

      const settings = await require("../database").getSettings();
      const usdRate = Number(settings.usdRate || 105);
      const inrBalance = balance * usdRate;

      await ctx.editMessageText(
        `💰 <b>Provider Balance</b>\n\n` +
        `💵 <b>USD Balance:</b> $${balance.toFixed(4)}\n` +
        `🇮🇳 <b>INR:</b> ₹${inrBalance.toFixed(2)}\n` +
        `💱 <b>Rate:</b> 1 USD = ₹${usdRate.toFixed(2)}\n\n` +
        `🟢 <b>Status:</b> Online`,
        {
          parse_mode: "HTML",
          ...providerListKeyboard(),
        }
      );

    } catch (err) {
      logger.error("Error checking provider balance", err);

      await ctx.editMessageText(
        `❌ <b>Provider Balance Unavailable</b>\n\n` +
        `<code>${escapeHtml(String(err.message || err))}</code>`,
        {
          parse_mode: "HTML",
          ...providerListKeyboard(),
        }
      ).catch(() => {});
    }
  });


  // ============================================================
  // PROVIDER DETAILS
  // ============================================================

  bot.action("admin:providers:details", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      const apiKey = process.env.GRIZZLY_API_KEY || "";

      await ctx.editMessageText(
        `📊 <b>Provider Details</b>\n\n` +
        `🟢 <b>Status:</b> ${apiKey ? "Connected ✅" : "Not Configured ❌"}\n` +
        `🔐 <b>Credentials:</b> Secured 🔒\n` +
        `⚙️ <b>Configuration:</b> Active\n\n` +
        `ℹ️ Provider information is hidden for security.`,
        {
          parse_mode: "HTML",
          ...providerDetailKeyboard(),
        }
      );

    } catch (err) {
      logger.error("Error showing provider details", err);
    }
  });

  // No textSteps required.
  return {
    textSteps: {},
  };
}

module.exports = {
  registerAdminProvidersHandler,
};
