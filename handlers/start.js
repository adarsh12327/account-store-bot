/**
 * handlers/start.js
 * ------------------------------------------------------------
 * FAST START + MESSAGE EDIT NAVIGATION
 *
 * /start:
 *   - Main menu is sent immediately.
 *   - Firebase checks continue in background.
 *
 * Callback navigation:
 *   - Main Menu edits the existing message.
 *   - No unnecessary new messages.
 * ------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");

const {
  isAdmin,
  isChannelMember,
  escapeHtml,
} = require("../utils/helpers");

const {
  mainMenu,
  forceJoinKeyboard,
} = require("../keyboards/user");
const { primeAccessCache } = require("../utils/accessGuard");


/**
 * Show main menu.
 *
 * edit = false:
 *   Used by /start -> sends a new message.
 *
 * edit = true:
 *   Used by callback buttons -> edits current message.
 */
async function showMainMenu(ctx, user = null, edit = false) {

  const firstName =
    ctx.from?.first_name || "there";

  // Keep /start and Main Menu instant. Do not wait for Firestore here.
  // The referral percentage is informational on the home screen; the
  // actual commission is calculated from Firestore during deposit approval.
  const botUsername = String(
    ctx.botInfo?.username ||
    ctx.telegram?.botInfo?.username ||
    "account_stores_bot"
  )
    .replace(/^@/, "")
    .trim();

  const referralRate = 10;

  const referralLink =
    `https://t.me/${botUsername}?start=${encodeURIComponent(String(ctx.from.id))}`;

  const referralText =
    `👥 <b>Refer &amp; Earn</b>\n` +
    `🎁 Earn <b>${referralRate}%</b> commission on every referred user's deposit.\n\n` +
    `🔗 <b>Your Referral Link:</b>\n` +
    `<a href="${referralLink}">${escapeHtml(referralLink)}</a>`;

  const text =
    `<b>Welcome back, ${escapeHtml(firstName)} 👋</b>\n\n` +
    referralText;

  const keyboard =
    mainMenu(isAdmin(ctx.from.id));

  // ------------------------------------------------------------
  // CALLBACK / EXISTING MESSAGE
  // ------------------------------------------------------------

  if (edit) {

    try {

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        ...keyboard,
      });

      return true;

    } catch (err) {

      const message =
        String(err.message || "").toLowerCase();

      if (
        message.includes("message is not modified")
      ) {
        return true;
      }

      if (
        message.includes("message can't be edited") ||
        message.includes("message to edit not found") ||
        message.includes("message_id_invalid")
      ) {
        logger.warn(
          "Main menu message cannot be edited; keeping existing menu."
        );

        return false;
      }

      logger.error(
        "Failed to edit main menu",
        err
      );

      return false;
    }
  }

  // ------------------------------------------------------------
  // /START -> SEND NEW MESSAGE
  // ------------------------------------------------------------

  return ctx.reply(text, {
    parse_mode: "HTML",
    ...keyboard,
  });
}

/**
 * Background security / database initialization.
 *
 * This does NOT block the initial menu.
 */
async function runBackgroundStart(
  bot,
  ctx,
  telegramId,
  menuMessage,
  startPayload = ""
) {

  try {

    const user = await db.createUser(
      telegramId,
      {
        firstName: ctx.from.first_name || "",
        lastName: ctx.from.last_name || "",
        username: ctx.from.username || "",
        startPayload: String(startPayload || "").trim(),
      }
    );

    if (user?._isNewUser && startPayload) {
      try {
        const referralResult =
          await db.registerUserReferral(
            telegramId,
            startPayload
          );

        if (referralResult.registered) {
          logger.info(
            `[REFERRAL] Registered | user=${telegramId} | referrer=${referralResult.referrerId} | rate=${referralResult.referralRate}%`
          );
        } else {
          logger.info(
            `[REFERRAL] Not registered | user=${telegramId} | reason=${referralResult.reason}`
          );
        }
      } catch (referralErr) {
        logger.error(
          `[REFERRAL] Registration failed | user=${telegramId}`,
          referralErr
        );
      }
    }

    if (user?.banned) {
      try {
        await ctx.telegram.deleteMessage(
          ctx.chat.id,
          menuMessage.message_id
        );
      } catch (_) {}

      await ctx.reply(
        "🚫 You are banned from using this bot."
      );

      return;
    }

    const settings =
      await db.getSettings();

    // Warm the global access cache after /start so the first button
    // click does not wait for Firestore or Telegram membership checks.
    await primeAccessCache(
      bot,
      telegramId,
      settings,
      user
    );

    const admin =
      isAdmin(telegramId);

    if (
      settings.maintenance &&
      !admin
    ) {
      try {
        await ctx.telegram.deleteMessage(
          ctx.chat.id,
          menuMessage.message_id
        );
      } catch (_) {}

      await ctx.reply(
        "🛠️ The bot is currently under maintenance.\n\n" +
        "Please check back later."
      );

      return;
    }

    if (
      settings.forceChannel &&
      !admin
    ) {
      const joined =
        await isChannelMember(
          bot,
          settings.forceChannel,
          telegramId
        );

      if (!joined) {
        try {
          await ctx.telegram.deleteMessage(
            ctx.chat.id,
            menuMessage.message_id
          );
        } catch (_) {}

        await ctx.reply(
          "📢 You must join our channel before using this bot.",
          forceJoinKeyboard(
            settings.forceChannel
          )
        );

        return;
      }
    }

    console.log(
      `[BACKGROUND] Start checks completed for ${telegramId}`
    );

  } catch (err) {
    logger.error(
      "Background /start error",
      err
    );
  }
}


