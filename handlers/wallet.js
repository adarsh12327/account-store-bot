/**
 * handlers/wallet.js
 * ------------------------------------------------------------------
 * 💰 Wallet: balance summary + transaction history.
 *
 * Callback navigation edits the existing message instead of
 * creating unnecessary new messages.
 * ------------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");

const {
  escapeHtml,
  formatAmount,
  formatDate,
} = require("../utils/helpers");

const {
  walletMenu,
  backToMenu,
} = require("../keyboards/user");


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


function registerWalletHandler(bot) {

  // ============================================================
  // MY WALLET
  // ============================================================

  bot.action("menu_wallet", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      // Render immediately. Firestore work happens after the callback
      // has been acknowledged and the Telegram screen is updated.
      await editScreen(
        ctx,
        "💰 <b>Your Wallet</b>\n\n⏳ Loading wallet...",
        walletMenu()
      ).catch(() => {});

      setImmediate(async () => {
        try {
          const user = await db.getUser(ctx.from.id);

          if (!user) {
            await editScreen(
              ctx,
              "⚠️ <b>User account not found.</b>\n\nPlease use /start again.",
              backToMenu()
            );
            return;
          }

          const text =
            `💰 <b>Your Wallet</b>\n\n` +
            `💵 Current Balance: ₹${formatAmount(user.balance)}\n` +
            `💳 Total Deposited: ₹${formatAmount(user.totalDeposit)}\n` +
            `⏳ Pending Deposit: ₹${formatAmount(user.pendingDeposit)}\n` +
            `📦 Total Orders: ${user.totalOrders || 0}`;

          await editScreen(ctx, text, walletMenu());
        } catch (err) {
          logger.error("Background wallet load failed", err);
          await editScreen(
            ctx,
            "💰 <b>Your Wallet</b>\n\n⚠️ Wallet data is temporarily unavailable.\nPlease try again shortly.",
            backToMenu()
          ).catch(() => {});
        }
      });

    } catch (err) {
      logger.error("Error in menu_wallet action", err);

      await ctx.reply(
        "💰 <b>Your Wallet</b>\n\n" +
        "⚠️ Wallet data is temporarily unavailable.\n" +
        "Please tap <b>My Wallet</b> again in a moment.",
        { parse_mode: "HTML", ...backToMenu() }
      ).catch(() => {});

      await ctx.answerCbQuery().catch(() => {});
    }
  });


  // ============================================================
  // TRANSACTION HISTORY
  // ============================================================

  bot.action("wallet_history", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      await editScreen(
        ctx,
        "📜 <b>Transaction History</b>\n\n⏳ Loading...",
        backToMenu()
      ).catch(() => {});

      setImmediate(async () => {
        try {
          const transactions = await db.listUserTransactions(ctx.from.id, 10);

          if (transactions.length === 0) {
            await editScreen(
              ctx,
              "📜 <b>Transaction History</b>\n\nNo transactions yet.",
              backToMenu()
            );
            return;
          }

          const lines = transactions.map((t) => {
            const sign = Number(t.amount) >= 0 ? "+" : "";
            return (
              `${formatDate(t.createdAt)}\n` +
              `${sign}₹${formatAmount(t.amount)} (${escapeHtml(t.type)})\n` +
              `${escapeHtml(t.note || "")}`
            );
          });

          const text =
            `📜 <b>Last ${transactions.length} Transactions</b>\n\n` +
            lines.join("\n\n");

          await editScreen(ctx, text, backToMenu());
        } catch (err) {
          logger.error("Background wallet history load failed", err);
          await editScreen(
            ctx,
            "📜 <b>Transaction History</b>\n\n⚠️ Data is temporarily unavailable.\nPlease try again shortly.",
            backToMenu()
          ).catch(() => {});
        }
      });

    } catch (err) {
      logger.error(
        "Error in wallet_history action",
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
  registerWalletHandler,
};
