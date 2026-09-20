
function getRealCallingCode(phoneNumber) {
  try {
    const { parsePhoneNumberFromString } = require("libphonenumber-js");

    const raw = String(phoneNumber || "").trim();
    if (!raw) return "";

    const number = raw.startsWith("+") ? raw : `+${raw}`;
    const parsed = parsePhoneNumberFromString(number);

    return parsed?.countryCallingCode
      ? `+${parsed.countryCallingCode}`
      : "";
  } catch (err) {
    logger.warn(
      `Real calling code detection failed: ${err.message}`
    );
    return "";
  }
}

/**
 * handlers/server1.js
 * ------------------------------------------------------------
 * Server 1 - Professional Product Store UI
 *
 * Features:
 * - 2-column country/product UI
 * - 28 products per page
 * - Lazy loading when Server 1 is opened
 * - Live Grizzly price/stock check on Buy Now
 * - Local catalog cache for navigation only
 * - Product details
 * - Stock / price / provider information
 * - Buy flow using createServer1Order()
 * ------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const logger = require("../utils/logger");
const db = require("../database");

const {
  getServer1CountrySalesStats,
  completeServer1Order,
  syncServer1ProviderPrices,
} = db;
const {
  getPrices,
  getNumberV2,
} = require("../services/grizzlyClient");

const {
  getActivationStatus,
  cancelActivation,
} = require("../services/server1");
const PRICE_CACHE_FILE = path.join(
  __dirname,
  "../.cache/server1-grizzly-tg.json"
);

const CATALOG_CACHE_FILE = path.join(
  __dirname,
  "../.cache/server1-catalog.json"
);

const CACHE_TTL = 5 * 60 * 1000;

const SALES_CACHE_FILE = path.join(
  __dirname,
  "../.cache/server1-sales.json"
);

const SALES_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

let server1SalesMemory = null;
let server1SalesMemoryAt = 0;

// Prevent multiple users from creating multiple Grizzly requests.
let grizzlyFetchPromise = null;

// Prevent multiple background catalog refreshes.
let server1BackgroundRefreshPromise = null;

// Never allow the Server 1 UI to wait forever for provider API.
const GRIZZLY_TIMEOUT = 15000;

// 28 products = 14 rows × 2 columns.
const PAGE_SIZE = 20;

// ------------------------------------------------------------
// Fast Server 1 catalog memory cache
// ------------------------------------------------------------
// Buttons such as Next / Previous / Product should not rebuild
// the complete catalog on every Telegram callback.
// ------------------------------------------------------------

let server1CatalogMemory = null;
let server1CatalogMemoryAt = 0;

const SERVER1_CATALOG_MEMORY_TTL = 60 * 1000; // 60 seconds



// ------------------------------------------------------------
// Server 1 - Countdown formatter
// ------------------------------------------------------------

function formatCountdown(value) {
  if (!value) {
    return "N/A";
  }

  let text = String(value).trim();

  // Grizzly timestamps are UTC:
  // 2026-08-20 08:33:12
  // Convert them to ISO UTC before calculating countdown.
  if (!/[zZ]|[+-]\\d{2}:?\\d{2}$/.test(text)) {
    text = text.replace(" ", "T") + "Z";
  }

  const end = new Date(text);

  if (Number.isNaN(end.getTime())) {
    return "N/A";
  }

  const diff = Math.max(0, end.getTime() - Date.now());

  const totalSeconds = Math.floor(diff / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}


// ------------------------------------------------------------
// Server 1 - Live purchase countdown
// ------------------------------------------------------------
function parseGrizzlyTime(value) {
  if (!value) return null;

  let text = String(value).trim();

  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    text = text.replace(" ", "T") + "Z";
  }

  const date = new Date(text);

  return Number.isNaN(date.getTime()) ? null : date;
}

function getRemainingText(value) {
  const end = parseGrizzlyTime(value);

  if (!end) return "N/A";

  const diff = Math.max(0, end.getTime() - Date.now());
  const totalSeconds = Math.floor(diff / 1000);

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}


// ------------------------------------------------------------
// Server 1 - Live Telegram purchase countdown
// ------------------------------------------------------------
const SERVER1_OTP_POLL_INTERVAL = 5000;

const SERVER1_ORDER_UI_MESSAGES = new Map();

const SERVER1_COUNTDOWN_UI_TIMERS = new Map();

function stopServer1Countdown(orderId) {
  const key = String(orderId);
  const timer = SERVER1_COUNTDOWN_UI_TIMERS.get(key);

  if (timer) {
    clearInterval(timer);
    SERVER1_COUNTDOWN_UI_TIMERS.delete(key);

    logger.info(
      `Server 1 countdown stopped: order=${orderId}`
    );
  }
}

async function updateServer1Countdown({
  orderId,
  currentOrder,
  remainingMs,
}) {
  const key = String(orderId);

  try {
    const uiMessage =
      SERVER1_ORDER_UI_MESSAGES.get(key);

    const bot =
      global.__SERVER1_BOT__;

    if (!bot || !uiMessage) {
      return;
    }

    // --------------------------------------------------------
    // IMPORTANT:
    // Check latest order status before every countdown render.
    // If order was refunded/cancelled/completed, immediately
    // stop the interval.
    // --------------------------------------------------------

    let latestOrder = null;

    try {
      latestOrder =
        await db.getServer1Order(orderId);
    } catch (err) {
      logger.warn(
        `Server 1 countdown status check failed: order=${orderId}`,
        err.message || err
      );
    }

    if (!latestOrder) {
      stopServer1Countdown(orderId);
      return;
    }

    const latestStatus =
      String(
        latestOrder.status || ""
      ).toLowerCase();

    if (
      !["waiting_otp", "processing"].includes(
        latestStatus
      )
    ) {
      stopServer1Countdown(orderId);

      logger.info(
        `Server 1 countdown stopped because order status changed: order=${orderId}, status=${latestStatus}`
      );

      return;
    }

    // --------------------------------------------------------
    // Prevent duplicate countdown timers.
    // --------------------------------------------------------

    if (SERVER1_COUNTDOWN_UI_TIMERS.has(key)) {
      return;
    }

    const parseDate = (value) => {
      if (!value) return null;

      let dateText =
        String(value).trim();

      if (
        !/[zZ]|[+-]\d{2}:?\d{2}$/.test(
          dateText
        )
      ) {
        dateText =
          dateText.replace(" ", "T") + "Z";
      }

      const date =
        new Date(dateText);

      return Number.isNaN(
        date.getTime()
      )
        ? null
        : date;
    };

    const formatMMSS = (ms) => {
      const totalSeconds =
        Math.max(
          0,
          Math.ceil(ms / 1000)
        );

      const minutes =
        Math.floor(
          totalSeconds / 60
        );

      const seconds =
        totalSeconds % 60;

      return (
        `${String(minutes).padStart(2, "0")}:` +
        `${String(seconds).padStart(2, "0")}`
      );
    };

    let stopped = false;
    let editing = false;

    const render = async () => {
      if (stopped || editing) {
        return;
      }

      editing = true;

      try {
        // ----------------------------------------------------
        // ALWAYS read latest order.
        // This is the important fix.
        // ----------------------------------------------------

        const order =
          await db.getServer1Order(orderId);

        if (!order) {
          stopped = true;
          stopServer1Countdown(orderId);
          return;
        }

        const status =
          String(
            order.status || ""
          ).toLowerCase();

        // ----------------------------------------------------
        // Refund / cancel / completed:
        // STOP TIMER IMMEDIATELY.
        // ----------------------------------------------------

        if (
          !["waiting_otp", "processing"].includes(
            status
          )
        ) {
          stopped = true;
          stopServer1Countdown(orderId);

          logger.info(
            `Server 1 UI timer stopped: order=${orderId}, status=${status}`
          );

          return;
        }

        // ----------------------------------------------------
        // Calculate timeout from real activation expiry.
        // ----------------------------------------------------

        let timeoutRemaining =
          remainingMs;

        if (order.activationEnd) {
          const end =
            parseDate(
              order.activationEnd
            );

          if (end) {
            timeoutRemaining =
              Math.max(
                0,
                end.getTime() -
                Date.now()
              );
          }
        }

        let cancelRemaining = 0;

        if (order.activationCancel) {
          const cancelAt =
            parseDate(
              order.activationCancel
            );

          if (cancelAt) {
            cancelRemaining =
              Math.max(
                0,
                cancelAt.getTime() -
                Date.now()
              );
          }
        }

        const cancelLocked =
          cancelRemaining > 0;

        const country =
          String(
            order.countryName ||
            "Unknown"
          )
            .replace(
              /\s*\([^)]*\)/g,
              ""
            )
            .trim();

        const phone =
          String(
            order.phoneNumber ||
            "N/A"
          );

        const price =
          Number(
            order.price ??
            order.amount ??
            order.sellingPrice ??
            0
          );

        const cancelText =
          cancelLocked
            ? `🔒 Cancel Locked (${Math.ceil(cancelRemaining / 1000)}s)`
            : "❌ Cancel";

        const cancelData =
          cancelLocked
            ? `server1:cancel_locked:${orderId}`
            : `server1:cancel:${orderId}`;

        await bot.telegram.editMessageText(
          uiMessage.chatId,
          uiMessage.messageId,
          undefined,

          `📱 <b>NUMBER PURCHASED</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +

          `📦 <b>Service:</b>\n` +
          `Telegram\n\n` +

          `🌍 <b>Country:</b>\n` +
          `${country} ${getRealCallingCode(phone)}\n\n` +

          `📞 <b>Number:</b>\n` +
          `<code>${phone}</code>\n\n` +

          `💰 <b>Cost:</b>\n` +
          `₹${price.toFixed(2)}\n\n` +

          `⏳ <b>Timeout:</b> ` +
          `<code>${formatMMSS(timeoutRemaining)}</code>\n\n` +

          `❌ <b>Cancel Available In:</b> ` +
          `<code>${formatMMSS(cancelRemaining)}</code>\n\n` +

          `🕐 <b>Status:</b>\n` +
          `<i>Waiting for OTP...</i>`,

          {
            parse_mode: "HTML",

            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🔄 Check OTP",
                    callback_data:
                      `server1:sendotp:${orderId}`,
                  },
                ],
                [
                  {
                    text: cancelText,
                    callback_data:
                      cancelData,
                  },
                ],
              ],
            },
          }
        );

        if (
          timeoutRemaining <= 0
        ) {
          stopped = true;
          stopServer1Countdown(orderId);
        }

      } catch (err) {
        const msg =
          String(
            err?.message || ""
          ).toLowerCase();

        if (
          msg.includes(
            "message is not modified"
          ) ||
          msg.includes(
            "message to edit not found"
          ) ||
          msg.includes(
            "message can't be edited"
          )
        ) {
          // Normal Telegram edit race.
        } else {
          logger.warn(
            `Server 1 countdown UI update failed: order=${orderId}`,
            err.message || err
          );
        }

      } finally {
        editing = false;
      }
    };

    // First render immediately.
    await render();

    // --------------------------------------------------------
    // LIVE TIMER
    // --------------------------------------------------------

    const timer =
      setInterval(
        async () => {
          if (stopped) {
            clearInterval(timer);

            SERVER1_COUNTDOWN_UI_TIMERS.delete(
              key
            );

            return;
          }

          await render();
        },
        1000
      );

    SERVER1_COUNTDOWN_UI_TIMERS.set(
      key,
      timer
    );

  } catch (err) {
    logger.warn(
      `Server 1 countdown initialization failed: order=${orderId}`,
      err.message || err
    );
  }
}


async function monitorServer1Activation({
  orderId,
  activationId,
  waitMinutes,
}) {
  const startedAt = Date.now();

  // Grizzly activationEnd is returned as UTC.
  // Use the real provider expiry time when available.
  let activationEndAt = null;

  try {
    const initialOrder =
      await db.getServer1Order(orderId);

    if (initialOrder?.activationEnd) {
      let endText =
        String(initialOrder.activationEnd).trim();

      if (!/[zZ]|[+-]\\d{2}:?\\d{2}$/.test(endText)) {
        endText =
          endText.replace(" ", "T") + "Z";
      }

      const parsed =
        new Date(endText);

      if (!Number.isNaN(parsed.getTime())) {
        activationEndAt =
          parsed.getTime();
      }
    }
  } catch (err) {
    logger.warn(
      `Server 1 activationEnd read failed: order=${orderId}`,
      err.message
    );
  }

  // Fallback to configured timeout if provider expiry
  // is unavailable.
  const timeoutMs =
    activationEndAt
      ? Math.max(
          1000,
          activationEndAt - Date.now()
        )
      : Math.max(
          1,
          Number(waitMinutes || 20)
        ) * 60 * 1000;

  logger.info(
    `Server 1 OTP monitor started: order=${orderId}, activation=${activationId}, timeout=${Math.round(timeoutMs / 60000)}m`
  );

  while (Date.now() - startedAt < timeoutMs) {
    try {

      // If the real Grizzly activation expiry has passed,
      // stop polling and let the timeout/refund block handle it.
      if (
        activationEndAt &&
        Date.now() >= activationEndAt
      ) {
        logger.info(
          `Server 1 activationEnd reached: order=${orderId}, activation=${activationId}`
        );
        break;
      }
      const currentOrder = await db.getServer1Order(orderId);

      if (!currentOrder) {
        logger.warn(
          `Server 1 OTP monitor: order not found: ${orderId}`
        );
        return;
      }

      // Stop if another flow already completed/cancelled/refunded it.
      if (
        !["waiting_otp", "processing"].includes(
          String(currentOrder.status || "").toLowerCase()
        )
      ) {
        stopServer1Countdown(orderId);

        logger.info(
          `Server 1 OTP monitor stopped: order=${orderId}, status=${currentOrder.status}`
        );
        return;
      }

      // --------------------------------------------------------


      // LIVE TELEGRAM COUNTDOWN


      // --------------------------------------------------------


      const countdownDeadline =


        activationEndAt || (startedAt + timeoutMs);



      const countdownRemaining =


        Math.max(0, countdownDeadline - Date.now());



      await updateServer1Countdown({


        orderId,


        currentOrder,


        remainingMs: countdownRemaining,


      });



      const result = await getActivationStatus(activationId);

      logger.info(
        `Server 1 activation status checked: order=${orderId}`
      );

      /*
       * Grizzly getStatusV2 returns data like:
       *
       * {
       *   verificationType: 1,
       *   sms: {
       *     dateTime: "...",
       *     code: "123456",
       *     text: "..."
       *   }
       * }
       *
       * Our provider adapter wraps it inside:
       *
       * {
       *   provider: "grizzly",
       *   activationId: "...",
       *   raw: { ... }
       * }
       */

      const raw = result?.raw || result || {};

      const sms = raw?.sms || {};

      const possibleOtpValues = [
        sms?.code,
        sms?.otp,
        result?.smsCode,
        result?.code,
        result?.otp,
        raw?.smsCode,
        raw?.code,
        raw?.otp,
      ];

      const smsCode = possibleOtpValues
        .map((value) => String(value ?? "").trim())
        .find((value) => /^\\d{4,8}$/.test(value)) || "";

      const providerStatus = String(
        result?.status ||
        result?.state ||
        result?.activationStatus ||
        raw?.status ||
        raw?.state ||
        raw?.activationStatus ||
        ""
      ).toLowerCase();

      // --------------------------------------------------------
      // OTP RECEIVED
      // --------------------------------------------------------
      if (smsCode) {
      const currentOrder = await db.getServer1Order(orderId);

        const completion = await completeServer1Order(orderId, {
          smsCode,
          deliveryInfo:
            sms?.text ||
            "OTP received successfully",
        });

        // Another flow (for example manual Check OTP) may have
        // completed/cancelled/refunded the order first.
        if (!completion.completed) {
          logger.info(
            `Server 1 order ${orderId} was already finalized before automatic OTP completion`
          );
          return;
        }

// --------------------------------------------------------
// UPDATE ORIGINAL PURCHASE MESSAGE → COMPLETED
// Removes timeout, cancel button and waiting status.
// --------------------------------------------------------
try {
  const uiMessage =
    SERVER1_ORDER_UI_MESSAGES.get(String(orderId));

  if (uiMessage) {
    const completedCountry =
      String(
        currentOrder?.countryName || "Unknown"
      )
        .replace(/\s*\([^)]*\)/g, "")
        .trim();

    const completedPhone =
      String(
        currentOrder?.phoneNumber || "N/A"
      );

    await global.__SERVER1_BOT__?.telegram.editMessageText(
      uiMessage.chatId,
      uiMessage.messageId,
      undefined,
      `🔐 <b>OTP RECEIVED</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📦 <b>Service:</b> Telegram\n` +
      `🌍 <b>Country:</b> ${completedCountry} ${getRealCallingCode(completedPhone)}\n` +
      `📞 <b>Number:</b> <code>${completedPhone}</code>\n\n` +
      `🔑 <b>OTP:</b> <code>${smsCode}</code>\n\n` +
      `✅ <b>Status:</b> Completed`,
      {
        parse_mode: "HTML"
      }
    );

    logger.info(
      `Server 1 purchase UI changed to COMPLETED: order=${orderId}`
    );

    SERVER1_ORDER_UI_MESSAGES.delete(
      String(orderId)
    );
  }
} catch (uiErr) {
  logger.error(
    `Server 1 completed UI update failed: order=${orderId}`,
    uiErr
  );
}

        
        // Automatically send OTP to the user
        

      // --------------------------------------------------------
      // SERVER 1 SALE CHANNEL NOTIFICATIONS
      // ONLY AFTER OTP / COMPLETED
      // --------------------------------------------------------
      try {
        const bot = global.__SERVER1_BOT__;

        const adminChannel =
          String(process.env.SERVER1_ADMIN_CHANNEL_ID || "").trim();

        const userChannel =
          String(process.env.SERVER1_USER_CHANNEL_ID || "").trim();

        // Prevent unlimited duplicate notifications during OTP polling
        if (
          bot &&
          (adminChannel || userChannel) &&
          smsCode &&
          !global.__SERVER1_SALE_NOTIFIED__
        ) {
          global.__SERVER1_SALE_NOTIFIED__ = new Set();
        }

        const notifiedSet = global.__SERVER1_SALE_NOTIFIED__;

        if (
          bot &&
          (adminChannel || userChannel) &&
          smsCode &&
          !notifiedSet.has(String(orderId))
        ) {
          notifiedSet.add(String(orderId));

          const userId =
            String(currentOrder?.userId || "N/A");

          const username =
            currentOrder?.username ||
            currentOrder?.userUsername ||
            currentOrder?.user?.username ||
            "";

          const userDisplay = username
            ? `@${String(username).replace(/^@/, "")}`
            : userId;

          const mask = (value, start = 3, end = 2) => {
            const v = String(value || "");

            if (!v || v === "N/A") return "N/A";

            if (v.length <= start + end) {
              return "*".repeat(v.length);
            }

            return (
              v.slice(0, start) +
              "*".repeat(v.length - start - end) +
              v.slice(-end)
            );
          };

          const phone =
            String(currentOrder?.phoneNumber || "N/A");

          const country =
            String(currentOrder?.countryName || "Unknown")
              .replace(/\s*\([^)]*\)/g, "")
              .trim();

          const price = Number(
            currentOrder?.price ??
            currentOrder?.amount ??
            currentOrder?.sellingPrice ??
            0
          );

          const saleOrderId =
            String(currentOrder?.orderId || orderId);

          const saleActivationId =
            String(
              currentOrder?.activationId ||
              activationId ||
              "N/A"
            );

          // ----------------------------------------------------
          // ADMIN CHANNEL — FULL DETAILS
          // ----------------------------------------------------
          if (adminChannel) {
            await bot.telegram.sendMessage(
              adminChannel,

              `🚀 <b>NEW ACCOUNT SOLD!</b>\n` +
              `━━━━━━━━━━━━━━━━━━━━\n\n` +

              `👤 <b>User:</b> ${userDisplay}\n` +
              `🆔 <b>User ID:</b> <code>${userId}</code>\n\n` +

              `📦 <b>Item:</b> Telegram\n` +
              `📍 <b>Region:</b> ${country}\n` +
              `📱 <b>Number:</b> <code>${phone}</code>\n\n` +

              `🔐 <b>OTP:</b> <code>${smsCode}</code>\n\n` +

              `🆔 <b>Order ID:</b> <code>${saleOrderId}</code>\n` +
              `⚡ <b>Activation ID:</b> <code>${saleActivationId}</code>\n` +
              `💰 <b>Cost:</b> ₹${price.toFixed(2)}\n` +
              `✅ <b>Status:</b> Verified & Delivered`,

              { parse_mode: "HTML" }
            );
          }

          // ----------------------------------------------------
          // USER / PUBLIC CHANNEL — MASKED DETAILS
          // ----------------------------------------------------
          if (userChannel) {
            await bot.telegram.sendMessage(
              userChannel,

              `🚀 <b>NEW ACCOUNT SOLD!</b>\n\n` +

              `👤 User: ${mask(userId, 2, 3)}\n` +
              `📦 Item: Telegram\n` +
              `📍 Region: ${country}\n` +
              `📱 Number: ${mask(phone, 3, 2)}\n` +
              `⚡ Status: Verified & Delivered\n\n` +

              `🤖 Always use @account_stores_bot`,

              { parse_mode: "HTML" }
            );
          }

          logger.info(
            `Server 1 sale channel notifications sent ONCE: order=${saleOrderId}`
          );
        }

      } catch (channelErr) {
        logger.error(
          `Server 1 sale channel notification failed: order=${orderId}`,
          channelErr
        );
      }


      } // end if (smsCode)
      // PROVIDER ACTIVATION ENDED
      // --------------------------------------------------------
      if (
        providerStatus.includes("cancel") ||
        providerStatus.includes("expired") ||
        providerStatus.includes("finish") ||
        providerStatus.includes("reject")
      ) {
        try {
          const latestOrder = await db.getServer1Order(orderId);

          if (
            latestOrder &&
            ["waiting_otp", "processing"].includes(
              String(latestOrder.status || "").toLowerCase()
            )
          ) {
            await db.cancelServer1OrderAndRefund(
              orderId,
              `Provider activation ended: ${providerStatus}`
            );

            logger.info(
              `Server 1 order refunded after provider status: order=${orderId}, status=${providerStatus}`
            );
          }
        } catch (refundErr) {
          logger.error(
            `Server 1 provider-status refund failed: order=${orderId}`,
            refundErr
          );
        }

        return;
      }

    } catch (err) {
      logger.error(
        `Server 1 OTP polling error: order=${orderId}`,
        err
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, SERVER1_OTP_POLL_INTERVAL)
    );
  }

  // ----------------------------------------------------------
  // OTP TIMEOUT -> CANCEL ACTIVATION + REFUND
  // ----------------------------------------------------------

  try {
    const currentOrder = await db.getServer1Order(orderId);

    if (
      currentOrder &&
      ["waiting_otp", "processing"].includes(
        String(currentOrder.status || "").toLowerCase()
      )
    ) {

      // Stop UI countdown before timeout refund.
      stopServer1Countdown(orderId);

            // Cancel provider activation.
      // Refund ONLY when provider cancellation succeeds.
      let cancellationSucceeded = false;

      try {
        const cancelResult = await cancelActivation(activationId);

        cancellationSucceeded = true;

      } catch (cancelErr) {
        logger.error(
          `Server 1 activation cancellation FAILED - REFUND BLOCKED: order=${orderId}, activation=${activationId}`,
          cancelErr
        );

        // BAD_ACTION or any cancel failure = NO REFUND.
        return;
      }

      if (!cancellationSucceeded) {
        logger.error(
          `Server 1 refund blocked: cancellation was not successful: order=${orderId}`
        );
        return;
      }

      // Refund only after successful provider cancellation.
      const refundResult =
        await db.cancelServer1OrderAndRefund(
          orderId,
          `OTP not received within ${waitMinutes} minutes`
        );

      logger.info(
        `Server 1 order refunded: order=${orderId}, amount=${refundResult.refundAmount}, newBalance=${refundResult.newBalance}`
      );

      // IMPORTANT:
      // Stop Telegram countdown immediately after refund.
      stopServer1Countdown(orderId);


      // Notify the user that the activation timed out.
      try {
        const bot = global.__SERVER1_BOT__;

        if (bot && currentOrder.userId) {
          await bot.telegram.sendMessage(
            String(currentOrder.userId),
            `⏰ <b>NUMBER REQUEST TIMED OUT</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📱 <b>Service:</b> Telegram\n` +
            `🌍 <b>Country:</b> ${currentOrder.countryName || "Unknown"} ${getRealCallingCode(currentOrder.phoneNumber)}\n` +
            `📞 <b>Number:</b> <code>${currentOrder.phoneNumber || "N/A"}</code>\n\n` +
            `💰 <b>Refunded:</b> ₹${Number(refundResult.refundAmount || 0).toFixed(2)}\n` +
            `💳 <b>New Balance:</b> ₹${Number(refundResult.newBalance || 0).toFixed(2)}\n\n` +
            `🕐 <b>Status:</b> Refunded\n` +
            `ℹ️ No OTP was received before the activation expired.`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🛒 Buy Again",
                      callback_data: "server1:menu"
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
        }
      } catch (notifyErr) {
        logger.error(
          `Server 1 timeout notification failed: order=${orderId}`,
          notifyErr
        );
      }
    }

  } catch (err) {
    logger.error(
      `Server 1 OTP timeout/refund failed: order=${orderId}`,
      err
    );
  }
}

