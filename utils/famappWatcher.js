/**
 * utils/famappWatcher.js
 * ------------------------------------------------------------
 * FamApp Gmail Auto Deposit Watcher
 *
 * Safety:
 * - Only FamApp sender
 * - Only "You received" emails
 * - Exact UTR match
 * - Exact amount match
 * - Old Gmail payments cannot approve newer deposits
 * - Same Gmail message cannot be processed twice
 * - Firestore transaction prevents double credit
 * - Gmail message is marked processed ONLY after approval
 * ------------------------------------------------------------
 */

const { getGmailClient } = require("./gmail");
const { parseFamAppEmail } = require("./famapp");
const config = require("../config");
const db = require("../database");
const logger = require("./logger");
const { formatAmount } = require("./helpers");
let checking = false;

/**
 * Read Gmail header.
 */
function getHeader(headers, name) {
  return (
    headers.find(
      (h) =>
        String(h.name || "").toLowerCase() ===
        String(name).toLowerCase()
    )?.value || ""
  );
}

/**
 * Decode Gmail base64url.
 */
function decodeBase64(data) {
  if (!data) return "";

  return Buffer.from(
    data.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}

/**
 * Find text/plain body recursively.
 */
function findTextBody(part) {
  if (!part) return "";

  if (
    part.mimeType === "text/plain" &&
    part.body?.data
  ) {
    return decodeBase64(part.body.data);
  }

  for (const child of part.parts || []) {
    const result = findTextBody(child);

    if (result) {
      return result;
    }
  }

  return "";
}

/**
 * Convert Firestore timestamp / Date / number to milliseconds.
 */
function timestampToMillis(value) {
  if (!value) return 0;

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (typeof value._seconds === "number") {
    return (
      value._seconds * 1000 +
      Math.floor((value._nanoseconds || 0) / 1000000)
    );
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number") {
    return value;
  }

  const parsed = new Date(value).getTime();

  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Process one Gmail message.
 */
async function processMessage(gmail, messageId, bot) {
  if (!messageId) {
    return "invalid_message";
  }

  // ----------------------------------------------------------
  // DUPLICATE CHECK
  // ----------------------------------------------------------

  if (
    await db.isGmailPaymentProcessed(messageId)
  ) {
    return "already_processed";
  }
  // ----------------------------------------------------------
  // GET FULL EMAIL
  // ----------------------------------------------------------

  const message =
    await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

  const gmailTimestamp =
    Number(message.data.internalDate || 0);

  if (!gmailTimestamp) {
    console.log(
      `[FAMAPP] Missing Gmail timestamp: ${messageId}`
    );

    return "no_timestamp";
  }

  const headers =
    message.data.payload?.headers || [];

  const from =
    getHeader(headers, "From");

  const subject =
    getHeader(headers, "Subject");

  const body =
    findTextBody(message.data.payload);

  // ----------------------------------------------------------
  // PARSE FAMAPP PAYMENT
  // ----------------------------------------------------------

  const payment =
    parseFamAppEmail({
      from,
      subject,
      body,
    });


  // Not a valid incoming FamApp payment.
  if (!payment) {
    return "ignored";
  }

  console.log(
   `[FAMAPP] Found payment ₹${payment.amount} ` +
`UTR=${payment.utr || "N/A"} ` +
`TransactionID=${payment.transactionId || "N/A"}`
  );

  // ----------------------------------------------------------
  // EXACT MATCH
  // UTR + AMOUNT
  // ----------------------------------------------------------

const deposit =
  await db.findPendingDepositByUtrAndAmount(
    payment.utr,
    payment.transactionId,
    payment.amount
  );

  if (!deposit) {
    console.log(
      `[FAMAPP] No pending match | ` +
`Amount=₹${payment.amount} | ` +
`UTR=${payment.utr || "N/A"} | ` +
`TransactionID=${payment.transactionId || "N/A"}`
    );

    return "no_match";
  }



  // ----------------------------------------------------------
  // FINAL SECURITY LOG
  // ----------------------------------------------------------

  console.log(
    `[FAMAPP] MATCH FOUND | ` +
    `Deposit=${deposit.depositId} | ` +
    `User=${deposit.userId} | ` +
    `Amount=₹${deposit.amount} | ` +
    `UTR=${deposit.utr}`
  );

  // ----------------------------------------------------------
  // ATOMIC FIRESTORE APPROVAL
  // ----------------------------------------------------------

  let approved;

  try {
    approved =
      await db.approveDeposit(
        deposit.depositId,
        "GMAIL_AUTO"
      );
  } catch (err) {

    if (
      err.code === "ALREADY_PROCESSED"
    ) {
      console.log(
        `[FAMAPP] Deposit already processed: ${deposit.depositId}`
      );

      return "already_processed";
    }

    logger.error(
      `FamApp approval failed for ${deposit.depositId}`,
      err
    );

    return "approval_failed";
  }

  // ----------------------------------------------------------
  // MARK GMAIL MESSAGE PROCESSED
  //
  // IMPORTANT:
  // This happens AFTER successful Firestore approval.
  // ----------------------------------------------------------

  try {
    await db.markGmailPaymentProcessed(
      messageId,
      deposit.depositId,
      payment.transactionId,
      payment.utr
    );
  } catch (err) {

    /*
     * Deposit has already been approved.
     *
     * Do NOT reverse it here.
     * The next watcher cycle will see the
     * already-approved deposit and won't credit it again.
     */

    logger.error(
      `Failed to mark Gmail message processed: ${messageId}`,
      err
    );
  }

    // ----------------------------------------------------------
  // TELEGRAM NOTIFICATIONS
  // ----------------------------------------------------------

  // Notify user
  try {
    await bot.telegram.sendMessage(
      deposit.userId,
      `✅ <b>DEPOSIT APPROVED</b>\n\n` +
      `💰 Amount: ₹${formatAmount(approved.amount)}\n` +
      `🔢 UTR: <code>${payment.utr}</code>\n\n` +
      `💵 Amount has been added to your wallet.\n` +
      `🤖 Automatically verified by FamApp.`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    logger.error(
      `Failed to notify user about auto deposit ${deposit.depositId}`,
      err
    );
  }

  // Notify admin
  try {
    await bot.telegram.sendMessage(
      config.adminId,
      `🤖 <b>AUTO DEPOSIT APPROVED</b>\n\n` +
      `👤 User ID: <code>${deposit.userId}</code>\n` +
      `💰 Amount: ₹${formatAmount(approved.amount)}\n` +
      `🔢 UTR: <code>${payment.utr}</code>\n` +
      `🧾 Deposit ID: <code>${deposit.depositId}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    logger.error(
      `Failed to notify admin about auto deposit ${deposit.depositId}`,
      err
    );
  }

  console.log(
    `[FAMAPP] AUTO APPROVED | ` +
    `Deposit=${deposit.depositId} | ` +
    `Amount=₹${approved.amount} | ` +
    `UTR=${payment.utr}`
  );

  return {
    status: "approved",
    deposit: approved,
    payment,
    messageId,
  };
}

/**
 * Check Gmail for recent FamApp payments.
 */
async function checkFamAppPayments(bot) {
  if (checking) {
    return;
  }

  checking = true;

  try {
    // ------------------------------------------------------------
    // IMPORTANT:
    // Do NOT query Gmail unless there is at least one pending
    // deposit in Firestore.
    //
    // This prevents old FamApp emails from being scanned when
    // nobody is currently waiting for a deposit approval.
    // ------------------------------------------------------------
    const pendingDeposits =
      await db.listPendingDeposits(1);

    if (
      !Array.isArray(pendingDeposits) ||
      pendingDeposits.length === 0
    ) {
      return;
    }

    console.log(
      `[FAMAPP] Pending deposit found: ${pendingDeposits[0].depositId} | checking Gmail`
    );

    const gmail =
      await getGmailClient();

    /*
     * Only recent emails.
     *
     * This prevents old Gmail payments from being
     * repeatedly scanned.
     */
    const result =
      await gmail.users.messages.list({
        userId: "me",

        q:
  "from:no-reply@famapp.in " +
  'subject:"You received" ' +
  "newer_than:1h",
       maxResults: 20,
      });

    const messages =
      result.data.messages || [];

    if (messages.length === 0) {
      return;
    }

    for (const message of messages) {
      try {
       const result =
  await processMessage(
    gmail,
    message.id,
    bot
  );

        if (
          result &&
          result.status === "approved"
        ) {
          console.log(
            `[FAMAPP] Deposit completed: ` +
            `${result.deposit.depositId}`
          );
        }

      } catch (err) {
        logger.error(
          `FamApp message ${message.id} failed`,
          err
        );
      }
    }

  } catch (err) {
    logger.error(
      "FamApp Gmail watcher error",
      err
    );

  } finally {
    checking = false;
  }
}

/**
 * Start watcher.
 */
function startFamAppWatcher(bot) {
  console.log(
    "[FAMAPP] Gmail watcher started"
  );

  /*
   * Initial check.
   */
  checkFamAppPayments(bot).catch(
    (err) =>
      logger.error(
        "Initial FamApp check failed",
        err
      )
  );

  /*
   * Check every 30 seconds.
   */
  setInterval(() => {
    checkFamAppPayments(bot).catch(
      (err) =>
        logger.error(
          "Scheduled FamApp check failed",
          err
        )
    );
  }, 2 * 60 * 1000);
}

module.exports = {
  startFamAppWatcher,
  checkFamAppPayments,
};
