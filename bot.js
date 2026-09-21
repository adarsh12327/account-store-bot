/**
 * bot.js
 * ------------------------------------------------------------------
 * Telegram bot entry point. Wires up every handler module and runs
 * the central text-step dispatcher for multi-step flows.
 * ------------------------------------------------------------------
 */
require("dotenv").config();
const { registerServer1Handler } = require("./handlers/server1");
const { registerServer2Handler } = require("./handlers/server2");
const { Telegraf } = require("telegraf");
const config = require("./config");
const logger = require("./utils/logger");
const session = require("./utils/session");
const { accessGuard } = require("./utils/accessGuard");

const { registerStartHandler } = require("./handlers/start");
const { registerUserHandler } = require("./handlers/user");
const { registerWalletHandler } = require("./handlers/wallet");
const { registerDepositHandler } = require("./handlers/deposit");
const { registerOrdersHandler } = require("./handlers/orders");
const { registerProductsHandler } = require("./handlers/products");
const { registerSupportHandler } = require("./handlers/support");
const { registerReferralHandler } = require("./handlers/referral");
const { registerAdminPricingFixHandler } = require("./handlers/adminPricingFix");
const { registerServer1OrderFiltersHandler } = require("./handlers/server1OrderFilters");

const { registerAdminHandler } = require("./handlers/admin");
const { registerAdminUsersHandler } = require("./handlers/adminUsers");
const { registerAdminCountriesHandler } = require("./handlers/adminCountries");
const { registerAdminProvidersHandler } = require("./handlers/adminProviders");
const { registerAdminProductsHandler } = require("./handlers/adminProducts");
const { registerAdminDepositsHandler } = require("./handlers/adminDeposits");
const { registerAdminOrdersHandler } = require("./handlers/adminOrders");
const { registerAdminSettingsHandler } = require("./handlers/adminSettings");
const { registerAdminBroadcastHandler } = require("./handlers/adminBroadcast");
const { registerAdminStatsHandler } = require("./handlers/adminStats");

const bot = new Telegraf(config.botToken);

// Global security/access middleware must run before all user handlers.
// Admins and recovery routes (/start, /cancel, verify_join) are allowed
// through by accessGuard itself.
bot.use((ctx, next) => accessGuard(bot, ctx, next));

// Register all handlers.
registerStartHandler(bot);
registerServer2Handler(bot);
registerUserHandler(bot);
registerWalletHandler(bot);
registerOrdersHandler(bot);
registerProductsHandler(bot);
registerSupportHandler(bot);
registerReferralHandler(bot);
registerAdminHandler(bot);
const server1TextStepRegistry = registerServer1Handler(bot) || {};

// These compatibility handlers intentionally register BEFORE the older
// handlers so the corrected callbacks own their routes.
const textStepRegistries = [
  registerAdminPricingFixHandler(bot),
  registerDepositHandler(bot),
  registerAdminUsersHandler(bot),
  registerAdminCountriesHandler(bot),
  registerAdminProvidersHandler(bot),
  registerAdminProductsHandler(bot),
  registerAdminSettingsHandler(bot),
  registerAdminBroadcastHandler(bot),
];

// Server 1 filter callbacks must be registered before the legacy order
// module's dormant filter registrations.
registerServer1OrderFiltersHandler(bot);
registerAdminDepositsHandler(bot);
textStepRegistries.push(registerAdminOrdersHandler(bot));
registerAdminStatsHandler(bot);

const textSteps = Object.assign(
  {},
  server1TextStepRegistry.textSteps || {},
  ...textStepRegistries.map((r) => r.textSteps)
);

// /cancel — universal escape hatch out of any multi-step flow.
bot.command("cancel", async (ctx) => {
  session.clear(ctx.from.id);
  await ctx.reply("❌ Cancelled.");
});

// Central text dispatcher for every multi-step flow.
bot.on("text", async (ctx) => {
  try {
    if (ctx.message.text.startsWith("/")) return;

    const state = session.get(ctx.from.id);
    if (!state || !state.step) return;

    const stepHandler = textSteps[state.step];
    if (!stepHandler) {
      session.clear(ctx.from.id);
      return;
    }

    await stepHandler(ctx, state);
  } catch (err) {
    logger.error("Error in text dispatcher", err);
    session.clear(ctx.from.id);
    await ctx.reply("⚠️ Something went wrong. Please try again.").catch(() => {});
  }
});

bot.catch((err, ctx) => {
  logger.error(`Unhandled error for update type ${ctx.updateType}`, err);
  ctx.reply("⚠️ Something went wrong. Please try again in a moment.").catch(() => {});
});

module.exports = { bot, textSteps };

if (require.main === module) {
  // FamApp auto-verification is event-driven from the deposit flow.
  // No background Gmail/Firestore polling is started here.

  /**
   * Launch bot with 409 Conflict retry logic.
   * Retries only on Telegram error 409 (duplicate polling), with bounded
   * exponential backoff: 5s, 10s, 20s, 30s (capped). Total window: ~65s.
   * All other errors exit immediately.
   */
  async function launchWithRetry() {
    const maxRetries = 4;
    const backoffDelays = [5000, 10000, 20000, 30000]; // 5s, 10s, 20s, 30s (capped)

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await bot.launch();
        console.log("[INFO] Telegram bot started in polling mode");
        return;
      } catch (err) {
        const is409 = err.code === 409 || (err.response && err.response.error_code === 409);

        if (!is409) {
          // Non-409 error: exit immediately
          console.error("[ERROR] Failed to start Telegram bot:", err);
          process.exit(1);
        }

        if (attempt < maxRetries) {
          const delay = backoffDelays[attempt];
          console.log(`[POLLING] 409 Conflict detected, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          // Exhausted retries after 409 errors
          console.error("[ERROR] Failed to start Telegram bot after retries:", err);
          process.exit(1);
        }
      }
    }
  }

  launchWithRetry().catch((err) => {
    console.error("[ERROR] Unexpected error in launchWithRetry:", err);
    process.exit(1);
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

