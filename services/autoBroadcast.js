/**
 * services/autoBroadcast.js
 * ---------------------------------------------------------------
 * Automatic promotional broadcast for registered bot users.
 * Sends two messages once every configured interval (default: 12h).
 * The last-run timestamp is persisted in settings so restarts do not
 * reset the schedule or cause an immediate duplicate broadcast.
 * ---------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");

const CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_INTERVAL_HOURS = 12;
const MIN_DELAY_MS = 40;

const MESSAGE_1 =
  "🚀 <b>TELEGRAM ACCOUNT STORE — BUY NOW</b>\\n\\n" +
  "🔥 Fresh Telegram accounts are available!\\n" +
  "💎 Fast • Simple • Trusted\\n\\n" +
  "🛒 <b>Ready to buy?</b>";

const MESSAGE_2 =
  "👉 <b>Open Telegram Account Store</b>\\n\\n" +
  "Send <code>/start</code> to open the store and start shopping. 🛍️";

let timer = null;
let running = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getRetryAfter(err) {
  return Number(
    err?.response?.parameters?.retry_after ||
    err?.parameters?.retry_after ||
    0
  );
}

async function sendWithRetry(telegram, userId, text) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await telegram.sendMessage(userId, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return true;
    } catch (err) {
      const retryAfter = getRetryAfter(err);

      if (retryAfter > 0 && attempt < 3) {
        await sleep(Math.max(retryAfter * 1000, 1000));
        continue;
      }

      // A short local delay handles normal Telegram pacing.
      if (attempt < 3 && /429|flood|too many requests/i.test(String(err?.message || ""))) {
        await sleep((attempt + 1) * 2000);
        continue;
      }

      throw err;
    }
  }

  return false;
}

async function runAutoBroadcast(bot) {
  if (running) return;

  const settings = await db.getSettings();
  const enabled = settings.autoBroadcastEnabled !== false;
  if (!enabled) return;

  const intervalHours = Number(
    settings.autoBroadcastIntervalHours || DEFAULT_INTERVAL_HOURS
  );
  const intervalMs = Math.max(intervalHours, 1) * 60 * 60 * 1000;
  const lastSentAt = toMillis(settings.autoBroadcastLastSentAt);

  // The scheduler is intentionally started with a fresh 12-hour timer.
  // A null timestamp means: send the first campaign on the next scheduler check.
  if (!lastSentAt) {
    // Start from now and continue into the normal 12-hour cycle.
    await db.updateSettings({
      autoBroadcastLastSentAt: new Date().toISOString(),
    });
    return;
  }

  if (Date.now() - lastSentAt < intervalMs) return;

  running = true;

  try {
    const userIds = await db.listAllUserIds();
    let sent = 0;
    let failed = 0;

    // Advance the schedule before sending so another tick cannot start
    // a duplicate campaign while this one is running.
    await db.updateSettings({
      autoBroadcastLastSentAt: new Date().toISOString(),
    });

    for (const userId of userIds) {
      try {
        await sendWithRetry(bot.telegram, userId, MESSAGE_1);
        await sleep(MIN_DELAY_MS);
        await sendWithRetry(bot.telegram, userId, MESSAGE_2);
        sent++;
      } catch (err) {
        failed++;
        logger.warn("Auto broadcast delivery failed", {
          userId,
          reason: err?.message || String(err),
        });
      }

      await sleep(MIN_DELAY_MS);
    }

    logger.info("Auto broadcast completed", {
      users: userIds.length,
      sent,
      failed,
      intervalHours,
    });
  } catch (err) {
    logger.error("Auto broadcast failed", err);
  } finally {
    running = false;
  }
}

function startAutoBroadcast(bot) {
  if (timer) return;

  // Start a fresh schedule from this process start. This makes the
  // first automatic campaign exactly 12 hours after deployment/startup.
  db.updateSettings({ autoBroadcastLastSentAt: new Date().toISOString() }).catch((err) => {
    logger.error("Auto broadcast timer initialization failed", err);
  });

  // Do not block bot startup.
  runAutoBroadcast(bot).catch((err) => {
    logger.error("Auto broadcast startup check failed", err);
  });

  timer = setInterval(() => {
    runAutoBroadcast(bot).catch((err) => {
      logger.error("Auto broadcast scheduler error", err);
    });
  }, CHECK_INTERVAL_MS);

  if (typeof timer.unref === "function") timer.unref();

  logger.info("Auto broadcast scheduler started");
}

module.exports = {
  startAutoBroadcast,
  runAutoBroadcast,
};
