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
const MORNING_HOUR_IST = 8;
const EVENING_HOUR_IST = 17;
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

function getIndiaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const out = {};
  for (const p of parts) out[p.type] = p.value;
  return {
    dateKey: `${out.year}-${out.month}-${out.day}`,
    hour: Number(out.hour),
  };
}

function getScheduledSlot(date = new Date()) {
  const { dateKey, hour } = getIndiaDateParts(date);
  if (hour === MORNING_HOUR_IST) return `${dateKey}:08`;
  if (hour === EVENING_HOUR_IST) return `${dateKey}:17`;
  return null;
}

async function runBroadcastMessage(bot, message) {
  const userIds = await db.listAllUserIds();
  let sent = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      await sendWithRetry(bot.telegram, userId, message);
      sent++;
    } catch (err) {
      failed++;
      logger.warn("Broadcast delivery failed", {
        userId,
        reason: err?.message || String(err),
      });
    }
    await sleep(MIN_DELAY_MS);
  }
  return { users: userIds.length, sent, failed };
}

async function runAutoBroadcast(bot) {
  if (running) return;

  const settings = await db.getSettings();
  if (settings.autoBroadcastEnabled === false) return;

  const slot = getScheduledSlot();
  if (!slot) return;

  if (String(settings.autoBroadcastLastSentAt || "") === slot) return;

  running = true;
  try {
    const userIds = await db.listAllUserIds();
    let sent = 0;
    let failed = 0;

    await db.updateSettings({ autoBroadcastLastSentAt: slot });

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
      slot,
      users: userIds.length,
      sent,
      failed,
    });
  } catch (err) {
    logger.error("Auto broadcast failed", err);
  } finally {
    running = false;
  }
}

function startAutoBroadcast(bot) {
  if (timer) return;

  // One-time live test: send one promotional message immediately.
  db.getSettings().then(async (settings) => {
    if (settings.autoBroadcastTestSent === true) return;
    const result = await runBroadcastMessage(bot, MESSAGE_1);
    await db.updateSettings({ autoBroadcastTestSent: true });
    logger.info("Auto broadcast live test completed", result);
  }).catch((err) => {
    logger.error("Auto broadcast live test failed", err);
  });

  // Scheduled slots are fixed to India time: 08:00 and 17:00 IST.
  runAutoBroadcast(bot).catch((err) => {
    logger.error("Auto broadcast startup check failed", err);
  });

  timer = setInterval(() => {
    runAutoBroadcast(bot).catch((err) => {
      logger.error("Auto broadcast scheduler error", err);
    });
  }, CHECK_INTERVAL_MS);

  if (typeof timer.unref === "function") timer.unref();

  logger.info("Auto broadcast scheduler started: 08:00 and 17:00 IST");
}

module.exports = {
  startAutoBroadcast,
  runAutoBroadcast,
};
