/**
 * Admin pricing compatibility handlers.
 *
 * The original pricing screen reads legacy display keys while the database
 * stores the live pricing keys (usdRate / profit). These handlers take
 * ownership of the pricing callbacks and keep one canonical source of truth.
 */

const db = require("../database");
const session = require("../utils/session");
const logger = require("../utils/logger");
const { requireAdmin } = require("./admin");
const { settingsMenu, cancelKeyboard } = require("../keyboards/admin");

function registerAdminPricingFixHandler(bot) {
  bot.action("admin:settings:productPricing", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      if (!(await requireAdmin(ctx))) return;

      const s = await db.getSettings();
      const usdRate = Number(s.usdRate ?? 105);
      const profit = Number(s.profit ?? 0);

      await ctx.editMessageText(
        "💰 <b>Product Pricing</b>\n\n" +
        `💱 USD Rate: <b>₹${usdRate.toFixed(2)}</b>\n` +
        `📈 Profit Margin: <b>${profit.toFixed(2)}%</b>\n\n` +
        "These are the live values used by Server 1 pricing.",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💱 Change USD Rate", callback_data: "admin:settings:productPricing:usd:fixed" }],
              [{ text: "📈 Change Margin", callback_data: "admin:settings:productPricing:margin:fixed" }],
              [{ text: "⬅️ Settings", callback_data: "admin:settings" }],
            ],
          },
        }
      );
    } catch (err) {
      logger.error("Error in fixed product pricing screen", err);
    }
  });

  bot.action("admin:settings:productPricing:usd:fixed", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, {
        step: "admin_settings_productUsdRate_fixed",
        data: {},
      });

      await ctx.reply(
        "💱 <b>USD Rate</b>\n\nEnter USD → INR rate.\nExample: <code>105</code>",
        { parse_mode: "HTML", ...cancelKeyboard() }
      );
    } catch (err) {
      logger.error("Error starting fixed USD rate flow", err);
    }
  });

  bot.action("admin:settings:productPricing:margin:fixed", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, {
        step: "admin_settings_productMarginPercent_fixed",
        data: {},
      });

      await ctx.reply(
        "📈 <b>Profit Margin</b>\n\nEnter margin percentage.\nExample: <code>30</code>",
        { parse_mode: "HTML", ...cancelKeyboard() }
      );
    } catch (err) {
      logger.error("Error starting fixed margin flow", err);
    }
  });

  const textSteps = {
    admin_settings_productUsdRate_fixed: async (ctx) => {
      const value = Number(String(ctx.message.text || "").trim());

      if (!Number.isFinite(value) || value <= 0 || value > 100000) {
        await ctx.reply("❌ Invalid USD rate. Example: 105", cancelKeyboard());
        return;
      }

      await db.updateSettings({
        usdRate: Number(value.toFixed(4)),
      });

      session.clear(ctx.from.id);
      await ctx.reply(
        `✅ USD rate updated to ₹${value.toFixed(2)}.`,
        settingsMenu(await db.getSettings())
      );
    },

    admin_settings_productMarginPercent_fixed: async (ctx) => {
      const value = Number(String(ctx.message.text || "").trim());

      if (!Number.isFinite(value) || value < 0 || value > 1000) {
        await ctx.reply(
          "❌ Invalid margin. Enter a percentage between 0 and 1000.",
          cancelKeyboard()
        );
        return;
      }

      await db.updateSettings({
        profit: Number(value.toFixed(4)),
      });

      session.clear(ctx.from.id);
      await ctx.reply(
        `✅ Profit margin updated to ${value.toFixed(2)}%.`,
        settingsMenu(await db.getSettings())
      );
    },
  };

  return { textSteps };
}

module.exports = { registerAdminPricingFixHandler };
