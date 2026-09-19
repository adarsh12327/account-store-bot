/**
 * database.js
 * ------------------------------------------------------------------
 * The ONLY module that talks to Firestore. Handlers/services must
 * never call `db.collection(...)` directly — go through the
 * functions exported here.
 *
 * Collections: users, products, countries, providers, deposits,
 *              orders, transactions, settings
 * ------------------------------------------------------------------
 */

const { FieldValue } = require("./d1");
const db = require("./d1");

const USERS = "users";

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const n = Date.parse(value);
  return Number.isNaN(n) ? 0 : n;
}

const PRODUCTS = "products";
const COUNTRIES = "countries";
const PROVIDERS = "providers";
const DEPOSITS = "deposits";
const ORDERS = "orders";
const TRANSACTIONS = "transactions";
const SETTINGS = "settings";
const SETTINGS_DOC_ID = "config";
const SERVER1_COUNTRIES = "server1_countries";
const SERVER1_SERVICES = "server1_services";

// ------------------------------------------------------------------
// Hot-read caches: Telegram button handlers must not hit Firestore on
// every click. These short TTL caches dramatically reduce read quota
// usage while keeping wallet/settings data fresh.
// ------------------------------------------------------------------
const USER_CACHE_TTL_MS = 5 * 60_000;
const SETTINGS_CACHE_TTL_MS = 60_000;
const userReadCache = new Map();
let settingsReadCache = null;
let settingsReadCacheAt = 0;
let settingsReadPromise = null;

// The migration may have preserved an older settings document ID.
// Keep the canonical config document repaired from that legacy data
// so a single admin update can never hide the rest of the settings.
let settingsResolvedDocId = SETTINGS_DOC_ID;

const DEFAULT_SETTINGS = {
  adminId: "",
  referralPercent: 10,
  forceChannel: "",
  salesChannel: "",
  supportUsername: "",
  botUsername: "",
  auditChannel: "",
  upiId: "",
  paymentQrFileId: "",
  minimumDeposit: 1,
  profit: 0,
  usdRate: 105,
  maintenance: false,
  server1OtpWaitMinutes: 20,
  server1Enabled: true,
  server2Enabled: true,
};

// ==================================================================
// USERS
// ==================================================================

/**
 * Register a user's referrer exactly once.
 *
 * The referral percentage is SNAPSHOTTED at registration time.
 * Later global-rate changes do not affect existing referred users.
 */
async function registerUserReferral(userId, referrerId) {
  userId = String(userId || "").trim();
  referrerId = String(referrerId || "").trim();

  if (!userId || !referrerId) {
    return { registered: false, reason: "INVALID_ID" };
  }

  if (userId === referrerId) {
    return { registered: false, reason: "SELF_REFERRAL" };
  }

  // Resolve the effective settings first. This also handles a
  // migrated settings document whose ID was not "config".
  const settings = await getSettings();

  const userRef = db.collection(USERS).doc(userId);
  const referrerRef = db.collection(USERS).doc(referrerId);

  return db.runTransaction(async (txn) => {
    const [userSnap, referrerSnap] =
      await Promise.all([
        txn.get(userRef),
        txn.get(referrerRef),
      ]);

    if (!userSnap.exists) {
      return {
        registered: false,
        reason: "USER_NOT_FOUND",
      };
    }

    if (!referrerSnap.exists) {
      return {
        registered: false,
        reason: "REFERRER_NOT_FOUND",
      };
    }

    const user = userSnap.data() || {};
    const referrer = referrerSnap.data() || {};

    // Referrer is locked permanently after first successful registration.
    if (user.referrerId) {
      return {
        registered: false,
        reason: "ALREADY_REGISTERED",
        referrerId: String(user.referrerId),
        referralRate: Number(user.referralRate || 0),
      };
    }

    const globalRate = Number(
      settings.referralPercent ?? 10
    );

    if (
      !Number.isFinite(globalRate) ||
      globalRate < 0 ||
      globalRate > 100
    ) {
      throw new Error("INVALID_REFERRAL_PERCENT");
    }

    // Admin override on the referrer takes priority.
    const override = referrer.referralRateOverride;

    const hasOverride =
      override !== null &&
      override !== undefined &&
      override !== "" &&
      Number.isFinite(Number(override)) &&
      Number(override) >= 0 &&
      Number(override) <= 100;

    const referralRate = hasOverride
      ? Number(Number(override).toFixed(2))
      : Number(globalRate.toFixed(2));

    const referralRateSource = hasOverride
      ? "admin"
      : "global";

    txn.update(userRef, {
      referrerId,
      referralRate,
      referralRateSource,
      referralRateSetAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      registered: true,
      referrerId,
      referralRate,
      referralRateSource,
    };
  });
}

async function createUser(telegramId, data = {}) {
  if (!telegramId) {
    throw new Error("createUser: telegramId is required");
  }

  const userId = String(telegramId);
  const userRef = db.collection(USERS).doc(userId);

  const existing = await userRef.get();

  if (existing.exists) {
    return {
      ...existing.data(),
      _isNewUser: false,
    };
  }

  const newUser = {
    telegramId: userId,
    firstName: data.firstName || "",
    lastName: data.lastName || "",
    username: data.username || "",
    balance: 0,
    pendingDeposit: 0,
    totalDeposit: 0,
    totalOrders: 0,

    // Referral snapshot:
    // These values are fixed when the user first registers.
    referrerId: null,

    // Referral snapshot:
    // Fixed when this user registers through a referral link.
    referralRate: 0,
    referralRateSource: "none",
    referralRateSetAt: null,

    // Outbound referral rate:
    // Admin can override the rate used for users referred by this user.
    referralRateOverride: null,
    referralRateOverrideSetAt: null,
    referralEarnings: 0,

    banned: false,
    registered: true,
    joinDate: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await userRef.set(newUser);

  userReadCache.set(userId, {
    user: { ...newUser, _isNewUser: true, joinDate: new Date(), updatedAt: new Date() },
    at: Date.now(),
  });

  return {
    ...newUser,
    _isNewUser: true,
    joinDate: new Date(),
    updatedAt: new Date(),
  };
}
function getSettingsSnapshot() {
  return {
    ...(settingsReadCache || DEFAULT_SETTINGS),
  };
}

function getUserSnapshot(telegramId) {
  const cached = userReadCache.get(String(telegramId || ""));
  return cached?.user || null;
}

async function getUser(telegramId) {
  if (!telegramId) throw new Error("getUser: telegramId is required");

  const userId = String(telegramId);
  const now = Date.now();
  const cached = userReadCache.get(userId);

  if (cached && now - cached.at < USER_CACHE_TTL_MS) {
    return cached.user;
  }

  const snap = await db.collection(USERS).doc(userId).get();
  const user = snap.exists ? snap.data() : null;

  userReadCache.set(userId, { user, at: now });
  return user;
}

async function getReferralStats(referrerId) {
  referrerId = String(referrerId || "").trim();

  if (!referrerId) {
    return {
      referredUsers: 0,
      referralEarnings: 0,
    };
  }

  const snap = await db
    .collection(USERS)
    .where("referrerId", "==", referrerId)
    .get();

  const referrer = await getUser(referrerId);

  return {
    referredUsers: snap.size,
    referralEarnings: Number(referrer?.referralEarnings || 0),
  };
}

async function updateUser(telegramId, updates = {}) {
  if (!telegramId) throw new Error("updateUser: telegramId is required");
  const userRef = db.collection(USERS).doc(String(telegramId));
  const snap = await userRef.get();
  if (!snap.exists) throw new Error(`updateUser: user ${telegramId} does not exist`);

  await userRef.update({ ...updates, updatedAt: FieldValue.serverTimestamp() });

  const cached = userReadCache.get(String(telegramId));
  if (cached?.user) {
    userReadCache.set(String(telegramId), {
      user: { ...cached.user, ...updates },
      at: Date.now(),
    });
  } else {
    userReadCache.delete(String(telegramId));
  }
}

/**
 * Search users by exact Telegram ID or by username (case-insensitive,
 * without leading @). Firestore has no native "contains" search, so
 * username search does a bounded prefix-independent client-side scan
 * over a capped result set — fine at small/medium scale.
 */
async function searchUsers(query) {
  const q = String(query || "").trim().toLowerCase();

  if (!q) return [];

  const search = q.replace(/^@/, "");

  const byId = await db
    .collection(USERS)
    .doc(search)
    .get();

  if (byId.exists) {
    return [byId.data()];
  }

  const snap = await db
    .collection(USERS)
    .limit(500)
    .get();

  return snap.docs
    .map((doc) => doc.data())
    .filter((user) => {
      const telegramId = String(user.telegramId || "").toLowerCase();
      const username = String(user.username || "").toLowerCase();
      const firstName = String(user.firstName || "").toLowerCase();
      const lastName = String(user.lastName || "").toLowerCase();

      const fullName = `${firstName} ${lastName}`.trim();

      return (
        telegramId.includes(search) ||
        username.includes(search) ||
        firstName.includes(search) ||
        lastName.includes(search) ||
        fullName.includes(search)
      );
    })
    .slice(0, 20);
}
async function countUsers() {
  const snap = await db.collection(USERS).count().get();
  return snap.data().count;
}

// ==================================================================
// TRANSACTIONS (ledger — created alongside every balance change)
// ==================================================================

/**
 * Internal helper: writes a transaction doc using an existing
 * Firestore transaction object (or a plain write if none is given).
 */
function writeTransactionRecord(txn, { userId, type, amount, balanceAfter, note, relatedId }) {
  const ref = db.collection(TRANSACTIONS).doc();
  const record = {
    transactionId: ref.id,
    userId: String(userId),
    type, // 'deposit' | 'admin_credit' | 'admin_debit' | 'order_purchase' | 'order_refund'
    amount,
    balanceAfter,
    note: note || "",
    relatedId: relatedId || null,
    createdAt: FieldValue.serverTimestamp(),
  };
  if (txn) {
    txn.set(ref, record);
  }
  return record;
}

async function listUserTransactions(telegramId, limit = 10) {
  const snap = await db
    .collection(TRANSACTIONS)
    .where("userId", "==", String(telegramId))
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data());
}

// ==================================================================
// WALLET (atomic balance changes)
// ==================================================================

/**
 * Add balance to a user atomically and record a transaction.
 * Used for: approved deposits, manual admin credits, order refunds.
 */
async function addBalance(telegramId, amount, { type, note, relatedId, bumpTotalDeposit = false } = {}) {
  if (!(amount > 0)) throw new Error("addBalance: amount must be positive");
  const userId = String(telegramId);
  const userRef = db.collection(USERS).doc(userId);

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(userRef);
    if (!snap.exists) throw new Error("addBalance: user does not exist");

    const current = snap.data();
    const newBalance = (current.balance || 0) + amount;

    const updates = { balance: newBalance, updatedAt: FieldValue.serverTimestamp() };
    if (bumpTotalDeposit) {
      updates.totalDeposit = (current.totalDeposit || 0) + amount;
    }

    txn.update(userRef, updates);
    const record = writeTransactionRecord(txn, {
      userId,
      type,
      amount,
      balanceAfter: newBalance,
      note,
      relatedId,
    });

    return { newBalance, transaction: record };
  });
}

