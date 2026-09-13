/**
 * handlers/adminBroadcast.js
 * ------------------------------------------------------------------
 * 📢 Broadcast (admin only): sends a message to every registered
 * user. Failures (blocked bot, deleted account, rate limits) are
 * caught per-recipient so one failure never stops the rest or
 * crashes the bot.
 *
 * textSteps: admin_broadcast_message
 * ------------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");
const session = require("../utils/session");
const { requireAdmin } = require("./admin");
const { parseText } = require("../utils/validation");
const { backToAdminHome, cancelKeyboard } = require("../keyboards/admin");

const SEND_DELAY_MS = 50; // basic pacing to stay under Telegram rate limits

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerAdminBroadcastHandler(bot) {
  bot.action("admin:broadcast", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;
      session.set(ctx.from.id, { step: "admin_broadcast_message", data: {} });
      await ctx.reply("📢 Enter the message you want to broadcast to all users:", cancelKeyboard());
    } catch (err) {
      logger.error("Error in admin:broadcast action", err);
    }
  });

  const textSteps = {
    admin_broadcast_message: async (ctx, state) => {
      const message = parseText(ctx.message.text, { minLen: 1, maxLen: 4000 });
      if (message === null) {
        await ctx.reply("❌ Invalid message.", cancelKeyboard());
        return;
      }
      session.clear(ctx.from.id);

      const userIds = await db.listAllUserIds();
      await ctx.reply(`📢 Broadcasting to ${userIds.length} users...`);

      let sent = 0;
      let failed = 0;

      for (const userId of userIds) {
        try {
          await ctx.telegram.sendMessage(userId, message);
          sent++;
        } catch (err) {
          failed++;
          logger.warn("Broadcast delivery failed", { userId, reason: err.message });
        }
        await sleep(SEND_DELAY_MS);
      }

      await ctx.reply(`✅ Broadcast complete.\n\nSent: ${sent}\nFailed: ${failed}`, backToAdminHome());
    },
  };

  return { textSteps };
}

module.exports = { registerAdminBroadcastHandler };
