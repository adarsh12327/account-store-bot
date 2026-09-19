/**
 * handlers/adminDeposits.js
 * ------------------------------------------------------------------
 * 💳 Deposit manager (admin only)
 *
 * Features:
 * - Deposit manager
 * - Pending deposits
 * - Deposit details
 * - Approve / reject
 *
 * Navigation callbacks EDIT the existing Telegram message instead
 * of creating duplicate/new messages.
 *
 * approveDeposit/rejectDeposit are handled by database.js and are
 * expected to be transaction-safe.
 * ------------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");

const { requireAdmin } = require("./admin");

const {
  escapeHtml,
  formatAmount,
} = require("../utils/helpers");

const {
  depositsMenu,
  depositListKeyboard,
  depositAdminKeyboard,
} = require("../keyboards/admin");


// ================================================================
// EDIT MESSAGE HELPER
// ================================================================

async function editOrReply(ctx, text, options = {}) {
  const message = ctx.callbackQuery?.message;

  if (message) {
    try {
      // ==========================================================
      // PHOTO MESSAGE
      // ==========================================================
      if (message.photo) {
        await ctx.editMessageCaption(text, options);
        return;
      }

      // ==========================================================
      // NORMAL TEXT MESSAGE
      // ==========================================================
      if (typeof message.text === "string") {
        await ctx.editMessageText(text, options);
        return;
      }

      // ==========================================================
      // MESSAGE HAS NO EDITABLE TEXT
      // ==========================================================
      await ctx.reply(text, options);
      return;

    } catch (err) {
      const errorMessage = String(
        err?.description ||
        err?.message ||
        ""
      ).toLowerCase();

      // Same content already exists
      if (
        errorMessage.includes("message is not modified")
      ) {
        return;
      }

      // Telegram says there is no text to edit.
      // Try photo caption before falling back to a new message.
      if (
        errorMessage.includes(
          "there is no text in the message to edit"
        )
      ) {
        try {
          await ctx.editMessageCaption(text, options);
          return;
        } catch (_) {
          // Fall through to reply.
        }
      }

      logger.error(
        "Could not edit deposit message",
        err
      );
    }
  }

  // ==========================================================
  // FINAL FALLBACK
  // ==========================================================
  await ctx.reply(text, options);
}


// ================================================================
// SAFE CALLBACK ANSWER
// ================================================================

async function safeAnswer(ctx, text = "") {
  try {
    await ctx.answerCbQuery(
      text
    );
  } catch (err) {
    /*
     * Telegram can return:
     * "query is too old and response timeout expired"
     *
     * The actual operation may still be fine, so don't crash
     * the handler because of the callback answer.
     */
    const message =
      String(
        err?.description ||
        err?.message ||
        ""
      ).toLowerCase();

    if (
      !message.includes("query is too old") &&
      !message.includes("response timeout") &&
      !message.includes("query id is invalid")
    ) {
      logger.error(
        "Failed to answer callback query",
        err
      );
    }
  }
}


// ================================================================
// REGISTER HANDLER
// ================================================================