// ------------------------------------------------------------
// Telegram helpers
// ------------------------------------------------------------

async function editScreen(ctx, text, keyboard = null) {
  const options = {
    parse_mode: "HTML",
  };

  if (keyboard) {
    options.reply_markup = keyboard.reply_markup;
  }

  try {
    // Always edit the callback message.
    if (
      ctx.callbackQuery &&
      ctx.callbackQuery.message
    ) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        undefined,
        text,
        options
      );
      return true;
    }

    // Fallback for normal messages.
    if (ctx.message) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.message.message_id,
        undefined,
        text,
        options
      );
      return true;
    }

    return false;

  } catch (err) {
    const msg = String(
      err.message || ""
    ).toLowerCase();

    // These are harmless Telegram errors.
    if (
      msg.includes("message is not modified") ||
      msg.includes("query is too old") ||
      msg.includes("query id is invalid") ||
      msg.includes("message can't be edited")
    ) {
      return false;
    }

    logger.error(
      "editScreen failed:",
      err
    );

    return false;
  }
}

async function answer(ctx, text = "") {
  try {
    await ctx.answerCbQuery(text);
  } catch (_) {}
}

// ------------------------------------------------------------
// Persistent Grizzly API cache
// ------------------------------------------------------------

function ensureCacheDir() {
  const dir = path.dirname(PRICE_CACHE_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {
      recursive: true,
    });
  }
}

