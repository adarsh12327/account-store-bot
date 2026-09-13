/**
 * handlers/adminSettings.js
 * ------------------------------------------------------------------
 * ⚙️ Admin Settings
 *
 * Editable settings:
 * - Force-Join Channel
 * - Support Username
 * - Minimum Deposit
 * - UPI ID
 * - Payment QR
 * - Sales Channel
 * - Maintenance Mode
 *
 * UPI ID save karne ke baad bot QR photo maangega.
 * ------------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");
const session = require("../utils/session");

const { requireAdmin } = require("./admin");
const { parseText, parseAmount } = require("../utils/validation");
const { escapeHtml, formatAmount } = require("../utils/helpers");

const {
  settingsMenu,
  cancelKeyboard,
} = require("../keyboards/admin");


// ================================================================
// SHOW SETTINGS
// ================================================================

async function showSettings(ctx, edit = false) {
  const s = await db.getSettings();

  const text =
    `⚙ <b>Settings</b>\n\n` +
    `📢 Force-Join: ${escapeHtml(s.forceChannel || "Not set")}\n` +
`📢 Sales Channel: ${escapeHtml(s.salesChannel || "Not set")}\n` +
    `🆘 Support: ${escapeHtml(s.supportUsername || "Not set")}\n` +
    `💵 Minimum Deposit: ₹${formatAmount(s.minimumDeposit)}\n` +
    `🏦 UPI ID: ${escapeHtml(s.upiId || "Not set")}\n` +
    `📲 Payment QR: ${s.paymentQrFileId ? "Set ✅" : "Not set ❌"}\n` +
    `⏳ Server 1 OTP Wait: ${Number(s.server1OtpWaitMinutes || 20)} min\n` +
    `🛠️ Maintenance: ${s.maintenance ? "ON" : "OFF"}`;

  // Button se Settings open hui hai
  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        ...settingsMenu(s),
      });

      return;
    } catch (err) {
      const message = String(err.message || "").toLowerCase();
      if (!message.includes("message is not modified")) {
        logger.error("Failed to edit settings message", err);
      }

      // Message edit fail hua to duplicate message mat bhejo.
      return;
    }
  }

  await ctx.reply(text, {
    parse_mode: "HTML",
    ...settingsMenu(s),
  });
}


// ================================================================
// REGISTER HANDLER
// ================================================================

function registerAdminSettingsHandler(bot) {

  // ==============================================================
  // SETTINGS MENU
  // ==============================================================

  bot.action("admin:settings", async (ctx) => {
    try {

      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      // IMPORTANT:
      // Button se aaye hain, isliye same message edit hoga.
      await showSettings(ctx, true);

    } catch (err) {

      logger.error(
        "Error in admin:settings action",
        err
      );
    }
  });



  // ==============================================================
  // PRODUCT PRICING
  // ==============================================================

  bot.action("admin:settings:productPricing", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      const s = await db.getSettings();

      await ctx.editMessageText(
        "💰 <b>Product Pricing</b>\n\n" +
        `💱 USD Rate: <b>₹${Number(s.productUsdRate || 105).toFixed(2)}</b>\n` +
        `📈 Profit Margin: <b>${Number(s.productMarginPercent || 30).toFixed(2)}%</b>\n\n` +
        "These values are used for automatic product pricing.",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "💱 Change USD Rate",
                  callback_data: "admin:settings:productPricing:usd",
                },
              ],
              [
                {
                  text: "📈 Change Margin",
                  callback_data: "admin:settings:productPricing:margin",
                },
              ],
              [
                {
                  text: "⬅️ Settings",
                  callback_data: "admin:settings",
                },
              ],
            ],
          },
        }
      );

    } catch (err) {
      logger.error("Error in product pricing settings", err);
    }
  });


  bot.action("admin:settings:productPricing:usd", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, {
        step: "admin_settings_productUsdRate",
        data: {},
      });

      await ctx.reply(
        "💱 <b>USD Rate</b>\n\nEnter USD → INR rate.\nExample: <code>105</code>",
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );

    } catch (err) {
      logger.error("Error changing USD rate", err);
    }
  });


  bot.action("admin:settings:productPricing:margin", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, {
        step: "admin_settings_productMarginPercent",
        data: {},
      });

      await ctx.reply(
        "📈 <b>Profit Margin</b>\n\nEnter margin percentage.\nExample: <code>30</code>",
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );

    } catch (err) {
      logger.error("Error changing product margin", err);
    }
  });


  // ==============================================================
  // REFERRAL COMMISSION
  // ==============================================================

  bot.action("admin:settings:referralStats", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      const stats = await db.getReferralAdminStats();

      let topReferrersText = "";

      if (
        Array.isArray(stats.topReferrers) &&
        stats.topReferrers.length > 0
      ) {
        topReferrersText =
          "\n🏆 <b>Top Referrers</b>\n\n" +
          stats.topReferrers
            .map(
              (item, index) =>
                `${index + 1}. <code>${String(item.userId)}</code> — ` +
                `₹${Number(item.earnings || 0).toFixed(2)} ` +
                `(${Number(item.commissions || 0)} commissions)`
            )
            .join("\n");
      } else {
        topReferrersText =
          "\n🏆 <b>Top Referrers</b>\n\n" +
          "No referral commissions yet.";
      }

      const text =
        "📊 <b>Referral Statistics</b>\n\n" +
        `👥 <b>Total Referred Users:</b> ${Number(
          stats.totalReferredUsers || 0
        )}\n` +
        `💰 <b>Total Referral Earnings:</b> ₹${Number(
          stats.totalReferralEarnings || 0
        ).toFixed(2)}\n` +
        `📅 <b>Today's Referral Earnings:</b> ₹${Number(
          stats.todayReferralEarnings || 0
        ).toFixed(2)}\n` +
        topReferrersText;

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🔄 Refresh",
                callback_data: "admin:settings:referralStats",
              },
            ],
            [
              {
                text: "⬅️ Settings",
                callback_data: "admin:settings",
              },
            ],
          ],
        },
      });
    } catch (err) {
      logger.error(
        "Error showing referral statistics",
        err
      );
    }
  });

  bot.action("admin:settings:referral", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      const s = await db.getSettings();
      const rate = Number(s.referralPercent ?? 10);

      await ctx.editMessageText(
        "👥 <b>Referral Commission</b>\n\n" +
        `🌐 <b>Global Rate:</b> ${rate.toFixed(2)}%\n\n` +
        "This rate is saved as a snapshot when a new user registers through a referral link.\n\n" +
        "⚠️ Changing the global rate will <b>not</b> change the rate of existing referred users.\n\n" +
        "Individual user rates can be overridden separately by admin.",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✏️ Change Global Rate",
                  callback_data: "admin:settings:referral:change",
                },
              ],
              [
                {
                  text: "⬅️ Settings",
                  callback_data: "admin:settings",
                },
              ],
            ],
          },
        }
      );
    } catch (err) {
      logger.error(
        "Error showing referral commission settings",
        err
      );
    }
  });

  bot.action("admin:settings:referral:change", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, {
        step: "admin_settings_referralPercent",
        data: {},
      });

      await ctx.reply(
        "👥 <b>Global Referral Commission</b>\n\n" +
        "Enter the commission percentage.\n\n" +
        "Example: <code>10</code>\n" +
        "Allowed: <code>0</code> to <code>100</code>",
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );
    } catch (err) {
      logger.error(
        "Error changing referral commission settings",
        err
      );
    }
  });

  // ==============================================================
  // FORCE JOIN CHANNEL
  // ==============================================================

  bot.action("admin:settings:forceChannel", async (ctx) => {
    try {

      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, {
        step: "admin_settings_forceChannel",
        data: {},
      });

      await ctx.reply(
        "📢 Enter the channel username (e.g. @mychannel), or type <b>off</b> to disable:",
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );

    } catch (err) {

      logger.error(
        "Error in admin:settings:forceChannel action",
        err
      );
    }
  });


  // ==============================================================
  // SALES CHANNEL
  // ==============================================================

  bot.action("admin:settings:salesChannel", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, {
        step: "admin_settings_salesChannel",
        data: {},
      });

      await ctx.reply(
        "📢 <b>Sales Channel</b>\n\n" +
        "Send your Telegram channel link.\n\n" +
        "Example:\n<code>https://t.me/yourchannel</code>\n\n" +
        "Type <code>off</code> to disable.",
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );
    } catch (err) {
      logger.error("Error in Sales Channel settings", err);
    }
  });


  // ==============================================================
  // SUPPORT USERNAME
  // ==============================================================

  bot.action("admin:settings:supportUsername", async (ctx) => {
    try {

      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, {
        step: "admin_settings_supportUsername",
        data: {},
      });

      await ctx.reply(
        "🆘 Enter the support username (without @):",
        cancelKeyboard()
      );

    } catch (err) {

      logger.error(
        "Error in admin:settings:supportUsername action",
        err
      );
    }
  });


  // ==============================================================
  // MINIMUM DEPOSIT
  // ==============================================================

  bot.action("admin:settings:minimumDeposit", async (ctx) => {
    try {

      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, {
        step: "admin_settings_minimumDeposit",
        data: {},
      });

      await ctx.reply(
        "💵 Enter the new minimum deposit amount (₹):",
        cancelKeyboard()
      );

    } catch (err) {

      logger.error(
        "Error in admin:settings:minimumDeposit action",
        err
      );
    }
  });


  // ==============================================================
  // UPI ID
  // ==============================================================

  bot.action("admin:settings:upiId", async (ctx) => {
    try {

      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, {
        step: "admin_settings_upiId",
        data: {},
      });

      await ctx.reply(
        "🏦 Enter the UPI ID:",
        cancelKeyboard()
      );

    } catch (err) {

      logger.error(
        "Error in admin:settings:upiId action",
        err
      );
    }
  });


  // ==============================================================
  // SERVER ENABLE / DISABLE

  bot.action("admin:settings:toggleServer1", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      const settings = await db.getSettings();
      const newValue = settings.server1Enabled !== true;

      await db.updateSettings({
        server1Enabled: newValue,
      });

      const updated = await db.getSettings();

      const text =
        `⚙ <b>Settings</b>\n\n` +
        `📢 Force-Join: ${escapeHtml(updated.forceChannel || "Not set")}\n` +
        `🆘 Support: ${escapeHtml(updated.supportUsername || "Not set")}\n` +
        `📢 Sales Channel: ${escapeHtml(updated.salesChannel || "Not set")}\n` +
        `💵 Minimum Deposit: ₹${formatAmount(updated.minimumDeposit)}\n` +
        `🏦 UPI ID: ${escapeHtml(updated.upiId || "Not set")}\n` +
        `📲 Payment QR: ${updated.paymentQrFileId ? "Set ✅" : "Not set ❌"}\n` +
        `⏳ Server 1 OTP Wait: ${Number(updated.server1OtpWaitMinutes || 20)} min\n` +
        `🖥️ Server 1: ${updated.server1Enabled !== false ? "🟢 ENABLED" : "🔴 DISABLED"}\n` +
        `🖥️ Server 2: ${updated.server2Enabled !== false ? "🟢 ENABLED" : "🔴 DISABLED"}\n` +
        `🛠️ Maintenance: ${updated.maintenance ? "ON" : "OFF"}`;

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        ...settingsMenu(s),
      }).catch((err) => {
        const msg = String(err.message || "").toLowerCase();
        if (!msg.includes("message is not modified")) {
          logger.error("Server 1 settings edit error", err);
        }
      });

    } catch (err) {
      logger.error("Error toggling Server 1", err);
    }
  });

  bot.action("admin:settings:toggleServer2", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      const settings = await db.getSettings();
      const newValue = settings.server2Enabled !== true;

      await db.updateSettings({
        server2Enabled: newValue,
      });

      const updated = await db.getSettings();

      const text =
        `⚙ <b>Settings</b>\n\n` +
        `📢 Force-Join: ${escapeHtml(updated.forceChannel || "Not set")}\n` +
        `🆘 Support: ${escapeHtml(updated.supportUsername || "Not set")}\n` +
        `📢 Sales Channel: ${escapeHtml(updated.salesChannel || "Not set")}\n` +
        `💵 Minimum Deposit: ₹${formatAmount(updated.minimumDeposit)}\n` +
        `🏦 UPI ID: ${escapeHtml(updated.upiId || "Not set")}\n` +
        `📲 Payment QR: ${updated.paymentQrFileId ? "Set ✅" : "Not set ❌"}\n` +
        `⏳ Server 1 OTP Wait: ${Number(updated.server1OtpWaitMinutes || 20)} min\n` +
        `🖥️ Server 1: ${updated.server1Enabled !== false ? "🟢 ENABLED" : "🔴 DISABLED"}\n` +
        `🖥️ Server 2: ${updated.server2Enabled !== false ? "🟢 ENABLED" : "🔴 DISABLED"}\n` +
        `🛠️ Maintenance: ${updated.maintenance ? "ON" : "OFF"}`;

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        ...settingsMenu(s),
      }).catch((err) => {
        const msg = String(err.message || "").toLowerCase();
        if (!msg.includes("message is not modified")) {
          logger.error("Server 2 settings edit error", err);
        }
      });

    } catch (err) {
      logger.error("Error toggling Server 2", err);
    }
  });

  // MAINTENANCE
  // ==============================================================

  // ==============================================================
  // SERVER 1 OTP WAIT TIME
  // ==============================================================
  bot.action("admin:settings:server1OtpWait", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      const s = await db.getSettings();
      const minutes = Number(s.server1OtpWaitMinutes || 20);

      await ctx.editMessageText(
        "⏳ <b>Server 1 OTP Wait Time</b>\n\n" +
        `Current time: <b>${minutes} minutes</b>\n\n` +
        "Set how long a purchased number should wait for OTP.",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✏️ Change Time",
                  callback_data: "admin:settings:server1OtpWait:change",
                },
              ],
              [
                {
                  text: "⬅️ Settings",
                  callback_data: "admin:settings",
                },
              ],
            ],
          },
        }
      );
    } catch (err) {
      logger.error(
        "Error showing Server 1 OTP wait time",
        err
      );
    }
  });

  bot.action("admin:settings:server1OtpWait:change", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, {
        step: "admin_settings_server1OtpWait",
        data: {},
      });

      await ctx.reply(
        "⏳ <b>Server 1 OTP Wait Time</b>\n\n" +
        "Enter time in minutes.\n\n" +
        "Example: <code>20</code>\n" +
        "Minimum: <code>1</code> minute",
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );
    } catch (err) {
      logger.error(
        "Error changing Server 1 OTP wait time",
        err
      );
    }
  });

  bot.action("admin:settings:toggleMaintenance", async (ctx) => {
    try {

      if (!(await requireAdmin(ctx))) return;

      const s = await db.getSettings();

      const newValue = !s.maintenance;

      await db.updateSettings({
        maintenance: newValue,
      });

      await ctx.answerCbQuery(
        `Maintenance mode ${newValue ? "enabled" : "disabled"}`
      ).catch(() => {});

      // Same Settings message update hoga.
      await showSettings(ctx, true);

    } catch (err) {

      logger.error(
        "Error in admin:settings:toggleMaintenance action",
        err
      );

      await ctx.answerCbQuery(
        "Something went wrong.",
        { show_alert: true }
      ).catch(() => {});
    }
  });


  // ==============================================================
  // QR PHOTO
  // ==============================================================
  //
  // UPI ID save karne ke baad session:
  //
  // admin_settings_upiQr
  //
  // Phir admin QR photo bhejega.
  // ==============================================================

  bot.on("photo", async (ctx, next) => {

    const telegramId = ctx.from.id;

    const state = session.get(telegramId);

    // QR update flow nahi hai
    if (
      !state ||
      state.step !== "admin_settings_upiQr"
    ) {
      return next();
    }

    try {

      if (!(await requireAdmin(ctx))) {
        return;
      }

      const photos = ctx.message.photo;

      if (!photos || photos.length === 0) {

        await ctx.reply(
          "❌ QR photo nahi mili.\n\nPlease payment QR code ki photo bhejo.",
          cancelKeyboard()
        );

        return;
      }


      // Telegram ka largest photo
      const largestPhoto =
        photos[photos.length - 1];


      const paymentQrFileId =
        largestPhoto.file_id;


      // Save QR
      await db.updateSettings({
        paymentQrFileId,
      });


      // Session clear
      session.clear(telegramId);


      await ctx.reply(
        "✅ Payment QR successfully updated."
      );


      // Photo message ke context mein callbackQuery nahi hota,
      // isliye yahan new Settings message expected hai.
      await showSettings(ctx, true);

    } catch (err) {

      logger.error(
        "Error updating payment QR",
        err
      );

      await ctx.reply(
        "❌ QR update nahi ho paya.\n\nPlease dobara try karo."
      );
    }
  });


  // ==============================================================
  // TEXT STEPS
  // ==============================================================

  const textSteps = {

    admin_settings_server1OtpWait: async (ctx, state) => {
      const raw = String(ctx.message.text || "").trim();
      const minutes = Number(raw);

      if (
        !Number.isInteger(minutes) ||
        minutes < 1 ||
        minutes > 1440
      ) {
        await ctx.reply(
          "❌ Invalid time.\n\n" +
          "Enter a whole number between 1 and 1440 minutes.\n\n" +
          "Example: <code>20</code>",
          {
            parse_mode: "HTML",
            ...cancelKeyboard(),
          }
        );
        return;
      }

      await db.updateSettings({
        server1OtpWaitMinutes: minutes,
      });

      session.clear(ctx.from.id);

      await ctx.reply(
        `✅ Server 1 OTP wait time updated to <b>${minutes} minutes</b>.`,
        {
          parse_mode: "HTML",
        }
      );

      await showSettings(ctx, true);
    },


    admin_settings_productUsdRate: async (ctx, state) => {
      const raw = String(ctx.message.text || "").trim();
      const value = Number(raw);

      if (!Number.isFinite(value) || value <= 0 || value > 100000) {
        await ctx.reply(
          "❌ Invalid USD rate. Example: 105",
          cancelKeyboard()
        );
        return;
      }

      await db.updateSettings({
        usdRate: Number(value.toFixed(4)),
      });

      session.clear(ctx.from.id);

      const settings = await db.getSettings();

      await ctx.reply(
        `✅ USD rate updated to ₹${Number(settings.usdRate).toFixed(2)}`,
        settingsMenu()
      );
    },

    admin_settings_productMarginPercent: async (ctx, state) => {
      const raw = String(ctx.message.text || "").trim();
      const value = Number(raw);

      if (!Number.isFinite(value) || value < 0 || value > 1000) {
        await ctx.reply(
          "❌ Invalid margin. Enter a percentage between 0 and 1000.",
          cancelKeyboard()
        );
        return;
      }

      await db.updateSettings({
        profit: Number(value.toFixed(4)),
      });

      session.clear(ctx.from.id);

      const settings = await db.getSettings();

      await ctx.reply(
        `✅ Profit margin updated to ${Number(settings.profit).toFixed(2)}%`,
        settingsMenu()
      );
    },



    // ------------------------------------------------------------
    // REFERRAL COMMISSION
    // ------------------------------------------------------------

    admin_settings_referralPercent: async (ctx, state) => {
      const raw = String(ctx.message.text || "").trim();
      const value = Number(raw);

      if (
        !Number.isFinite(value) ||
        value < 0 ||
        value > 100
      ) {
        await ctx.reply(
          "❌ Invalid referral percentage.\\n\\n" +
          "Enter a value between 0 and 100.\\n\\n" +
          "Example: <code>10</code>",
          {
            parse_mode: "HTML",
            ...cancelKeyboard(),
          }
        );
        return;
      }

      const referralPercent = Number(value.toFixed(2));

      await db.updateSettings({
        referralPercent,
      });

      session.clear(ctx.from.id);

      await ctx.reply(
        `✅ Global referral commission updated to <b>${referralPercent.toFixed(2)}%</b>.\n\n` +
        `⚠️ Existing referred users keep their saved referral rate.`,
        {
          parse_mode: "HTML",
        }
      );

      await showSettings(ctx, true);
    },

    // ------------------------------------------------------------
    // SALES CHANNEL
    // ------------------------------------------------------------

    admin_settings_salesChannel: async (ctx, state) => {
      const raw = String(ctx.message.text || "").trim();

      if (raw.toLowerCase() === "off") {
        await db.updateSettings({
          salesChannel: "",
        });

        session.clear(ctx.from.id);

        await ctx.reply("✅ Sales channel disabled.");
        await showSettings(ctx, true);
        return;
      }

      if (!/^https?:\/\/(t\.me|telegram\.me)\//i.test(raw)) {
        await ctx.reply(
          "❌ Invalid Telegram channel link.\n\n" +
          "Example:\n<code>https://t.me/yourchannel</code>",
          {
            parse_mode: "HTML",
            ...cancelKeyboard(),
          }
        );
        return;
      }

      await db.updateSettings({
        salesChannel: raw,
      });

      session.clear(ctx.from.id);

      await ctx.reply(
        "✅ <b>Sales channel updated successfully.</b>",
        {
          parse_mode: "HTML",
        }
      );

      await showSettings(ctx, true);
    },


    // ------------------------------------------------------------
    // FORCE CHANNEL
    // ------------------------------------------------------------

    admin_settings_forceChannel: async (ctx, state) => {

      const raw =
        String(ctx.message.text || "").trim();

      const value =
        raw.toLowerCase() === "off"
          ? ""
          : raw;

      await db.updateSettings({
        forceChannel: value,
      });

      session.clear(ctx.from.id);

      await ctx.reply(
        "✅ Force-join channel updated."
      );

      await showSettings(ctx, true);
    },


    // ------------------------------------------------------------
    // SUPPORT USERNAME
    // ------------------------------------------------------------

    admin_settings_supportUsername: async (ctx, state) => {

      const value =
        parseText(
          String(ctx.message.text || "").replace(/^@/, ""),
          {
            minLen: 1,
            maxLen: 50,
          }
        );

      if (value === null) {

        await ctx.reply(
          "❌ Invalid username.",
          cancelKeyboard()
        );

        return;
      }

      await db.updateSettings({
        supportUsername: value,
      });

      session.clear(ctx.from.id);

      await ctx.reply(
        "✅ Support username updated."
      );

      await showSettings(ctx, true);
    },


    // ------------------------------------------------------------
    // MINIMUM DEPOSIT
    // ------------------------------------------------------------

    admin_settings_minimumDeposit: async (ctx, state) => {

      const amount =
        parseAmount(
          ctx.message.text,
          {
            min: 1,
          }
        );

      if (amount === null) {

        await ctx.reply(
          "❌ Invalid amount.",
          cancelKeyboard()
        );

        return;
      }

      await db.updateSettings({
        minimumDeposit: amount,
      });

      session.clear(ctx.from.id);

      await ctx.reply(
        "✅ Minimum deposit updated."
      );

      await showSettings(ctx, true);
    },


    // ------------------------------------------------------------
    // UPI ID
    // ------------------------------------------------------------

    admin_settings_upiId: async (ctx, state) => {

      const value =
        parseText(
          ctx.message.text,
          {
            minLen: 3,
            maxLen: 100,
          }
        );

      if (value === null) {

        await ctx.reply(
          "❌ Invalid UPI ID.",
          cancelKeyboard()
        );

        return;
      }


      // ----------------------------------------------------------
      // Save UPI ID
      // ----------------------------------------------------------

      await db.updateSettings({
        upiId: value,
      });


      // ----------------------------------------------------------
      // Now ask for QR
      // ----------------------------------------------------------

      session.set(ctx.from.id, {
        step: "admin_settings_upiQr",
        data: {},
      });


      await ctx.reply(
        `✅ UPI ID saved: <code>${escapeHtml(value)}</code>\n\n` +
        `📸 Now send your payment QR code photo.`,
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );
    },
  };


  // Return text steps
  return {
    textSteps,
  };
}


// ================================================================
// EXPORT
// ================================================================

module.exports = {
  registerAdminSettingsHandler,
};