/**
 * Register start-related handlers.
 */
function registerStartHandler(bot) {

  // ==========================================================
  // /START
  // ==========================================================

  bot.start(async (ctx) => {

    const startedAt =
      Date.now();

    try {

      const telegramId =
        ctx.from.id;

      const startPayload =
        String(ctx.startPayload || "").trim();

      console.log(
        `[START] ${telegramId} received`
      );

      const menuMessage =
        await showMainMenu(ctx);

      console.log(
        `[START] Menu sent in ${Date.now() - startedAt}ms`
      );

      setImmediate(() => {
        runBackgroundStart(
          bot,
          ctx,
          telegramId,
          menuMessage,
          startPayload
        ).catch((err) => {
          logger.error(
            "Background start promise error",
            err
          );
        });
      });

    } catch (err) {

      logger.error(
        "Error in /start handler",
        err
      );

      try {
        await ctx.reply(
          "⚠️ Something went wrong. Please try /start again."
        );
      } catch (_) {}
    }
  });

  // ==========================================================
  // VERIFY JOIN
  // ==========================================================

  bot.action("verify_join", async (ctx) => {

    try {
      const telegramId =
        ctx.from.id;

      const startPayload =
        String(ctx.startPayload || "").trim();

      await ctx.answerCbQuery();

      const settings =
        await db.getSettings();

      if (!settings.forceChannel) {
        await ctx.answerCbQuery(
          "✅ No channel verification is required."
        );

        await showMainMenu(
          ctx,
          null,
          true
        );

        return;
      }

      const joined =
        await isChannelMember(
          bot,
          settings.forceChannel,
          telegramId
        );

      if (!joined) {
        await ctx.answerCbQuery(
          "❌ You haven't joined the channel yet.",
          {
            show_alert: true,
          }
        );

        return;
      }

      await ctx.answerCbQuery(
        "✅ Verified!"
      );

      const user =
        await db.getUser(
          telegramId
        );

      await showMainMenu(
        ctx,
        user,
        true
      );

    } catch (err) {
      logger.error(
        "Error in verify_join action",
        err
      );

      await ctx.answerCbQuery(
        "⚠️ Something went wrong.",
        {
          show_alert: true,
        }
      ).catch(() => {});
    }
  });

  // ==========================================================
  // SALES CHANNEL
  // ==========================================================

  bot.action("menu_sales", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      const settings = await db.getSettings();
      const salesChannel = String(settings.salesChannel || "").trim();

      if (!salesChannel) {
        await ctx.answerCbQuery(
          "⚠️ Sales channel is not configured yet.",
          { show_alert: true }
        );
        return;
      }

      await ctx.reply(
        "📢 <b>Sales Channel</b>\n\n" +
        "Latest sales and updates ke liye hamare channel ko visit karein.",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📢 Open Sales Channel",
                  url: salesChannel
                }
              ],
              [
                {
                  text: "🏠 Main Menu",
                  callback_data: "menu_home"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {
      logger.error("Error in menu_sales action", err);

      await ctx.answerCbQuery(
        "⚠️ Something went wrong.",
        { show_alert: true }
      ).catch(() => {});
    }
  });

  // ==========================================================
  // MAIN MENU
  // ==========================================================

  bot.action("menu_home", async (ctx) => {

    try {
      await ctx.answerCbQuery();

      const telegramId =
        ctx.from.id;

      const user =
        await db.getUser(
          telegramId
        );

      if (!user) {
        await showMainMenu(
          ctx,
          null,
          true
        );

        return;
      }

      if (user.banned) {
        await ctx.answerCbQuery(
          "🚫 You are banned from using this bot.",
          {
            show_alert: true,
          }
        );

        return;
      }

      await showMainMenu(
        ctx,
        user,
        true
      );

    } catch (err) {
      logger.error(
        "Error in menu_home action",
        err
      );

      await ctx.answerCbQuery(
        "⚠️ Something went wrong.",
        {
          show_alert: true,
        }
      ).catch(() => {});
    }
  });
}


module.exports = {
  registerStartHandler,
  showMainMenu,
  runBackgroundStart,
};