function readPriceCache() {
  try {
    if (!fs.existsSync(PRICE_CACHE_FILE)) {
      return null;
    }

    const raw = fs.readFileSync(
      PRICE_CACHE_FILE,
      "utf8"
    );

    const data = JSON.parse(raw);

    if (!data || typeof data !== "object") {
      return null;
    }

    return data;
  } catch (err) {
    logger.warn(
      "Unable to read Server 1 price cache"
    );

    return null;
  }
}

function savePriceCache(prices) {
  try {
    ensureCacheDir();

    fs.writeFileSync(
      PRICE_CACHE_FILE,
      JSON.stringify(
        {
          cachedAt: Date.now(),
          prices,
        },
        null,
        2
      )
    );
  } catch (err) {
    logger.warn(
      "Unable to save Server 1 price cache"
    );
  }
}

async function getCachedGrizzlyPrices() {
  const cached = readPriceCache();

  // ----------------------------------------------------------
  // Fresh local cache = instant response
  // ----------------------------------------------------------
  if (
    cached &&
    cached.cachedAt &&
    cached.prices &&
    Date.now() - Number(cached.cachedAt) < CACHE_TTL
  ) {
    return {
      prices: cached.prices,
      fromCache: true,
      stale: false,
    };
  }

  // ----------------------------------------------------------
  // If another user is already fetching Grizzly,
  // reuse that same request.
  // ----------------------------------------------------------
  if (!grizzlyFetchPromise) {
    grizzlyFetchPromise = (async () => {
      logger.info(
        "Server 1: fetching Grizzly TG prices..."
      );

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          const err = new Error(
            "GRIZZLY_API_TIMEOUT"
          );
          err.code = "GRIZZLY_API_TIMEOUT";
          reject(err);
        }, GRIZZLY_TIMEOUT);
      });

      try {
        const prices = await Promise.race([
          getPrices(),
          timeoutPromise,
        ]);

        savePriceCache(prices);

        logger.info(
          "Server 1: Grizzly prices cached successfully"
        );

        return {
          prices,
          fromCache: false,
          stale: false,
        };

      } finally {
        grizzlyFetchPromise = null;
      }
    })();
  }

  // ----------------------------------------------------------
  // Wait for shared request
  // ----------------------------------------------------------
  try {
    return await grizzlyFetchPromise;

  } catch (err) {

    // --------------------------------------------------------
    // API failed but old cache exists.
    // Use old cache instead of breaking Server 1.
    // --------------------------------------------------------
    if (
      cached &&
      cached.prices
    ) {
      logger.warn(
        "Grizzly API failed; using stale Server 1 cache"
      );

      return {
        prices: cached.prices,
        fromCache: true,
        stale: true,
      };
    }

    throw err;
  }
}

// ------------------------------------------------------------
// Extract TG price from Grizzly response
// ------------------------------------------------------------

function getGrizzlyTGItem(
  root,
  countryCode
) {
  if (!root || !countryCode) {
    return null;
  }

  const code = String(countryCode);

  const candidates = [];

  // Grizzly getPrices() format:
  // {
  //   "countryCode": {
  //     "count": 123,
  //     "cost": 0.42,
  //     "retry": 0
  //   }
  // }
  if (
    root[code] &&
    typeof root[code] === "object"
  ) {
    candidates.push(
      root[code]
    );
  }

  // Also support nested formats.
  if (
    root[code] &&
    root[code].tg
  ) {
    candidates.push(
      root[code].tg
    );
  }

  if (
    root[`${code}.tg`]
  ) {
    candidates.push(
      root[`${code}.tg`]
    );
  }

  if (
    root[`${code}:tg`]
  ) {
    candidates.push(
      root[`${code}:tg`]
    );
  }

  if (
    root.tg &&
    root.tg[code]
  ) {
    candidates.push(
      root.tg[code]
    );
  }

  const item = candidates.find(
    (x) =>
      x &&
      (
        Number.isFinite(Number(x.cost)) ||
        Number.isFinite(Number(x.count))
      )
  );

  return item || null;
}

// ------------------------------------------------------------
// 🔄 Convert Grizzly price response to sync items

// ------------------------------------------------------------
// 🔴 LIVE BUY PRICE
// Price/stock are checked ONLY when Buy Now is clicked.
// No Firestore read/write is performed for provider pricing.
// ------------------------------------------------------------
async function getLiveGrizzlyTelegramPrice(countryCode) {
  const code = String(countryCode || "").trim();
  if (!code) {
    const err = new Error("GRIZZLY_COUNTRY_CODE_REQUIRED");
    err.code = "GRIZZLY_COUNTRY_CODE_REQUIRED";
    throw err;
  }

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      const err = new Error("GRIZZLY_API_TIMEOUT");
      err.code = "GRIZZLY_API_TIMEOUT";
      reject(err);
    }, GRIZZLY_TIMEOUT);
  });

  const prices = await Promise.race([
    getPrices(),
    timeoutPromise,
  ]);

  const item = getGrizzlyTGItem(prices, code);

  if (!item) {
    const err = new Error("GRIZZLY_PRICE_NOT_FOUND");
    err.code = "GRIZZLY_PRICE_NOT_FOUND";
    throw err;
  }

  const costUsd = Number(item.cost);
  const count = Number(item.count || 0);
  const retry = Number(item.retry || 0);

  if (!Number.isFinite(costUsd) || costUsd <= 0) {
    const err = new Error("GRIZZLY_INVALID_PRICE");
    err.code = "GRIZZLY_INVALID_PRICE";
    throw err;
  }

  return {
    costUsd,
    count: Number.isFinite(count) ? count : 0,
    retry: Number.isFinite(retry) ? retry : 0,
  };
}


// ------------------------------------------------------------

function buildGrizzlyPriceItems(root, countries = []) {
  const items = [];

  if (!root || typeof root !== "object") {
    return items;
  }

  for (const country of countries) {
    const countryCode = String(
      country.countryCode || ""
    ).trim();

    if (!countryCode) {
      continue;
    }

    const liveItem =
      getGrizzlyTGItem(
        root,
        countryCode
      );

    if (!liveItem) {
      continue;
    }

    const cost =
      Number(liveItem.cost);

    if (
      !Number.isFinite(cost) ||
      cost < 0
    ) {
      continue;
    }

    items.push({
      countryCode,
      cost,
      count: Number(
        liveItem.count || 0
      ),
      retry: Number(
        liveItem.retry || 0
      ),
    });
  }

  return items;
}

// ------------------------------------------------------------
// Load complete Server 1 catalog
// ------------------------------------------------------------


// ------------------------------------------------------------
// Automatic country ranking
// ------------------------------------------------------------