function registerAdminDepositsHandler(bot) {

  // ==============================================================
  // DEPOSIT MANAGER
  // ==============================================================

  bot.action(
    "admin:deposits",
    async (ctx) => {

      try {

        await safeAnswer(ctx);

        if (!(await requireAdmin(ctx))) {
          return;
        }


        await editOrReply(
          ctx,
          "💳 <b>Deposit Manager</b>",
          {
            parse_mode: "HTML",
            ...depositsMenu(),
          }
        );

      } catch (err) {

        logger.error(
          "Error in admin:deposits action",
          err
        );
      }
    }
  );


  // ==============================================================
  // PENDING DEPOSITS
  // ==============================================================

  bot.action(
    "admin:deposits:list",
    async (ctx) => {

      try {

        await safeAnswer(ctx);

        if (!(await requireAdmin(ctx))) {
          return;
        }


        const deposits =
          await db.listPendingDeposits(20);


        // ----------------------------------------------------------
        // No pending deposits
        // ----------------------------------------------------------

        if (deposits.length === 0) {

          await editOrReply(
            ctx,
            "📋 <b>Pending Deposits</b>\n\n" +
            "✅ No pending deposits.",
            {
              parse_mode: "HTML",
              ...depositsMenu(),
            }
          );

          return;
        }


        // ----------------------------------------------------------
        // Pending deposit list
        // ----------------------------------------------------------

        await editOrReply(
          ctx,
          "📋 <b>Pending Deposits</b>\n\n" +
          `Found ${deposits.length} pending deposit(s).`,
          {
            parse_mode: "HTML",
            ...depositListKeyboard(deposits),
          }
        );

      } catch (err) {

        logger.error(
          "Error in admin:deposits:list action",
          err
        );
      }
    }
  );


  // ==============================================================
  // VIEW DEPOSIT
  // ==============================================================

  bot.action(
    /^admin:deposits:view:(.+)$/,
    async (ctx) => {

      try {

        await safeAnswer(ctx);

        if (!(await requireAdmin(ctx))) {
          return;
        }


        const depositId =
          ctx.match[1];


        const deposit =
          await db.getDeposit(depositId);


        // ----------------------------------------------------------
        // Deposit not found
        // ----------------------------------------------------------

        if (!deposit) {

          await editOrReply(
            ctx,
            "❌ <b>Deposit not found.</b>",
            {
              parse_mode: "HTML",
              ...depositsMenu(),
            }
          );

          return;
        }


        // ----------------------------------------------------------
        // Deposit details
        // ----------------------------------------------------------

        const status =
          String(
            deposit.status || "unknown"
          ).toLowerCase();


        const statusIcon = {
          pending: "⏳",
          approved: "✅",
          rejected: "❌",
        };


        const text =
          `💳 <b>DEPOSIT DETAILS</b>\n\n` +

          `🆔 Deposit ID:\n` +
          `<code>${escapeHtml(
            deposit.depositId || depositId
          )}</code>\n\n` +

          `👤 User ID:\n` +
          `<code>${escapeHtml(
            String(deposit.userId)
          )}</code>\n\n` +

          `💰 Amount: ` +
          `<b>₹${formatAmount(
            deposit.amount
          )}</b>\n\n` +

          `🔢 UTR:\n` +
          `<code>${escapeHtml(
            deposit.utr || "N/A"
          )}</code>\n\n` +

          `📌 Status: ` +
          `${statusIcon[status] || "❔"} ` +
          `<b>${escapeHtml(
            status.toUpperCase()
          )}</b>`;


        // ----------------------------------------------------------
        // Pending → Approve / Reject buttons
        // ----------------------------------------------------------

        if (status === "pending") {

          await editOrReply(
            ctx,
            text,
            {
              parse_mode: "HTML",
              ...depositAdminKeyboard(
                deposit.depositId
              ),
            }
          );

          return;
        }


        // ----------------------------------------------------------
        // Already processed → menu only
        // ----------------------------------------------------------

        await editOrReply(
          ctx,
          text,
          {
            parse_mode: "HTML",
            ...depositsMenu(),
          }
        );

      } catch (err) {

        logger.error(
          "Error in admin:deposits:view action",
          err
        );
      }
    }
  );


  // ==============================================================
  // APPROVE DEPOSIT
  // ==============================================================

  bot.action(
    /^admin:deposits:approve:(.+)$/,
    async (ctx) => {

      try {

        /*
         * Answer callback immediately.
         */
        await safeAnswer(
          ctx,
          "Processing..."
        );


        if (!(await requireAdmin(ctx))) {
          return;
        }


        const depositId =
          ctx.match[1];


        let deposit;


        // ----------------------------------------------------------
        // Database transaction
        // ----------------------------------------------------------

        try {

          deposit =
            await db.approveDeposit(
              depositId,
              ctx.from.id
            );

        } catch (err) {

          /*
           * Another click/process already handled it.
           */
          if (
            err.code ===
            "ALREADY_PROCESSED"
          ) {

            await safeAnswer(
              ctx,
              "⚠️ Already processed."
            );

            return;
          }

          throw err;
        }


        // ----------------------------------------------------------
        // Update same Telegram message
        // ----------------------------------------------------------

        await editOrReply(
          ctx,

          `✅ <b>DEPOSIT APPROVED</b>\n\n` +

          `👤 User: ` +
          `<code>${escapeHtml(
            String(deposit.userId)
          )}</code>\n` +

          `💰 Amount: ` +
          `<b>₹${formatAmount(
            deposit.amount
          )}</b>\n` +

          `🔢 UTR: ` +
          `<code>${escapeHtml(
            deposit.utr || "N/A"
          )}</code>\n\n` +

          `Status: ✅ APPROVED`,

          {
            parse_mode: "HTML",
            ...depositsMenu(),
          }
        );


        // ----------------------------------------------------------
        // Notify referrer about successful referral commission
        // ----------------------------------------------------------

        if (
          deposit.referralReferrerId &&
          Number(deposit.referralCommission || 0) > 0
        ) {
          await ctx.telegram
            .sendMessage(
              String(deposit.referralReferrerId),

              `🎉 <b>Referral Commission Received!</b>\n\n` +
              `👤 Your referred user made a deposit.\n` +
              `💰 Deposit: ₹${formatAmount(deposit.amount)}\n` +
              `💸 Commission: ₹${formatAmount(deposit.referralCommission)}\n` +
              `📈 Rate: ${formatAmount(deposit.referralRate)}%\n\n` +
              `💳 Commission has been added to your wallet.`,

              {
                parse_mode: "HTML",
              }
            )
            .catch(
              (err) =>
                logger.error(
                  "Failed to notify referrer of referral commission",
                  err
                )
            );
        }


        // ----------------------------------------------------------
        // Notify user
        // ----------------------------------------------------------

        await ctx.telegram
          .sendMessage(
            deposit.userId,

            `✅ <b>Deposit Approved</b>\n\n` +
            `💰 Amount: ₹${formatAmount(
              deposit.amount
            )}\n` +
            `🔢 UTR: <code>${escapeHtml(
              deposit.utr || "N/A"
            )}</code>\n\n` +
            `💳 The amount has been added to your balance.`,

            {
              parse_mode: "HTML",
            }
          )
          .catch(
            (err) =>
              logger.error(
                "Failed to notify user of deposit approval",
                err
              )
          );

      } catch (err) {

        logger.error(
          "Error in admin:deposits:approve action",
          err
        );

        await safeAnswer(
          ctx,
          "❌ Something went wrong."
        );
      }
    }
  );


  // ==============================================================
  // REJECT DEPOSIT
  // ==============================================================

  bot.action(
    /^admin:deposits:reject:(.+)$/,
    async (ctx) => {

      try {

        await safeAnswer(
          ctx,
          "Processing..."
        );


        if (!(await requireAdmin(ctx))) {
          return;
        }


        const depositId =
          ctx.match[1];


        let deposit;


        // ----------------------------------------------------------
        // Database transaction
        // ----------------------------------------------------------

        try {

          deposit =
            await db.rejectDeposit(
              depositId,
              ctx.from.id
            );

        } catch (err) {

          if (
            err.code ===
            "ALREADY_PROCESSED"
          ) {

            await safeAnswer(
              ctx,
              "⚠️ Already processed."
            );

            return;
          }

          throw err;
        }


        // ----------------------------------------------------------
        // Update same message
        // ----------------------------------------------------------

        await editOrReply(
          ctx,

          `❌ <b>DEPOSIT REJECTED</b>\n\n` +

          `👤 User: ` +
          `<code>${escapeHtml(
            String(deposit.userId)
          )}</code>\n` +

          `💰 Amount: ` +
          `<b>₹${formatAmount(
            deposit.amount
          )}</b>\n` +

          `🔢 UTR: ` +
          `<code>${escapeHtml(
            deposit.utr || "N/A"
          )}</code>\n\n` +

          `Status: ❌ REJECTED`,

          {
            parse_mode: "HTML",
            ...depositsMenu(),
          }
        );


        // ----------------------------------------------------------
        // Notify user
        // ----------------------------------------------------------

        await ctx.telegram
          .sendMessage(
            deposit.userId,

            `❌ <b>Deposit Rejected</b>\n\n` +
            `💰 Amount: ₹${formatAmount(
              deposit.amount
            )}\n` +
            `🔢 UTR: <code>${escapeHtml(
              deposit.utr || "N/A"
            )}</code>\n\n` +
            `Your deposit request was rejected.`,

            {
              parse_mode: "HTML",
            }
          )
          .catch(
            (err) =>
              logger.error(
                "Failed to notify user of deposit rejection",
                err
              )
          );

      } catch (err) {

        logger.error(
          "Error in admin:deposits:reject action",
          err
        );

        await safeAnswer(
          ctx,
          "❌ Something went wrong."
        );
      }
    }
  );
}


// ================================================================
// EXPORT
// ================================================================

module.exports = {
  registerAdminDepositsHandler,
};
