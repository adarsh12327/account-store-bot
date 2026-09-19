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
      await ctx.answerCbQuery().catch(() => {});

      const snapshotUser = await db.getUser(ctx.from.id);
      const snapshotSettings = await db.getSettings();

      const botUsername = String(
        snapshotSettings?.botUsername ||
        ctx.botInfo?.username ||
        ctx.telegram?.botInfo?.username ||
        "account_stores_bot"
      ).replace(/^@/, "").trim();

      const referralLink =
        `https://t.me/${botUsername}?start=${encodeURIComponent(String(ctx.from.id))}`;

      const rate = getEffectiveOutboundRate(
        snapshotUser || { referralRateOverride: null },
        snapshotSettings
      );

      // Instant first render. Statistics are refreshed in background.
      await editScreen(ctx,
        `👥 <b>Refer & Earn</b>\n\n` +
        `🎁 Earn <b>${rate}%</b> commission on deposits made by users you refer.\n\n` +
        `👤 <b>Referred Users:</b> —\n` +
        `💰 <b>Referral Earnings:</b> ₹—\n\n` +
        `🔗 <b>Your Referral Link:</b>\n` +
        `<code>${escapeHtml(referralLink)}</code>\n\n` +
        `👤 <b>Your Referrer:</b> ${snapshotUser?.referrerId ? "Already assigned" : "None"}`,
        {
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
        }
      ).catch(() => {});

      setImmediate(async () => {
        try {
          const user = (await db.getUser(ctx.from.id)) || snapshotUser || {
            telegramId: String(ctx.from.id),
            firstName: ctx.from?.first_name || "",
            lastName: ctx.from?.last_name || "",
            username: ctx.from?.username || "",
            referrerId: null,
            referralRateOverride: null,
          };

          const settings =
            (await db.getSettings()) || snapshotSettings;

          let referredUsers = 0;
          let referralEarnings = 0;

          try {
            const referralStats = await db.getReferralStats(ctx.from.id);
            referredUsers = Number(referralStats?.referredUsers || 0);
            referralEarnings = Number(referralStats?.referralEarnings || 0);
          } catch (statsErr) {
            logger.error(
              `Referral stats read failed | user=${ctx.from?.id || "unknown"}`,
              statsErr
            );
          }

          const freshBotUsername = String(
            settings?.botUsername ||
            botUsername ||
            "account_stores_bot"
          ).replace(/^@/, "").trim();

          const freshReferralLink =
            `https://t.me/${freshBotUsername}?start=${encodeURIComponent(String(ctx.from.id))}`;

          const freshRate = getEffectiveOutboundRate(user, settings);

          const text =
            `👥 <b>Refer & Earn</b>\n\n` +
            `🎁 Earn <b>${freshRate}%</b> commission on deposits made by users you refer.\n\n` +
            `👤 <b>Referred Users:</b> ${referredUsers}\n` +
            `💰 <b>Referral Earnings:</b> ₹${formatAmount(referralEarnings)}\n\n` +
            `🔗 <b>Your Referral Link:</b>\n` +
            `<code>${escapeHtml(freshReferralLink)}</code>\n\n` +
            `👤 <b>Your Referrer:</b> ${user.referrerId ? "Already assigned" : "None"}\n\n` +
            `Share your link with your friends to invite them.`;

          await editScreen(ctx, text, {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "📤 Share Referral Link",
                    url: `https://t.me/share/url?url=${encodeURIComponent(freshReferralLink)}`,
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
            `Background referral load failed | user=${ctx.from?.id || "unknown"}`,
            err
          );
        }
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