function rankServer1Catalog(
  catalog,
  salesStats = {}
) {
  return [...catalog].sort((a, b) => {

    const aName = String(
      a.countryName || ""
    ).toLowerCase();

    const bName = String(
      b.countryName || ""
    ).toLowerCase();

    const aId = String(
      a.countryId || ""
    );

    const bId = String(
      b.countryId || ""
    );

    // --------------------------------------------------------
    // INDIA = permanent top priority
    // --------------------------------------------------------

    const aIndia =
      aName === "india" ||
      aId === "india";

    const bIndia =
      bName === "india" ||
      bId === "india";

    if (aIndia && !bIndia) {
      return -1;
    }

    if (!aIndia && bIndia) {
      return 1;
    }

    // --------------------------------------------------------
    // Sales count
    // --------------------------------------------------------

    const aSales =
      Number(
        salesStats[aId]?.sales || 0
      );

    const bSales =
      Number(
        salesStats[bId]?.sales || 0
      );

    const aScore =
      Number(
        salesStats[aId]?.score || 0
      );

    const bScore =
      Number(
        salesStats[bId]?.score || 0
      );

    // Recent successful sales have more influence.
    if (
      Math.abs(aScore - bScore) > 0.01
    ) {
      return bScore - aScore;
    }

    // Total successful sales as secondary signal.
    if (aSales !== bSales) {
      return bSales - aSales;
    }

    // --------------------------------------------------------
    // Cheapest first when popularity is equal
    // --------------------------------------------------------

    const aPrice =
      Number(a.finalPrice || 0);

    const bPrice =
      Number(b.finalPrice || 0);

    if (aPrice !== bPrice) {
      return aPrice - bPrice;
    }

    // --------------------------------------------------------
    // Stable alphabetical fallback
    // --------------------------------------------------------

    return String(
      a.countryName || ""
    ).localeCompare(
      String(b.countryName || "")
    );
  });
}

