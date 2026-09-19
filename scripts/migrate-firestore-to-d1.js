/**
 * One-time Firestore -> Cloudflare D1 migration.
 *
 * This script ONLY copies data. It does not change the bot's database
 * implementation, so production can continue using Firestore until the
 * D1 data has been verified.
 *
 * Required environment variables:
 *   FIREBASE_SERVICE_ACCOUNT_JSON
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_D1_DATABASE_ID
 *
 * Run:
 *   node scripts/migrate-firestore-to-d1.js
 */

require("dotenv").config();

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const COLLECTIONS = [
  "users",
  "products",
  "countries",
  "providers",
  "deposits",
  "orders",
  "transactions",
  "settings",
  "server1_countries",
  "server1_services",
  "server1_orders",
  "processed_gmail_payments",
  "seen_gmail_messages",
];

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function normalizeValue(value) {
  if (value === null || value === undefined) return value;

  if (value && typeof value.toMillis === "function") {
    return new Date(value.toMillis()).toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = normalizeValue(child);
    }
    return out;
  }

  return value;
}

function timestampValue(data, key) {
  const value = data?.[key];
  if (!value) return null;

  if (typeof value.toMillis === "function") {
    return new Date(value.toMillis()).toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return value;
  }

  return null;
}

async function d1Query(accountId, databaseId, token, sql, params = []) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ sql, params }),
    }
  );

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.success === false || body.errors?.length) {
    throw new Error(
      `D1 query failed: HTTP ${response.status} ${JSON.stringify(body.errors || body)}`
    );
  }

  return body;
}

async function d1Batch(accountId, databaseId, token, batch) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ batch }),
    }
  );

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.success === false || body.errors?.length) {
    throw new Error(
      `D1 batch failed: HTTP ${response.status} ${JSON.stringify(body.errors || body)}`
    );
  }

  return body;
}

async function main() {
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const databaseId = required("CLOUDFLARE_D1_DATABASE_ID");
  const token = required("CLOUDFLARE_API_TOKEN");
  const serviceAccountJson = required("FIREBASE_SERVICE_ACCOUNT_JSON");

  if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
  }

  const firestore = getFirestore();

  // Safety: schema must already exist.
  const schemaCheck = await d1Query(
    accountId,
    databaseId,
    token,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='firestore_documents'"
  );

  const tables = schemaCheck.result?.[0]?.results || [];
  if (!tables.length) {
    throw new Error(
      "D1 table firestore_documents does not exist. Run migrations/0001_firestore_documents.sql first."
    );
  }

  let total = 0;

  for (const collectionName of COLLECTIONS) {
    console.log(`[MIGRATE] Reading ${collectionName}...`);

    const snapshot = await firestore.collection(collectionName).get();
    const docs = snapshot.docs;

    console.log(`[MIGRATE] ${collectionName}: ${docs.length} documents`);

    for (let i = 0; i < docs.length; i += 50) {
      const chunk = docs.slice(i, i + 50);

      const batch = chunk.map((doc) => {
        const data = normalizeValue(doc.data());

        return {
          sql:
            "INSERT INTO firestore_documents " +
            "(collection, doc_id, data, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(collection, doc_id) DO UPDATE SET " +
            "data=excluded.data, " +
            "created_at=excluded.created_at, " +
            "updated_at=excluded.updated_at",
          params: [
            collectionName,
            doc.id,
            JSON.stringify(data),
            timestampValue(doc.data(), "createdAt") ||
              timestampValue(doc.data(), "joinDate") ||
              timestampValue(doc.data(), "seenAt"),
            timestampValue(doc.data(), "updatedAt"),
          ],
        };
      });

      await d1Batch(accountId, databaseId, token, batch);

      total += chunk.length;
      console.log(
        `[MIGRATE] ${collectionName}: ${Math.min(i + chunk.length, docs.length)}/${docs.length}`
      );
    }
  }

  console.log(`[MIGRATE] Complete. Copied ${total} documents.`);

  for (const collectionName of COLLECTIONS) {
    const result = await d1Query(
      accountId,
      databaseId,
      token,
      "SELECT COUNT(*) AS count FROM firestore_documents WHERE collection = ?",
      [collectionName]
    );

    const count = result.result?.[0]?.results?.[0]?.count ?? 0;
    console.log(`[VERIFY] ${collectionName}: ${count}`);
  }
}

main().catch((error) => {
  console.error("[MIGRATE] FAILED", error);
  process.exitCode = 1;
});
