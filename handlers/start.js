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
 * Start-time security checks.
 *
 * Security checks intentionally run only from /start. The user first
 * receives a lightweight checking screen, then all required checks run
 * before the home menu is shown.
 *
 * The normal button/callback path never performs these checks, so normal
 * bot navigation stays fast.
 */
async function runBackgroundStart(
  bot,
  ctx,
  telegramId,
  checkingMessage,
  startPayload = ""
) {
  const editChecking = async (text) => {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        checkingMessage.message_id,
        undefined,
        text,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      const msg = String(err.message || "").toLowerCase();
      if (!msg.includes("message is not modified")) {
        logger.debug?.("Start checking screen update skipped", err);
      }
    }
  };

  try {
    // User creation and settings load happen in parallel.
    const [user, settings] = await Promise.all([
      db.createUser(telegramId, {
        firstName: ctx.from.first_name || "",
        lastName: ctx.from.last_name || "",
        username: ctx.from.username || "",
        startPayload: String(startPayload || "").trim(),
      }),
      db.getSettings(),
    ]);

    // Referral registration is only needed for a brand-new user.
    if (user?._isNewUser && startPayload) {
      try {
        const referralResult = await db.registerUserReferral(
          telegramId,
          startPayload
        );

        logger.info(
          referralResult.registered
            ? `[REFERRAL] Registered | user=${telegramId} | referrer=${referralResult.referrerId} | rate=${referralResult.referralRate}%`
            : `[REFERRAL] Not registered | user=${telegramId} | reason=${referralResult.reason}`
        );
      } catch (referralErr) {
        logger.error(
          `[REFERRAL] Registration failed | user=${telegramId}`,
          referralErr
        );
      }
    }

    // Account ban is checked before any home screen is shown.
    if (user?.banned) {
      await editChecking(
        "🚫 <b>Access Denied</b>\n\nYour account is banned from using this bot."
      );
      return;
    }

    const admin = isAdmin(telegramId);

    if (settings.maintenance && !admin) {
      await editChecking(
        "🛠️ <b>Maintenance Mode</b>\n\nThe bot is currently under maintenance.\nPlease try again later."
      );
      return;
    }

    // Telegram membership is the only external security check. It runs
    // only when Force Join is configured and the user is not an admin.
    if (settings.forceChannel && !admin) {
      await editChecking(
        "🔄 <b>Checking channel membership...</b>\n\nPlease wait..."
      );

      const joined = await isChannelMember(
        bot,
        settings.forceChannel,
        telegramId
      );

      if (!joined) {
        await editChecking(
          "📢 <b>Join Required</b>\n\nYou must join our channel before using this bot."
        );

        // Add the Join/Verify buttons to the same checking message.
        try {
          await ctx.telegram.editMessageReplyMarkup(
            ctx.chat.id,
            checkingMessage.message_id,
            undefined,
            forceJoinKeyboard(settings.forceChannel).reply_markup
          );
        } catch (_) {}

        return;
      }
    }

    // Only after every start-time check succeeds do we show Home.
    const homeText = showMainMenuText(ctx);
    const keyboard = mainMenu(isAdmin(telegramId));

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      checkingMessage.message_id,
      undefined,
      homeText,
      {
        parse_mode: "HTML",
        ...keyboard,
      }
    );

    console.log(
      `[START] Checks completed for ${telegramId}`
    );
  } catch (err) {
    logger.error(
      `Start checks failed | user=${telegramId}`,
      err
    );

    // Never silently bypass security on a failed check.
    await editChecking(
      "⚠️ <b>Verification failed</b>\n\nPlease tap /start again in a moment."
    );
  }
}

/**
 * Build the home-screen text without any database/network read.
 */
function showMainMenuText(ctx) {
  const firstName = ctx.from?.first_name || "there";

  const botUsername = String(
    ctx.botInfo?.username ||
    ctx.telegram?.botInfo?.username ||
    "account_stores_bot"
  ).replace(/^@/, "").trim();

  const referralLink =
    `https://t.me/${botUsername}?start=${encodeURIComponent(String(ctx.from.id))}`;

  return (
    `<b>Welcome back, ${escapeHtml(firstName)} 👋</b>\n\n` +
    `👥 <b>Refer &amp; Earn</b>\n` +
    `🎁 Earn <b>10%</b> commission on every referred user's deposit.\n\n` +
    `🔗 <b>Your Referral Link:</b>\n` +
    `<a href="${referralLink}">${escapeHtml(referralLink)}</a>`
  );
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

      const checkingMessage = await ctx.reply(
        "🔄 <b>Checking your account...</b>\n\n" +
        "⏳ <i>Please wait...</i>",
        { parse_mode: "HTML" }
      );

      console.log(
        `[START] Checking screen sent in ${Date.now() - startedAt}ms`
      );

      await runBackgroundStart(
        bot,
        ctx,
        telegramId,
        checkingMessage,
        startPayload
      );

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

      const settings =
        typeof db.getSettingsSnapshot === "function"
          ? db.getSettingsSnapshot()
          : {};
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

      // Main Menu is pure UI navigation. Do not wait for Firestore.
      await showMainMenu(
        ctx,
        null,
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
