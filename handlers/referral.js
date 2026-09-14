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

      const settings = await db.getSettings();

      const botUsername =
        String(settings.botUsername || "")
          .replace(/^@/, "")
          .trim();

      if (!botUsername) {
        await editScreen(
          ctx,
          "⚠️ <b>Referral system is temporarily unavailable.</b>\n\nPlease try again later."
        );
        return;
      }

      const referralLink =
        `https://t.me/${botUsername}?start=${encodeURIComponent(String(ctx.from.id))}`;

      // Use the referral rate already snapshotted for this user.
      // This must match the rate used during deposit commission calculation.
      const rate = Number(user.referralRate || 0);

      const referralStats =
        await db.getReferralStats(ctx.from.id);

      const referredUsers =
        Number(referralStats.referredUsers || 0);

      const referralEarnings =
        Number(referralStats.referralEarnings || 0);

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

      await editScreen(
        ctx,
        text,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📤 Share Referral Link",
                  url:
                    `https://t.me/share/url?url=${encodeURIComponent(referralLink)}`
                }
              ],
              [
                {
                  text: "🏠 Main Menu",
                  callback_data: "menu_home"
                }
              ]
            ]
          }
        }
      );

    } catch (err) {
      logger.error(
        `Error in menu_referral action | user=${ctx.from?.id || "unknown"}`,
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
  registerReferralHandler,
};
