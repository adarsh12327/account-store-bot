/**
 * handlers/deposit.js
 * ------------------------------------------------------------
 * 💳 Deposit flow:
 *
 * Amount
 *   ↓
 * UTR
 *   ↓
 * Payment Screenshot
 *   ↓
 * Create Pending Deposit
 *   ↓
 * Admin + Private Audit Channel
 *
 * Screenshot आते ही deposit request submit हो जाती है.
 * Admin manually Approve / Reject करता है.
 * ------------------------------------------------------------
 */

const db = require("../database");
const config = require("../config");
const logger = require("../utils/logger");
const session = require("../utils/session");

const {
  parseAmount,
  parseText,
} = require("../utils/validation");

const {
  escapeHtml,
  formatAmount,
} = require("../utils/helpers");

const {
  cancelKeyboard,
  backToMenu,
} = require("../keyboards/user");

const {
  depositAdminKeyboard,
  countriesMenu,
  productsMenu,
  settingsMenu,
  usersMenu,
  adminHome,
} = require("../keyboards/admin");


function registerDepositHandler(bot) {

  // ==========================================================
  // START DEPOSIT
  // ==========================================================

  bot.action("menu_deposit", async (ctx) => {
    try {

      await ctx.answerCbQuery();

      const settings = await db.getSettings();

      session.set(ctx.from.id, {
        step: "deposit_amount",
        data: {},
      });

      await ctx.reply(
        `💳 <b>Deposit</b>\n\n` +
        `Minimum deposit: ₹${formatAmount(settings.minimumDeposit)}\n\n` +
        `Please enter the amount you want to deposit:`,
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );

    } catch (err) {

      logger.error(
        "Error in menu_deposit action",
        err
      );

      await ctx.answerCbQuery(
        "Something went wrong.",
        { show_alert: true }
      ).catch(() => {});
    }
  });


  // ==========================================================
  // CANCEL
  // ==========================================================

  bot.action("flow_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery("Cancelled");

      const state = session.get(ctx.from.id);
      const step = String(state?.step || "");

      let menu = backToMenu();

      if (
        step.startsWith("admin_country_") ||
        step === "admin_server1_country_search"
      ) {
        menu = countriesMenu();
      } else if (step.startsWith("admin_product_")) {
        menu = productsMenu();
      } else if (step.startsWith("admin_settings_")) {
        menu = settingsMenu();
      } else if (step.startsWith("admin_user_")) {
        menu = usersMenu();
      } else if (step.startsWith("admin_")) {
        menu = adminHome();
      }

      session.clear(ctx.from.id);

      await ctx.reply(
        "❌ Cancelled.",
        menu
      );
    } catch (err) {
      logger.error(
        "Error in flow_cancel action",
        err
      );
    }
  });


  // ==========================================================
  // TEXT STEPS
  // ==========================================================

  const textSteps = {

    // --------------------------------------------------------
    // AMOUNT
    // --------------------------------------------------------

    deposit_amount: async (ctx, state) => {

      const settings = await db.getSettings();

      const amount = parseAmount(
        ctx.message.text,
        {
          min: settings.minimumDeposit,
        }
      );

      if (amount === null) {

        await ctx.reply(
          `❌ Invalid amount.\n\n` +
          `Minimum deposit: ₹${formatAmount(settings.minimumDeposit)}`,
          cancelKeyboard()
        );

        return;
      }

            state.data.amount = amount;

const upiId = settings.upiId || "";
const paymentQrFileId = settings.paymentQrFileId || "";

state.step = "deposit_utr";

session.set(
  ctx.from.id,
  state
);

const paymentText =
  `💳 <b>PAYMENT DETAILS</b>\n\n` +
  `💰 Amount: ₹${formatAmount(amount)}\n` +
  `🏦 UPI: <code>${escapeHtml(upiId || "Not set")}</code>\n\n` +
  `📲 QR Code से या UPI ID पर payment करें।\n\n` +
  `✅ Payment के बाद:\n` +
  `1️⃣ UTR / Transaction ID भेजें\n` +
  `2️⃣ Payment screenshot भेजें\n\n` +
  `⚠️ सही UTR भेजें, तभी payment verify हो पाएगा।`;

if (paymentQrFileId) {
  await ctx.replyWithPhoto(
    paymentQrFileId,
    {
      caption: paymentText,
      parse_mode: "HTML",
      ...cancelKeyboard(),
    }
  );
} else {
  await ctx.reply(
    paymentText +
      `\n\n⚠️ QR code अभी उपलब्ध नहीं है।`,
    {
      parse_mode: "HTML",
      ...cancelKeyboard(),
    }
  );
}
    },


    // --------------------------------------------------------
    // UTR
    // --------------------------------------------------------

    deposit_utr: async (ctx, state) => {

      const utr = parseText(
        ctx.message.text,
        {
          minLen: 3,
          maxLen: 100,
        }
      );

      if (utr === null) {

        await ctx.reply(
          "❌ Invalid payment reference.\n\nPlease enter a valid UTR or Transaction ID.",
          cancelKeyboard()
        );

        return;
      }

      state.data.utr = utr;

      state.step = "deposit_screenshot";

      session.set(
        ctx.from.id,
        state
      );

      await ctx.reply(
        `🔢 UTR: <code>${escapeHtml(utr)}</code>\n\n` +
        `📸 <b>Now send your payment screenshot.</b>\n\n` +
        `The screenshot will be sent to the admin for verification.`,
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );
    },
  };


  // ==========================================================
  // SCREENSHOT
  // ==========================================================

  bot.on("photo", async (ctx, next) => {

    const telegramId = ctx.from.id;

    const state = session.get(telegramId);

    // Not part of deposit flow
    if (
      !state ||
      state.step !== "deposit_screenshot"
    ) {
      return next();
    }

    try {

      const photo = ctx.message.photo;

      if (!photo || photo.length === 0) {

        await ctx.reply(
          "❌ Screenshot not received. Please send the payment screenshot.",
          cancelKeyboard()
        );

        return;
      }


      // Telegram gives multiple sizes.
      // Last one is normally the largest.
      const largestPhoto =
        photo[photo.length - 1];

      const screenshotFileId =
        largestPhoto.file_id;


      const amount =
        Number(state.data.amount);

      const utr =
        state.data.utr;


      // ------------------------------------------------------
      // CREATE PENDING DEPOSIT
      // ------------------------------------------------------

     let deposit;

try {
  deposit = await db.createDeposit(
    telegramId,
    amount,
    utr,
    screenshotFileId
  );
} catch (err) {
  if (err.code === "DUPLICATE_REFERENCE") {
    await ctx.reply(
      `⚠️ <b>This payment reference has already been submitted.</b>\n\n` +
      `🔢 Reference: <code>${escapeHtml(utr)}</code>\n\n` +
      `Please do not submit the same payment again.`,
      {
        parse_mode: "HTML",
        ...backToMenu(),
      }
    );

    session.clear(telegramId);
    return;
  }

  throw err;
}


      session.clear(telegramId);


      // ------------------------------------------------------
      // USER CONFIRMATION
      // ------------------------------------------------------

      await ctx.reply(
        `✅ <b>Deposit Request Submitted</b>\n\n` +
        `💰 Amount: ₹${formatAmount(amount)}\n` +
        `🔢 UTR: <code>${escapeHtml(utr)}</code>\n` +
        `📸 Screenshot: Received\n\n` +
        `⏳ Status: Pending admin approval`,
        {
          parse_mode: "HTML",
          ...backToMenu(),
        }
      );


      // ------------------------------------------------------
      // GET USER
      // ------------------------------------------------------

      const user =
        await db.getUser(telegramId);


      const firstName =
        user?.firstName ||
        ctx.from.first_name ||
        "Unknown";

      const username =
        user?.username ||
        ctx.from.username ||
        "";


      const usernameText =
        username
          ? `@${escapeHtml(username)}`
          : "N/A";


      const caption =
        `💳 <b>NEW DEPOSIT REQUEST</b>\n\n` +

        `👤 User: ${escapeHtml(firstName)}\n` +
        `🔗 Username: ${usernameText}\n` +
        `🆔 Telegram ID: <code>${telegramId}</code>\n\n` +

        `💰 Amount: ₹${formatAmount(amount)}\n` +
        `🔢 UTR: <code>${escapeHtml(utr)}</code>\n` +

        `📌 Status: <b>PENDING</b>\n` +
        `🧾 Deposit ID: <code>${deposit.depositId}</code>`;


      // ======================================================
      // ADMIN MESSAGE
      // ======================================================

      try {

        await ctx.telegram.sendPhoto(
          config.adminId,
          screenshotFileId,
          {
            caption,
            parse_mode: "HTML",
            ...depositAdminKeyboard(
              deposit.depositId
            ),
          }
        );

      } catch (err) {

        logger.error(
          "Failed to send deposit screenshot to admin",
          err
        );
      }


      // ======================================================
      // PRIVATE AUDIT CHANNEL
      // ======================================================

      if (config.auditChannelId) {

        try {

          await ctx.telegram.sendPhoto(
            config.auditChannelId,
            screenshotFileId,
            {
              caption,
              parse_mode: "HTML",
              ...depositAdminKeyboard(
                deposit.depositId
              ),
            }
          );

        } catch (err) {

          logger.error(
            "Failed to send deposit to audit channel",
            err
          );
        }
      }


      console.log(
        `[DEPOSIT] ${deposit.depositId} created for ${telegramId}`
      );


    } catch (err) {

      logger.error(
        "Error in deposit screenshot handler",
        err
      );

      session.clear(telegramId);

      await ctx.reply(
        "⚠️ Could not submit your deposit. Please try again.",
        backToMenu()
      ).catch(() => {});
    }
  });


  // ==========================================================
  // OLD DEPOSIT SUBMIT
  // ==========================================================
  //
  // Kept for compatibility with old sessions/buttons.
  //

  bot.action("deposit_submit", async (ctx) => {

    try {

      await ctx.answerCbQuery();

      await ctx.reply(
        "📸 Please send your payment screenshot first.",
        backToMenu()
      );

    } catch (err) {

      logger.error(
        "Error in deposit_submit action",
        err
      );
    }
  });


  return {
    textSteps,
  };
}


module.exports = {
  registerDepositHandler,
};