async function getCachedServer1SalesStats() {
  // 1. Memory cache
  if (
    server1SalesMemory &&
    Date.now() - server1SalesMemoryAt < SALES_CACHE_TTL
  ) {
    return server1SalesMemory;
  }

  // 2. JSON cache
  try {
    if (fs.existsSync(SALES_CACHE_FILE)) {
      const cached = JSON.parse(
        fs.readFileSync(SALES_CACHE_FILE, "utf8")
      );

      if (
        cached &&
        cached.stats &&
        typeof cached.stats === "object" &&
        cached.cachedAt &&
        Date.now() - Number(cached.cachedAt) < SALES_CACHE_TTL
      ) {
        server1SalesMemory = cached.stats;
        server1SalesMemoryAt = Date.now();

        return server1SalesMemory;
      }
    }
  } catch (err) {
    logger.warn(
      "Server 1 sales cache read failed:",
      err.message
    );
  }

  // 3. Firestore fallback
  const stats = await getServer1CountrySalesStats();

  server1SalesMemory = stats;
  server1SalesMemoryAt = Date.now();

  // 4. Persist locally
  try {
    ensureCacheDir();

    fs.writeFileSync(
      SALES_CACHE_FILE,
      JSON.stringify(
        {
          cachedAt: Date.now(),
          stats,
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (err) {
    logger.warn(
      "Server 1 sales cache write failed:",
      err.message
    );
  }

  return stats;
}

function invalidateServer1CatalogCache() {
  server1CatalogMemory = null;
  server1CatalogMemoryAt = 0;

  // Also remove the persistent JSON cache so admin product
  // changes are visible immediately on the next catalog load.
  try {
    if (fs.existsSync(CATALOG_CACHE_FILE)) {
      fs.unlinkSync(CATALOG_CACHE_FILE);
    }
  } catch (err) {
    logger.warn(
      "Server 1 catalog cache invalidation failed:",
      err.message
    );
  }
}

async function loadServer1Catalog(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);

  // ----------------------------------------------------------
  // ⚡ USER-FACING CATALOG
  // ----------------------------------------------------------
  // User requests NEVER call Grizzly directly.
  // Memory -> JSON -> Firestore is the only path.
  // ----------------------------------------------------------

  if (!forceRefresh) {
    // 1. Memory cache
    if (
      server1CatalogMemory &&
      Date.now() - server1CatalogMemoryAt <
        SERVER1_CATALOG_MEMORY_TTL
    ) {
      return server1CatalogMemory;
    }

    // 2. Local JSON cache
    try {
      if (fs.existsSync(CATALOG_CACHE_FILE)) {
        const cached = JSON.parse(
          fs.readFileSync(CATALOG_CACHE_FILE, "utf8")
        );

        if (
          cached &&
          Array.isArray(cached.catalog) &&
          cached.catalog.length
        ) {
          const result = {
            catalog: cached.catalog,
            fromCache: true,
            stale: false,
          };

          server1CatalogMemory = result;
          server1CatalogMemoryAt = Date.now();

          return result;
        }
      }
    } catch (err) {
      logger.warn(
        "Server 1 catalog JSON cache read failed:",
        err.message
      );
    }
  }

  // ----------------------------------------------------------
  // 🗄️ DATABASE FALLBACK
  // ----------------------------------------------------------
  // No provider API here.
  // Prices come directly from Firestore product documents.
  // ----------------------------------------------------------

  const [products, countries, pricingSettings] = await Promise.all([
    db.listProducts({
      onlyEnabled: true,
    }),

    db.listServer1Countries({
      onlyEnabled: true,
    }),

    db.getSettings(),
  ]);

  server1PricingSignature =
    getServer1PricingSignature(pricingSettings);

  const countryMap = new Map();

  for (const country of countries) {
    countryMap.set(
      String(country.id),
      country
    );
  }

  const catalog = [];

  for (const product of products) {
    if (product.status !== "enabled") {
      continue;
    }

    if (product.serviceCode !== "tg") {
      continue;
    }

    const country = countryMap.get(
      String(product.countryId)
    );

    if (!country) {
      continue;
    }

    // Products use the Admin global pricing by default.
    // An admin editing an individual product margin explicitly sets
    // useGlobalPricing=false, preserving that product-specific override.
    const useGlobalPricing =
      product.useGlobalPricing !== false;

    const usdRate = useGlobalPricing
      ? Number(pricingSettings.usdRate || 105)
      : Number(product.usdRate || 105);

    const marginPercent = useGlobalPricing
      ? Number(pricingSettings.profit || 0)
      : Number(product.marginPercent || 0);

    const providerUsdPrice =
      Number(product.providerUsdPrice || 0);

    const costInr =
      Number(product.costInr || 0);

    const finalPrice =
      Number(product.finalPrice || 0);

    catalog.push({
      ...product,

      countryId:
        product.countryId,

      countryName:
        country.countryName ||
        country.name ||
        "Unknown",

      countryCode:
        country.countryCode || "",

      emoji:
        country.emoji ||
        "🌍",

      providerUsdPrice,
      apiCost:
        providerUsdPrice,

      costInr,
      usdRate,
      marginPercent,
      finalPrice,

      // These values are maintained by the
      // background Grizzly synchronization.
      apiCount:
        Number(product.apiCount || 0),

      apiRetry:
        Number(product.apiRetry || 0),

      cacheAt:
        Number(product.cacheAt || Date.now()),

      cacheStale:
        Boolean(product.cacheStale),
    });
  }

  // ----------------------------------------------------------
  // 📊 SALES RANKING
  // ----------------------------------------------------------
  // Only used when rebuilding the catalog.
  // Normal user navigation uses the saved JSON/memory cache.
  // ----------------------------------------------------------

  let salesStats = {};

  try {
    salesStats =
      await getCachedServer1SalesStats();
  } catch (err) {
    logger.warn(
      "Server 1 sales stats unavailable:",
      err.message
    );
  }

  catalog.forEach((item) => {
    const id =
      String(item.countryId || "");

    const stats =
      salesStats[id] || {};

    item.salesCount =
      Number(stats.sales || 0);

    item.salesScore =
      Number(stats.score || 0);
  });

  // ----------------------------------------------------------
  // 🏆 RANKING
  // ----------------------------------------------------------

  catalog.sort((a, b) => {
    const aName =
      String(a.countryName || "")
        .toLowerCase();

    const bName =
      String(b.countryName || "")
        .toLowerCase();

    const aIndia =
      aName === "india" ||
      String(a.countryCode || "")
        .toLowerCase() === "in";

    const bIndia =
      bName === "india" ||
      String(b.countryCode || "")
        .toLowerCase() === "in";

    if (aIndia && !bIndia) return -1;
    if (!aIndia && bIndia) return 1;

    const aScore =
      Number(a.salesScore || 0);

    const bScore =
      Number(b.salesScore || 0);

    if (
      Math.abs(aScore - bScore) > 0.01
    ) {
      return bScore - aScore;
    }

    const aSales =
      Number(a.salesCount || 0);

    const bSales =
      Number(b.salesCount || 0);

    if (aSales !== bSales) {
      return bSales - aSales;
    }

    const aPrice =
      Number(a.finalPrice || 0);

    const bPrice =
      Number(b.finalPrice || 0);

    if (
      Number.isFinite(aPrice) &&
      Number.isFinite(bPrice) &&
      aPrice !== bPrice
    ) {
      return aPrice - bPrice;
    }

    const aStock =
      Number(a.apiCount || 0);

    const bStock =
      Number(b.apiCount || 0);

    if (aStock !== bStock) {
      return bStock - aStock;
    }

    return aName.localeCompare(bName);
  });

  // ----------------------------------------------------------
  // 💾 SAVE LOCAL CATALOG CACHE
  // ----------------------------------------------------------

  try {
    fs.mkdirSync(
      path.dirname(CATALOG_CACHE_FILE),
      { recursive: true }
    );

    fs.writeFileSync(
      CATALOG_CACHE_FILE,
      JSON.stringify(
        {
          catalog,
          cachedAt: Date.now(),
        },
        null,
        2
      ),
      "utf8"
    );

    logger.info(
      `Server 1 catalog JSON cache updated: ${catalog.length} products`
    );
  } catch (err) {
    logger.warn(
      "Server 1 catalog JSON cache write failed:",
      err.message
    );
  }

  const result = {
    catalog,
    fromCache: false,
    stale: false,
  };

  server1CatalogMemory = result;
  server1CatalogMemoryAt = Date.now();

  return result;
}

// ------------------------------------------------------------
// 🔄 SERVER 1 BACKGROUND AUTO REFRESH
// ------------------------------------------------------------

const SERVER1_AUTO_REFRESH_INTERVAL = 10 * 60 * 1000;

let server1AutoRefreshTimer = null;

async function syncServer1PricesInBackground() {
  logger.info(
    "Server 1 background price sync started"
  );

  try {
    // ----------------------------------------------------------
    // 1. Get latest provider prices from Grizzly.
    // ----------------------------------------------------------
    const priceResult =
      await getCachedGrizzlyPrices();

    const root =
      priceResult.prices &&
      typeof priceResult.prices === "object"
        ? priceResult.prices
        : {};

    // ----------------------------------------------------------
    // 2. Load existing local catalog cache.
    //
    // Normal background refreshes use this cache instead of
    // reading all Server 1 countries/products from Firestore.
    // ----------------------------------------------------------
    let cachedCatalog = null;

    if (
      server1CatalogMemory &&
      Array.isArray(server1CatalogMemory.catalog) &&
      server1CatalogMemory.catalog.length
    ) {
      cachedCatalog =
        server1CatalogMemory.catalog;
    }

    if (!cachedCatalog && fs.existsSync(CATALOG_CACHE_FILE)) {
      try {
        const cached = JSON.parse(
          fs.readFileSync(
            CATALOG_CACHE_FILE,
            "utf8"
          )
        );

        if (
          cached &&
          Array.isArray(cached.catalog) &&
          cached.catalog.length
        ) {
          cachedCatalog = cached.catalog;
        }
      } catch (cacheErr) {
        logger.warn(
          "Server 1 background catalog cache read failed:",
          cacheErr.message
        );
      }
    }

    // ----------------------------------------------------------
    // 3. Build unique country list from local catalog cache.
    //
    // The catalog already contains countryId, countryCode,
    // countryName and emoji.
    // ----------------------------------------------------------
    let countries = [];

    if (
      Array.isArray(cachedCatalog) &&
      cachedCatalog.length
    ) {
      const countryMap = new Map();

      for (const item of cachedCatalog) {
        if (!item) continue;

        const countryId = String(
          item.countryId || ""
        ).trim();

        const countryCode = String(
          item.countryCode || ""
        ).trim();

        if (!countryId || !countryCode) {
          continue;
        }

        if (!countryMap.has(countryId)) {
          countryMap.set(countryId, {
            id: countryId,
            countryName:
              item.countryName ||
              item.name ||
              "Unknown",
            name:
              item.countryName ||
              item.name ||
              "Unknown",
            countryCode,
            emoji:
              item.emoji ||
              "🌍",
            status: "enabled",
            provider: "grizzly",
          });
        }
      }

      countries = Array.from(countryMap.values());
    }

    // ----------------------------------------------------------
    // 4. Fallback only when local catalog cache is unavailable.
    //
    // This keeps the system recoverable after a fresh deployment
    // or cache loss.
    // ----------------------------------------------------------
    if (!countries.length) {
      countries =
        await db.listServer1Countries({
          onlyEnabled: true,
        });
    }

    const countryCodeById = new Map();

    for (const country of countries) {
      countryCodeById.set(
        String(country.id),
        String(
          country.countryCode || ""
        ).trim()
      );
    }

    const priceItems =
      buildGrizzlyPriceItems(
        root,
        countries
      );

    if (!priceItems.length) {
      logger.warn(
        "Server 1 background price sync: no valid Grizzly prices found"
      );
      return;
    }

    // ----------------------------------------------------------
    // 5. Compare provider prices against local catalog cache.
    //
    // Firestore is used only for actual changed prices.
    // ----------------------------------------------------------
    const result =
      await syncServer1ProviderPrices(
        priceItems,
        countryCodeById,
        cachedCatalog
      );

    logger.info(
      `Server 1 background price sync completed: checked=${result.checked}, changed=${result.changed}, unchanged=${result.unchanged}, stockChanged=${result.stockChanged || 0}`
    );

    // ----------------------------------------------------------
    // 6. Update local catalog cache with latest provider
    // price/stock/retry information.
    // ----------------------------------------------------------
    if (
      result.changed > 0 ||
      Number(result.stockChanged || 0) > 0
    ) {
      try {
        if (!Array.isArray(cachedCatalog)) {
          logger.warn(
            "Server 1 catalog cache unavailable; provider sync saved to Firestore where required"
          );
          return server1CatalogMemory;
        }

        const providerById = new Map();

        for (
          const item of result.providerProducts || []
        ) {
          providerById.set(
            String(item.productId),
            item
          );
        }

        const changedById = new Map();

        for (
          const item of result.changedProducts || []
        ) {
          changedById.set(
            String(item.productId),
            item
          );
        }

        let cacheChanged = false;

        for (const product of cachedCatalog) {
          const productId = String(
            product.id ||
            product.productId ||
            ""
          );

          const provider =
            providerById.get(productId);

          if (!provider) {
            continue;
          }

          const priceChange =
            changedById.get(productId);

          if (priceChange) {
            product.providerUsdPrice =
              Number(
                priceChange.providerUsdPrice || 0
              );

            product.apiCost =
              Number(
                priceChange.providerUsdPrice || 0
              );

            product.costInr =
              Number(
                priceChange.costInr || 0
              );

            product.finalPrice =
              Number(
                priceChange.finalPrice || 0
              );

            cacheChanged = true;
          }

          const newCount =
            Number(provider.apiCount || 0);

          const newRetry =
            Number(provider.apiRetry || 0);

          if (
            Number(product.apiCount || 0) !==
              newCount ||
            Number(product.apiRetry || 0) !==
              newRetry
          ) {
            product.apiCount = newCount;
            product.apiRetry = newRetry;
            cacheChanged = true;
          }

          product.cacheAt = Date.now();
          product.cacheStale = false;
        }

        if (cacheChanged) {
          cachedCatalog.sort((a, b) => {
            const aName =
              String(
                a.countryName || ""
              ).toLowerCase();

            const bName =
              String(
                b.countryName || ""
              ).toLowerCase();

            const aIndia =
              aName === "india" ||
              String(
                a.countryCode || ""
              ).toLowerCase() === "in";

            const bIndia =
              bName === "india" ||
              String(
                b.countryCode || ""
              ).toLowerCase() === "in";

            if (aIndia && !bIndia) return -1;
            if (!aIndia && bIndia) return 1;

            const aScore =
              Number(a.salesScore || 0);

            const bScore =
              Number(b.salesScore || 0);

            if (
              Math.abs(aScore - bScore) > 0.01
            ) {
              return bScore - aScore;
            }

            const aSales =
              Number(a.salesCount || 0);

            const bSales =
              Number(b.salesCount || 0);

            if (aSales !== bSales) {
              return bSales - aSales;
            }

            const aPrice =
              Number(a.finalPrice || 0);

            const bPrice =
              Number(b.finalPrice || 0);

            if (
              Number.isFinite(aPrice) &&
              Number.isFinite(bPrice) &&
              aPrice !== bPrice
            ) {
              return aPrice - bPrice;
            }

            const aStock =
              Number(a.apiCount || 0);

            const bStock =
              Number(b.apiCount || 0);

            if (aStock !== bStock) {
              return bStock - aStock;
            }

            return aName.localeCompare(bName);
          });

          const cacheResult = {
            catalog: cachedCatalog,
            fromCache: true,
            stale: false,
          };

          server1CatalogMemory =
            cacheResult;

          server1CatalogMemoryAt =
            Date.now();

          fs.mkdirSync(
            path.dirname(
              CATALOG_CACHE_FILE
            ),
            { recursive: true }
          );

          fs.writeFileSync(
            CATALOG_CACHE_FILE,
            JSON.stringify(
              {
                catalog: cachedCatalog,
                cachedAt: Date.now(),
              },
              null,
              2
            ),
            "utf8"
          );

          logger.info(
            `Server 1 catalog cache updated: priceChanges=${result.changed}, stockChanges=${result.stockChanged || 0}`
          );
        }
      } catch (cacheErr) {
        logger.warn(
          "Server 1 direct catalog cache update failed:",
          cacheErr.message
        );
      }
    }

    return server1CatalogMemory;
  } catch (err) {
    logger.warn(
      "Server 1 background price sync failed:",
      err.message
    );
    return null;
  }
}

function startServer1AutoRefresh() {
  if (server1AutoRefreshTimer) {
    return;
  }

  logger.info(
    "Server 1 automatic background price sync started"
  );

  server1AutoRefreshTimer =
    setInterval(async () => {
      if (server1BackgroundRefreshPromise) {
        logger.info(
          "Server 1 background sync already running, skipping"
        );
        return;
      }

      server1BackgroundRefreshPromise =
        syncServer1PricesInBackground()
          .finally(() => {
            server1BackgroundRefreshPromise =
              null;
          });
    }, SERVER1_AUTO_REFRESH_INTERVAL);
}

let server1LoadingGeneration = 0;

let server1PricingSignature = "";

function getServer1PricingSignature(settings = {}) {
  return [
    Number(settings.usdRate || 105),
    Number(settings.profit || 0),
  ].join("|");
}

function invalidateServer1CatalogCache() {
  server1CatalogMemory = null;
  server1CatalogMemoryAt = 0;

  try {
    if (fs.existsSync(CATALOG_CACHE_FILE)) {
      fs.unlinkSync(CATALOG_CACHE_FILE);
    }
  } catch (err) {
    logger.warn(
      "Server 1 pricing cache invalidation failed:",
      err.message
    );
  }
}



// ------------------------------------------------------------
// Loading animation
// ------------------------------------------------------------

async function loadWithAnimation(ctx, loader) {
  // Every new Server 1 loading request gets its own generation.
  // If another navigation starts, the old loading UI becomes invalid.
  const myGeneration = ++server1LoadingGeneration;

  let cancelled = false;

  const loadingTimer = setTimeout(async () => {
    if (cancelled) return;

    // Another page/request started while we were loading.
    if (myGeneration !== server1LoadingGeneration) {
      return;
    }

    try {
      await editScreen(
        ctx,
        `🖥️ <b>SERVER 1</b>
━━━━━━━━━━━━━━━━━━

⚡ <b>Preparing catalog...</b>
🌍 <b>Syncing availability</b>

⏳ <i>Please wait...</i>`
      );
    } catch (_) {}
  }, 250);

  try {
    const result = await loader();

    // Loading finished, but another navigation may have happened.
    // Do not allow old Server 1 code to continue updating the screen.
    if (myGeneration !== server1LoadingGeneration) {
      return result;
    }

    return result;
  } finally {
    cancelled = true;
    clearTimeout(loadingTimer);
  }
}

function getInstantServer1Catalog() {
  if (
    server1CatalogMemory &&
    Array.isArray(server1CatalogMemory.catalog) &&
    server1CatalogMemory.catalog.length
  ) {
    return server1CatalogMemory;
  }

  try {
    if (fs.existsSync(CATALOG_CACHE_FILE)) {
      const cached = JSON.parse(
        fs.readFileSync(CATALOG_CACHE_FILE, "utf8")
      );

      if (
        cached &&
        Array.isArray(cached.catalog) &&
        cached.catalog.length
      ) {
        const result = {
          catalog: cached.catalog,
          fromCache: true,
          stale: false,
        };

        server1CatalogMemory = result;
        server1CatalogMemoryAt = Date.now();
        return result;
      }
    }
  } catch (err) {
    logger.warn("Server 1 instant catalog cache read failed:", err.message);
  }

  return null;
}

// ------------------------------------------------------------
// Main menu
// ------------------------------------------------------------

function mainKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🏠 Main Menu",
            callback_data:
              "menu_home",
          },
        ],
      ],
    },
  };
}

// ------------------------------------------------------------
// Product list keyboard
// ------------------------------------------------------------

