/**
 * Fast global access guard.
 *
 * IMPORTANT:
 * Never block a Telegram callback on Firestore or getChatMember().
 * User actions continue immediately; security checks run in the
 * background. If a user is banned or has not joined the required
 * channel, the current bot message is replaced with the appropriate
 * blocked/join screen.
 */
const db = require("../database");
const { isAdmin, isChannelMember } = require("./helpers");
const { forceJoinKeyboard } = require("../keyboards/user");

const SETTINGS_TTL_MS = 15_000;
const USER_TTL_MS = 10_000;
const MEMBERSHIP_TTL_MS = 15_000;

let settingsCache = null;
let settingsCacheAt = 0;

const userCache = new Map();
const membershipCache = new Map();

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

async function getCachedSettings() {
  const now = Date.now();

  if (settingsCache && now - settingsCacheAt < SETTINGS_TTL_MS) {
    return settingsCache;
  }

  const settings = await db.getSettings();
  settingsCache = settings;
  settingsCacheAt = now;
  return settings;
}

async function getCachedUser(telegramId) {
  const id = String(telegramId);
  const now = Date.now();
  const cached = userCache.get(id);

  if (cached && now - cached.at < USER_TTL_MS) {
    return cached.user;
  }

  const user = await db.getUser(telegramId);
  userCache.set(id, { user, at: now });
  return user;
}

async function getCachedMembership(bot, channel, telegramId) {
  const key = `${channel}:${telegramId}`;
  const now = Date.now();
  const cached = membershipCache.get(key);

  if (cached && now - cached.at < MEMBERSHIP_TTL_MS) {
    return cached.joined;
  }

  const joined = await isChannelMember(bot, channel, telegramId);
  membershipCache.set(key, { joined, at: now });
  return joined;
}

async function primeAccessCache(bot, telegramId, settings = null, user = null) {
  const id = String(telegramId);
  const now = Date.now();

  if (settings) {
    settingsCache = settings;
    settingsCacheAt = now;
  }

  if (user) {
    userCache.set(id, { user, at: now });
  }

  const effectiveSettings = settings || settingsCache;

  if (effectiveSettings?.forceChannel) {
    getCachedMembership(
      bot,
      effectiveSettings.forceChannel,
      telegramId
    ).catch(() => {});
  }
}

async function editBlockedMessage(ctx, text, keyboard = null) {
  if (!ctx.callbackQuery) return false;

  const options = { parse_mode: "HTML" };

  if (keyboard) {
    options.reply_markup = keyboard.reply_markup;
  }

  try {
    await ctx.editMessageText(text, options);
    return true;
  } catch (err) {
    const message = String(err.message || "").toLowerCase();

    // The handler may have already edited the same message. In that case
    // do not send another error message to the user.
    if (
      message.includes("message is not modified") ||
      message.includes("message can't be edited") ||
      message.includes("message to edit not found") ||
      message.includes("message_id_invalid")
    ) {
      return false;
    }

    return false;
  }
}

async function showBlockedScreen(bot, ctx, telegramId) {
  try {
    const settings = await getCachedSettings();
    const user = await getCachedUser(telegramId);

    if (user?.banned) {
      await ctx.answerCbQuery("🚫 Access blocked.", {
        show_alert: false,
      }).catch(() => {});

      const edited = await editBlockedMessage(
        ctx,
        "🚫 <b>Access Denied</b>\n\nYour account has been banned from using this bot."
      );

      if (!edited && !ctx.callbackQuery && ctx.chat) {
        await ctx.reply(
          "🚫 <b>Access Denied</b>\n\nYour account has been banned from using this bot.",
          { parse_mode: "HTML" }
        ).catch(() => {});
      }

      return true;
    }

    if (settings.forceChannel) {
      const joined = await getCachedMembership(
        bot,
        settings.forceChannel,
        telegramId
      );

      if (!joined) {
        await ctx.answerCbQuery("📢 Please join the required channel.", {
          show_alert: false,
        }).catch(() => {});

        const edited = await editBlockedMessage(
          ctx,
          "📢 <b>Join Required</b>\n\nPlease join our channel first, then tap <b>Verify</b>.",
          forceJoinKeyboard(settings.forceChannel)
        );

        if (!edited && !ctx.callbackQuery && ctx.chat) {
          await ctx.reply(
            "📢 <b>You must join our channel before using this bot.</b>",
            {
              parse_mode: "HTML",
              ...forceJoinKeyboard(settings.forceChannel),
            }
          ).catch(() => {});
        }

        return true;
      }
    }

    return false;
  } catch (_) {
    // Access checks are background-only. A temporary Firestore/Telegram
    // error must never make normal buttons slow or fail.
    return false;
  }
}

async function accessGuard(bot, ctx, next) {
  const telegramId = ctx.from?.id;

  if (!telegramId) return;

  // Admins are never blocked.
  if (isAdmin(telegramId)) {
    return next();
  }

  // /start has its own background initialization/security flow.
  // /cancel and Verify must always reach their handlers.
  if (isStartCommand(ctx) || isCancelCommand(ctx) || isJoinVerification(ctx)) {
    return next();
  }

  // IMPORTANT: continue immediately. Security runs in the background.
  // This keeps every inline button responsive even during a slow
  // Firestore or Telegram API request.
  showBlockedScreen(bot, ctx, telegramId).catch(() => {});

  return next();
}

module.exports = {
  accessGuard,
  primeAccessCache,
};