/**
 * Remove balance atomically. Throws INSUFFICIENT_BALANCE if the user
 * doesn't have enough — never allows a negative balance.
 */
async function removeBalance(telegramId, amount, { type, note, relatedId } = {}) {
  if (!(amount > 0)) throw new Error("removeBalance: amount must be positive");
  const userId = String(telegramId);
  const userRef = db.collection(USERS).doc(userId);

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(userRef);
    if (!snap.exists) throw new Error("removeBalance: user does not exist");

    const current = snap.data();
    const currentBalance = current.balance || 0;

    if (currentBalance < amount) {
      const err = new Error("Insufficient balance");
      err.code = "INSUFFICIENT_BALANCE";
      throw err;
    }

    const newBalance = currentBalance - amount;
    txn.update(userRef, { balance: newBalance, updatedAt: FieldValue.serverTimestamp() });

    const record = writeTransactionRecord(txn, {
      userId,
      type,
      amount: -amount,
      balanceAfter: newBalance,
      note,
      relatedId,
    });

    return { newBalance, transaction: record };
  });
}

async function getUserBalance(telegramId) {
  const user = await getUser(telegramId);
  return user ? user.balance || 0 : 0;
}

// ==================================================================
// DEPOSITS
// ==================================================================

async function createDeposit(telegramId, amount, utr, screenshotFileId = "") {
  const userId = String(telegramId);

  const normalizedUtr = String(utr || "")
    .trim()
    .toUpperCase();

  if (!normalizedUtr) {
    const err = new Error("INVALID_REFERENCE");
    err.code = "INVALID_REFERENCE";
    throw err;
  }

  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    const err = new Error("INVALID_DEPOSIT_AMOUNT");
    err.code = "INVALID_DEPOSIT_AMOUNT";
    throw err;
  }

  const userRef = db
    .collection(USERS)
    .doc(userId);

  // ==========================================================
  // ATOMIC DEPOSIT CREATION
  //
  // The duplicate UTR check and deposit creation happen inside
  // one Firestore transaction.
  //
  // This prevents two simultaneous requests using the same UTR
  // from both creating deposits.
  // ==========================================================

  return db.runTransaction(async (txn) => {
    const duplicateSnap = await txn
      .get(
        db
          .collection(DEPOSITS)
          .where("utr", "==", normalizedUtr)
          .limit(1)
      );

    if (!duplicateSnap.empty) {
      const existingDoc = duplicateSnap.docs[0];
      const existingDeposit = existingDoc.data();

      const err = new Error("DUPLICATE_REFERENCE");
      err.code = "DUPLICATE_REFERENCE";
      err.depositId = existingDoc.id;
      err.existingStatus =
        existingDeposit.status || "unknown";

      throw err;
    }

    const userSnap = await txn.get(userRef);

    if (!userSnap.exists) {
      const err = new Error("USER_NOT_FOUND");
      err.code = "USER_NOT_FOUND";
      throw err;
    }

    const ref = db
      .collection(DEPOSITS)
      .doc();

    const deposit = {
      depositId: ref.id,
      userId,
      amount: numericAmount,
      utr: normalizedUtr,
      screenshotFileId: screenshotFileId || "",
      status: "pending",

      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),

      processedAt: null,
      processedBy: null,
    };

    txn.set(ref, deposit);

    txn.update(userRef, {
      pendingDeposit:
        FieldValue.increment(numericAmount),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      ...deposit,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });
}

// ==================================================================
// FAMAPP AUTO DEPOSIT MATCHING
// ==================================================================

async function findPendingDepositByUtrAndAmount(
  emailUtr,
  emailTransactionId,
  amount
) {
  const normalizedUtr = String(emailUtr || "")
    .trim()
    .toUpperCase();

  const normalizedTransactionId = String(emailTransactionId || "")
    .trim()
    .toUpperCase();

  if (
    (!normalizedUtr && !normalizedTransactionId) ||
    !Number.isFinite(Number(amount))
  ) {
    return null;
  }

  const paymentAmount = Math.round(Number(amount) * 100);

  const snap = await db
    .collection(DEPOSITS)
    .where("status", "==", "pending")
    .get();

  for (const doc of snap.docs) {
    const deposit = {
      ...doc.data(),
      depositId: doc.id,
    };

    // Amount must match exactly
    const depositAmount =
      Math.round(Number(deposit.amount || 0) * 100);

    if (depositAmount !== paymentAmount) {
      continue;
    }

    // User's submitted UTR/reference is stored in `utr`
    const savedUtr = String(deposit.utr || "")
      .trim()
      .toUpperCase();

    if (!savedUtr) {
      continue;
    }

    // 1️⃣ First try UTR
    if (normalizedUtr && savedUtr === normalizedUtr) {
      console.log(
        `[FAMAPP] UTR MATCH | Deposit=${deposit.depositId}`
      );

      return deposit;
    }

    // 2️⃣ If UTR doesn't match, try Transaction ID
    if (
      normalizedTransactionId &&
      savedUtr === normalizedTransactionId
    ) {
      console.log(
        `[FAMAPP] TRANSACTION ID MATCH | Deposit=${deposit.depositId}`
      );

      return deposit;
    }
  }

  return null;
}



async function markGmailPaymentProcessed(
  gmailMessageId,
  depositId,
  transactionId,
  utr
) {
  if (!gmailMessageId) {
    throw new Error("gmailMessageId is required");
  }

  const ref = db
    .collection("processed_gmail_payments")
    .doc(String(gmailMessageId));

  const existing = await ref.get();

  if (existing.exists) {
    return false;
  }

  await ref.create({
    gmailMessageId: String(gmailMessageId),
    depositId: String(depositId),
    transactionId: String(transactionId || ""),
    utr: String(utr || ""),
    processedAt: FieldValue.serverTimestamp(),
  });

  return true;
}


async function isGmailPaymentProcessed(gmailMessageId) {
  if (!gmailMessageId) return false;

  const ref = db
    .collection("processed_gmail_payments")
    .doc(String(gmailMessageId));

  const snap = await ref.get();

  return snap.exists;
}
async function markGmailMessageSeen(gmailMessageId) {
  if (!gmailMessageId) return false;

  const ref = db
    .collection("seen_gmail_messages")
    .doc(String(gmailMessageId));

  const existing = await ref.get();

  if (existing.exists) {
    return false;
  }

  await ref.create({
    gmailMessageId: String(gmailMessageId),
    seenAt: FieldValue.serverTimestamp(),
  });

  return true;
}

async function isGmailMessageSeen(gmailMessageId) {
  if (!gmailMessageId) return false;

  const ref = db
    .collection("seen_gmail_messages")
    .doc(String(gmailMessageId));

  const snap = await ref.get();

  return snap.exists;
}

async function getDeposit(depositId) {
  const snap = await db.collection(DEPOSITS).doc(depositId).get();
  return snap.exists ? snap.data() : null;
}

async function listPendingDeposits(limit = 20) {
  // The watcher only needs to know whether ANY pending deposit exists.
  // Reading every pending document every 30 seconds can exhaust the
  // Firestore read quota. Keep the query bounded to the oldest few.
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1, 5));

  const snap = await db
    .collection(DEPOSITS)
    .where("status", "==", "pending")
    .limit(safeLimit)
    .get();

  return snap.docs
    .map((d) => d.data())
    .sort((a, b) => toMillis(a.createdAt) - toMillis(b.createdAt));
}
async function listUserDeposits(telegramId, limit = 10, offset = 0) {
  const userId = String(telegramId);

  const snap = await db
    .collection(DEPOSITS)
    .where("userId", "==", userId)
    .get();

  return snap.docs
    .map((doc) => doc.data())
    .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
    .slice(offset, offset + limit);
}
async function countDepositsByStatus(status) {
  const snap = await db.collection(DEPOSITS).where("status", "==", status).count().get();
  return snap.data().count;
}

async function sumApprovedDepositAmount() {
  const snap = await db.collection(DEPOSITS).where("status", "==", "approved").get();
  return snap.docs.reduce((sum, d) => sum + (d.data().amount || 0), 0);
}

/**
 * Approve a pending deposit exactly once: credits the user's balance,
 * bumps totalDeposit, clears pendingDeposit, writes a transaction
 * record, and marks the deposit approved — all atomically. A second
 * approval attempt on the same deposit is a no-op that reports
 * ALREADY_PROCESSED instead of double-crediting.
 */
