/**
 * handlers/orders.js
 * ------------------------------------------------------------------
 * 📦 My Orders: list + detail view.
 *
 * Navigation edits the existing Telegram message.
 * Includes both legacy store orders and Server 1 orders.
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
  ordersListKeyboard,
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

function orderTime(order) {
  const value = order.createdAt;
  if (value?.toMillis) return value.toMillis();
  if (value?.toDate) return value.toDate().getTime();

  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeServer1Order(order) {
  return {
    ...order,
    orderId: String(order.orderId),
    productName: `Telegram — ${order.countryName || "Unknown"}`,
    amount: Number(order.amount || 0),
    status: String(order.status || "unknown"),
  };
}

function buildServer1OrderDetail(order) {
  const status = escapeHtml(order.status || "unknown");
  const country = escapeHtml(order.countryName || "Unknown");
  const number = escapeHtml(order.phoneNumber || "Not assigned");

  let delivery = "";

  if (order.status === "completed" && order.deliveryInfo) {
    delivery = `\n\n📩 <b>Delivery Info</b>\n${escapeHtml(order.deliveryInfo)}`;
  }

  return (
    `📦 <b>Server 1 Order Details</b>\n\n` +
    `📱 Service: <b>Telegram</b>\n` +
    `🌍 Country: <b>${country}</b>\n` +
    `💰 Amount: ₹${formatAmount(order.amount)}\n` +
    `📌 Status: <b>${status}</b>\n` +
    `📞 Number: <code>${number}</code>\n` +
    `🕒 Placed: ${formatDate(order.createdAt)}` +
    delivery
  );
}

function registerOrdersHandler(bot) {

  // ============================================================
  // MY ORDERS
  // ============================================================

  bot.action("menu_orders", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      // Give immediate visual feedback; Firestore reads continue in
      // the background and cannot hold the Telegram callback open.
      await editScreen(
        ctx,
        "📦 <b>My Orders</b>\n\n⏳ Loading orders...",
        backToMenu()
      ).catch(() => {});

      setImmediate(async () => {
        try {
          const userId = String(ctx.from.id);

          const [legacyOrders, server1OrdersRaw] = await Promise.all([
            db.listUserOrders(userId, 10),
            db.listUserServer1Orders(userId, 10, 0),
          ]);

          const server1Orders = server1OrdersRaw.map(normalizeServer1Order);
          const orders = [...legacyOrders, ...server1Orders]
            .sort((a, b) => orderTime(b) - orderTime(a))
            .slice(0, 10);

          if (orders.length === 0) {
            await editScreen(
              ctx,
              "📦 <b>My Orders</b>\n\nYou have no orders yet.",
              backToMenu()
            );
            return;
          }

          await editScreen(
            ctx,
            "📦 <b>Your Orders</b>\n\nTap an order to view details:",
            ordersListKeyboard(orders)
          );
        } catch (err) {
          logger.error("Background orders load failed", err);
          await editScreen(
            ctx,
            "📦 <b>My Orders</b>\n\n⚠️ Orders are temporarily unavailable.\nPlease try again shortly.",
            backToMenu()
          ).catch(() => {});
        }
      });

    } catch (err) {
      logger.error(
        "Error in menu_orders action",
        err
      );

      await editScreen(
        ctx,
        "📦 <b>My Orders</b>\n\n" +
        "⚠️ Orders are temporarily unavailable.\n" +
        "Please try again in a moment.",
        backToMenu()
      ).catch(() => {});

      await ctx.answerCbQuery().catch(() => {});
    }
  });


  // ============================================================
  // ORDER DETAILS
  // ============================================================

  bot.action(/^order_view:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();

      const orderId = ctx.match[1];
      const userId = String(ctx.from.id);

      // First check the legacy orders collection.
      const legacyOrder = await db.getOrder(orderId);

      if (legacyOrder) {
        if (String(legacyOrder.userId) !== userId) {
          await editScreen(
            ctx,
            "❌ <b>Order Not Found</b>\n\nThis order does not exist or does not belong to you.",
            backToMenu()
          );
          return;
        }

        const text =
          `📦 <b>Order Details</b>\n\n` +
          `📱 Product: ${escapeHtml(legacyOrder.productName)}\n` +
          `💰 Amount: ₹${formatAmount(legacyOrder.amount)}\n` +
          `📌 Status: ${escapeHtml(legacyOrder.status)}\n` +
          `🕒 Placed: ${formatDate(legacyOrder.createdAt)}` +
          (
            legacyOrder.status === "completed" &&
            legacyOrder.deliveryInfo
              ? `\n\n📩 <b>Delivery Info</b>\n${escapeHtml(legacyOrder.deliveryInfo)}`
              : ""
          );

        await editScreen(ctx, text, backToMenu());
        return;
      }

      // Server 1 orders live in a separate collection.
      const server1Order = await db.getServer1Order(orderId);

      if (
        !server1Order ||
        String(server1Order.userId) !== userId
      ) {
        await editScreen(
          ctx,
          "❌ <b>Order Not Found</b>\n\nThis order does not exist or does not belong to you.",
          backToMenu()
        );
        return;
      }

      await editScreen(
        ctx,
        buildServer1OrderDetail(server1Order),
        backToMenu()
      );

    } catch (err) {
      logger.error(
        "Error in order_view action",
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
  registerOrdersHandler,
};
