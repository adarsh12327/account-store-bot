/**
 * bot.js
 * ------------------------------------------------------------------
 * Telegram bot entry point. Wires up every handler module and runs
 * the central text-step dispatcher for multi-step flows.
 * ------------------------------------------------------------------
 */
require("dotenv").config();
const { registerServer1Handler } = require("./handlers/server1");
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
const { startFamAppWatcher } = require("./utils/famappWatcher");

const bot = new Telegraf(config.botToken);

// Global security/access middleware must run before all user handlers.
// Admins and recovery routes (/start, /cancel, verify_join) are allowed
// through by accessGuard itself.
bot.use((ctx, next) => accessGuard(bot, ctx, next));

// Register all handlers.
registerStartHandler(bot);
registerUserHandler(bot);
registerWalletHandler(bot);
registerOrdersHandler(bot);
registerProductsHandler(bot);
registerSupportHandler(bot);
registerReferralHandler(bot);
registerAdminHandler(bot);
registerServer1Handler(bot);

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
  // Railway runs this file as a long-lived Node process. Start the
  // Gmail watcher only in polling/worker mode, never when imported by
  // a serverless webhook entry point.
  startFamAppWatcher(bot);

  bot.launch()
    .then(() => console.log("[INFO] Telegram bot started in polling mode"))
    .catch((err) => {
      console.error("[ERROR] Failed to start Telegram bot:", err);
      process.exit(1);
    });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
