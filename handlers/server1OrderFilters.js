/**
 * Server 1 admin order filters.
 *
 * Kept separate from the legacy order handler so every filter callback is
 * registered at module initialization time instead of being registered only
 * after a filter has already been clicked.
 */

const db = require("../database");
const logger = require("../utils/logger");
const { requireAdmin } = require("./admin");
const { escapeHtml, formatAmount } = require("../utils/helpers");

const FILTERS = {
  all: {
    title: "📋 <b>All Server 1 Orders</b>",
    test: () => true,
  },
  completed: {
    title: "✅ <b>Completed Server 1 Orders</b>",
    test: (order) => String(order.status || "").toLowerCase() === "completed",
  },
  refunded: {
    title: "❌ <b>Cancelled / Refunded Server 1 Orders</b>",
    test: (order) => ["refunded", "cancelled"].includes(String(order.status || "").toLowerCase()),
  },
  no_number: {
    title: "📵 <b>No Number Orders</b>",
    test: (order) => {
      const status = String(order.status || "").toLowerCase();
      const reason = String(order.failureReason || "").toLowerCase();
      const info = String(order.deliveryInfo || "").toLowerCase();
      return status === "refunded" && (
        reason === "no_numbers" ||
        reason === "no_number" ||
        info.includes("no numbers") ||
        info.includes("number not available")
      );
    },
  },
  manual_review: {
    title: "⚠️ <b>Manual Review Orders</b>",
    test: (order) => {
      const info = String(order.deliveryInfo || "").toLowerCase();
      const reason = String(order.failureReason || "").toLowerCase();
      return (
        info.includes("manual review") ||
        info.includes("could not be confirmed") ||
        reason.includes("manual review")
      );
    },
  },
};

function orderTime(order) {
  const value = order.createdAt;
  if (value?.toMillis) return value.toMillis();
  if (value?.toDate) return value.toDate().getTime();
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

async function showServer1OrderFilter(ctx, filter) {
  try {
    await ctx.answerCbQuery().catch(() => {});
    if (!(await requireAdmin(ctx))) return;

    const config = FILTERS[filter] || FILTERS.all;
    const orders = await db.listServer1Orders({ limit: 1000 });
    const filtered = orders
      .filter(config.test)
      .sort((a, b) => orderTime(b) - orderTime(a));

    if (!filtered.length) {
      await ctx.editMessageText(
        `🖥️ <b>SERVER 1 ORDERS</b>\n\n${config.title}\n\nNo orders found.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "⬅️ Server 1 Orders", callback_data: "admin:server1:orders" },
            ]],
          },
        }
      );
      return;
    }

    const rows = filtered.slice(0, 50).map((order) => {
      const status = String(order.status || "unknown").toLowerCase();
      const icon = status === "completed" ? "✅" :
        ["refunded", "cancelled"].includes(status) ? "❌" :
        status === "waiting_otp" ? "📩" : "⏳";

      const country = escapeHtml(order.countryName || "Unknown");
      const amount = formatAmount(order.amount || 0);

      return [{
        text: `${icon} ${country} — ₹${amount}`,
        callback_data: `admin:server1:order:${order.orderId}`,
      }];
    });

    rows.push([
      { text: "⬅️ Server 1 Orders", callback_data: "admin:server1:orders" },
    ]);

    await ctx.editMessageText(
      `🖥️ <b>SERVER 1 ORDERS</b>\n\n${config.title}\n\nShowing ${Math.min(filtered.length, 50)} of ${filtered.length} orders:`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: rows },
      }
    );
  } catch (err) {
    logger.error(`Error in Server 1 ${filter} filter`, err);
    await ctx.answerCbQuery("Failed to load orders.", { show_alert: true }).catch(() => {});
  }
}

function registerServer1OrderFiltersHandler(bot) {
  for (const filter of Object.keys(FILTERS)) {
    bot.action(`admin:server1:orders:${filter}`, (ctx) =>
      showServer1OrderFilter(ctx, filter)
    );
  }
}

module.exports = {
  registerServer1OrderFiltersHandler,
  showServer1OrderFilter,
};
