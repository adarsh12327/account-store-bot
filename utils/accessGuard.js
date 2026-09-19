/**
 * Global user-access guard.
 *
 * Railway runs the bot as a long-lived Node process. Keep short-lived
 * caches here so every button click does not perform multiple Firestore
 * reads and Telegram membership checks.
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

  // Warm the membership cache in the background when possible.
  const effectiveSettings = settings || settingsCache;
  if (effectiveSettings?.forceChannel) {
    getCachedMembership(bot, effectiveSettings.forceChannel, telegramId).catch(() => {});
  }
}

async function accessGuard(bot, ctx, next) {
  const telegramId = ctx.from?.id;

  if (!telegramId) return;

  if (isAdmin(telegramId)) {
    return next();
  }

  if (isStartCommand(ctx) || isCancelCommand(ctx) || isJoinVerification(ctx)) {
    return next();
  }

  const isCallback = Boolean(ctx.callbackQuery);

  // Callback queries must be acknowledged by their handler quickly.
  // Never block them on a cold Firestore/Telegram access check.
  // /start primes these caches, so normal callbacks still get the
  // full security checks without making the UI feel slow.
  if (isCallback) {
    const now = Date.now();
    const settingsFresh =
      settingsCache && now - settingsCacheAt < SETTINGS_TTL_MS;
    const cachedUser = userCache.get(String(telegramId));
    const userFresh =
      cachedUser && now - cachedUser.at < USER_TTL_MS;

    if (!settingsFresh || !userFresh) {
      getCachedSettings().catch(() => {});
      getCachedUser(telegramId).catch(() => {});
      return next();
    }
  }

  const settings = await getCachedSettings();
  const user = await getCachedUser(telegramId);

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

  if (settings.forceChannel) {
    const joined = await getCachedMembership(
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

module.exports = { accessGuard, primeAccessCache };
