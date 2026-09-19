/**
 * handlers/referral.js
 * ------------------------------------------------------------
 * 👥 Referral / Refer & Earn
 * ------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");
const { escapeHtml, formatAmount } = require("../utils/helpers");

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

function getEffectiveOutboundRate(user, settings) {
  const override = user?.referralRateOverride;

  if (
    override !== null &&
    override !== undefined &&
    override !== ""
  ) {
    const value = Number(override);
    if (Number.isFinite(value) && value >= 0 && value <= 100) {
      return Number(value.toFixed(2));
    }
  }

  const globalRate = Number(settings?.referralPercent ?? 10);

  if (
    !Number.isFinite(globalRate) ||
    globalRate < 0 ||
    globalRate > 100
  ) {
    return 0;
  }

  return Number(globalRate.toFixed(2));
}

function registerReferralHandler(bot) {
  // ==========================================================
  // REFER & EARN
  // ==========================================================
  bot.action("menu_referral", async (ctx) => {
    try {
      await ctx.answerCbQuery();

      const user = await db.getUser(ctx.from.id);

      if (!user) {
        await editScreen(
          ctx,
          "⚠️ <b>User account not found.</b>\n\nPlease use /start again."
        );
        return;
      }

      let settings = {};
      try {
        settings = await db.getSettings();
      } catch (settingsErr) {
        logger.warn(
          `Referral settings read failed | user=${ctx.from?.id || "unknown"}`
        );
      }

      // Resolve the bot username from the most reliable available source.
      // Do not make Refer & Earn depend on the optional Firestore setting.
      const FALLBACK_BOT_USERNAME = "account_stores_bot";

      let botUsername = String(
        settings?.botUsername ||
        ctx.botInfo?.username ||
        ctx.telegram?.botInfo?.username ||
        ""
      )
        .replace(/^@/, "")
        .trim();

      if (!botUsername) {
        try {
          const botInfo = await bot.telegram.getMe();
          botUsername = String(botInfo?.username || "")
            .replace(/^@/, "")
            .trim();
        } catch (usernameErr) {
          logger.error(
            `Unable to resolve bot username | user=${ctx.from?.id || "unknown"}`,
            usernameErr
          );
        }
      }

      if (!botUsername) {
        botUsername = FALLBACK_BOT_USERNAME;
      }

      const referralLink =
        `https://t.me/${botUsername}?start=${encodeURIComponent(String(ctx.from.id))}`;

      // IMPORTANT: referralRate is the rate this user received from
      // their own referrer. It is NOT the rate they earn from new
      // users they refer. Use the outbound override/global rate here.
      const rate = getEffectiveOutboundRate(user, settings);

      let referredUsers = 0;
      let referralEarnings = 0;

      try {
        const referralStats = await db.getReferralStats(ctx.from.id);
        referredUsers = Number(referralStats?.referredUsers || 0);
        referralEarnings = Number(referralStats?.referralEarnings || 0);
      } catch (statsErr) {
        // The referral page must still open even if a statistics query
        // temporarily fails. Link generation is independent of stats.
        logger.error(
          `Referral stats read failed | user=${ctx.from?.id || "unknown"}`,
          statsErr
        );
      }

      const text =
        `👥 <b>Refer & Earn</b>\n\n` +
        `🎁 Earn <b>${rate}%</b> commission on deposits made by users you refer.\n\n` +
        `👤 <b>Referred Users:</b> ${referredUsers}\n` +
        `💰 <b>Referral Earnings:</b> ₹${formatAmount(referralEarnings)}\n\n` +
        `🔗 <b>Your Referral Link:</b>\n` +
        `<code>${escapeHtml(referralLink)}</code>\n\n` +
        `👤 <b>Your Referrer:</b> ` +
        `${user.referrerId ? "Already assigned" : "None"}\n\n` +
        `Share your link with your friends to invite them.`;

      await editScreen(ctx, text, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "📤 Share Referral Link",
                url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}`,
              },
            ],
            [
              {
                text: "🏠 Main Menu",
                callback_data: "menu_home",
              },
            ],
          ],
        },
      });
    } catch (err) {
      logger.error(
        `Error in menu_referral action | user=${ctx.from?.id || "unknown"}`,
        err
      );

      await ctx
        .answerCbQuery("Something went wrong.", { show_alert: true })
        .catch(() => {});
    }
  });
}

module.exports = {
  registerReferralHandler,
};
