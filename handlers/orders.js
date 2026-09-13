/**
 * handlers/orders.js
 * ------------------------------------------------------------------
 * 📦 My Orders: list + detail view.
 *
 * Navigation edits the existing Telegram message.
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


function registerOrdersHandler(bot) {

  // ============================================================
  // MY ORDERS
  // ============================================================

  bot.action("menu_orders", async (ctx) => {
    try {
      await ctx.answerCbQuery();

      const orders =
        await db.listUserOrders(
          ctx.from.id,
          10
        );

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
      logger.error(
        "Error in menu_orders action",
        err
      );

      await ctx.answerCbQuery(
        "Something went wrong.",
        { show_alert: true }
      ).catch(() => {});
    }
  });


  // ============================================================
  // ORDER DETAILS
  // ============================================================

  bot.action(/^order_view:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();

      const orderId =
        ctx.match[1];

      const order =
        await db.getOrder(orderId);


      // Security: user can only view their own order.
      if (
        !order ||
        String(order.userId) !==
          String(ctx.from.id)
      ) {

        await editScreen(
          ctx,
          "❌ <b>Order Not Found</b>\n\nThis order does not exist or does not belong to you.",
          backToMenu()
        );

        return;
      }


      const text =
        `📦 <b>Order Details</b>\n\n` +
        `📱 Product: ${escapeHtml(order.productName)}\n` +
        `💰 Amount: ₹${formatAmount(order.amount)}\n` +
        `📌 Status: ${escapeHtml(order.status)}\n` +
        `🕒 Placed: ${formatDate(order.createdAt)}` +
        (
          order.status === "completed" &&
          order.deliveryInfo
            ? `\n\n📩 <b>Delivery Info</b>\n${escapeHtml(order.deliveryInfo)}`
            : ""
        );


      await editScreen(
        ctx,
        text,
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
