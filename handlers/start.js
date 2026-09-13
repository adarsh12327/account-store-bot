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

  const text =
    `<b>Welcome back, ${firstName} 👋</b>\n\n` +
    `Browse our available digital products with fast delivery.\n\n` +
    `Select an option below to get started:`;

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

      // Message already contains exactly the same content.
      if (
        message.includes("message is not modified")
      ) {
        return true;
      }

      // Some Telegram messages cannot be edited.
      // Do NOT crash background processing.
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

    // ----------------------------------------------------------
    // USER
    // ----------------------------------------------------------

    const user = await db.createUser(
      telegramId,
      {
        firstName: ctx.from.first_name || "",
        lastName: ctx.from.last_name || "",
        username: ctx.from.username || "",
        startPayload: String(startPayload || "").trim(),
      }
    );

    // ----------------------------------------------------------
    // REFERRAL REGISTRATION
    // Only a genuinely new user can be attached to a referrer.
    // The referral rate is snapshotted at registration time.
    // ----------------------------------------------------------
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

    // ----------------------------------------------------------
    // BANNED CHECK
    // ----------------------------------------------------------

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


    // ----------------------------------------------------------
    // SETTINGS
    // ----------------------------------------------------------

    const settings =
      await db.getSettings();


    // ----------------------------------------------------------
    // ADMIN
    // ----------------------------------------------------------

    const admin =
      isAdmin(telegramId);


    // ----------------------------------------------------------
    // MAINTENANCE
    // ----------------------------------------------------------

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


    // ----------------------------------------------------------
    // FORCE CHANNEL
    // ----------------------------------------------------------

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


      // ------------------------------------------------------
      // INSTANT MENU
      // ------------------------------------------------------

      const menuMessage =
        await showMainMenu(ctx);


      console.log(
        `[START] Menu sent in ${Date.now() - startedAt}ms`
      );


      // ------------------------------------------------------
      // BACKGROUND CHECKS
      // ------------------------------------------------------

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

      // Immediately remove Telegram button loading.
      await ctx.answerCbQuery();


      const telegramId =
        ctx.from.id;

      const startPayload =
        String(ctx.startPayload || "").trim();


      const user =
        await db.getUser(
          telegramId
        );


      if (!user) {

        // If user doesn't exist, still edit the message.
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


      // IMPORTANT:
      // true = EDIT CURRENT MESSAGE
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


/**
 * Exports
 */
module.exports = {
  registerStartHandler,
  showMainMenu,
  runBackgroundStart,
};
