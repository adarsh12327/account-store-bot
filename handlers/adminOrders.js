/**
 * handlers/adminOrders.js
 * ------------------------------------------------------------------
 * 🛒 Order manager (admin only)
 * ------------------------------------------------------------------
 */

const db = require("../database");

const {
  getServer1OrderStats,
  getServer1TodayStats,
} = db;
const logger = require("../utils/logger");
const session = require("../utils/session");

const { requireAdmin } = require("./admin");
const { parseText } = require("../utils/validation");
const {
  escapeHtml,
  formatAmount,
  formatDate,
} = require("../utils/helpers");

const {
  ordersMenu,
  server1OrdersMenu,
  server1OrderDetailMenu,
  orderListKeyboard,
  orderDetailKeyboard,
  cancelKeyboard,
} = require("../keyboards/admin");


/* ================================================================
   ORDER DETAIL TEXT
================================================================ */

function orderDetailText(order) {
  return (
    `🛒 <b>ORDER DETAILS</b>\n\n` +
    `🆔 Order ID: <code>${escapeHtml(order.orderId || "N/A")}</code>\n` +
    `👤 User: <code>${escapeHtml(order.userId || "N/A")}</code>\n` +
    `📦 Product: ${escapeHtml(order.productName || "Unknown")}\n` +
    `💰 Amount: ₹${formatAmount(order.amount || 0)}\n` +
    `📌 Status: ${escapeHtml(order.status || "unknown")}\n` +
    `📅 Placed: ${formatDate(order.createdAt)}`
  );
}


/* ================================================================
   ORDER MANAGER
================================================================ */

async function showOrdersMenu(ctx) {
  const text = `🛒 <b>ORDER MANAGER</b>`;

  const options = {
    parse_mode: "HTML",
    ...ordersMenu(),
  };

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (err) {
      logger.warn("Could not edit order manager message.");
    }
  }

  await ctx.reply(text, options);
}


/* ================================================================
   PROCESSING ORDERS
================================================================ */

async function showProcessingOrders(ctx) {
  const orders = await db.listOrders({
    status: "processing",
    limit: 20,
  });

  if (orders.length === 0) {
    const text =
      `📋 <b>PROCESSING ORDERS</b>\n\n` +
      `✅ No orders awaiting fulfillment.`;

    const options = {
      parse_mode: "HTML",
      ...ordersMenu(),
    };

    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, options);
        return;
      } catch (err) {
        logger.warn("Could not edit processing orders message.");
      }
    }

    await ctx.reply(text, options);
    return;
  }

  const text =
    `📋 <b>PROCESSING ORDERS</b>\n\n` +
    `Select an order below:`;

  const options = {
    parse_mode: "HTML",
    ...orderListKeyboard(orders),
  };

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (err) {
      logger.warn("Could not edit processing orders message.");
    }
  }

  await ctx.reply(text, options);
}


/* ================================================================
   ORDER DETAILS
================================================================ */

async function showOrderDetails(ctx, orderId) {
  const order = await db.getOrder(orderId);

  if (!order) {
    const text = `❌ <b>Order not found.</b>`;

    const options = {
      parse_mode: "HTML",
      ...ordersMenu(),
    };

    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, options);
        return;
      } catch (err) {
        logger.warn("Could not edit order-not-found message.");
      }
    }

    await ctx.reply(text, options);
    return;
  }

  const text = orderDetailText(order);

  const options = {
    parse_mode: "HTML",
    ...orderDetailKeyboard(order),
  };

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (err) {
      logger.warn("Could not edit order details message.");
    }
  }

  await ctx.reply(text, options);
}


/* ================================================================
   REGISTER HANDLERS
================================================================ */

