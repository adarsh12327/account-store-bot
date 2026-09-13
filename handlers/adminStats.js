/**
 * handlers/adminStats.js
 * ------------------------------------------------------------------
 * 📊 Statistics (admin only)
 * Uses editMessageText for callback navigation so the admin panel
 * does not create unnecessary new messages.
 * ------------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");
const { requireAdmin } = require("./admin");
const { formatAmount } = require("../utils/helpers");
const { backToAdminHome } = require("../keyboards/admin");


async function showStatistics(ctx) {
  const stats = await db.getStatistics();

  const text =
    `📊 <b>STATISTICS</b>\n\n` +
    `👥 Total Users: ${stats.totalUsers || 0}\n` +
    `📦 Total Products: ${stats.totalProducts || 0}\n` +
    `🌍 Total Countries: ${stats.totalCountries || 0}\n` +
    `🔌 Total Providers: ${stats.totalProviders || 0}\n\n` +

    `🛒 <b>ORDERS</b>\n` +
    `Total Orders: ${stats.totalOrders || 0}\n` +
    `⏳ Pending Orders: ${stats.pendingOrders || 0}\n` +
    `✅ Completed Orders: ${stats.completedOrders || 0}\n\n` +

    `💳 <b>DEPOSITS</b>\n` +
    `⏳ Pending: ${stats.pendingDeposits || 0}\n` +
    `✅ Approved: ${stats.approvedDeposits || 0}\n` +
    `❌ Rejected: ${stats.rejectedDeposits || 0}\n` +
    `💰 Total Amount: ₹${formatAmount(stats.totalDepositAmount || 0)}`;

  const options = {
    parse_mode: "HTML",
    ...backToAdminHome(),
  };

  /*
   * If Statistics was opened from an inline button,
   * edit the existing Admin Panel message instead of
   * creating another message.
   */
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (err) {
      logger.warn(
        "Could not edit statistics message, sending new message."
      );
    }
  }

  await ctx.reply(text, options);
}


function registerAdminStatsHandler(bot) {

  bot.action("admin:stats", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      await showStatistics(ctx);

    } catch (err) {
      logger.error(
        "Error in admin:stats action",
        err
      );

      await ctx
        .answerCbQuery(
          "Something went wrong.",
          { show_alert: true }
        )
        .catch(() => {});
    }
  });

}


module.exports = {
  registerAdminStatsHandler,
  showStatistics,
};

