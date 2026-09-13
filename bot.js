
/**
 * bot.js
 * ------------------------------------------------------------------
 * Telegram bot entry point. Wires up every handler module and runs
 * the central text-step dispatcher for multi-step flows (deposit,
 * admin add/edit forms, broadcast, etc). No business logic lives
 * directly in this file.
 * ------------------------------------------------------------------
 */
require("dotenv").config();
const { registerServer1Handler } = require("./handlers/server1");
const { Telegraf } = require("telegraf");
const config = require("./config");
const logger = require("./utils/logger");
const session = require("./utils/session");

const { registerStartHandler } = require("./handlers/start");
const { registerUserHandler } = require("./handlers/user");
const { registerWalletHandler } = require("./handlers/wallet");
const { registerDepositHandler } = require("./handlers/deposit");
const { registerOrdersHandler } = require("./handlers/orders");
const { registerProductsHandler } = require("./handlers/products");
const { registerSupportHandler } = require("./handlers/support");
const { registerReferralHandler } = require("./handlers/referral");

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
const {
  startFamAppWatcher,
} = require("./utils/famappWatcher");

const bot = new Telegraf(config.botToken);

// Register all handlers. Handlers that expose multi-step text flows
// return { textSteps }, which we merge into one lookup table used by
// the global bot.on('text', ...) dispatcher below.
registerStartHandler(bot);
registerUserHandler(bot);
registerWalletHandler(bot);
registerOrdersHandler(bot);
registerProductsHandler(bot);
registerSupportHandler(bot);
registerReferralHandler(bot);
registerAdminHandler(bot);
registerServer1Handler(bot);
const textStepRegistries = [
  registerDepositHandler(bot),
  registerAdminUsersHandler(bot),
  registerAdminCountriesHandler(bot),
  registerAdminProvidersHandler(bot),
  registerAdminProductsHandler(bot),
  registerAdminSettingsHandler(bot),
  registerAdminBroadcastHandler(bot),
];
registerAdminDepositsHandler(bot);
textStepRegistries.push(registerAdminOrdersHandler(bot));
registerAdminStatsHandler(bot);

const textSteps = Object.assign({}, ...textStepRegistries.map((r) => r.textSteps));

// /cancel — universal escape hatch out of any multi-step flow.
bot.command("cancel", async (ctx) => {
  session.clear(ctx.from.id);
  await ctx.reply("❌ Cancelled.");
});

// Central text dispatcher for every multi-step flow.
bot.on("text", async (ctx) => {
  try {
    if (ctx.message.text.startsWith("/")) return; // let command handlers deal with commands

    const state = session.get(ctx.from.id);
    if (!state || !state.step) return; // no active flow — ignore stray text

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

// Vercel uses Telegram Webhook mode.
// Polling and long-running background watchers are intentionally
// not started from this module.
module.exports = { bot, textSteps };