function registerAdminOrdersHandler(bot) {

  /* ---------------- Orders ---------------- */

  bot.action("admin:orders", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      await showOrdersMenu(ctx);

    } catch (err) {
      logger.error("Error in admin:orders action", err);
    }
  });


  /* ---------------- Processing Orders ---------------- */

  bot.action("admin:orders:list", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      await showProcessingOrders(ctx);

    } catch (err) {
      logger.error(
        "Error in admin:orders:list action",
        err
      );
    }
  });


  /* ---------------- Server 1 Orders ---------------- */

  bot.action("admin:server1:orders", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      await ctx.editMessageText(
        "🖥️ <b>SERVER 1 ORDERS</b>\n\nSelect a status:",
        {
          parse_mode: "HTML",
          ...server1OrdersMenu(),
        }
      );
    } catch (err) {
      logger.error(
        "Error in admin:server1:orders action",
        err
      );
    }
  });


  /* ---------------- Server 1 Processing Orders ---------------- */

  bot.action(
    "admin:server1:orders:processing",
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        const [processingOrders, waitingOtpOrders] = await Promise.all([
          db.listServer1Orders({
            status: "processing",
            limit: 100,
          }),
          db.listServer1Orders({
            status: "waiting_otp",
            limit: 100,
          }),
        ]);

        const orders = [...processingOrders, ...waitingOtpOrders]
          .sort((a, b) => {
            const aTime = a.createdAt?.toMillis
              ? a.createdAt.toMillis()
              : 0;
            const bTime = b.createdAt?.toMillis
              ? b.createdAt.toMillis()
              : 0;

            return bTime - aTime;
          })
          .slice(0, 20);

        if (orders.length === 0) {
          await ctx.editMessageText(
            "🖥️ <b>SERVER 1 — PROCESSING</b>\n\n" +
            "✅ No Server 1 orders require attention.",
            {
              parse_mode: "HTML",
              ...server1OrdersMenu(),
            }
          );
          return;
        }

        const rows = orders.map((order) => {
          const status = String(order.status || "").toLowerCase();

          const icon =
            status === "waiting_otp"
              ? "📩"
              : "⏳";

          const label =
            status === "waiting_otp"
              ? "Waiting OTP"
              : "Processing";

          return [
            {
              text:
                `${icon} ${label} • ` +
                `${order.countryName || "Unknown"} — ` +
                `₹${formatAmount(order.amount || 0)}`,
              callback_data:
                `admin:server1:order:${order.orderId}`,
            },
          ];
        });

        rows.push([
          {
            text: "⬅ Server 1 Orders",
            callback_data: "admin:server1:orders",
          },
        ]);

        await ctx.editMessageText(
          "🖥️ <b>SERVER 1 — PROCESSING</b>\n\n" +
          "Select an order:",
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: rows,
            },
          }
        );
      } catch (err) {
        logger.error(
          "Error in admin:server1:orders:processing action",
          err
        );
      }
    }
  );


  /* ---------------- Server 1 Statistics ---------------- */

  
bot.action("admin:server1:today_stats", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});

    if (!(await requireAdmin(ctx))) return;

    const stats = await getServer1TodayStats();

    const successRate =
      Number(stats.successRate || 0).toFixed(2);

    const text =
      "📅 <b>TODAY'S SERVER 1 STATISTICS</b>\n" +
      "━━━━━━━━━━━━━━━━━━━━\n\n" +
      `📦 <b>Total Orders:</b> ${stats.total}\n\n` +
      `✅ <b>Completed:</b> ${stats.completed}\n` +
      `❌ <b>Cancelled / Refunded:</b> ${stats.cancelled}\n` +
      `📵 <b>No Number:</b> ${stats.noNumber}\n` +
      `⏳ <b>Waiting OTP:</b> ${stats.waitingOtp}\n` +
      `⚙️ <b>Processing:</b> ${stats.processing}\n` +
      `⚠️ <b>Manual Review:</b> ${stats.manualReview}\n\n` +
      `📈 <b>Success Rate:</b> ${successRate}%\n\n` +
      `💰 <b>Today's Sales:</b> ₹${formatAmount(stats.totalSales)}\n` +
      `💸 <b>Provider Cost:</b> ₹${formatAmount(stats.totalCost)}\n` +
      `💵 <b>Profit:</b> ₹${formatAmount(stats.profit)}`;

    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      ...server1OrdersMenu(),
    });
  } catch (err) {
    logger.error(
      "Error in admin:server1:today_stats action",
      err
    );
  }
});