function productListKeyboard(
  catalog,
  page = 1
) {
  const total = catalog.length;

  const totalPages = Math.max(
    1,
    Math.ceil(total / PAGE_SIZE)
  );

  page = Math.max(
    1,
    Math.min(
      Number(page) || 1,
      totalPages
    )
  );

  const start =
    (page - 1) * PAGE_SIZE;

  const items = catalog.slice(
    start,
    start + PAGE_SIZE
  );

  const rows = [];

  // ============================================================
  // COUNTRY BUTTONS
  // 2 countries per row
  // ============================================================

  for (let i = 0; i < items.length; i += 2) {
    const row = [];

    for (
      let j = i;
      j < i + 2 && j < items.length;
      j++
    ) {
      const product = items[j];

      const price = Number(
        product.finalPrice || 0
      ).toFixed(2);

      const code =
        String(product.countryCode || "")
          .toUpperCase();

      let badge = "";

      // India badge
      if (code === "IN") {
        badge = " 🇮🇳";
      }

      // Best seller badge
      else if (
        Number(product.sales || 0) > 0
      ) {
        badge = " 🔥";
      }

      // Cheapest badge
      else if (
        Number(product.finalPrice || 0) > 0
      ) {
        badge = " 💰";
      }

      const countryName = String(
        product.countryName ||
        product.name ||
        "Unknown"
      )
        .replace(/^🌍\s*/u, "")
        .replace(/^Telegram\s*/i, "")
        .trim();

      const text =
        `${product.emoji || "🌍"} ` +
        `${countryName}` +
        `${badge} ` +
        `₹${price}`;

      row.push({
        text,
        callback_data:
          `server1:product:${product.id}`,
      });
    }

    rows.push(row);
  }

  // ============================================================
  // PAGINATION
  // ============================================================

  const nav = [];

  if (page > 1) {
    nav.push({
      text: "⬅️ Previous",
      callback_data:
        `server1:page:${page - 1}`,
    });
  }

  nav.push({
    text:
      `📄 ${page}/${totalPages}`,
    callback_data:
      "server1:noop",
  });

  if (page < totalPages) {
    nav.push({
      text: "Next ➡️",
      callback_data:
        `server1:page:${page + 1}`,
    });
  }

  rows.push(nav);

  // ============================================================
  // SEARCH
  // ============================================================

  rows.push([
    {
      text: "🔎 Search Country",
      callback_data:
        "server1:search",
    },
  ]);

  // ============================================================
  // FOOTER
  // ============================================================

  rows.push([
    {
      text: "⬅️ Back",
      callback_data:
        "menu_buy",
    },
    {
      text: "🏠 Main Menu",
      callback_data:
        "menu_home",
    },
  ]);

  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

// ------------------------------------------------------------
// Product details

// ------------------------------------------------------------

function productDetailKeyboard(product) {
  const stock =
    Number.isFinite(Number(product.apiCount))
      ? Number(product.apiCount)
      : 0;

  const rows = [];

  // Buy button ONLY when live stock is available.
  if (stock > 0) {
    rows.push([
      {
        text: "🛒 Buy Now",
        callback_data:
          `server1:buy:${product.id}`,
      },
    ]);
  }

  // Product list
  rows.push([
    {
      text: "⬅️ Product List",
      callback_data: "server1:menu",
    },
  ]);

  // Main menu
  rows.push([
    {
      text: "🏠 Main Menu",
      callback_data: "menu_home",
    },
  ]);

  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

// ------------------------------------------------------------
// Register handlers
// ------------------------------------------------------------



function registerServer1Handler(bot) {

  // Make the Telegram bot available to the background Server 1 monitor.
  global.__SERVER1_BOT__ = bot;

  // Server 1 provider pricing is checked live only on Buy Now.
  // No background Grizzly price polling.
  // ==========================================================
  // SERVER 1 OPEN
  // ==========================================================

  bot.action(
    "server1:menu",
    async (ctx) => {

      try {

        // Acknowledge Telegram callback immediately.
        await answer(ctx);

        // Server 1 can be disabled from Admin Settings at any time.
        // Settings are cached, so this check is fast and does not hit D1
        // on every click when the cache is warm.
        const server1Settings = await db.getSettings();

        const pricingSignature =
          getServer1PricingSignature(server1Settings);

        const pricingChanged =
          server1PricingSignature &&
          server1PricingSignature !== pricingSignature;

        if (pricingChanged) {
          invalidateServer1CatalogCache();
        }

        server1PricingSignature = pricingSignature;

        if (server1Settings.server1Enabled === false) {
          await editScreen(
            ctx,
            "🖥️ <b>Server 1</b>\n\n🔴 Server 1 is currently disabled.",
            mainKeyboard()
          );
          return;
        }

        const instant =
          pricingChanged
            ? null
            : getInstantServer1Catalog();

        if (!instant) {
          await editScreen(
            ctx,
            `🖥️ <b>Server 1</b>\n\n⏳ Preparing catalog...`,
            mainKeyboard()
          ).catch(() => {});

          setImmediate(async () => {
            try {
              const result = await loadServer1Catalog();
              const { catalog, fromCache, stale } = result;

              if (!catalog.length) {
                await editScreen(
                  ctx,
                  `🖥️ <b>Server 1</b>\n\n📱 <b>Telegram</b>\n\n❌ No products available.`,
                  mainKeyboard()
                );
                return;
              }

              const totalPages = Math.max(1, Math.ceil(catalog.length / PAGE_SIZE));
              let cacheText = fromCache ? "⚡ Cached" : "🌐 Live";
              if (stale) cacheText = "⚡ Cached (offline)";

              await editScreen(
                ctx,
                `🖥️ <b>Server 1</b>\n\n📱 <b>Telegram</b>\n\n🌍 Total: <b>${catalog.length}</b>\n📄 Page: <b>1/${totalPages}</b>\n⚡ Data: <b>${cacheText}</b>\n\nSelect your country:`,
                productListKeyboard(catalog, 1)
              );
            } catch (err) {
              logger.error("Background Server 1 catalog load failed", err);
              await editScreen(
                ctx,
                `🖥️ <b>Server 1</b>\n\n⚠️ Catalog is temporarily unavailable.\nPlease try again shortly.`,
                mainKeyboard()
              ).catch(() => {});
            }
          });

          return;
        }

        const { catalog, fromCache, stale } = instant;
        const totalPages = Math.max(1, Math.ceil(catalog.length / PAGE_SIZE));
        let cacheText = fromCache ? "⚡ Cached" : "🌐 Live";
        if (stale) cacheText = "⚡ Cached (offline)";

        await editScreen(
          ctx,
          `🖥️ <b>Server 1</b>\n\n📱 <b>Telegram</b>\n\n🌍 Total: <b>${catalog.length}</b>\n📄 Page: <b>1/${totalPages}</b>\n⚡ Data: <b>${cacheText}</b>\n\nSelect your country:`,
          productListKeyboard(catalog, 1)
        );

        // Refresh the cache in the background; never block navigation.
        setImmediate(() => {
          loadServer1Catalog().catch((err) => {
            logger.warn("Background Server 1 catalog refresh failed:", err.message);
          });
        });

      } catch (err) {

        logger.error(
          "Error in server1:menu",
          err
        );

        await answer(
          ctx,
          "Server 1 unavailable."
        );
      }
    }
  );

  // ==========================================================
  // PAGINATION
  // ==========================================================

  bot.action(
    /^server1:page:(\d+)$/,
    async (ctx) => {

      try {

        await answer(ctx);

        const page =
          Number(
            ctx.match[1]
          ) || 1;

        await editScreen(
          ctx,
          `🖥️ <b>Server 1</b>\n\n` +
          `⏳ <b>Loading page ${page}...</b>`
        );

        const {
          catalog,
          fromCache,
          stale,
        } =
          await loadServer1Catalog();

        if (!catalog.length) {
          await editScreen(
            ctx,
            `❌ No products available.`,
            mainKeyboard()
          );
          return;
        }

        const totalPages =
          Math.max(
            1,
            Math.ceil(
              catalog.length /
              PAGE_SIZE
            )
          );

        const safePage =
          Math.min(
            Math.max(
              page,
              1
            ),
            totalPages
          );

        let cacheText =
          fromCache
            ? "⚡ Cached"
            : "🌐 Live";

        if (stale) {
          cacheText =
            "⚡ Cached (offline)";
        }

        await editScreen(
          ctx,

          `🖥️ <b>Server 1</b>\n\n` +
          `📱 <b>Telegram</b>\n\n` +
          `🌍 Total: <b>${catalog.length}</b>\n` +
          `📄 Page: <b>${safePage}/${totalPages}</b>\n` +
          `⚡ Data: <b>${cacheText}</b>\n\n` +
          `Select your country:`,

          productListKeyboard(
            catalog,
            safePage
          )
        );

      } catch (err) {

        logger.error(
          "Error in server1 pagination",
          err
        );

        await answer(
          ctx,
          "Unable to load page."
        );
      }
    }
  );

  // ==========================================================
  // NO-OP
  // ==========================================================

  bot.action(
    "server1:noop",
    async (ctx) => {
      await answer(ctx);
    }
  );

  // ==========================================================
  // SEARCH PLACEHOLDER
  // ==========================================================

  bot.action(
    "server1:search",
    async (ctx) => {

      await answer(ctx);

      await ctx.reply(
        `🔎 <b>Search Country</b>\n\n` +
        `Search feature is ready to connect with the bot's text session.`,
        {
          parse_mode: "HTML",
        }
      );
    }
  );

  // ==========================================================
  // PRODUCT DETAILS
  // ==========================================================

  bot.action(
    /^server1:product:(.+)$/,
    async (ctx) => {

      let order = null;

      try {

        await answer(ctx);

        const productId =
          ctx.match[1];

        // Re-check the cached Admin setting before a purchase so a
        // Server 1 disable takes effect even if the user already has
        // an old product screen open.
        const server1Settings = await db.getSettings();
        if (server1Settings.server1Enabled === false) {
          await answer(
            ctx,
            "🔴 Server 1 is currently disabled.",
            true
          );
          return;
        }

        const {
          catalog,
        } =
          getInstantServer1Catalog() || {};

        if (!Array.isArray(catalog) || !catalog.length) {
          await answer(
            ctx,
            "⚠️ Server 1 catalog is temporarily unavailable. Please refresh and try again.",
            true
          );
          return;
        }

        const product =
          catalog.find(
            (p) =>
              String(p.id) ===
              String(productId)
          );

        if (!product) {

          await answer(
            ctx,
            "Product not found."
          );

          return;
        }

        const price =
          Number(
            product.finalPrice || 0
          );

        // Grizzly live stock is the authoritative stock.
        const stock =
          Number.isFinite(
            Number(product.apiCount)
          )
            ? Number(product.apiCount)
            : 0;

        const status =
          stock > 0
            ? "🟢 Available"
            : "🔴 Out of Stock";

        const description =
          String(
            product.description ||
            "Telegram Account • Fast & Reliable"
          );

        await editScreen(
          ctx,

          `📱 <b>Telegram Account</b>\n\n` +

          `${product.emoji || "🌍"} ` +
          `<b>${product.countryName} </b>\n\n` +

          `💰 Price: ` +
          `<b>₹${price.toFixed(2)}</b>\n` +

          `📦 Stock: ` +
          `<b>${stock}</b>\n` +

          `📌 Status: ` +
          `<b>${status}</b>\n\n` +

          `━━━━━━━━━━━━━━\n\n` +

          `📝 <b>Description</b>\n` +

          `${description}\n\n` +

          `⚡ <i>Live availability</i>`,

          productDetailKeyboard(
            {
              ...product,
              apiCount: stock,
            }
          )
        );

      } catch (err) {

        logger.error(
          "Error in server1:product",
          err
        );

        await answer(
          ctx,
          "Unable to load product."
        );
      }
    }
  );

  // ==========================================================
  // BUY
  // ==========================================================

  bot.action(
    /^server1:buy:(.+)$/,
    async (ctx) => {

      try {

        await answer(ctx);

        const productId =
          ctx.match[1];

        // Re-check Server 1 status before starting the live provider request.
        // This also keeps pricing settings available to the Buy flow.
        const server1Settings = await db.getSettings();
        if (server1Settings.server1Enabled === false) {
          await answer(
            ctx,
            "🔴 Server 1 is currently disabled.",
            true
          );
          return;
        }

        const {
          catalog,
        } =
          getInstantServer1Catalog() || {};

        if (!Array.isArray(catalog) || !catalog.length) {
          await answer(
            ctx,
            "⚠️ Server 1 catalog is temporarily unavailable. Please refresh and try again.",
            true
          );
          return;
        }

        const product =
          catalog.find(
            (p) =>
              String(p.id) ===
              String(productId)
          );

        if (!product) {

          await answer(
            ctx,
            "Product not found."
          );

          return;
        }

        // LIVE Grizzly check: provider price + stock are read
        // directly from the API only after Buy Now is clicked.
        let liveProvider;

        try {
          liveProvider =
            await getLiveGrizzlyTelegramPrice(
              product.countryCode
            );
        } catch (err) {
          logger.warn(
            `Server 1 live Grizzly price check failed: country=${product.countryCode}`,
            err.message || err
          );

          await answer(
            ctx,
            "⚠️ Live Grizzly price/stock is temporarily unavailable. Please try again.",
            true
          );
          return;
        }

        if (liveProvider.count < 1) {
          await answer(
            ctx,
            "❌ Out of stock on Grizzly.",
            true
          );
          return;
        }

        // Existing pricing model:
        // Grizzly USD cost -> INR using product's configured USD
        // rate -> configured margin. No Firestore price read.
        const useGlobalPricing =
          product.useGlobalPricing !== false;

        const usdRate = useGlobalPricing
          ? Number(server1Settings.usdRate || 105)
          : Number(product.usdRate) || 105;

        const marginPercent = useGlobalPricing
          ? Number(server1Settings.profit || 0)
          : Number(product.marginPercent) || 0;

        const costInr =
          liveProvider.costUsd * usdRate;

        const price = Number(
          (
            costInr +
            (costInr * marginPercent / 100)
          ).toFixed(2)
        );

        if (!Number.isFinite(price) || price <= 0) {
          await answer(
            ctx,
            "⚠️ Invalid live price.",
            true
          );
          return;
        }

        await editScreen(
          ctx,

          `🛒 <b>Processing Purchase...</b>\n\n` +

          `${product.emoji} ` +
          `<b>${product.countryName}</b>\n` +

          `📱 Service: <b>Telegram</b>\n` +

          `💰 Amount: ` +
          `<b>₹${price.toFixed(2)}</b>\n\n` +

          `⏳ Please wait...`
        );

        order =
          await db.createServer1Order({
            userId:
              String(ctx.from.id),

            productId:
              String(product.id),

            serviceId:
              product.serviceCode || "tg",

            serviceName:
              "Telegram",

            countryId:
              product.countryId,

            countryName:
              product.countryName,

            amount:
             price,

            provider:
              product.providerId ||
              "grizzly",

            status:
              "processing",
          });

        // ----------------------------------------------------------
        // BUY REAL NUMBER FROM GRIZZLY
        // ----------------------------------------------------------
        let activation;

        try {
          activation = await getNumberV2({
            service: product.serviceCode || "tg",
            country: product.countryCode || "",
          });

          // Do not log the raw provider response. It may contain
          // activation/number-related information.
          logger.info(
            `[SERVER1] Grizzly number request completed | order=${order.orderId}`
          );
        } catch (err) {
          logger.error(
            `[SERVER1] Grizzly getNumberV2 request failed | order=${order.orderId}`,
            err
          );

          // A transport/API exception is ambiguous: the provider may
          // have allocated a number even though our request failed.
          // Do NOT automatically refund in this case.
          await db.updateServer1Order(
            order.orderId,
            {
              status: "processing",
              deliveryInfo:
                "Provider request could not be confirmed. Manual review required.",
              processedAt: null,
            }
          );

          await editScreen(
            ctx,
            `❌ <b>Number Purchase Could Not Be Confirmed</b>\n\n` +
            `The provider did not return a confirmed result.\n\n` +
            `⚠️ <b>Your order is under review.</b>\n` +
            `Please contact support if the order does not update automatically.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🏠 Main Menu",
                      callback_data: "menu_home",
                    },
                  ],
                ],
              },
            }
          );

          return;
        }

        // ----------------------------------------------------------
        // GRIZZLY: NO BALANCE
        // ----------------------------------------------------------
        if (
          activation === "NO_BALANCE" ||
          String(activation || "").trim() === "NO_BALANCE"
        ) {
          logger.warn(
            `[SERVER1] NO_BALANCE | order=${order.orderId} | user=${order.userId}`
          );

          let refundResult;

          try {
            refundResult = await db.cancelServer1OrderAndRefund(
              order.orderId,
              "Provider balance unavailable"
            );

            logger.info(
              `[SERVER1] NO_BALANCE REFUND | order=${order.orderId} | amount=${refundResult.refundAmount} | newBalance=${refundResult.newBalance}`
            );
          } catch (refundErr) {
            logger.error(
              `[SERVER1] NO_BALANCE REFUND FAILED | order=${order.orderId}`,
              refundErr
            );

            await editScreen(
              ctx,
              `❌ <b>Number Purchase Failed</b>\n\n` +
              `The provider is currently unavailable.\n\n` +
              `⚠️ Your refund could not be processed automatically.\n` +
              `Please contact support.`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "🏠 Main Menu",
                        callback_data: "menu_home",
                      },
                    ],
                  ],
                },
              }
            );

            return;
          }

          await editScreen(
            ctx,
            `❌ <b>Number Purchase Failed</b>\n\n` +
            `Numbers are temporarily unavailable right now.\n\n` +
            `💰 <b>Refund:</b> ₹${Number(refundResult.refundAmount || price || 0).toFixed(2)}\n` +
            `💳 The amount has been refunded to your wallet.\n\n` +
            `Please try again later.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🔄 Try Again",
                      callback_data: "server1:menu",
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
          );

          return;
        }

        // ----------------------------------------------------------
        // GRIZZLY: NO NUMBERS AVAILABLE
        // ----------------------------------------------------------
        if (
          activation === "NO_NUMBERS" ||
          String(activation || "").trim() === "NO_NUMBERS"
        ) {
          const adminChannel = String(
            process.env.SERVER1_ADMIN_CHANNEL_ID || ""
          ).trim();

          const userId = String(
            order.userId || "N/A"
          );

          const country = String(
            product.countryName ||
            product.countryCode ||
            "Unknown"
          ).replace(/\\s*\\([^)]*\\)/g, "").trim();

          const service = String(
            product.serviceCode || "tg"
          );

          logger.warn(
            `[SERVER1] NO_NUMBERS | country=${country} | service=${service} | user=${userId}`
          );

          // Notify admin channel
          try {
            const bot = global.__SERVER1_BOT__;

            if (bot && adminChannel) {
              await bot.telegram.sendMessage(
                adminChannel,
                `⚠️ <b>NUMBER NOT AVAILABLE</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `📍 <b>Country:</b> ${country}\n` +
                `📱 <b>Service:</b> <code>${service}</code>\n` +
                `👤 <b>User ID:</b> <code>${userId}</code>\n` +
                `🆔 <b>Order ID:</b> <code>${order.orderId}</code>\n` +
                `💰 <b>Amount:</b> ₹${Number(price || 0).toFixed(2)}\n` +
                `❌ <b>Provider:</b> Unavailable\n` +
                `📦 <b>Status:</b> NO_NUMBERS`,
                { parse_mode: "HTML" }
              );
            }
          } catch (notifyErr) {
            logger.error(
              "[SERVER1] Failed to notify admin about NO_NUMBERS",
              notifyErr
            );
          }

          // ----------------------------------------------------
          // NO NUMBERS -> REFUND USER
          // ----------------------------------------------------
          const refundResult =
            await db.cancelServer1OrderAndRefund(
              order.orderId,
              "No numbers available from provider"
            );

          logger.info(
            `[SERVER1] NO_NUMBERS REFUND | order=${order.orderId} | amount=${refundResult.refundAmount} | newBalance=${refundResult.newBalance}`
          );

          await editScreen(
            ctx,
            `❌ <b>Number Not Available</b>\n\n` +
            `Sorry, this country is currently out of stock.\n\n` +
            `💰 <b>Refund:</b> ₹${Number(refundResult.refundAmount || price || 0).toFixed(2)}\n` +
            `💳 The amount has been refunded to your wallet.\n\n` +
            `Please try another country or try again later.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🔄 Try Again",
                      callback_data: "server1:menu",
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
          );

          return;
        }

        // ----------------------------------------------------------
        // INVALID GRIZZLY ACTIVATION RESPONSE
        // ----------------------------------------------------------
        if (
          !activation ||
          typeof activation !== "object" ||
          !activation.activationId ||
          !activation.phoneNumber
        ) {
          throw new Error(
            "INVALID_GRIZZLY_ACTIVATION_RESPONSE"
          );
        }

        // Save real Grizzly activation information.
        const updatedOrder =
          await db.updateServer1Order(
            order.orderId,
            {
              status: "waiting_otp",
              activationId:
                activation.activationId,
              phoneNumber:
                activation.phoneNumber,
              countryCode:
                activation.countryCode || product.countryCode || "",
              activationCost:
                Number(activation.activationCost || 0),
              activationTime:
                activation.activationTime || null,
              activationCancel:
                activation.activationCancel || null,
              activationEnd:
                activation.activationEnd || null,
              canGetAnotherSms:
                activation.canGetAnotherSms || "0",
              deliveryInfo:
                "Number purchased successfully",
              processedAt: null,
            }
          );

        // Save the original purchase message.
        // OTP मिलने पर इसी message को COMPLETED में edit किया जाएगा.
        try {
          const purchaseMessage =
            ctx.callbackQuery?.message || ctx.message;

          if (purchaseMessage?.message_id && ctx.chat?.id) {
            SERVER1_ORDER_UI_MESSAGES.set(
              String(order.orderId),
              {
                chatId: ctx.chat.id,
                messageId: purchaseMessage.message_id,
              }
            );

            logger.info(
              `Server 1 purchase UI saved: order=${order.orderId}, message=${purchaseMessage.message_id}`
            );
          }
        } catch (uiErr) {
          logger.warn(
            `Server 1 purchase UI save failed: order=${order.orderId}`,
            uiErr.message
          );
        }

        // Start automatic OTP monitor.
        // It will detect OTP, provider expiry, timeout and refund when required.
        const otpWaitMinutes =
          Number(
            db.getSettingsSnapshot?.().server1OtpWaitMinutes || 20
          );

        setImmediate(() => {
          monitorServer1Activation({
            orderId: order.orderId,
            activationId: activation.activationId,
            waitMinutes: otpWaitMinutes,
          }).catch((monitorErr) => {
            logger.error(
              `Server 1 OTP monitor crashed: order=${order.orderId}`,
              monitorErr
            );
          });
        });

        await editScreen(
          ctx,

          `📱 <b>NUMBER PURCHASED</b>
` +
          `━━━━━━━━━━━━━━━━━━━━

` +

          `📦 <b>Service:</b>
` +
          `<b>Telegram</b>

` +

          `🌍 <b>Country:</b>
` +
          `<b>${product.countryName} ${getRealCallingCode(activation.phoneNumber)}</b>

` +

          `📞 <b>Number:</b>
` +
          `<code>${activation.phoneNumber}</code>

` +

          `💰 <b>Cost:</b>
` +
          `₹${price.toFixed(2)}

` +

          `⏳ <b>Timeout:</b> ` +
          `${formatCountdown(activation.activationEnd)}
` +

          `❌ <b>Cancel Available In:</b> ` +
          `${formatCountdown(activation.activationCancel)}

` +

          `🕐 <b>Status:</b>
` +
          `<i>Waiting for OTP...</i>`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      (() => {
                        if (!activation.activationCancel) {
                          return "❌ Cancel";
                        }

                        let cancelTime =
                          String(activation.activationCancel).trim();

                        if (
                          !/[zZ]|[+-]\\d{2}:?\\d{2}$/.test(cancelTime)
                        ) {
                          cancelTime =
                            cancelTime.replace(" ", "T") + "Z";
                        }

                        const cancelAt =
                          new Date(cancelTime);

                        if (
                          !Number.isNaN(cancelAt.getTime()) &&
                          Date.now() < cancelAt.getTime()
                        ) {
                          return "🔒 Cancel Locked";
                        }

                        return "❌ Cancel";
                      })(),
                    callback_data:
                      (() => {
                        if (!activation.activationCancel) {
                          return `server1:cancel:${order.orderId}`;
                        }

                        let cancelTime =
                          String(activation.activationCancel).trim();

                        if (
                          !/[zZ]|[+-]\\d{2}:?\\d{2}$/.test(cancelTime)
                        ) {
                          cancelTime =
                            cancelTime.replace(" ", "T") + "Z";
                        }

                        const cancelAt =
                          new Date(cancelTime);

                        if (
                          !Number.isNaN(cancelAt.getTime()) &&
                          Date.now() < cancelAt.getTime()
                        ) {
                          return `server1:cancel_locked:${order.orderId}`;
                        }

                        return `server1:cancel:${order.orderId}`;
                      })(),
                  }
                ]
              ]
            }
          }
        );

      } catch (err) {
        logger.error(
          "Error in Server 1 buy flow",
          err
        );

        if (err && err.code === "SERVER1_PRICE_CHANGED") {
          await answer(
            ctx,
            "⚠️ Price changed. Please refresh the product and try again.",
            true
          );

          try {
            await editScreen(
              ctx,
              "⚠️ <b>Price Updated</b>\n\n" +
              "The price of this country has changed.\n" +
              "Please refresh the list and select the country again.",
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "🔄 Refresh",
                        callback_data: "server1:menu"
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
          } catch (screenErr) {
            logger.warn(
              "Server 1 price-change screen update failed:",
              screenErr.message
            );
          }

          return;
        }

        await answer(
          ctx,
          "❌ Purchase failed. Please try again.",
          true
        );
      }
    }
  );


  // ==========================================================
  // SEND OTP / CHECK OTP
  // ==========================================================

  bot.action(
    /^server1:sendotp:(.+)$/,
    async (ctx) => {
      try {
        await answer(ctx, "🔄 Checking OTP...");

        const orderId = ctx.match[1];
        const order = await db.getServer1Order(orderId);

        if (!order) {
          await answer(ctx, "❌ Order not found.", true);
          return;
        }

        if (
          String(order.userId) !==
          String(ctx.from.id)
        ) {
          await answer(ctx, "❌ This order does not belong to you.", true);
          return;
        }

        if (
          !["waiting_otp", "processing"].includes(
            String(order.status || "").toLowerCase()
          )
        ) {
          await answer(
            ctx,
            `❌ Order status: ${order.status}`,
            true
          );
          return;
        }

        const result =
          await getActivationStatus(
            order.activationId
          );

        const raw =
          result?.raw ||
          result ||
          {};

        const sms =
          raw?.sms ||
          {};

        const smsCode = String(
          sms?.code ||
          result?.smsCode ||
          result?.code ||
          result?.otp ||
          raw?.smsCode ||
          raw?.code ||
          raw?.otp ||
          ""
        ).trim();

        if (!smsCode) {
          await answer(
            ctx,
            "⏳ OTP has not arrived yet.",
            true
          );
          return;
        }

        const completion = await completeServer1Order(orderId, {
          smsCode,
          deliveryInfo:
            sms?.text ||
            "OTP received successfully",
        });

        // Automatic OTP monitor may have completed the order first.
        if (!completion.completed) {
          await editScreen(
            ctx,
            "ℹ️ <b>ORDER ALREADY FINALIZED</b>\n" +
            "━━━━━━━━━━━━━━━━━━━━\n\n" +
            "This order has already been completed or closed."
          );
          return;
        }

        await editScreen(
          ctx,

          `📱 <b>OTP RECEIVED</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +

          `📦 <b>Service:</b>\n` +
          `<b>Telegram</b>\n\n` +

          `🌍 <b>Country:</b>\n` +
          `<b>${order.countryName} ${getRealCallingCode(order.phoneNumber)}</b>\n\n` +

          `📞 <b>Number:</b>\n` +
          `<code>${order.phoneNumber}</code>\n\n` +

          `🔐 <b>OTP:</b>\n` +
          `<code>${smsCode}</code>\n\n` +

          `🕐 <b>Status:</b>\n` +
          `<b>Completed</b>`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🏠 Main Menu",
                    callback_data: "menu_home",
                  }
                ]
              ]
            }
          }
        );

      } catch (err) {
        logger.error(
          "Server1 send OTP failed",
          err
        );

        await answer(
          ctx,
          "❌ Unable to check OTP.",
          true
        );
      }
    }
  );


  // ==========================================================
  // CANCEL LOCKED
  // ==========================================================

  bot.action(
    /^server1:cancel_locked:(.+)$/,
    async (ctx) => {
      try {
        await answer(
          ctx,
          "🔒 Cancel is not available yet. Please wait until the timer ends.",
          true
        );
      } catch (err) {
        logger.warn(
          "Server1 locked-cancel handler failed",
          err
        );
      }
    }
  );


  // ==========================================================
  // CANCEL ORDER
  // ==========================================================

  bot.action(
    /^server1:cancel:(.+)$/,
    async (ctx) => {
      try {
        await answer(ctx, "❌ Cancelling...");

        const orderId = ctx.match[1];

        const order =
          await db.getServer1Order(orderId);

        if (!order) {
          await answer(
            ctx,
            "❌ Order not found.",
            true
          );
          return;
        }

        if (
          String(order.userId) !==
          String(ctx.from.id)
        ) {
          await answer(
            ctx,
            "❌ This order does not belong to you.",
            true
          );
          return;
        }

        if (
          !["waiting_otp", "processing"].includes(
            String(order.status || "").toLowerCase()
          )
        ) {
          await answer(
            ctx,
            `❌ Cannot cancel: ${order.status}`,
            true
          );
          return;
        }

        // ----------------------------------------------------------
        // CANCEL LOCK
        // Grizzly does not allow cancellation until activationCancel.
        // Protect the order on our side as well.
        // ----------------------------------------------------------
        if (order.activationCancel) {
          let cancelTime = String(order.activationCancel).trim();

          // Grizzly timestamps are UTC.
          if (!/[zZ]|[+-]\\d{2}:?\\d{2}$/.test(cancelTime)) {
            cancelTime =
              cancelTime.replace(" ", "T") + "Z";
          }

          const cancelAt = new Date(cancelTime);

          if (!Number.isNaN(cancelAt.getTime())) {
            const remaining =
              cancelAt.getTime() - Date.now();

            if (remaining > 0) {
              const totalSeconds =
                Math.ceil(remaining / 1000);

              const minutes =
                Math.floor(totalSeconds / 60);

              const seconds =
                totalSeconds % 60;

              await answer(
                ctx,
                `🔒 Cancel is locked. Please wait ${minutes}m ${String(seconds).padStart(2, "0")}s.`,
                true
              );

              return;
            }
          }
        }

        // Stop UI countdown immediately before cancellation/refund.
        stopServer1Countdown(orderId);

        // Cancel provider activation FIRST.
        // Refund ONLY if provider cancellation succeeds.
        let cancellationSucceeded = false;

        try {
          const cancelResult = await cancelActivation(
            order.activationId
          );

          cancellationSucceeded = true;

          logger.info(
            `Server1 activation cancelled successfully: order=${orderId}`
          );
        } catch (providerErr) {
          logger.error(
            `Server1 activation cancellation FAILED - REFUND BLOCKED: order=${orderId}, activation=${order.activationId}`,
            providerErr
          );

          await answer(
            ctx,
            "❌ Cancellation failed at provider. Your wallet has NOT been refunded automatically.",
            true
          );

          return;
        }

        if (!cancellationSucceeded) {
          logger.error(
            `Server1 refund blocked: provider cancellation was not successful: order=${orderId}`
          );

          return;
        }

        // Refund ONLY after successful provider cancellation.
        const refund =
          await db.cancelServer1OrderAndRefund(
            orderId,
            "User cancelled Server 1 activation"
          );

        // IMPORTANT:
        // Stop Telegram countdown immediately after refund.
        stopServer1Countdown(orderId);

        await editScreen(
          ctx,

          `❌ <b>ORDER CANCELLED</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n\n` +

          `📱 <b>Service:</b>\n` +
          `<b>Telegram</b>\n\n` +

          `🌍 <b>Country:</b>\n` +
          `<b>${order.countryName}</b>\n\n` +

          `📞 <b>Number:</b>\n` +
          `<code>${order.phoneNumber}</code>\n\n` +

          `💰 <b>Refunded:</b>\n` +
          `<b>₹${Number(
            refund.refundAmount || 0
          ).toFixed(2)}</b>\n\n` +

          `💳 <b>New Balance:</b>\n` +
          `<b>₹${Number(
            refund.newBalance || 0
          ).toFixed(2)}</b>\n\n` +

          `🕐 <b>Status:</b>\n` +
          `<b>Refunded</b>`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🏠 Main Menu",
                    callback_data: "menu_home",
                  }
                ]
              ]
            }
          }
        );

      } catch (err) {
        logger.error(
          "Server1 cancel failed",
          err
        );

        await answer(
          ctx,
          err.message || "❌ Cancellation failed.",
          true
        );
      }
    }
  );

}

module.exports = {
  registerServer1Handler,
  invalidateServer1CatalogCache,
  getCachedGrizzlyPrices,
  getGrizzlyTGItem,
  getLiveGrizzlyTelegramPrice,
  loadServer1Catalog,
};
