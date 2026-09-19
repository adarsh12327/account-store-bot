/**
 * handlers/products.js
 * ------------------------------------------------------------
 * User-facing server selection.
 *
 * Old manual product-order flow has been removed.
 * Server-specific order flows are handled separately.
 * ------------------------------------------------------------
 */

const logger = require("../utils/logger");
const db = require("../database");

async function editScreen(ctx, text, keyboard = null) {
  const options = {
    parse_mode: "HTML",
  };

  if (keyboard) {
    options.reply_markup = keyboard.reply_markup;
  }

  try {
    await ctx.editMessageText(text, options);
  } catch (err) {
    const message = String(err.message || "").toLowerCase();

    if (!message.includes("message is not modified")) {
      throw err;
    }
  }
}

function registerProductsHandler(bot) {

  // ==========================================================
  // BUY TELEGRAM ACCOUNTS
  // ==========================================================

  bot.action("menu_buy", async (ctx) => {
    try {
      // Answer Telegram callback safely.
      try {
        await ctx.answerCbQuery();
      } catch (_) {}

      const settings =
        typeof db.getSettingsSnapshot === "function"
          ? db.getSettingsSnapshot()
          : { server1Enabled: true, server2Enabled: true };

      const serverButtons = [];

      if (settings.server1Enabled !== false) {
        serverButtons.push([
          {
            text: "🖥️ Server 1",
            callback_data: "server1:menu",
          },
        ]);
      }

      if (settings.server2Enabled !== false) {
        serverButtons.push([
          {
            text: "🖥️ Server 2",
            callback_data: "server2:menu",
          },
        ]);
      }

      if (serverButtons.length === 0) {
        serverButtons.push([
          {
            text: "⚠️ No Server Available",
            callback_data: "menu_buy",
          },
        ]);
      }

      serverButtons.push([
        {
          text: "🏠 Main Menu",
          callback_data: "menu_home",
        },
      ]);

      await editScreen(
        ctx,

        `🛍️ <b>Buy Telegram Accounts</b>\n\n` +
        `Select an available server:`,

        {
          reply_markup: {
            inline_keyboard: serverButtons,
          },
        }
      );

    } catch (err) {
      logger.error(
        "Error in menu_buy action",
        err
      );

      await ctx.answerCbQuery(
        "Something went wrong.",
        { show_alert: true }
      ).catch(() => {});
    }
  });
}

module.exports = {
  registerProductsHandler,
};