async function approveDeposit(depositId, adminId) {
  const depositRef = db.collection(DEPOSITS).doc(depositId);

  const result = await db.runTransaction(async (txn) => {
    // ----------------------------------------------------------
    // READ PHASE — all reads happen before any writes
    // ----------------------------------------------------------

    const depositSnap = await txn.get(depositRef);

    if (!depositSnap.exists) {
      throw new Error("Deposit not found");
    }

    const deposit = depositSnap.data();

    if (deposit.status !== "pending") {
      const err = new Error("Deposit already processed");
      err.code = "ALREADY_PROCESSED";
      throw err;
    }

    const userId = String(deposit.userId || "").trim();

    if (!userId) {
      throw new Error("INVALID_DEPOSIT_USER");
    }

    const userRef = db.collection(USERS).doc(userId);
    const userSnap = await txn.get(userRef);

    if (!userSnap.exists) {
      throw new Error("User not found for deposit");
    }

    const user = userSnap.data();

    const depositAmount = Number(deposit.amount || 0);

    if (
      !Number.isFinite(depositAmount) ||
      depositAmount <= 0
    ) {
      throw new Error("INVALID_DEPOSIT_AMOUNT");
    }

    // ----------------------------------------------------------
    // REFERRAL READ PHASE
    // ----------------------------------------------------------

    let referralCommission = 0;
    let referralRate = 0;
    let referrerId = null;
    let referrerRef = null;
    let referrerSnap = null;
    let referrer = null;

    if (user.referrerId) {
      referrerId = String(user.referrerId).trim();

      referralRate = Number(user.referralRate || 0);

      if (
        referrerId &&
        referrerId !== userId &&
        Number.isFinite(referralRate) &&
        referralRate > 0 &&
        referralRate <= 100
      ) {
        referrerRef =
          db.collection(USERS).doc(referrerId);

        referrerSnap = await txn.get(referrerRef);

        if (referrerSnap.exists) {
          referrer = referrerSnap.data();

          referralCommission = Number(
            (
              depositAmount *
              referralRate /
              100
            ).toFixed(2)
          );
        }
      }
    }

    // ----------------------------------------------------------
    // CALCULATE USER BALANCE
    // ----------------------------------------------------------

    const newBalance =
      Number(user.balance || 0) +
      depositAmount;

    const newTotalDeposit =
      Number(user.totalDeposit || 0) +
      depositAmount;

    const newPendingDeposit =
      Math.max(
        0,
        Number(user.pendingDeposit || 0) -
        depositAmount
      );

    // ----------------------------------------------------------
    // WRITE PHASE — all writes happen after reads
    // ----------------------------------------------------------

    txn.update(userRef, {
      balance: newBalance,
      totalDeposit: newTotalDeposit,
      pendingDeposit: newPendingDeposit,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // ----------------------------------------------------------
    // REFERRAL COMMISSION
    // ----------------------------------------------------------

    if (
      referrerSnap &&
      referrerSnap.exists &&
      referrerRef &&
      referrer &&
      referralCommission > 0
    ) {
      const referrerBalance =
        Number(referrer.balance || 0) +
        referralCommission;

      const referralEarnings =
        Number(referrer.referralEarnings || 0) +
        referralCommission;

      txn.update(referrerRef, {
        balance: referrerBalance,
        referralEarnings,
        updatedAt: FieldValue.serverTimestamp(),
      });

      writeTransactionRecord(txn, {
        userId: referrerId,
        type: "referral_commission",
        amount: referralCommission,
        balanceAfter: referrerBalance,
        note:
          `Referral commission ${referralRate}% ` +
          `from deposit ${depositId}`,
        relatedId: depositId,
      });
    }

    // ----------------------------------------------------------
    // MARK DEPOSIT APPROVED
    // ----------------------------------------------------------

    txn.update(depositRef, {
      status: "approved",
      processedAt: FieldValue.serverTimestamp(),
      processedBy: String(adminId),

      referralCommission,
      referralRate,
      referralReferrerId: referrerId,

      updatedAt: FieldValue.serverTimestamp(),
    });

    // ----------------------------------------------------------
    // DEPOSIT TRANSACTION RECORD
    // ----------------------------------------------------------

    writeTransactionRecord(txn, {
      userId,
      type: "deposit",
      amount: depositAmount,
      balanceAfter: newBalance,
      note:
        `Deposit approved (UTR: ${deposit.utr || "N/A"})`,
      relatedId: depositId,
    });

    return {
      ...deposit,
      status: "approved",
      newBalance,
      referralCommission,
      referralRate,
      referralReferrerId: referrerId,
    };
  });
}

/**
 * Reject a pending deposit exactly once. Never touches balance.
 */
async function rejectDeposit(depositId, adminId) {
  const depositRef = db.collection(DEPOSITS).doc(depositId);

  return db.runTransaction(async (txn) => {
    const depositSnap = await txn.get(depositRef);
    if (!depositSnap.exists) throw new Error("Deposit not found");

    const deposit = depositSnap.data();
    if (deposit.status !== "pending") {
      const err = new Error("Deposit already processed");
      err.code = "ALREADY_PROCESSED";
      throw err;
    }

    const userRef = db.collection(USERS).doc(deposit.userId);
    const userSnap = await txn.get(userRef);
    if (userSnap.exists) {
      const user = userSnap.data();
      const newPendingDeposit = Math.max(0, (user.pendingDeposit || 0) - deposit.amount);
      txn.update(userRef, { pendingDeposit: newPendingDeposit, updatedAt: FieldValue.serverTimestamp() });
    }

    txn.update(depositRef, {
      status: "rejected",
      processedAt: FieldValue.serverTimestamp(),
      processedBy: String(adminId),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { ...deposit, status: "rejected" };
  });
}

// ==================================================================
// COUNTRIES (data management only)
// ==================================================================

async function createCountry({ name, code, emoji }) {
  const ref = db.collection(COUNTRIES).doc();
  const country = {
    id: ref.id,
    name,
    code: code || "",
    emoji: emoji || "🌍",
    status: "enabled",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(country);
  return country;
}

async function getCountry(countryId) {
  const snap = await db.collection(COUNTRIES).doc(countryId).get();
  return snap.exists ? snap.data() : null;
}

async function updateCountry(countryId, updates = {}) {
  await db
    .collection(COUNTRIES)
    .doc(countryId)
    .update({ ...updates, updatedAt: FieldValue.serverTimestamp() });
}

async function deleteCountry(countryId) {
  await db.collection(COUNTRIES).doc(countryId).delete();
}

async function listCountries({ onlyEnabled = false } = {}) {
  let ref = db.collection(COUNTRIES);
  if (onlyEnabled) ref = ref.where("status", "==", "enabled");
  const snap = await ref.get();
  return snap.docs.map((d) => d.data());
}

async function countCountries() {
  const snap = await db.collection(COUNTRIES).count().get();
  return snap.data().count;
}

async function countProductsByCountry(countryId) {
  const snap = await db.collection(PRODUCTS).where("countryId", "==", countryId).count().get();
  return snap.data().count;
}

// ==================================================================
// PROVIDERS (data management only — never exposed to users, never
// used to make outbound API calls in this project)
// ==================================================================

async function createProvider({ name, apiUrl, apiKey }) {
  const ref = db.collection(PROVIDERS).doc();
  const provider = {
    id: ref.id,
    name,
    apiUrl: apiUrl || "",
    apiKey: apiKey || "",
    status: "enabled",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set(provider);
  return provider;
}

async function getProvider(providerId) {
  const snap = await db.collection(PROVIDERS).doc(providerId).get();
  return snap.exists ? snap.data() : null;
}

async function updateProvider(providerId, updates = {}) {
  await db
    .collection(PROVIDERS)
    .doc(providerId)
    .update({ ...updates, updatedAt: FieldValue.serverTimestamp() });
}

async function deleteProvider(providerId) {
  await db.collection(PROVIDERS).doc(providerId).delete();
}

async function listProviders() {
  const snap = await db.collection(PROVIDERS).get();
  return snap.docs.map((d) => d.data());
}

async function countProviders() {
  const snap = await db.collection(PROVIDERS).count().get();
  return snap.data().count;
}

// ==================================================================
// PRODUCTS (catalog management only — no live pricing/delivery API)
// ==================================================================

function computeFinalPrice({ priceMode, apiPrice, manualPrice }) {
  if (priceMode === "API") {
    return Number(apiPrice) > 0 ? Number(apiPrice) : 0;
  }

  return Number(manualPrice) > 0 ? Number(manualPrice) : 0;
}

async function createProduct({
  name,
  countryId,
  providerId,
  priceMode,
  apiPrice,
  manualPrice,
  stock,
  description = "",
  serviceCode = "tg",
  providerUsdPrice = 0,
  usdRate = 0,
  marginPercent = 0,
}) {
  const ref = db.collection(PRODUCTS).doc();

  const usd = Number(providerUsdPrice) || 0;
  const rate = Number(usdRate) || 0;
  const margin = Number(marginPercent) || 0;

  const costInr = usd * rate;

  const calculatedPrice =
    costInr + (costInr * margin / 100);

  const finalPrice =
    priceMode === "API"
      ? calculatedPrice
      : (Number(manualPrice) > 0 ? Number(manualPrice) : calculatedPrice);

  const product = {
    id: ref.id,
    name,
    description,
    serviceCode,

    countryId,
    providerId: providerId || null,

    priceMode: priceMode === "API" ? "API" : "MANUAL",

    providerUsdPrice: Number(usd.toFixed(4)),
    usdRate: Number(rate.toFixed(4)),
    marginPercent: Number(margin.toFixed(4)),
    costInr: Number(costInr.toFixed(2)),

    apiPrice: Number(apiPrice) || finalPrice,
    manualPrice: Number(manualPrice) || 0,

    finalPrice: Number(finalPrice.toFixed(2)),
    stock: Number(stock) || 0,

    status: "enabled",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await ref.set(product);
  return product;
}


/**
 * Create multiple products efficiently using Firestore batches.
 * Maximum 400 products per batch for safety.
 */
async function createProductsBatch(products = []) {
  if (!Array.isArray(products) || products.length === 0) {
    return [];
  }

  const BATCH_SIZE = 400;
  const createdProducts = [];

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = db.batch();

    const chunk = products.slice(
      i,
      i + BATCH_SIZE
    );

    for (const data of chunk) {
      const ref = db.collection(PRODUCTS).doc();

      const usd =
        Number(data.providerUsdPrice) || 0;

      const rate =
        Number(data.usdRate) || 0;

      const margin =
        Number(data.marginPercent) || 0;

      const costInr =
        usd * rate;

      const calculatedPrice =
        costInr +
        (costInr * margin / 100);

      const finalPrice =
        data.priceMode === "API"
          ? calculatedPrice
          : (Number(data.manualPrice) > 0
              ? Number(data.manualPrice)
              : calculatedPrice);

      const product = {
        id: ref.id,

        name: data.name || "",

        description:
          data.description || "",

        serviceCode:
          data.serviceCode || "tg",

        countryId:
          data.countryId || null,

        providerId:
          data.providerId || null,

        priceMode:
          data.priceMode === "API"
            ? "API"
            : "MANUAL",

        providerUsdPrice:
          Number(usd.toFixed(4)),

        usdRate:
          Number(rate.toFixed(4)),

        marginPercent:
          Number(margin.toFixed(4)),

        costInr:
          Number(costInr.toFixed(2)),

        apiPrice:
          Number(
            data.apiPrice || finalPrice
          ),

        manualPrice:
          Number(data.manualPrice) || 0,

        finalPrice:
          Number(finalPrice.toFixed(2)),

        stock:
          Number(data.stock) || 0,

        status: "enabled",

        createdAt:
          FieldValue.serverTimestamp(),

        updatedAt:
          FieldValue.serverTimestamp(),
      };

      batch.set(ref, product);

      createdProducts.push(product);
    }

    await batch.commit();
  }

  return createdProducts;
}

async function getProduct(productId) {
  const snap = await db.collection(PRODUCTS).doc(productId).get();
  return snap.exists ? snap.data() : null;
}

async function updateProduct(productId, updates = {}) {
  const productRef = db.collection(PRODUCTS).doc(productId);

  // Recalculate finalPrice whenever any pricing-related field changes.
  if (
    "priceMode" in updates ||
    "apiPrice" in updates ||
    "manualPrice" in updates ||
    "marginPercent" in updates ||
    "providerUsdPrice" in updates ||
    "usdRate" in updates
  ) {
    const snap = await productRef.get();

    if (!snap.exists) {
      throw new Error("updateProduct: product not found");
    }

    const current = snap.data();
    const merged = { ...current, ...updates };

    const usd = Number(merged.providerUsdPrice) || 0;
    const rate = Number(merged.usdRate) || 0;
    const margin = Number(merged.marginPercent) || 0;

    let basePrice = 0;

    if (merged.priceMode === "API") {
      basePrice = usd > 0 && rate > 0
        ? usd * rate
        : Number(merged.apiPrice) || 0;
    } else {
      basePrice = Number(merged.manualPrice) || 0;
    }

    const costInr =
      usd > 0 && rate > 0
        ? usd * rate
        : Number(merged.costInr) || 0;

    const calculatedPrice =
      basePrice + (basePrice * margin / 100);

    updates.costInr =
      Number(costInr.toFixed(2));

    updates.finalPrice =
      Number(calculatedPrice.toFixed(2));
  }

  await productRef.update({
    ...updates,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Sync Server 1 provider prices.
 *
 * priceItems:
 *   [{ countryCode, cost, count, retry }]
 *
 * countryCodeById:
 *   Map/object that resolves product.countryId -> provider country code.
 *
 * Only changed API prices are written to Firestore.
 * Manual-price products are never changed.
 */
async function syncServer1ProviderPrices(
  priceItems = [],
  countryCodeById = new Map(),
  cachedCatalog = null
) {
  if (!Array.isArray(priceItems)) {
    throw new Error("SERVER1_PRICE_ITEMS_INVALID");
  }

  const latestByCountry = new Map();

  for (const item of priceItems) {
    if (!item || !item.countryCode) continue;

    const cost = Number(item.cost);
    if (!Number.isFinite(cost) || cost < 0) continue;

    latestByCountry.set(
      String(item.countryCode).trim().toLowerCase(),
      {
        cost,
        count: Number(item.count || 0),
        retry: Number(item.retry || 0),
      }
    );
  }

  const updates = [];
  const changedProducts = [];
  const providerProducts = [];

  let unchanged = 0;
  let stockChanged = 0;
  let checked = 0;

  /*
   * FAST PATH:
   * Use the already-built local catalog cache.
   *
   * The catalog contains the product id, country code,
   * provider price, USD rate and margin. Therefore we don't
   * need to read every enabled TG product from Firestore
   * on every background refresh.
   */
  if (Array.isArray(cachedCatalog) && cachedCatalog.length) {
    for (const product of cachedCatalog) {
      if (!product || product.status !== "enabled") continue;
      if (product.serviceCode !== "tg") continue;

            // Manual-priced products must never be changed
            // by automatic provider price synchronization.
            if (product.priceMode !== "API") {
              unchanged++;
              continue;
            }

      const productId = String(
        product.id || product.productId || ""
      ).trim();

      const countryId = String(product.countryId || "").trim();
      const countryCode = String(
        product.countryCode || ""
      ).trim().toLowerCase();

      if (!productId || !countryCode) {
        unchanged++;
        continue;
      }

      const live = latestByCountry.get(countryCode);

      if (!live) {
        unchanged++;
        continue;
      }

      checked++;

      const oldUsd = Number(product.providerUsdPrice || 0);
      const oldCount = Number(product.apiCount || 0);
      const oldRetry = Number(product.apiRetry || 0);

      const liveCount = Number.isFinite(live.count)
        ? live.count
        : 0;

      const liveRetry = Number.isFinite(live.retry)
        ? live.retry
        : 0;

      const priceChanged =
        Math.abs(oldUsd - live.cost) >= 0.000001;

      const currentStockChanged =
        oldCount !== liveCount ||
        oldRetry !== liveRetry;

      if (currentStockChanged) {
        stockChanged++;
      }

      providerProducts.push({
        productId,
        countryId,
        countryCode,
        providerUsdPrice: live.cost,
        apiCount: liveCount,
        apiRetry: liveRetry,
      });

      if (!priceChanged) {
        // Price is unchanged, but provider stock/retry changed.
        // Persist only those changed provider values.
        if (currentStockChanged) {
          updates.push({
            ref: db.collection(PRODUCTS).doc(productId),
            data: {
              apiCount: liveCount,
              apiRetry: liveRetry,
              updatedAt: FieldValue.serverTimestamp(),
            },
          });
        } else {
          unchanged++;
        }

        continue;
      }

      /*
       * Keep the existing pricing model:
       * provider USD price -> INR using usdRate -> margin.
       */
      const usdRate = Number(product.usdRate) || 0;
      const marginPercent = Number(product.marginPercent) || 0;

      const costInr = live.cost * usdRate;
      const finalPrice =
        costInr + (costInr * marginPercent / 100);

      const roundedCostInr = Number(costInr.toFixed(2));
      const roundedFinalPrice = Number(finalPrice.toFixed(2));

      updates.push({
        ref: db.collection(PRODUCTS).doc(productId),
        data: {
          providerUsdPrice: live.cost,
          costInr: roundedCostInr,
          finalPrice: roundedFinalPrice,
          updatedAt: FieldValue.serverTimestamp(),
        },
      });

      changedProducts.push({
        productId,
        countryId,
        countryCode,
        providerUsdPrice: live.cost,
        costInr: roundedCostInr,
        finalPrice: roundedFinalPrice,
        apiCount: liveCount,
        apiRetry: liveRetry,
      });
    }
  } else {
    /*
     * FALLBACK:
     * If local catalog cache is unavailable, use Firestore once
     * to rebuild the comparison source.
     */
    const snap = await db
      .collection(PRODUCTS)
      .where("status", "==", "enabled")
      .where("serviceCode", "==", "tg")
      .get();

    if (snap.empty) {
      return {
        checked: 0,
        changed: 0,
        stockChanged: 0,
        unchanged: 0,
        providerProducts: [],
        changedProducts: [],
      };
    }

    for (const doc of snap.docs) {
      const product = doc.data();

      if (product.priceMode !== "API") {
        unchanged++;
        continue;
      }

      const countryId = String(product.countryId || "");

      let countryCode = "";

      if (
        countryCodeById &&
        typeof countryCodeById.get === "function"
      ) {
        countryCode = String(
          countryCodeById.get(countryId) || ""
        );
      } else if (
        countryCodeById &&
        typeof countryCodeById === "object"
      ) {
        countryCode = String(
          countryCodeById[countryId] || ""
        );
      }

      countryCode = countryCode.trim().toLowerCase();

      if (!countryCode) {
        unchanged++;
        continue;
      }

      const live = latestByCountry.get(countryCode);

      if (!live) {
        unchanged++;
        continue;
      }

      checked++;

      const oldUsd = Number(product.providerUsdPrice || 0);
      const oldCount = Number(product.apiCount || 0);
      const oldRetry = Number(product.apiRetry || 0);

      const liveCount = Number.isFinite(live.count)
        ? live.count
        : 0;

      const liveRetry = Number.isFinite(live.retry)
        ? live.retry
        : 0;

      const priceChanged =
        Math.abs(oldUsd - live.cost) >= 0.000001;

      const currentStockChanged =
        oldCount !== liveCount ||
        oldRetry !== liveRetry;

      if (currentStockChanged) {
        stockChanged++;
      }

      providerProducts.push({
        productId: String(doc.id),
        countryId,
        countryCode,
        providerUsdPrice: live.cost,
        apiCount: liveCount,
        apiRetry: liveRetry,
      });

      if (priceChanged) {
        const usdRate = Number(product.usdRate) || 0;
        const marginPercent =
          Number(product.marginPercent) || 0;

        const costInr = live.cost * usdRate;
        const finalPrice =
          costInr + (costInr * marginPercent / 100);

        const roundedCostInr =
          Number(costInr.toFixed(2));

        const roundedFinalPrice =
          Number(finalPrice.toFixed(2));

        updates.push({
          ref: doc.ref,
          data: {
            providerUsdPrice: live.cost,
            costInr: roundedCostInr,
            finalPrice: roundedFinalPrice,
            updatedAt: FieldValue.serverTimestamp(),
          },
        });

        changedProducts.push({
          productId: String(doc.id),
          countryId,
          countryCode,
          providerUsdPrice: live.cost,
          costInr: roundedCostInr,
          finalPrice: roundedFinalPrice,
          apiCount: liveCount,
          apiRetry: liveRetry,
        });

        continue;
      }

      if (!currentStockChanged) {
        unchanged++;
      }
    }
  }

  /*
   * Only actual provider-price changes are written to Firestore.
   */
  if (updates.length) {
    const BATCH_SIZE = 400;

    for (
      let i = 0;
      i < updates.length;
      i += BATCH_SIZE
    ) {
      const batch = db.batch();
      const chunk = updates.slice(i, i + BATCH_SIZE);

      for (const item of chunk) {
        batch.update(item.ref, item.data);
      }

      await batch.commit();
    }
  }

  return {
    checked,
    changed: updates.length,
    stockChanged,
    unchanged,
    providerProducts,
    changedProducts,
  };
}

async function deleteProduct(productId) {
  await db.collection(PRODUCTS).doc(productId).delete();
}

async function listProducts({ countryId, onlyEnabled = false } = {}) {
  let ref = db.collection(PRODUCTS);
  if (countryId) ref = ref.where("countryId", "==", countryId);
  if (onlyEnabled) ref = ref.where("status", "==", "enabled");
  const snap = await ref.get();
  return snap.docs.map((d) => d.data());
}

async function deleteAllProducts() {
  const snap = await db.collection(PRODUCTS).get();

  if (snap.empty) {
    return 0;
  }

  const BATCH_SIZE = 400;
  let deleted = 0;

  for (let i = 0; i < snap.docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = snap.docs.slice(i, i + BATCH_SIZE);

    for (const doc of chunk) {
      batch.delete(doc.ref);
    }

    await batch.commit();
    deleted += chunk.length;
  }

  return deleted;
}

async function countProducts() {
  const snap = await db.collection(PRODUCTS).count().get();
  return snap.data().count;
}

// ==================================================================
// ORDERS (legitimate/manual fulfillment workflow — NO automated
// provider purchasing or account delivery is implemented here)
// ==================================================================

/**
 * Create an order and atomically deduct the user's balance + product
 * stock in a single transaction. Order starts in "processing" status,
 * to be manually fulfilled or cancelled (with refund) by an admin.
 */
async function createOrder(telegramId, productId) {
  const userId = String(telegramId);
  const userRef = db.collection(USERS).doc(userId);
  const productRef = db.collection(PRODUCTS).doc(productId);
  const orderRef = db.collection(ORDERS).doc();

  return db.runTransaction(async (txn) => {
    const [userSnap, productSnap] = await Promise.all([txn.get(userRef), txn.get(productRef)]);

    if (!userSnap.exists) throw new Error("User not found");
    if (!productSnap.exists) throw new Error("Product not found");

    const user = userSnap.data();
    const product = productSnap.data();

    if (product.status !== "enabled") {
      const err = new Error("Product is not available");
      err.code = "PRODUCT_UNAVAILABLE";
      throw err;
    }
    if ((product.stock || 0) < 1) {
      const err = new Error("Out of stock");
      err.code = "OUT_OF_STOCK";
      throw err;
    }

    const price = product.finalPrice || 0;
    if ((user.balance || 0) < price) {
      const err = new Error("Insufficient balance");
      err.code = "INSUFFICIENT_BALANCE";
      throw err;
    }

    const newBalance = (user.balance || 0) - price;

    txn.update(userRef, {
      balance: newBalance,
      totalOrders: (user.totalOrders || 0) + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });

    txn.update(productRef, {
      stock: product.stock - 1,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const order = {
      orderId: orderRef.id,
      userId,
      productId,
      productName: product.name,
      countryId: product.countryId || null,
      providerId: product.providerId || null,
      amount: price,
      status: "processing",
      deliveryInfo: "",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      processedBy: null,
    };
    txn.set(orderRef, order);

    writeTransactionRecord(txn, {
      userId,
      type: "order_purchase",
      amount: -price,
      balanceAfter: newBalance,
      note: `Purchase: ${product.name}`,
      relatedId: orderRef.id,
    });

    return { ...order, newBalance };
  });
}

async function getOrder(orderId) {
  const snap = await db.collection(ORDERS).doc(orderId).get();
  return snap.exists ? snap.data() : null;
}

async function listUserOrders(telegramId, limit = 10, offset = 0) {
  const snap = await db
    .collection(ORDERS)
    .where("userId", "==", String(telegramId))
    .get();

  return snap.docs
    .map((d) => d.data())
    .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
    .slice(offset, offset + limit);
}

async function listOrders({ status, limit = 20 } = {}) {
  let ref = db.collection(ORDERS);
  if (status) ref = ref.where("status", "==", status);
  const snap = await ref.get();
  return snap.docs
    .map((d) => d.data())
    .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt))
    .slice(0, limit);
}

async function countOrdersByStatus(status) {
  const snap = await db.collection(ORDERS).where("status", "==", status).count().get();
  return snap.data().count;
}

async function countOrders() {
  const snap = await db.collection(ORDERS).count().get();
  return snap.data().count;
}

/**
 * Mark an order completed and attach manual delivery info written by
 * the admin (e.g. instructions on how the buyer receives their item
 * outside the bot). Only valid from "processing".
 */
async function completeOrder(orderId, adminId, deliveryInfo) {
  const orderRef = db.collection(ORDERS).doc(orderId);

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(orderRef);
    if (!snap.exists) throw new Error("Order not found");
    const order = snap.data();

    if (order.status !== "processing") {
      const err = new Error("Order is not in a completable state");
      err.code = "INVALID_STATE";
      throw err;
    }

    txn.update(orderRef, {
      status: "completed",
      deliveryInfo: deliveryInfo || "",
      processedBy: String(adminId),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { ...order, status: "completed" };
  });
}

/**
 * Cancel a processing order and refund the user atomically. Prevents
 * double refunds by only allowing cancellation from "processing".
 */
async function cancelOrder(orderId, adminId) {
  const orderRef = db.collection(ORDERS).doc(orderId);

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(orderRef);
    if (!snap.exists) throw new Error("Order not found");
    const order = snap.data();

    if (order.status !== "processing") {
      const err = new Error("Order cannot be cancelled from its current state");
      err.code = "INVALID_STATE";
      throw err;
    }

    const userRef = db.collection(USERS).doc(order.userId);
    const userSnap = await txn.get(userRef);
    if (userSnap.exists) {
      const user = userSnap.data();
      const newBalance = (user.balance || 0) + order.amount;
      txn.update(userRef, { balance: newBalance, updatedAt: FieldValue.serverTimestamp() });
      writeTransactionRecord(txn, {
        userId: order.userId,
        type: "order_refund",
        amount: order.amount,
        balanceAfter: newBalance,
        note: `Refund: order cancelled (${order.productName})`,
        relatedId: orderId,
      });
    }

    // Restore stock.
    const productRef = db.collection(PRODUCTS).doc(order.productId);
    const productSnap = await txn.get(productRef);
    if (productSnap.exists) {
      txn.update(productRef, {
        stock: (productSnap.data().stock || 0) + 1,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    txn.update(orderRef, {
      status: "cancelled",
      processedBy: String(adminId),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { ...order, status: "cancelled" };
  });
}

// ==================================================================
// SETTINGS
// ==================================================================

async function getSettings() {
  const now = Date.now();

  if (
    settingsReadCache &&
    now - settingsReadCacheAt < SETTINGS_CACHE_TTL_MS
  ) {
    return settingsReadCache;
  }

  if (settingsReadPromise) {
    return settingsReadPromise;
  }

  settingsReadPromise = (async () => {
    try {
      const configRef = db
        .collection(SETTINGS)
        .doc(SETTINGS_DOC_ID);

      const configSnap = await configRef.get();

      // Read any migrated legacy settings document as a backup source.
      // Config values take precedence, so an intentional admin change
      // is never overwritten by old data.
      const settingsSnap = await db
        .collection(SETTINGS)
        .get();

      const legacyDocs = settingsSnap.docs.filter(
        (doc) => doc.id !== SETTINGS_DOC_ID
      );

      const legacy = legacyDocs[0];
      const legacyData = legacy?.exists
        ? legacy.data() || {}
        : {};

      if (legacy?.exists) {
        settingsResolvedDocId = legacy.id;
      }

      const configData = configSnap.exists
        ? configSnap.data() || {}
        : {};

      settingsReadCache = {
        ...DEFAULT_SETTINGS,
        ...legacyData,
        ...configData,
      };

      // Repair the canonical "config" document by filling only keys
      // that are missing there. This restores settings lost when an
      // update was accidentally written to a new sparse config doc.
      if (legacy?.exists) {
        const missing = {};

        for (const [key, value] of Object.entries(legacyData)) {
          if (!Object.prototype.hasOwnProperty.call(configData, key)) {
            missing[key] = value;
          }
        }

        if (Object.keys(missing).length > 0) {
          await configRef.set(missing, { merge: true });
        }
      } else if (!configSnap.exists) {
        // No settings document existed at all. Create the canonical
        // document only when we have no migrated data to preserve.
        await configRef.set(
          settingsReadCache,
          { merge: true }
        );
      }

      settingsResolvedDocId = SETTINGS_DOC_ID;
      settingsReadCacheAt = Date.now();

      return settingsReadCache;
    } catch (err) {
      // Never replace a known-good cache with blank defaults.
      if (settingsReadCache) {
        return settingsReadCache;
      }

      settingsReadCache = {
        ...DEFAULT_SETTINGS,
      };
      settingsReadCacheAt = Date.now();
      return settingsReadCache;
    } finally {
      settingsReadPromise = null;
    }
  })();

  return settingsReadPromise;
}

async function updateSettings(updates = {}) {
  // Always load/repair settings first so updates merge into the
  // complete canonical document instead of creating a sparse one.
  await getSettings();

  const docId =
    settingsResolvedDocId || SETTINGS_DOC_ID;

  const ref = db
    .collection(SETTINGS)
    .doc(docId);

  await ref.set(updates, { merge: true });

  settingsReadCache = {
    ...(settingsReadCache || DEFAULT_SETTINGS),
    ...updates,
  };
  settingsReadCacheAt = Date.now();
}

// ==================================================================
// STATISTICS
// ==================================================================

// Admin statistics are intentionally cached.
// Admin Home does not need second-by-second counters.
// This greatly reduces repeated Firestore AggregateQuery usage.
const ADMIN_STATS_CACHE_TTL = 60 * 1000;

let adminStatisticsCache = null;
let adminStatisticsCacheAt = 0;
let adminStatisticsRefreshPromise = null;

async function getStatistics() {
  const now = Date.now();

  // Fast path: return cached statistics.
  if (
    adminStatisticsCache &&
    now - adminStatisticsCacheAt < ADMIN_STATS_CACHE_TTL
  ) {
    return adminStatisticsCache;
  }

  // Prevent multiple simultaneous Admin Home clicks from
  // starting the same Firestore statistics queries.
  if (adminStatisticsRefreshPromise) {
    return adminStatisticsRefreshPromise;
  }

  adminStatisticsRefreshPromise = (async () => {
    try {
      /*
       * Admin Home only displays these 7 values.
       *
       * The old implementation also queried:
       * - processing orders
       * - completed orders
       * - approved deposits count
       * - rejected deposits count
       *
       * Those values are not used by Admin Home, so those
       * four Firestore queries are intentionally removed.
       */
      const [
          totalUsers,
          totalProducts,
          totalCountries,
          totalProviders,
          totalOrders,
          pendingOrders,
          completedOrders,
          pendingDeposits,
          approvedDeposits,
          rejectedDeposits,
          totalDepositAmount,
        ] = await Promise.all([
          countUsers(),
          countProducts(),
          countCountries(),
          countProviders(),
          countOrders(),
          countOrdersByStatus("processing"),
          countOrdersByStatus("completed"),
          countDepositsByStatus("pending"),
          countDepositsByStatus("approved"),
          countDepositsByStatus("rejected"),
          sumApprovedDepositAmount(),
        ]);

      const stats = {
        totalUsers,
        totalProducts,
        totalCountries,
        totalProviders,
        totalOrders,

        pendingOrders,
          completedOrders,
          pendingDeposits,
          approvedDeposits,
          rejectedDeposits,
          totalDepositAmount,
      };

      adminStatisticsCache = stats;
      adminStatisticsCacheAt = Date.now();

      return stats;
    } catch (err) {
      /*
       * If Firestore quota is temporarily exhausted but an older
       * cache exists, keep Admin Home usable instead of failing.
       */
      if (adminStatisticsCache) {
        return adminStatisticsCache;
      }

      throw err;
    } finally {
      adminStatisticsRefreshPromise = null;
    }
  })();

  return adminStatisticsRefreshPromise;
}

async function listUsers(limit = 10, offset = 0) {
  const snap = await db
    .collection(USERS)
    .orderBy("joinDate", "desc")
    .limit(limit)
    .offset(offset)
    .get();

  return snap.docs.map((doc) => doc.data());
}

async function getTopDepositors(limit = 10) {
  const snap = await db
    .collection(USERS)
    .orderBy("totalDeposit", "desc")
    .limit(limit)
    .get();

  return snap.docs.map((doc) => doc.data());
}

async function listAllUserIds(batchSize = 500) {
  // Used by broadcast. Returns all telegram IDs.
  const snap = await db.collection(USERS).select().get();
  return snap.docs.map((d) => d.id);
}
// ==================================================================
// SERVER 1 CATALOG
// ==================================================================

async function createServer1Country({
  name,
  emoji = "🌍",
  countryCode = "",
}) {
  if (!name || !String(name).trim()) {
    throw new Error("COUNTRY_NAME_REQUIRED");
  }

  const ref = db.collection(SERVER1_COUNTRIES).doc();

  const country = {
    id: ref.id,
    name: String(name).trim(),
    emoji: String(emoji || "🌍"),
    countryCode: String(countryCode || "").trim(),
    status: "enabled",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await ref.set(country);

  return country;
}



async function updateServer1Country(
  countryId,
  updates = {}
) {
  if (!countryId) {
    throw new Error("COUNTRY_ID_REQUIRED");
  }

  await db
    .collection(SERVER1_COUNTRIES)
    .doc(String(countryId))
    .update({
      ...updates,
      updatedAt: FieldValue.serverTimestamp(),
    });

  return getServer1Country(countryId);
}

async function deleteServer1Country(countryId) {
  if (!countryId) {
    throw new Error("COUNTRY_ID_REQUIRED");
  }

  await db
    .collection(SERVER1_COUNTRIES)
    .doc(String(countryId))
    .delete();
}


// ==================================================================
// SERVER 1 SERVICES
// ==================================================================

async function createServer1Service({
  name,
  serviceCode,
  countryId,
  description = "",
  price,
}) {
  if (!name || !String(name).trim()) {
    throw new Error("SERVICE_NAME_REQUIRED");
  }

  if (!serviceCode || !String(serviceCode).trim()) {
    throw new Error("SERVICE_CODE_REQUIRED");
  }

  if (!countryId) {
    throw new Error("COUNTRY_ID_REQUIRED");
  }

  const amount = Number(price);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("INVALID_PRICE");
  }

  const country = await getServer1Country(countryId);

  if (!country) {
    throw new Error("COUNTRY_NOT_FOUND");
  }

  const ref = db.collection(SERVER1_SERVICES).doc();

  const service = {
    id: ref.id,
    name: String(name).trim(),
    serviceCode: String(serviceCode).trim(),
    countryId: String(countryId),
    countryName: country.name || "",
    description: String(description || "").trim(),
    price: amount,
    status: "enabled",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await ref.set(service);

  return service;
}

async function getServer1Service(serviceId) {
  if (!serviceId) return null;

  const snap = await db
    .collection(SERVER1_SERVICES)
    .doc(String(serviceId))
    .get();

  return snap.exists ? snap.data() : null;
}

async function listServer1Services({
  countryId,
  onlyEnabled = false,
} = {}) {
  let ref = db.collection(SERVER1_SERVICES);

  if (countryId) {
    ref = ref.where(
      "countryId",
      "==",
      String(countryId)
    );
  }

  if (onlyEnabled) {
    ref = ref.where("status", "==", "enabled");
  }

  const snap = await ref.get();

  return snap.docs
    .map((doc) => doc.data())
    .sort((a, b) =>
      String(a.name || "").localeCompare(
        String(b.name || "")
      )
    );
}

async function updateServer1Service(
  serviceId,
  updates = {}
) {
  if (!serviceId) {
    throw new Error("SERVICE_ID_REQUIRED");
  }

  await db
    .collection(SERVER1_SERVICES)
    .doc(String(serviceId))
    .update({
      ...updates,
      updatedAt: FieldValue.serverTimestamp(),
    });

  return getServer1Service(serviceId);
}

async function deleteServer1Service(serviceId) {
  if (!serviceId) {
    throw new Error("SERVICE_ID_REQUIRED");
  }

  await db
    .collection(SERVER1_SERVICES)
    .doc(String(serviceId))
    .delete();
}
// ==================================================================
// SERVER 1 ORDERS
// ==================================================================

const SERVER1_ORDERS = "server1_orders";

/**
 * Create a Server 1 order.
 *
 * This is separate from the old manual product orders.
 */
async function createServer1Order({
  userId,
  productId = null,
  serviceId,
  serviceName = "",
  countryId,
  countryName = "",
  amount,
  provider = "grizzly",
  status = "processing",
  externalId = null,
}) {
  const uid = String(userId);
  const requestedPrice = Number(amount);

  if (!uid) {
    throw new Error("USER_ID_REQUIRED");
  }

  if (!serviceId) {
    throw new Error("SERVICE_ID_REQUIRED");
  }

  if (
    !Number.isFinite(requestedPrice) ||
    requestedPrice <= 0
  ) {
    throw new Error("INVALID_AMOUNT");
  }

  const userRef =
    db.collection(USERS).doc(uid);

  const orderRef =
    db.collection(SERVER1_ORDERS).doc();

  const productRef = productId
    ? db.collection(PRODUCTS).doc(String(productId))
    : null;

  return db.runTransaction(async (txn) => {
    let authoritativePrice = requestedPrice;

    // Read the current Firestore product price inside
    // the same transaction before deducting wallet balance.
    if (productRef) {
      const productSnap = await txn.get(productRef);

      if (!productSnap.exists) {
        throw new Error("PRODUCT_NOT_FOUND");
      }

      const product = productSnap.data();

      authoritativePrice =
        Number(product.finalPrice || 0);

      if (
        !Number.isFinite(authoritativePrice) ||
        authoritativePrice <= 0
      ) {
        throw new Error("INVALID_PRODUCT_PRICE");
      }

      // The local catalog may be stale if the background
      // provider sync changed the price just before purchase.
      // Never deduct money at the stale price.
      if (
        Math.abs(
          authoritativePrice - requestedPrice
        ) >= 0.01
      ) {
        const err = new Error(
          "Server 1 price changed. Please refresh and try again."
        );

        err.code = "SERVER1_PRICE_CHANGED";
        err.oldPrice = requestedPrice;
        err.newPrice = authoritativePrice;

        throw err;
      }
    }

    const userSnap = await txn.get(userRef);

    if (!userSnap.exists) {
      throw new Error("User not found");
    }

    const user = userSnap.data();
    const balance = Number(user.balance || 0);

    if (balance < authoritativePrice) {
      const err = new Error("Insufficient balance");
      err.code = "INSUFFICIENT_BALANCE";
      throw err;
    }

    const newBalance =
      balance - authoritativePrice;

    txn.update(userRef, {
      balance: newBalance,
      totalOrders:
        Number(user.totalOrders || 0) + 1,
      updatedAt:
        FieldValue.serverTimestamp(),
    });

    // Update automatic product popularity ranking.
    if (productRef) {
      txn.update(productRef, {
        salesCount:
          FieldValue.increment(1),
        lastSoldAt:
          FieldValue.serverTimestamp(),
        updatedAt:
          FieldValue.serverTimestamp(),
      });
    }

    const order = {
      orderId: orderRef.id,
      userId: uid,
      productId: productId
        ? String(productId)
        : null,
      serviceId: String(serviceId),
      serviceName: serviceName || "",
      countryId: countryId
        ? String(countryId)
        : null,
      countryName: countryName || "",
      provider: provider || "grizzly",
      amount: authoritativePrice,
      status,
      externalId,
      phoneNumber: "",
      activationId: null,
      smsCode: "",
      deliveryInfo: "",
      createdAt:
        FieldValue.serverTimestamp(),
      updatedAt:
        FieldValue.serverTimestamp(),
      processedAt: null,
      cancelledAt: null,
    };

    txn.set(orderRef, order);

    writeTransactionRecord(txn, {
      userId: uid,
      type: "server1_order_purchase",
      amount: -authoritativePrice,
      balanceAfter: newBalance,
      note:
        `Server 1 order: ${serviceName || serviceId}`,
      relatedId: orderRef.id,
    });

    return {
      ...order,
      newBalance,
    };
  });
}

/**
 * Get Server 1 order.
 */
async function getServer1Order(orderId) {
  if (!orderId) return null;

  const snap = await db
    .collection(SERVER1_ORDERS)
    .doc(String(orderId))
    .get();

  return snap.exists ? snap.data() : null;
}


/**
 * Get user's Server 1 orders.
 */
async function listUserServer1Orders(
  telegramId,
  limit = 10,
  offset = 0
) {
  const snap = await db
    .collection(SERVER1_ORDERS)
    .where("userId", "==", String(telegramId))
    .get();

  return snap.docs
    .map((doc) => doc.data())
    .sort(
      (a, b) =>
        toMillis(b.createdAt) -
        toMillis(a.createdAt)
    )
    .slice(offset, offset + limit);
}


/**
 * List Server 1 orders for admin.
 */
async function listServer1Orders({
  status,
  limit = 20,
} = {}) {
  let ref = db.collection(SERVER1_ORDERS);

  if (status) {
    ref = ref.where("status", "==", status);
  }

  const snap = await ref.get();

  return snap.docs
    .map((doc) => doc.data())
    .sort(
      (a, b) =>
        toMillis(b.createdAt) -
        toMillis(a.createdAt)
    )
    .slice(0, limit);
}



/**
 * Get Server 1 country sales statistics.
 *
 * Counts successful/non-failed orders by country.
 * Used for automatic country ranking.
 */

/**
 * Server 1 order statistics.
 *
 * Finalized orders:
 * - completed
 * - refunded
 *
 * No-number is detected from failureReason when available,
 * with deliveryInfo fallback for older orders.
 */
async function getServer1OrderStats() {
  const snap = await db
    .collection(SERVER1_ORDERS)
    .get();

  const stats = {
    total: 0,
    completed: 0,
    refunded: 0,
    noNumber: 0,
    cancelled: 0,
    waitingOtp: 0,
    processing: 0,
    manualReview: 0,
    finalized: 0,

    totalSales: 0,
    totalCost: 0,
    profit: 0,

    successRate: 0,
  };

  for (const doc of snap.docs) {
    const order = doc.data() || {};

    stats.total++;

    const status = String(
      order.status || ""
    ).toLowerCase();

    const reason = String(
      order.failureReason || ""
    ).toLowerCase();

    const info = String(
      order.deliveryInfo || ""
    ).toLowerCase();

    const amount = Number(order.amount || 0);
    const activationCost = Number(
      order.activationCost || 0
    );

    if (status === "completed") {
      stats.completed++;
      stats.totalSales +=
        Number.isFinite(amount) ? amount : 0;

      stats.totalCost +=
        Number.isFinite(activationCost)
          ? activationCost
          : 0;

      continue;
    }

    if (status === "refunded") {
      stats.refunded++;

      const isNoNumber =
        reason === "no_numbers" ||
        reason === "no_number" ||
        info.includes("no numbers") ||
        info.includes("number not available");

      if (isNoNumber) {
        stats.noNumber++;
      } else {
        stats.cancelled++;
      }

      continue;
    }

    if (status === "waiting_otp") {
      stats.waitingOtp++;
      continue;
    }

    if (status === "processing") {
      if (
        info.includes("manual review") ||
        info.includes("could not be confirmed")
      ) {
        stats.manualReview++;
      } else {
        stats.processing++;
      }

      continue;
    }
  }

  stats.finalized =
    stats.completed +
    stats.refunded;

  if (stats.finalized > 0) {
    stats.successRate =
      (stats.completed / stats.finalized) * 100;
  }

  stats.profit =
    stats.totalSales -
    stats.totalCost;

  return stats;
}


/**
 * Server 1 statistics for today.
 * Uses the server's local date boundary.
 */
async function getServer1TodayStats() {
  const snap = await db
    .collection(SERVER1_ORDERS)
    .get();

  const stats = {
    total: 0,
    completed: 0,
    refunded: 0,
    noNumber: 0,
    cancelled: 0,
    waitingOtp: 0,
    processing: 0,
    manualReview: 0,
    totalSales: 0,
    totalCost: 0,
    profit: 0,
    successRate: 0,
  };

  const now = new Date();

  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  const startMs = startOfDay.getTime();

  for (const doc of snap.docs) {
    const order = doc.data() || {};
    const createdAt = order.createdAt;

    let createdMs = 0;

    if (createdAt?.toDate) {
      createdMs = createdAt.toDate().getTime();
    } else if (createdAt instanceof Date) {
      createdMs = createdAt.getTime();
    }

    if (!createdMs || createdMs < startMs) {
      continue;
    }

    stats.total++;

    const status = String(
      order.status || ""
    ).toLowerCase();

    const reason = String(
      order.failureReason || ""
    ).toLowerCase();

    const info = String(
      order.deliveryInfo || ""
    ).toLowerCase();

    const amount = Number(order.amount || 0);
    const activationCost = Number(
      order.activationCost || 0
    );

    if (status === "completed") {
      stats.completed++;

      if (Number.isFinite(amount)) {
        stats.totalSales += amount;
      }

      if (Number.isFinite(activationCost)) {
        stats.totalCost += activationCost;
      }

      continue;
    }

    if (status === "refunded") {
      stats.refunded++;

      const isNoNumber =
        reason === "no_numbers" ||
        reason === "no_number" ||
        info.includes("no numbers") ||
        info.includes("number not available");

      if (isNoNumber) {
        stats.noNumber++;
      } else {
        stats.cancelled++;
      }

      continue;
    }

    if (status === "waiting_otp") {
      stats.waitingOtp++;
      continue;
    }

    if (status === "processing") {
      if (
        info.includes("manual review") ||
        info.includes("could not be confirmed")
      ) {
        stats.manualReview++;
      } else {
        stats.processing++;
      }
    }
  }

  const finalized =
    stats.completed +
    stats.refunded;

  if (finalized > 0) {
    stats.successRate =
      (stats.completed / finalized) * 100;
  }

  stats.profit =
    stats.totalSales -
    stats.totalCost;

  return stats;
}


/**
 * Admin referral statistics.
 *
 * Returns:
 * - total referred users
 * - total referral earnings
 * - today's referral earnings
 * - top referrers by earnings
 */
async function getReferralAdminStats() {
  const usersSnap = await db
    .collection(USERS)
    .get();

  const stats = {
    totalReferredUsers: 0,
    totalReferralEarnings: 0,
    todayReferralEarnings: 0,
    topReferrers: [],
  };

  const now = new Date();

  const startOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );

  const startMs = startOfDay.getTime();

  for (const doc of usersSnap.docs) {
    const user = doc.data() || {};

    const referralEarnings =
      Number(user.referralEarnings || 0);

    if (
      user.referrerId &&
      String(user.referrerId).trim()
    ) {
      stats.totalReferredUsers++;
    }

    if (
      Number.isFinite(referralEarnings) &&
      referralEarnings > 0
    ) {
      stats.totalReferralEarnings +=
        referralEarnings;
    }
  }

  const transactionsSnap = await db
    .collection(TRANSACTIONS)
    .where(
      "type",
      "==",
      "referral_commission"
    )
    .get();

  const referrerMap = {};

  for (const doc of transactionsSnap.docs) {
    const transaction = doc.data() || {};

    const userId = String(
      transaction.userId || ""
    ).trim();

    const amount = Number(
      transaction.amount || 0
    );

    if (
      !userId ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      continue;
    }

    if (!referrerMap[userId]) {
      referrerMap[userId] = {
        userId,
        earnings: 0,
        commissions: 0,
      };
    }

    referrerMap[userId].earnings += amount;
    referrerMap[userId].commissions++;

    let createdMs = 0;

    const createdAt =
      transaction.createdAt;

    if (createdAt?.toDate) {
      createdMs =
        createdAt.toDate().getTime();
    } else if (createdAt instanceof Date) {
      createdMs =
        createdAt.getTime();
    }

    if (
      createdMs &&
      createdMs >= startMs
    ) {
      stats.todayReferralEarnings +=
        amount;
    }
  }

  stats.totalReferralEarnings =
    Number(
      stats.totalReferralEarnings.toFixed(2)
    );

  stats.todayReferralEarnings =
    Number(
      stats.todayReferralEarnings.toFixed(2)
    );

  stats.topReferrers =
    Object.values(referrerMap)
      .sort(
        (a, b) =>
          b.earnings - a.earnings
      )
      .slice(0, 10)
      .map((item) => ({
        userId: item.userId,
        earnings: Number(
          item.earnings.toFixed(2)
        ),
        commissions:
          item.commissions,
      }));

  return stats;
}

async function getServer1CountrySalesStats() {
  const snap = await db
    .collection(SERVER1_ORDERS)
    .get();

  const stats = {};

  const SUCCESS_STATUSES = new Set([
    "completed",
    "success",
    "successful",
    "delivered",
    "done"
  ]);

  const FAILED_STATUSES = new Set([
    "failed",
    "cancelled",
    "canceled",
    "refunded",
    "rejected"
  ]);

  const now = Date.now();

  for (const doc of snap.docs) {
    const order = doc.data();

    const status = String(
      order.status || ""
    ).toLowerCase();

    // Only successful orders affect popularity.
    if (!SUCCESS_STATUSES.has(status)) {
      continue;
    }

    if (FAILED_STATUSES.has(status)) {
      continue;
    }

    const countryId = String(
      order.countryId || ""
    );

    if (!countryId) {
      continue;
    }

    if (!stats[countryId]) {
      stats[countryId] = {
        sales: 0,
        score: 0
      };
    }

    stats[countryId].sales += 1;

    // Recent successful purchases get slightly higher weight.
    let createdAt = null;

    try {
      if (
        order.createdAt &&
        typeof order.createdAt.toMillis === "function"
      ) {
        createdAt = order.createdAt.toMillis();
      } else if (
        order.createdAt &&
        typeof order.createdAt.seconds === "number"
      ) {
        createdAt =
          Number(order.createdAt.seconds) * 1000;
      } else if (
        typeof order.createdAt === "number"
      ) {
        createdAt = order.createdAt;
      }
    } catch (_) {}

    if (createdAt) {
      const ageDays =
        Math.max(
          0,
          (now - createdAt) /
            (24 * 60 * 60 * 1000)
        );

      // Slowly decay old sales.
      const weight =
        Math.max(
          0.25,
          1 - ageDays / 30
        );

      stats[countryId].score += weight;
    } else {
      stats[countryId].score += 0.5;
    }
  }

  return stats;
}

/**
 * Update Server 1 order.
 */
async function updateServer1Order(
  orderId,
  updates = {}
) {
  if (!orderId) {
    throw new Error("ORDER_ID_REQUIRED");
  }

  await db
    .collection(SERVER1_ORDERS)
    .doc(String(orderId))
    .update({
      ...updates,
      updatedAt: FieldValue.serverTimestamp(),
    });

  return getServer1Order(orderId);
}

/**
 * Atomically complete a Server 1 order only if it is still active.
 *
 * Returns completed=false when another flow already completed,
 * cancelled, refunded, or otherwise changed the order.
 */
async function completeServer1Order(
  orderId,
  { smsCode, deliveryInfo = "OTP received successfully" } = {}
) {
  if (!orderId) {
    throw new Error("ORDER_ID_REQUIRED");
  }

  const code = String(smsCode || "").trim();

  if (!/^\\d{4,8}$/.test(code)) {
    throw new Error("INVALID_SMS_CODE");
  }

  const orderRef = db
    .collection(SERVER1_ORDERS)
    .doc(String(orderId));

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(orderRef);

    if (!snap.exists) {
      throw new Error("SERVER1_ORDER_NOT_FOUND");
    }

    const order = snap.data();
    const status = String(order.status || "").toLowerCase();

    if (!["waiting_otp", "processing"].includes(status)) {
      return {
        completed: false,
        order: {
          ...order,
          orderId: String(orderId),
        },
      };
    }

    txn.update(orderRef, {
      status: "completed",
      smsCode: code,
      deliveryInfo,
      processedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      completed: true,
      order: {
        ...order,
        orderId: String(orderId),
        status: "completed",
        smsCode: code,
        deliveryInfo,
      },
    };
  });
}

// ==================================================================
// SERVER 1 COUNTRIES
// ==================================================================
async function syncServer1Countries(countries = []) {
  if (!Array.isArray(countries) || countries.length === 0) {
    throw new Error("COUNTRY_CATALOG_EMPTY");
  }

  const BATCH_SIZE = 400;
  let saved = 0;

  for (let i = 0; i < countries.length; i += BATCH_SIZE) {
    const batch = db.batch();

    const chunk = countries.slice(
      i,
      i + BATCH_SIZE
    );

    for (const country of chunk) {
      if (!country.countryCode || !country.countryName) {
        continue;
      }

      const docId =
        `grizzly_${String(country.countryCode)}`;

      const ref = db
        .collection(SERVER1_COUNTRIES)
        .doc(docId);

      batch.set(
        ref,
        {
          provider: "grizzly",
          countryCode: String(country.countryCode),
          countryName: String(country.countryName),
          emoji: country.emoji || "🌍",
          status: "enabled",
          updatedAt:
            FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      saved++;
    }

    await batch.commit();
  }

  return {
    total: countries.length,
    saved,
  };
}

/**
 * Get one Server 1 country.
 */
async function getServer1Country(countryId) {
  if (!countryId) return null;

  const snap = await db
    .collection(SERVER1_COUNTRIES)
    .doc(String(countryId))
    .get();

  return snap.exists ? snap.data() : null;
}

/**
 * List Server 1 countries.
 */
async function listServer1Countries({
  provider = "grizzly",
  onlyEnabled = false,
} = {}) {
  let ref = db
    .collection(SERVER1_COUNTRIES)
    .where("provider", "==", provider);

  if (onlyEnabled) {
    ref = ref.where("status", "==", "enabled");
  }

  const snap = await ref.get();

  return snap.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }))
    .sort((a, b) =>
      String(a.countryName).localeCompare(
        String(b.countryName)
      )
    );
}

/**
 * Count Server 1 countries.
 */
async function countServer1Countries({
  provider = "grizzly",
} = {}) {
  const snap = await db
    .collection(SERVER1_COUNTRIES)
    .where("provider", "==", provider)
    .count()
    .get();

  return snap.data().count;
}


/**
 * Cancel Server 1 order and refund user atomically.
 * Prevents double refunds.
 */
async function cancelServer1OrderAndRefund(orderId, reason = "") {
  if (!orderId) {
    throw new Error("SERVER1_ORDER_ID_REQUIRED");
  }

  const orderRef = db
    .collection(SERVER1_ORDERS)
    .doc(String(orderId));

  return db.runTransaction(async (txn) => {
    const orderSnap = await txn.get(orderRef);

    if (!orderSnap.exists) {
      throw new Error("SERVER1_ORDER_NOT_FOUND");
    }

    const order = orderSnap.data();
    const status = String(order.status || "").toLowerCase();

    // ==========================================================
    // HARD REFUND LOCK
    // Refund is allowed ONLY for active Server 1 orders.
    // ==========================================================
    if (!["processing", "waiting_otp"].includes(status)) {
      const err = new Error(
        `SERVER1_REFUND_NOT_ALLOWED_FOR_STATUS:${status}`
      );
      err.code = "SERVER1_REFUND_NOT_ALLOWED";
      throw err;
    }

    const amount = Number(order.amount || 0);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("SERVER1_INVALID_REFUND_AMOUNT");
    }

    const userId = String(order.userId || "");

    if (!userId) {
      throw new Error("SERVER1_USER_ID_REQUIRED");
    }

    const userRef = db
      .collection(USERS)
      .doc(userId);

    const userSnap = await txn.get(userRef);

    if (!userSnap.exists) {
      throw new Error("SERVER1_USER_NOT_FOUND");
    }

    const user = userSnap.data();
    const currentBalance = Number(user.balance || 0);

    if (!Number.isFinite(currentBalance) || currentBalance < 0) {
      throw new Error("SERVER1_INVALID_USER_BALANCE");
    }

    const newBalance = currentBalance + amount;

    txn.update(userRef, {
      balance: newBalance,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const refundReason = String(reason || "").trim();

    const failureReason =
      refundReason.toLowerCase().includes("no numbers")
        ? "no_numbers"
        : "cancelled";

    txn.update(orderRef, {
      status: "refunded",
      failureReason,
      deliveryInfo:
        refundReason ||
        "Server 1 order cancelled and amount refunded",
      cancelledAt: FieldValue.serverTimestamp(),
      processedAt: FieldValue.serverTimestamp(),
      refundProcessedAt: FieldValue.serverTimestamp(),
      refundAmount: amount,
      updatedAt: FieldValue.serverTimestamp(),
    });

    writeTransactionRecord(txn, {
      userId,
      type: "order_refund",
      amount,
      balanceAfter: newBalance,
      note:
        reason ||
        "Server 1 order cancelled and amount refunded",
      relatedId: String(orderId),
    });


    return {
      orderId: String(orderId),
      userId,
      refundAmount: amount,
      newBalance,
      status: "refunded",
    };
  });
}

module.exports = {
  registerUserReferral,
  // users
  createUser,
  getUser,
  getReferralStats,
  getReferralAdminStats,
  updateUser,
  listUsers,
  getTopDepositors,
  searchUsers,
  countUsers,
  listAllUserIds,
  cancelServer1OrderAndRefund,
  // wallet
  addBalance,
  removeBalance,
  getUserBalance,
  listUserTransactions,
  // deposits
  createDeposit,
  getDeposit,
  listPendingDeposits,
  listUserDeposits,
  approveDeposit,
  rejectDeposit,
  countDepositsByStatus,
  sumApprovedDepositAmount,
  //fam pay chekar
  findPendingDepositByUtrAndAmount,
  markGmailPaymentProcessed,
  isGmailPaymentProcessed,
  markGmailMessageSeen,
  isGmailMessageSeen,
  // countries
  createCountry,
  getCountry,
  updateCountry,
  deleteCountry,
  listCountries,
  countCountries,
  countProductsByCountry,
  // providers
  createProvider,
  getProvider,
  updateProvider,
  deleteProvider,
  listProviders,
  countProviders,
  // products
  createProduct,
  createProductsBatch,
  getProduct,
  updateProduct,
  deleteProduct,
  deleteAllProducts,
  listProducts,
  countProducts,
  // orders
  createOrder,
  getOrder,
  listUserOrders,
  listOrders,
  countOrders,
  countOrdersByStatus,
  completeOrder,
  cancelOrder,
  // settings
  getSettings,
  getSettingsSnapshot,
  getUserSnapshot,
  updateSettings,
  // statistics
  getStatistics,
    // Server 1 catalog
  createServer1Country,
  getServer1Country,
  listServer1Countries,
  updateServer1Country,
  deleteServer1Country,

  createServer1Service,
  getServer1Service,
  listServer1Services,
  updateServer1Service,
  deleteServer1Service,
  // Server 1 countries
  syncServer1Countries,
  countServer1Countries,
 
  // Server 1 orders
  createServer1Order,
  getServer1Order,
  listUserServer1Orders,
  listServer1Orders,
  updateServer1Order,
  completeServer1Order,
  syncServer1ProviderPrices,
  getServer1CountrySalesStats,
  getServer1OrderStats,
  getServer1TodayStats,
};
