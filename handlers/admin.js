/**
 * handlers/admin.js
 * ------------------------------------------------------------------
 * /admin command + admin:home callback. All other admin:* callbacks
 * live in their own handler files, but every one of them MUST call
 * requireAdmin() first — see the pattern used throughout this file.
 * ------------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");
const { isAdmin, escapeHtml } = require("../utils/helpers");
const { adminHome, serversMenu } = require("../keyboards/admin");
const { showOrEdit } = require("../utils/navigation");
/**
 * Call at the top of every admin handler. Returns true if the caller
 * is the configured admin; otherwise replies "Access Denied" and
 * returns false so the handler can bail out immediately.
 */
async function requireAdmin(ctx) {
  if (isAdmin(ctx.from.id)) return true;

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery("⛔ Access Denied", { show_alert: true }).catch(() => {});
  } else {
    await ctx.reply("⛔ Access Denied").catch(() => {});
  }
  return false;
}

async function showAdminHome(ctx) {
  const stats = await db.getStatistics();
  const text =
    `👨‍💼 <b>Admin Panel</b>\n\n` +
    `👥 Total Users: ${stats.totalUsers}\n` +
    `📦 Total Products: ${stats.totalProducts}\n` +
    `🌍 Total Countries: ${stats.totalCountries}\n` +
    `🔌 Total Providers: ${stats.totalProviders}\n` +
    `🛒 Total Orders: ${stats.totalOrders}\n` +
    `💳 Pending Deposits: ${stats.pendingDeposits}\n` +
    `💰 Total Deposits: ₹${stats.totalDepositAmount}`;

if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        ...adminHome(),
      });
    } catch (err) {
      if (
        !String(err.message || "")
          .toLowerCase()
          .includes("message is not modified")
      ) {
        throw err;
      }
    }
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      ...adminHome(),
    });
  }
}
function registerAdminHandler(bot) {
  bot.action("admin:servers", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;
      await ctx.editMessageText(
        "🖥️ <b>Servers</b>\n\nSelect a server:",
        { parse_mode: "HTML", ...serversMenu() }
      );
    } catch (err) {
      logger.error("Error in admin:servers action", err);
    }
  });

  bot.command("admin", async (ctx) => {
    try {
      if (!(await requireAdmin(ctx))) return;
      await showAdminHome(ctx);
    } catch (err) {
      logger.error("Error in /admin command", err);
      await ctx.reply("⚠️ Something went wrong.").catch(() => {});
    }
  });

  bot.action("admin:home", async (ctx) => {
    try {
      try {
        await ctx.answerCbQuery();
      } catch (_) {
        // Ignore expired/invalid callback query
      }
      if (!(await requireAdmin(ctx))) return;

      // Admin navigation should acknowledge and render immediately.
      await ctx.editMessageText(
        "👨‍💼 <b>Admin Panel</b>\n\n⏳ Loading statistics...",
        { parse_mode: "HTML", ...adminHome() }
      ).catch(() => {});

      setImmediate(async () => {
        try {
          await showAdminHome(ctx);
        } catch (err) {
          logger.error("Background admin home load failed", err);
          await ctx.editMessageText(
            "👨‍💼 <b>Admin Panel</b>\n\n⚠️ Statistics are temporarily unavailable.\nPlease try again shortly.",
            { parse_mode: "HTML", ...adminHome() }
          ).catch(() => {});
        }
      });
    } catch (err) {
      logger.error("Error in admin:home action", err);
      await ctx.answerCbQuery("Something went wrong.", { show_alert: true }).catch(() => {});
    }
  });
}

module.exports = { registerAdminHandler, requireAdmin, showAdminHome };