bot.action("admin:server1:stats", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      const stats = await getServer1OrderStats();

      const successRate =
        Number(stats.successRate || 0).toFixed(2);

      const text =
        "📊 <b>SERVER 1 STATISTICS</b>\n" +
        "━━━━━━━━━━━━━━━━━━━━\n\n" +
        `📦 <b>Total Orders:</b> ${stats.total}\n\n` +
        `✅ <b>Completed:</b> ${stats.completed}\n` +
        `❌ <b>Cancelled / Refunded:</b> ${stats.cancelled}\n` +
        `📵 <b>No Number:</b> ${stats.noNumber}\n` +
        `⏳ <b>Waiting OTP:</b> ${stats.waitingOtp}\n` +
        `⚙️ <b>Processing:</b> ${stats.processing}\n` +
        `⚠️ <b>Manual Review:</b> ${stats.manualReview}\n\n` +
        `📈 <b>Success Rate:</b> ${successRate}%\n\n` +
        `💰 <b>Total Sales:</b> ₹${formatAmount(stats.totalSales)}\n` +
        `💸 <b>Provider Cost:</b> ₹${formatAmount(stats.totalCost)}\n` +
        `💵 <b>Profit:</b> ₹${formatAmount(stats.profit)}`;

      await ctx.editMessageText(
        text,
        {
          parse_mode: "HTML",
          ...server1OrdersMenu(),
        }
      );
    } catch (err) {
      logger.error(
        "Error in admin:server1:stats action",
        err
      );
    }
  });


  /* ---------------- Server 1 Order Details ---------------- */

  bot.action(/^admin:server1:order:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      const orderId = ctx.match[1];
      const order = await db.getServer1Order(orderId);

      if (!order) {
        await ctx.editMessageText(
          "❌ <b>Server 1 order not found.</b>",
          {
            parse_mode: "HTML",
            ...server1OrderDetailMenu(),
          }
        );
        return;
      }

      const status = String(order.status || "unknown").toLowerCase();

      const statusMap = {
        processing: "⏳ Processing",
        waiting_otp: "📩 Waiting OTP",
        completed: "✅ Completed",
        refunded: "❌ Refunded",
        cancelled: "❌ Cancelled",
        failed: "⚠️ Failed",
      };

      const statusLabel =
        statusMap[status] || `📌 ${status}`;

      const text =
        "🖥️ <b>SERVER 1 ORDER</b>\n" +
        "━━━━━━━━━━━━━━━━━━━━\n\n" +
        `🆔 <b>Order:</b> <code>${escapeHtml(order.orderId || orderId)}</code>\n` +
        `👤 <b>User:</b> <code>${escapeHtml(order.userId || "N/A")}</code>\n` +
        `📱 <b>Service:</b> ${escapeHtml(order.serviceName || "Telegram")}\n` +
        `🌍 <b>Country:</b> ${escapeHtml(order.countryName || "Unknown")}\n` +
        `💰 <b>Amount:</b> ₹${formatAmount(order.amount || 0)}\n` +
        `📌 <b>Status:</b> ${escapeHtml(statusLabel)}\n` +
        `📞 <b>Number:</b> ${escapeHtml(order.phoneNumber || "Not assigned")}\n` +
        `📝 <b>Info:</b> ${escapeHtml(order.deliveryInfo || "N/A")}`;

      await ctx.editMessageText(
        text,
        {
          parse_mode: "HTML",
          ...server1OrdersMenu(),
        }
      );
    } catch (err) {
      logger.error(
        "Error in admin:server1:order action",
        err
      );
    }
  });


  /* ---------------- Order Details ---------------- */

  bot.action(/^admin:orders:view:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      await showOrderDetails(
        ctx,
        ctx.match[1]
      );

    } catch (err) {
      logger.error(
        "Error in admin:orders:view action",
        err
      );
    }
  });


  /* ---------------- Complete Order ---------------- */

  bot.action(/^admin:orders:complete:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      const orderId = ctx.match[1];

      const order = await db.getOrder(orderId);

      if (!order) {
        await ctx.reply(
          "❌ Order not found.",
          ordersMenu()
        );
        return;
      }

      if (order.status !== "processing") {
        await ctx.reply(
          "⚠️ This order is no longer processing.",
          ordersMenu()
        );
        return;
      }

      session.set(ctx.from.id, {
        step: "admin_order_complete",
        data: {
          orderId,
        },
      });

      await ctx.reply(
        `📩 <b>Enter delivery information</b>\n\n` +
        `Order: <code>${escapeHtml(orderId)}</code>\n` +
        `Product: ${escapeHtml(order.productName || "Unknown")}\n\n` +
        `The information will be sent to the buyer.`,
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );

    } catch (err) {
      logger.error(
        "Error in admin:orders:complete action",
        err
      );
    }
  });


  /* ---------------- Cancel Order ---------------- */

  bot.action(/^admin:orders:cancel:(.+)$/, async (ctx) => {
    try {
      if (!(await requireAdmin(ctx))) return;

      const orderId = ctx.match[1];

      let order;

      try {
        order = await db.cancelOrder(
          orderId,
          ctx.from.id
        );

      } catch (err) {

        if (err.code === "INVALID_STATE") {
          await ctx.answerCbQuery(
            "⚠️ This order can't be cancelled from its current state.",
            { show_alert: true }
          );
          return;
        }

        throw err;
      }

      await ctx.answerCbQuery(
        "❌ Cancelled & refunded"
      ).catch(() => {});


      const text =
        `❌ <b>ORDER CANCELLED</b>\n\n` +
        `🆔 Order: <code>${escapeHtml(order.orderId || orderId)}</code>\n` +
        `👤 User: <code>${escapeHtml(order.userId)}</code>\n` +
        `💰 Refunded: ₹${formatAmount(order.amount)}`;

      if (ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageText(
            text,
            {
              parse_mode: "HTML",
              ...ordersMenu(),
            }
          );
        } catch (err) {
          await ctx.reply(
            text,
            {
              parse_mode: "HTML",
              ...ordersMenu(),
            }
          );
        }
      } else {
        await ctx.reply(
          text,
          {
            parse_mode: "HTML",
            ...ordersMenu(),
          }
        );
      }


      await ctx.telegram
        .sendMessage(
          order.userId,
          `❌ Your order for "${order.productName}" was cancelled.\n\n` +
          `💰 ₹${formatAmount(order.amount)} has been refunded to your wallet.`
        )
        .catch((err) =>
          logger.error(
            "Failed to notify user of order cancellation",
            err
          )
        );

    } catch (err) {

      logger.error(
        "Error in admin:orders:cancel action",
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


  /* ================================================================
     TEXT STEPS
  ================================================================ */

  const textSteps = {

    /* ---------------- Complete Order ---------------- */

    admin_order_complete: async (ctx, state) => {

      const deliveryInfo = parseText(
        ctx.message.text,
        {
          minLen: 1,
          maxLen: 2000,
        }
      );

      if (deliveryInfo === null) {
        await ctx.reply(
          "❌ Please enter valid delivery information.",
          cancelKeyboard()
        );
        return;
      }


      const { orderId } = state.data;

      let order;

      try {

        order = await db.completeOrder(
          orderId,
          ctx.from.id,
          deliveryInfo
        );

      } catch (err) {

        if (err.code === "INVALID_STATE") {

          session.clear(ctx.from.id);

          await ctx.reply(
            "⚠️ This order can't be completed from its current state.",
            ordersMenu()
          );

          return;
        }

        throw err;
      }


      session.clear(ctx.from.id);


      await ctx.reply(
        `✅ <b>ORDER COMPLETED</b>\n\n` +
        `🆔 Order: <code>${escapeHtml(order.orderId || orderId)}</code>\n` +
        `📦 ${escapeHtml(order.productName || "Unknown")}\n` +
        `💰 ₹${formatAmount(order.amount)}`,
        {
          parse_mode: "HTML",
          ...ordersMenu(),
        }
      );


      await ctx.telegram
        .sendMessage(
          order.userId,
          `✅ Your order for "${order.productName}" has been fulfilled!\n\n` +
          `📩 ${deliveryInfo}`
        )
        .catch((err) =>
          logger.error(
            "Failed to notify user of order completion",
            err
          )
        );
    },
  };


  return {
    textSteps,
  };
}



async function showServer1OrderFilter(ctx, filter) {
  try {
    await ctx.answerCbQuery().catch(() => {});

    if (!(await requireAdmin(ctx))) return;

    const orders = await db.listServer1Orders({
      limit: 1000,
    });

    let filtered = orders;

    if (filter === "completed") {
      filtered = orders.filter(
        (o) => String(o.status || "").toLowerCase() === "completed"
      );
    }

    if (filter === "refunded") {
      filtered = orders.filter(
        (o) => String(o.status || "").toLowerCase() === "refunded"
      );
    }

    if (filter === "no_number") {
      filtered = orders.filter((o) => {
        const status = String(o.status || "").toLowerCase();
        const reason = String(o.failureReason || "").toLowerCase();
        const info = String(o.deliveryInfo || "").toLowerCase();

        return (
          status === "refunded" &&
          (
            reason === "no_numbers" ||
            reason === "no_number" ||
            info.includes("no numbers") ||
            info.includes("number not available")
          )
        );
      });
    }

    if (filter === "manual_review") {
      filtered = orders.filter((o) => {
        const info = String(o.deliveryInfo || "").toLowerCase();

        return (
          info.includes("manual review") ||
          info.includes("could not be confirmed")
        );
      });
    }

    let title = "📋 <b>All Orders</b>";

    if (filter === "completed") {
      title = "✅ <b>Completed Orders</b>";
    } else if (filter === "refunded") {
      title = "❌ <b>Cancelled / Refunded Orders</b>";
    } else if (filter === "no_number") {
      title = "📵 <b>No Number Orders</b>";
    } else if (filter === "manual_review") {
      title = "⚠️ <b>Manual Review Orders</b>";
    }

    let text =
      "🖥️ <b>SERVER 1 ORDERS</b>\n" +
      "━━━━━━━━━━━━━━━━━━━━\n\n" +
      title +
      "\n\n";

    if (!filtered.length) {
      text += "No orders found.";

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        ...server1OrdersMenu(),
      });

      return;
    }

    const buttons = filtered.slice(0, 50).map((order) => {
      const status = String(order.status || "").toLowerCase();

      let icon = "⏳";

      if (status === "completed") {
        icon = "✅";
      } else if (status === "refunded") {
        icon = "❌";
      }

      return [
        Markup.button.callback(
          `${icon} ${order.countryName || "Unknown"} — ₹${formatAmount(order.amount || 0)}`,
          `admin:server1:order:${order.orderId}`
        ),
      ];
    });

    buttons.push([
      Markup.button.callback(
        "⬅️ Server 1 Orders",
        "admin:server1:orders"
      ),
    ]);

    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: buttons,
      },
    });
  } catch (err) {
    logger.error(
      `Error in Server 1 order filter: ${filter}`,
      err
    );
  }
  /* ---------------- Server 1 Order Filters ---------------- */

  bot.action("admin:server1:orders:all", async (ctx) => {
    await showServer1OrderFilter(ctx, "all");
  });

  bot.action("admin:server1:orders:completed", async (ctx) => {
    await showServer1OrderFilter(ctx, "completed");
  });

  bot.action("admin:server1:orders:refunded", async (ctx) => {
    await showServer1OrderFilter(ctx, "refunded");
  });

  bot.action("admin:server1:orders:no_number", async (ctx) => {
    await showServer1OrderFilter(ctx, "no_number");
  });

  bot.action("admin:server1:orders:manual_review", async (ctx) => {
    await showServer1OrderFilter(ctx, "manual_review");
  });


}

module.exports = {
  registerAdminOrdersHandler,
  showOrdersMenu,
  showProcessingOrders,
  showOrderDetails,
};
