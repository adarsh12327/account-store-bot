/**
 * handlers/adminUsers.js
 * ------------------------------------------------------------------
 * 👥 User manager (admin only)
 *
 * Features:
 * - User list + pagination
 * - Top 10 depositors
 * - Search user
 * - User details
 * - Deposit history
 * - Order history
 * - Add / remove balance
 * - Ban / unban
 *
 * Navigation callbacks EDIT the existing Telegram message instead
 * of creating duplicate/new messages.
 *
 * Text-input flows intentionally use ctx.reply().
 * ------------------------------------------------------------------
 */

const { Markup } = require("telegraf");

const db = require("../database");
const logger = require("../utils/logger");
const session = require("../utils/session");

const { requireAdmin } = require("./admin");

const { parseAmount } = require("../utils/validation");

const {
  escapeHtml,
  formatAmount,
  formatDate,
} = require("../utils/helpers");

const {
  usersMenu,
  userDetailKeyboard,
  cancelKeyboard,
} = require("../keyboards/admin");


// ================================================================
// USER DETAILS TEXT
// ================================================================

function userDetailText(user) {
  const fullName =
    `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
    "Unknown";

  return (
    `👤 <b>USER DETAILS</b>\n\n` +
    `👤 Name: ${escapeHtml(fullName)}\n` +
    `🆔 ID: <code>${escapeHtml(String(user.telegramId))}</code>\n` +
    `📛 Username: ${
      user.username
        ? "@" + escapeHtml(user.username)
        : "N/A"
    }\n\n` +
    `💰 Balance: ₹${formatAmount(user.balance)}\n` +
    `📥 Total Deposit: ₹${formatAmount(user.totalDeposit)}\n` +
    `🛒 Total Orders: ${user.totalOrders || 0}\n\n` +
    `👥 <b>Referral</b>\n` +
    `↩️ Referred By: ${
      user.referrerId
        ? `<code>${escapeHtml(String(user.referrerId))}</code>`
        : "None"
    }\n` +
    `📊 Incoming Rate: ${Number(user.referralRate || 0).toFixed(2)}%\n` +
    `🎯 Referral Earnings: ₹${formatAmount(user.referralEarnings || 0)}\n` +
    `⚙️ Outbound Rate: ${
      user.referralRateOverride !== null &&
      user.referralRateOverride !== undefined &&
      user.referralRateOverride !== ""
        ? `${Number(user.referralRateOverride).toFixed(2)}% (Admin)`
        : "Global"
    }\n\n` +
    `📅 Registered: ${formatDate(user.joinDate)}\n` +
    `🚫 Status: ${user.banned ? "Banned" : "Active"}`
  );
}


// ================================================================
// EDIT MESSAGE HELPER
// ================================================================

async function editOrReply(ctx, text, options = {}) {
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (err) {
      /*
       * Telegram can return "message is not modified" if the same
       * content is already displayed. This is not a real error.
       */
      const message =
        String(err?.description || err?.message || "").toLowerCase();

      if (message.includes("message is not modified")) {
        return;
      }

      /*
       * If editing is impossible, fall back to a new message.
       * This prevents the handler from completely failing.
       */
      logger.error("Could not edit admin users message", err);
    }
  }

  await ctx.reply(text, options);
}


// ================================================================
// HISTORY PAGINATION KEYBOARD
// ================================================================

function historyPagination(type, userId, page, hasNext) {
  const rows = [];

  const navigation = [];

  if (page > 1) {
    navigation.push({
      text: "⬅",
      callback_data:
        `admin:users:${type}:${userId}:${page - 1}`,
    });
  }

  navigation.push({
    text: `📄 ${page}`,
    callback_data: "admin:users:noop",
  });

  if (hasNext) {
    navigation.push({
      text: "➡",
      callback_data:
        `admin:users:${type}:${userId}:${page + 1}`,
    });
  }

  if (navigation.length > 0) {
    rows.push(navigation);
  }

  rows.push([
    {
      text: "⬅ User Details",
      callback_data:
        `admin:users:view:${userId}`,
    },
  ]);

  return Markup.inlineKeyboard(rows);
}


// ================================================================
// REGISTER HANDLER
// ================================================================

function registerAdminUsersHandler(bot) {

  // ==============================================================
  // USERS MENU
  // ==============================================================

  bot.action("admin:users", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      await editOrReply(
        ctx,
        "👥 <b>User Manager</b>",
        {
          parse_mode: "HTML",
          ...usersMenu(),
        }
      );

    } catch (err) {
      logger.error(
        "Error in admin:users action",
        err
      );
    }
  });


  // ==============================================================
  // NO-OP PAGINATION BUTTON
  // ==============================================================

  bot.action("admin:users:noop", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
    } catch (err) {
      logger.error(
        "Error in admin:users:noop action",
        err
      );
    }
  });


  // ==============================================================
  // USER LIST
  // ==============================================================

  bot.action(
    /^admin:users:list:(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        const page =
          Math.max(
            1,
            Number(ctx.match[1]) || 1
          );

        const perPage = 10;

        const offset =
          (page - 1) * perPage;

        const users =
          await db.listUsers(
            perPage,
            offset
          );

        if (users.length === 0) {
          await editOrReply(
            ctx,
            "📋 <b>USER LIST</b>\n\nNo more users.",
            {
              parse_mode: "HTML",
              ...usersMenu(),
            }
          );

          return;
        }

        const rows = [];

        users.forEach((user, index) => {

          const number =
            offset + index + 1;

          const name =
            `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
            "Unknown";

          rows.push([
            {
              text:
                `${number}. 👤 ${name} — 🆔 ${user.telegramId}`,

              callback_data:
                `admin:users:view:${user.telegramId}`,
            },
          ]);
        });


        // Pagination
        const navigation = [];

        if (page > 1) {
          navigation.push({
            text: "⬅",
            callback_data:
              `admin:users:list:${page - 1}`,
          });
        }

        navigation.push({
          text: `📄 ${page}`,
          callback_data:
            "admin:users:noop",
        });

        if (users.length === perPage) {
          navigation.push({
            text: "➡",
            callback_data:
              `admin:users:list:${page + 1}`,
          });
        }

        rows.push(navigation);

        rows.push([
          {
            text: "⬅ Users Menu",
            callback_data: "admin:users",
          },
        ]);


        await editOrReply(
          ctx,
          "👥 <b>USER LIST</b>\n\nSelect a user:",
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard(rows),
          }
        );

      } catch (err) {
        logger.error(
          "Error in admin:users:list action",
          err
        );
      }
    }
  );


  // ==============================================================
  // TOP 10 DEPOSITORS
  // ==============================================================

  bot.action(
    "admin:users:top",
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        const users =
          await db.getTopDepositors(10);

        if (users.length === 0) {
          await editOrReply(
            ctx,
            "🏆 <b>TOP 10 DEPOSITORS</b>\n\nNo users found.",
            {
              parse_mode: "HTML",
              ...usersMenu(),
            }
          );

          return;
        }

        const rows = [];

        const medals = [
          "🥇",
          "🥈",
          "🥉",
        ];

        users.forEach((user, index) => {

          const name =
            `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
            "Unknown";

          const deposit =
            Number(user.totalDeposit || 0);

          const rank =
            medals[index] ||
            `${index + 1}️⃣`;

          rows.push([
            {
              text:
                `${rank} ${name} — ₹${formatAmount(deposit)}`,

              callback_data:
                `admin:users:view:${user.telegramId}`,
            },
          ]);
        });


        rows.push([
          {
            text: "⬅ Users Menu",
            callback_data: "admin:users",
          },
        ]);


        await editOrReply(
          ctx,
          "🏆 <b>TOP 10 DEPOSITORS</b>\n\nSelect a user:",
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard(rows),
          }
        );

      } catch (err) {
        logger.error(
          "Error in admin:users:top action",
          err
        );
      }
    }
  );


  // ==============================================================
  // SEARCH USER
  // ==============================================================

  bot.action(
    "admin:users:search",
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        session.set(
          ctx.from.id,
          {
            step: "admin_user_search",
            data: {},
          }
        );

        /*
         * This MUST be a new message because the admin needs
         * to type a search query.
         */
        await ctx.reply(
          "🔎 Enter the Telegram ID or username to search:",
          cancelKeyboard()
        );

      } catch (err) {
        logger.error(
          "Error in admin:users:search action",
          err
        );
      }
    }
  );


  // ==============================================================
  // VIEW USER
  // ==============================================================

  bot.action(
    /^admin:users:view:(.+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        const userId =
          ctx.match[1];

        const user =
          await db.getUser(userId);

        if (!user) {
          await editOrReply(
            ctx,
            "❌ <b>User not found.</b>",
            {
              parse_mode: "HTML",
              ...usersMenu(),
            }
          );

          return;
        }


        await editOrReply(
          ctx,
          userDetailText(user),
          {
            parse_mode: "HTML",
            ...userDetailKeyboard(user),
          }
        );

      } catch (err) {
        logger.error(
          "Error in admin:users:view action",
          err
        );
      }
    }
  );


  // ==============================================================
  // USER DEPOSIT HISTORY
  // ==============================================================

  bot.action(
    /^admin:users:deposits:(.+):(\d+)$/,
    async (ctx) => {

      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        const userId =
          ctx.match[1];

        const page =
          Math.max(
            1,
            Number(ctx.match[2]) || 1
          );

        const perPage = 10;

        const offset =
          (page - 1) * perPage;


        const user =
          await db.getUser(userId);

        if (!user) {
          await editOrReply(
            ctx,
            "❌ <b>User not found.</b>",
            {
              parse_mode: "HTML",
              ...usersMenu(),
            }
          );

          return;
        }


        const deposits =
          await db.listUserDeposits(
            userId,
            perPage + 1,
            offset
          );

        const hasNext =
          deposits.length > perPage;

        const pageDeposits =
          deposits.slice(0, perPage);


        const fullName =
          `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
          "Unknown";


        if (pageDeposits.length === 0) {

          await editOrReply(
            ctx,

            `📥 <b>DEPOSIT HISTORY</b>\n\n` +
            `👤 ${escapeHtml(fullName)}\n` +
            `🆔 <code>${escapeHtml(String(user.telegramId))}</code>\n\n` +
            `No deposits found.`,

            {
              parse_mode: "HTML",

              ...historyPagination(
                "deposits",
                userId,
                page,
                false
              ),
            }
          );

          return;
        }


        const statusIcon = {
          approved: "✅",
          rejected: "❌",
          pending: "⏳",
        };


        const lines =
          pageDeposits.map(
            (deposit, index) => {

              const number =
                offset + index + 1;

              const status =
                String(
                  deposit.status || "unknown"
                ).toLowerCase();


              return (
                `${number}. ` +
                `${statusIcon[status] || "❔"} ` +
                `<b>₹${formatAmount(deposit.amount)}</b>\n` +

                `   🔢 UTR: ` +
                `<code>${escapeHtml(
                  deposit.utr || "N/A"
                )}</code>\n` +

                `   📌 Status: ` +
                `${escapeHtml(
                  status.toUpperCase()
                )}\n` +

                `   📅 ` +
                `${formatDate(deposit.createdAt)}`
              );
            }
          );


        await editOrReply(
          ctx,

          `📥 <b>DEPOSIT HISTORY</b>\n\n` +
          `👤 ${escapeHtml(fullName)}\n` +
          `🆔 <code>${escapeHtml(String(user.telegramId))}</code>\n\n` +
          `${lines.join("\n\n")}\n\n` +
          `📄 Page ${page}`,

          {
            parse_mode: "HTML",

            ...historyPagination(
              "deposits",
              userId,
              page,
              hasNext
            ),
          }
        );

      } catch (err) {
        logger.error(
          "Error in admin:users:deposits action",
          err
        );
      }
    }
  );


  // ==============================================================
  // USER ORDER HISTORY
  // ==============================================================

  bot.action(
    /^admin:users:orders:(.+):(\d+)$/,
    async (ctx) => {

      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        const userId =
          ctx.match[1];

        const page =
          Math.max(
            1,
            Number(ctx.match[2]) || 1
          );

        const perPage = 10;

        const offset =
          (page - 1) * perPage;


        const user =
          await db.getUser(userId);

        if (!user) {
          await editOrReply(
            ctx,
            "❌ <b>User not found.</b>",
            {
              parse_mode: "HTML",
              ...usersMenu(),
            }
          );

          return;
        }


        const orders =
          await db.listUserOrders(
            userId,
            perPage + 1,
            offset
          );

        const hasNext =
          orders.length > perPage;

        const pageOrders =
          orders.slice(0, perPage);


        const fullName =
          `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
          "Unknown";


        if (pageOrders.length === 0) {

          await editOrReply(
            ctx,

            `🛒 <b>ORDER HISTORY</b>\n\n` +
            `👤 ${escapeHtml(fullName)}\n` +
            `🆔 <code>${escapeHtml(String(user.telegramId))}</code>\n\n` +
            `No orders found.`,

            {
              parse_mode: "HTML",

              ...historyPagination(
                "orders",
                userId,
                page,
                false
              ),
            }
          );

          return;
        }


        const statusIcon = {
          completed: "✅",
          processing: "⏳",
          cancelled: "❌",
        };


        const lines =
          pageOrders.map(
            (order, index) => {

              const number =
                offset + index + 1;

              const status =
                String(
                  order.status || "unknown"
                ).toLowerCase();


              return (
                `${number}. ` +
                `${statusIcon[status] || "❔"} ` +
                `<b>₹${formatAmount(order.amount)}</b>\n` +

                `   📦 ` +
                `${escapeHtml(
                  order.productName ||
                  "Unknown Product"
                )}\n` +

                `   🆔 <code>` +
                `${escapeHtml(
                  order.orderId || "N/A"
                )}</code>\n` +

                `   📌 Status: ` +
                `${escapeHtml(
                  status.toUpperCase()
                )}\n` +

                `   📅 ` +
                `${formatDate(order.createdAt)}`
              );
            }
          );


        await editOrReply(
          ctx,

          `🛒 <b>ORDER HISTORY</b>\n\n` +
          `👤 ${escapeHtml(fullName)}\n` +
          `🆔 <code>${escapeHtml(String(user.telegramId))}</code>\n\n` +
          `${lines.join("\n\n")}\n\n` +
          `📄 Page ${page}`,

          {
            parse_mode: "HTML",

            ...historyPagination(
              "orders",
              userId,
              page,
              hasNext
            ),
          }
        );

      } catch (err) {
        logger.error(
          "Error in admin:users:orders action",
          err
        );
      }
    }
  );


  // ==============================================================
  // ADD BALANCE
  // ==============================================================

  bot.action(
    /^admin:users:addbal:(.+)$/,
    async (ctx) => {

      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        session.set(
          ctx.from.id,
          {
            step: "admin_user_addbal",
            data: {
              targetId: ctx.match[1],
            },
          }
        );

        await ctx.reply(
          "💰 Enter the amount to ADD to this user's balance:",
          cancelKeyboard()
        );

      } catch (err) {
        logger.error(
          "Error in admin:users:addbal action",
          err
        );
      }
    }
  );


  // ==============================================================
  // REMOVE BALANCE
  // ==============================================================

  bot.action(
    /^admin:users:removebal:(.+)$/,
    async (ctx) => {

      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        session.set(
          ctx.from.id,
          {
            step: "admin_user_removebal",
            data: {
              targetId: ctx.match[1],
            },
          }
        );

        await ctx.reply(
          "💸 Enter the amount to REMOVE from this user's balance:",
          cancelKeyboard()
        );

      } catch (err) {
        logger.error(
          "Error in admin:users:removebal action",
          err
        );
      }
    }
  );


  // ==============================================================
  // REFERRAL RATE OVERRIDE
  // ==============================================================

  bot.action(
    /^admin:users:referral:(.+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        const userId = String(ctx.match[1] || "").trim();
        const user = await db.getUser(userId);

        if (!user) {
          await editOrReply(
            ctx,
            "❌ User not found.",
            {
              ...usersMenu(),
            }
          );
          return;
        }

        const override = user.referralRateOverride;

        const currentRate =
          override !== null &&
          override !== undefined &&
          override !== ""
            ? `${Number(override).toFixed(2)}% (Admin Override)`
            : "Global Rate";

        session.set(ctx.from.id, {
          step: "admin_user_referralRate",
          data: {
            userId,
          },
        });

        await ctx.reply(
          `👥 <b>Referral Rate</b>\n\n` +
          `👤 <b>User:</b> <code>${userId}</code>\n` +
          `📊 <b>Current:</b> ${currentRate}\n\n` +
          `Enter a referral percentage from <code>0</code> to <code>100</code>.\n\n` +
          `To remove the individual override and use the global rate, enter <code>global</code>.`,
          {
            parse_mode: "HTML",
            ...cancelKeyboard(),
          }
        );
      } catch (err) {
        logger.error(
          "Error in admin:users:referral action",
          err
        );
      }
    }
  );

  // ==============================================================
  // BAN USER
  // ==============================================================

  bot.action(
    /^admin:users:ban:(.+)$/,
    async (ctx) => {

      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        const userId =
          ctx.match[1];

        await db.updateUser(
          userId,
          {
            banned: true,
          }
        );

        const user =
          await db.getUser(userId);

        if (!user) {
          await editOrReply(
            ctx,
            "❌ User not found.",
            {
              ...usersMenu(),
            }
          );

          return;
        }


        await editOrReply(
          ctx,
          `🚫 <b>User banned successfully.</b>\n\n` +
          userDetailText(user),
          {
            parse_mode: "HTML",
            ...userDetailKeyboard(user),
          }
        );

      } catch (err) {
        logger.error(
          "Error in admin:users:ban action",
          err
        );
      }
    }
  );


  // ==============================================================
  // UNBAN USER
  // ==============================================================

  bot.action(
    /^admin:users:unban:(.+)$/,
    async (ctx) => {

      try {
        await ctx.answerCbQuery().catch(() => {});

        if (!(await requireAdmin(ctx))) return;

        const userId =
          ctx.match[1];

        await db.updateUser(
          userId,
          {
            banned: false,
          }
        );

        const user =
          await db.getUser(userId);

        if (!user) {
          await editOrReply(
            ctx,
            "❌ User not found.",
            {
              ...usersMenu(),
            }
          );

          return;
        }


        await editOrReply(
          ctx,
          `✅ <b>User unbanned successfully.</b>\n\n` +
          userDetailText(user),
          {
            parse_mode: "HTML",
            ...userDetailKeyboard(user),
          }
        );

      } catch (err) {
        logger.error(
          "Error in admin:users:unban action",
          err
        );
      }
    }
  );


  // ==============================================================
  // TEXT STEPS
  // ==============================================================

  const textSteps = {

    // ============================================================
    // REFERRAL RATE OVERRIDE
    // ============================================================

    admin_user_referralRate: async (ctx, state) => {
      const raw = String(ctx.message.text || "").trim();
      const userId = String(state?.data?.userId || "").trim();

      if (!userId) {
        session.clear(ctx.from.id);
        await ctx.reply("❌ User session expired.");
        return;
      }

      if (raw.toLowerCase() === "global") {
        await db.updateUser(userId, {
          referralRateOverride: null,
          referralRateOverrideSetAt: null,
        });

        session.clear(ctx.from.id);

        await ctx.reply(
          `✅ Individual referral rate removed.\n\n` +
          `User <code>${userId}</code> will now use the global referral rate for new referrals.`,
          {
            parse_mode: "HTML",
          }
        );

        return;
      }

      const value = Number(raw);

      if (
        !Number.isFinite(value) ||
        value < 0 ||
        value > 100
      ) {
        await ctx.reply(
          "❌ Invalid referral percentage.\n\n" +
          "Enter a value between 0 and 100.\n\n" +
          "Example: <code>20</code>\n" +
          "Or enter <code>global</code> to remove the override.",
          {
            parse_mode: "HTML",
            ...cancelKeyboard(),
          }
        );
        return;
      }

      const referralRateOverride =
        Number(value.toFixed(2));

      await db.updateUser(userId, {
        referralRateOverride,
        referralRateOverrideSetAt: new Date(),
      });

      session.clear(ctx.from.id);

      await ctx.reply(
        `✅ Referral rate override set to <b>${referralRateOverride.toFixed(2)}%</b>.\n\n` +
        `👤 User: <code>${userId}</code>\n` +
        `This rate will apply to new users referred by this user.`,
        {
          parse_mode: "HTML",
        }
      );
    },



    // ============================================================
    // SEARCH
    // ============================================================

    admin_user_search: async (ctx, state) => {

      const query =
        String(ctx.message.text || "").trim();

      if (!query) {
        await ctx.reply(
          "❌ Please enter a Telegram ID or username.",
          cancelKeyboard()
        );

        return;
      }


      const results =
        await db.searchUsers(query);

      session.clear(ctx.from.id);


      if (results.length === 0) {

        await ctx.reply(
          "❌ No matching users found.",
          usersMenu()
        );

        return;
      }


      // One result
      if (results.length === 1) {

        await ctx.reply(
          userDetailText(results[0]),
          {
            parse_mode: "HTML",
            ...userDetailKeyboard(results[0]),
          }
        );

        return;
      }


      // Multiple results
      const rows =
        results.map((user) => {

          const name =
            `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
            "Unknown";

          return [
            {
              text:
                `👤 ${name} — 🆔 ${user.telegramId}`,

              callback_data:
                `admin:users:view:${user.telegramId}`,
            },
          ];
        });


      rows.push([
        {
          text: "⬅ Users Menu",
          callback_data: "admin:users",
        },
      ]);


      await ctx.reply(
        `🔎 <b>SEARCH RESULTS</b>\n\n` +
        `Found ${results.length} users:`,

        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard(rows),
        }
      );
    },


    // ============================================================
    // ADD BALANCE TEXT STEP
    // ============================================================

    admin_user_addbal: async (ctx, state) => {

      const amount =
        parseAmount(
          ctx.message.text,
          {
            min: 0.01,
          }
        );

      if (amount === null) {

        await ctx.reply(
          "❌ Invalid amount.",
          cancelKeyboard()
        );

        return;
      }


      const targetId =
        state.data.targetId;


      await db.addBalance(
        targetId,
        amount,
        {
          type: "admin_credit",
          note: "Manual credit by admin",
          relatedId: null,
        }
      );


      session.clear(ctx.from.id);


      const user =
        await db.getUser(targetId);


      if (!user) {
        await ctx.reply(
          "❌ User not found.",
          usersMenu()
        );

        return;
      }


      await ctx.reply(
        `✅ <b>Balance Added</b>\n\n` +
        `Amount: ₹${formatAmount(amount)}\n` +
        `New Balance: ₹${formatAmount(user.balance)}`,

        {
          parse_mode: "HTML",
          ...userDetailKeyboard(user),
        }
      );


      await ctx.telegram
        .sendMessage(
          targetId,
          `💰 Your balance was credited by ₹${formatAmount(amount)} by an admin.`
        )
        .catch(() => {});
    },


    // ============================================================
    // REMOVE BALANCE TEXT STEP
    // ============================================================

    admin_user_removebal: async (ctx, state) => {

      const amount =
        parseAmount(
          ctx.message.text,
          {
            min: 0.01,
          }
        );

      if (amount === null) {

        await ctx.reply(
          "❌ Invalid amount.",
          cancelKeyboard()
        );

        return;
      }


      const targetId =
        state.data.targetId;


      try {

        await db.removeBalance(
          targetId,
          amount,
          {
            type: "admin_debit",
            note: "Manual debit by admin",
            relatedId: null,
          }
        );

      } catch (err) {

        if (
          err.code === "INSUFFICIENT_BALANCE"
        ) {

          await ctx.reply(
            "❌ User doesn't have enough balance for this deduction.",
            cancelKeyboard()
          );

          return;
        }

        throw err;
      }


      session.clear(ctx.from.id);


      const user =
        await db.getUser(targetId);


      if (!user) {
        await ctx.reply(
          "❌ User not found.",
          usersMenu()
        );

        return;
      }


      await ctx.reply(
        `✅ <b>Balance Removed</b>\n\n` +
        `Amount: ₹${formatAmount(amount)}\n` +
        `New Balance: ₹${formatAmount(user.balance)}`,

        {
          parse_mode: "HTML",
          ...userDetailKeyboard(user),
        }
      );


      await ctx.telegram
        .sendMessage(
          targetId,
          `⚠️ ₹${formatAmount(amount)} was deducted from your balance by an admin.`
        )
        .catch(() => {});
    },
  };


  return {
    textSteps,
  };
}


// ================================================================
// EXPORT
// ================================================================

module.exports = {
  registerAdminUsersHandler,
};
