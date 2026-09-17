/**
 * Global user-access guard.
 *
 * Railway runs the bot as a long-lived Node process, so normal in-memory
 * sessions are fine. This guard is intentionally kept separate from the
 * individual handlers so maintenance / force-join cannot be bypassed by
 * using an old inline button.
 */

const db = require("../database");
const { isAdmin, isChannelMember } = require("./helpers");
const { forceJoinKeyboard } = require("../keyboards/user");

function isStartCommand(ctx) {
  const text = String(ctx.message?.text || "").trim();
  return /^\/start(?:@[^\s]+)?(?:\s|$)/i.test(text);
}

function isCancelCommand(ctx) {
  const text = String(ctx.message?.text || "").trim();
  return /^\/cancel(?:@[^\s]+)?(?:\s|$)/i.test(text);
}

function isJoinVerification(ctx) {
  return String(ctx.callbackQuery?.data || "") === "verify_join";
}

async function accessGuard(bot, ctx, next) {
  const telegramId = ctx.from?.id;

  // Telegram updates without a user should never reach user flows.
  if (!telegramId) return;

  // Admin is never blocked by maintenance / force-join.
  if (isAdmin(telegramId)) {
    return next();
  }

  // These routes must remain available so a blocked user can recover.
  if (isStartCommand(ctx) || isCancelCommand(ctx) || isJoinVerification(ctx)) {
    return next();
  }

  const settings = await db.getSettings();

  // Banned users are blocked from all callbacks/messages after /start.
  const user = await db.getUser(telegramId);
  if (user?.banned) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("🚫 You are banned from using this bot.", {
        show_alert: true,
      }).catch(() => {});
    } else if (ctx.chat) {
      await ctx.reply("🚫 You are banned from using this bot.").catch(() => {});
    }
    return;
  }

  // Maintenance blocks all normal user activity.
  if (settings.maintenance) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("🛠️ Bot is under maintenance.", {
        show_alert: true,
      }).catch(() => {});
    } else if (ctx.chat) {
      await ctx.reply("🛠️ The bot is currently under maintenance.\n\nPlease check back later.").catch(() => {});
    }
    return;
  }

  // Force-join is checked on every user interaction, not only /start.
  if (settings.forceChannel) {
    const joined = await isChannelMember(
      bot,
      settings.forceChannel,
      telegramId
    );

    if (!joined) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery("📢 Please join the required channel first.", {
          show_alert: true,
        }).catch(() => {});
      }

      if (ctx.chat) {
        await ctx.reply(
          "📢 <b>You must join our channel before using this bot.</b>",
          {
            parse_mode: "HTML",
            ...forceJoinKeyboard(settings.forceChannel),
          }
        ).catch(() => {});
      }

      return;
    }
  }

  return next();
}

module.exports = { accessGuard };
