/**
 * D1-backed Firestore-compatible store used by database.js.
 *
 * This keeps the existing repository API shape while moving persistence
 * to Cloudflare D1 through the authenticated Worker bridge.
 *
 * Transaction callbacks are protected by a short-lived application mutex.
 * The callback reads normally, queues writes, then commits them through
 * D1's atomic batch API before releasing the mutex.
 */

const crypto = require("crypto");

const ACCOUNT_ID = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const DATABASE_ID = String(process.env.CLOUDFLARE_D1_DATABASE_ID || "").trim();
const API_SECRET = String(process.env.D1_API_SECRET || "").trim();

if (!ACCOUNT_ID || !DATABASE_ID || !API_SECRET) {
  throw new Error("D1 configuration missing: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and D1_API_SECRET are required");
}

const API_URL =
  String(process.env.D1_API_URL || "").trim() ||
  `https://account-store-d1-api.kumaradarshpatel30.workers.dev`;

const MAX_RETRIES = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, body = null) {
  const response = await fetch(`${API_URL}${path}`, {
    method: body === null ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${API_SECRET}`,
      "content-type": "application/json",
    },
    body: body === null ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }

  if (!response.ok) {
    const error = new Error(payload?.error || `D1 API HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function query(sql, params = []) {
  const payload = await api("/query", { sql, params });
  return Array.isArray(payload?.results) ? payload.results : [];
}

async function batch(statements) {
  if (!statements.length) return [];
  const payload = await api("/batch", { batch: statements });
  return Array.isArray(payload?.results) ? payload.results : [];
}

function deepClone(value) {
  if (value === undefined || value === null) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (isServerTimestamp(value) || isDeleteField(value) || isIncrement(value)) {
    return { ...value };
  }
  if (Array.isArray(value)) return value.map(deepClone);
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepClone(item);
    return out;
  }
  return value;
}

const SERVER_TIMESTAMP = Symbol("d1.serverTimestamp");
const DELETE_FIELD = Symbol("d1.deleteField");

function increment(value) {
  return { __d1FieldValue: "increment", value: Number(value) || 0 };
}

const FieldValue = {
  serverTimestamp() {
    return { __d1FieldValue: SERVER_TIMESTAMP };
  },
  increment(value) {
    return increment(value);
  },
  delete() {
    return { __d1FieldValue: DELETE_FIELD };
  },
};

function isServerTimestamp(value) {
  return value && value.__d1FieldValue === SERVER_TIMESTAMP;
}

function isDeleteField(value) {
  return value && value.__d1FieldValue === DELETE_FIELD;
}

function isIncrement(value) {
  return value && value.__d1FieldValue === "increment";
}

function resolveValue(value, oldValue) {
  if (isServerTimestamp(value)) return new Date().toISOString();
  if (isDeleteField(value)) return DELETE_FIELD;

  if (isIncrement(value)) {
    return Number(oldValue || 0) + Number(value.value || 0);
  }

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map((item, index) => resolveValue(item, oldValue?.[index]));
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const resolved = resolveValue(item, oldValue?.[key]);
      if (resolved !== DELETE_FIELD) out[key] = resolved;
    }
    return out;
  }

  return value;
}

function applyObject(existing, incoming, merge) {
  const base = merge ? deepClone(existing || {}) : {};
  const source = incoming || {};

  for (const [key, rawValue] of Object.entries(source)) {
    const oldValue = base[key];
    const value = resolveValue(rawValue, oldValue);

    if (value === DELETE_FIELD) {
      delete base[key];
    } else {
      base[key] = value;
    }
  }

  return base;
}

function makeSnapshot(collection, id, data) {
  const exists = data !== null && data !== undefined;
  return {
    id,
    exists,
    ref: new DocumentReference(collection, id),
    data: () => (exists ? deepClone(data) : undefined),
  };
}

async function readDocument(collection, id) {
  const rows = await query(
    "SELECT doc_id, data FROM firestore_documents WHERE collection = ? AND doc_id = ? LIMIT 1",
    [collection, id]
  );

  if (!rows.length) return makeSnapshot(collection, id, null);

  let data = {};
  try {
    data = JSON.parse(rows[0].data);
  } catch {
    throw new Error(`Invalid JSON stored for ${collection}/${id}`);
  }

  return makeSnapshot(collection, id, data);
}

async function readCollection(collection) {
  const rows = await query(
    "SELECT doc_id, data FROM firestore_documents WHERE collection = ?",
    [collection]
  );

  return rows.map((row) => {
    let data = {};
    try {
      data = JSON.parse(row.data);
    } catch {
      throw new Error(`Invalid JSON stored for ${collection}/${row.doc_id}`);
    }
    return makeSnapshot(collection, row.doc_id, data);
  });
}

function compareValues(a, b) {
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();

  if (typeof a === "string" && typeof b === "string") {
    const at = Date.parse(a);
    const bt = Date.parse(b);
    if (!Number.isNaN(at) && !Number.isNaN(bt)) {
      a = at;
      b = bt;
    }
  }

  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function fieldValue(data, field) {
  if (!field) return undefined;
  return field.split(".").reduce((current, key) => current?.[key], data);
}

function matchesWhere(data, field, op, expected) {
  const actual = fieldValue(data, field);

  switch (op) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case "<":
      return compareValues(actual, expected) < 0;
    case "<=":
      return compareValues(actual, expected) <= 0;
    case ">":
      return compareValues(actual, expected) > 0;
    case ">=":
      return compareValues(actual, expected) >= 0;
    case "array-contains":
      return Array.isArray(actual) && actual.includes(expected);
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "array-contains-any":
      return Array.isArray(actual) &&
        Array.isArray(expected) &&
        actual.some((value) => expected.includes(value));
    default:
      throw new Error(`Unsupported D1 query operator: ${op}`);
  }
}

class Query {
  constructor(collection) {
    this.collection = collection;
    this.filters = [];
    this.order = null;
    this.max = null;
    this.skip = 0;
    this.projection = null;
  }

  _clone() {
    const next = new Query(this.collection);
    next.filters = [...this.filters];
    next.order = this.order ? { ...this.order } : null;
    next.max = this.max;
    next.skip = this.skip;
    next.projection = this.projection ? [...this.projection] : null;
    return next;
  }

  where(field, op, value) {
    const next = this._clone();
    next.filters.push({ field, op, value });
    return next;
  }

  orderBy(field, direction = "asc") {
    const next = this._clone();
    next.order = {
      field,
      direction: String(direction).toLowerCase() === "desc" ? "desc" : "asc",
    };
    return next;
  }

  limit(value) {
    const next = this._clone();
    next.max = Math.max(0, Number(value) || 0);
    return next;
  }

  offset(value) {
    const next = this._clone();
    next.skip = Math.max(0, Number(value) || 0);
    return next;
  }

  select(...fields) {
    const next = this._clone();
    next.projection = fields.flat();
    return next;
  }

  async _execute() {
    let docs = await readCollection(this.collection);

    for (const filter of this.filters) {
      docs = docs.filter((doc) =>
        matchesWhere(doc.data(), filter.field, filter.op, filter.value)
      );
    }

    if (this.order) {
      const { field, direction } = this.order;
      docs.sort((a, b) => {
        const result = compareValues(
          fieldValue(a.data(), field),
          fieldValue(b.data(), field)
        );
        return direction === "desc" ? -result : result;
      });
    }

    if (this.skip) docs = docs.slice(this.skip);
    if (this.max !== null) docs = docs.slice(0, this.max);

    if (this.projection) {
      docs = docs.map((doc) => {
        const source = doc.data() || {};
        const selected = {};
        for (const field of this.projection) {
          if (Object.prototype.hasOwnProperty.call(source, field)) {
            selected[field] = source[field];
          }
        }
        return makeSnapshot(this.collection, doc.id, selected);
      });
    }

    return docs;
  }

  async get() {
    const docs = await this._execute();
    return {
      docs,
      size: docs.length,
      empty: docs.length === 0,
    };
  }

  count() {
    return {
      get: async () => {
        const docs = await this._execute();
        return { data: () => ({ count: docs.length }) };
      },
    };
  }
}

class DocumentReference {
  constructor(collection, id) {
    this.collection = String(collection);
    this.id = String(id);
    this.path = `${this.collection}/${this.id}`;
  }

  async get() {
    return readDocument(this.collection, this.id);
  }

  async set(data, options = {}) {
    const existing = await this.get();
    const finalData = applyObject(existing.exists ? existing.data() : {}, data, Boolean(options.merge));

    await batch([{
      sql: `INSERT INTO firestore_documents (collection, doc_id, data)
            VALUES (?, ?, ?)
            ON CONFLICT(collection, doc_id)
            DO UPDATE SET data = excluded.data`,
      params: [this.collection, this.id, JSON.stringify(finalData)],
    }]);

    return this;
  }

  async create(data) {
    const existing = await this.get();
    if (existing.exists) {
      const error = new Error(`Document already exists: ${this.path}`);
      error.code = "ALREADY_EXISTS";
      throw error;
    }

    const finalData = applyObject({}, data, false);

    await batch([{
      sql: "INSERT INTO firestore_documents (collection, doc_id, data) VALUES (?, ?, ?)",
      params: [this.collection, this.id, JSON.stringify(finalData)],
    }]);

    return this;
  }

  async update(data) {
    const existing = await this.get();
    if (!existing.exists) {
      const error = new Error(`Document does not exist: ${this.path}`);
      error.code = "NOT_FOUND";
      throw error;
    }

    const finalData = applyObject(existing.data(), data, true);

    await batch([{
      sql: "UPDATE firestore_documents SET data = ? WHERE collection = ? AND doc_id = ?",
      params: [JSON.stringify(finalData), this.collection, this.id],
    }]);

    return this;
  }

  async delete() {
    await batch([{
      sql: "DELETE FROM firestore_documents WHERE collection = ? AND doc_id = ?",
      params: [this.collection, this.id],
    }]);
  }
}

class Transaction {
  constructor() {
    this.operations = [];
  }

  async get(refOrQuery) {
    if (refOrQuery instanceof DocumentReference) {
      return refOrQuery.get();
    }
    return refOrQuery.get();
  }

  set(ref, data, options = {}) {
    this.operations.push({ type: "set", ref, data: deepClone(data), options });
    return this;
  }

  create(ref, data) {
    this.operations.push({ type: "create", ref, data: deepClone(data) });
    return this;
  }

  update(ref, data) {
    this.operations.push({ type: "update", ref, data: deepClone(data) });
    return this;
  }

  delete(ref) {
    this.operations.push({ type: "delete", ref });
    return this;
  }

  async commit() {
    const statements = [];

    for (const op of this.operations) {
      const current = await op.ref.get();
      const currentData = current.exists ? current.data() : {};

      if (op.type === "create" && current.exists) {
        const error = new Error(`Document already exists: ${op.ref.path}`);
        error.code = "ALREADY_EXISTS";
        throw error;
      }

      if ((op.type === "update") && !current.exists) {
        const error = new Error(`Document does not exist: ${op.ref.path}`);
        error.code = "NOT_FOUND";
        throw error;
      }

      if (op.type === "delete") {
        statements.push({
          sql: "DELETE FROM firestore_documents WHERE collection = ? AND doc_id = ?",
          params: [op.ref.collection, op.ref.id],
        });
        continue;
      }

      const finalData = applyObject(
        currentData,
        op.data,
        op.type === "set" ? Boolean(op.options?.merge) : true
      );

      statements.push({
        sql: `INSERT INTO firestore_documents (collection, doc_id, data)
              VALUES (?, ?, ?)
              ON CONFLICT(collection, doc_id)
              DO UPDATE SET data = excluded.data`,
        params: [op.ref.collection, op.ref.id, JSON.stringify(finalData)],
      });
    }

    await batch(statements);
  }
}

class WriteBatch {
  constructor() {
    this.operations = [];
  }

  set(ref, data, options = {}) {
    this.operations.push({ type: "set", ref, data: deepClone(data), options });
    return this;
  }

  update(ref, data) {
    this.operations.push({ type: "update", ref, data: deepClone(data) });
    return this;
  }

  delete(ref) {
    this.operations.push({ type: "delete", ref });
    return this;
  }

  async commit() {
    const txn = new Transaction();
    txn.operations = this.operations;
    await txn.commit();
  }
}

let localLockTail = Promise.resolve();
const localHolders = new Set();

async function acquireLocalLock() {
  let release;
  const previous = localLockTail;
  localLockTail = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  const holder = `local-${crypto.randomUUID()}`;
  localHolders.add(holder);
  return holder;
}

async function releaseLocalLock(holder) {
  if (localHolders.has(holder)) {
    localHolders.delete(holder);
  }
  // Advance the local mutex queue.
  // The promise resolver is stored on the holder map below.
}

const localResolvers = new Map();
async function acquireProcessLock() {
  const previous = localLockTail;
  let resolveCurrent;
  localLockTail = new Promise((resolve) => {
    resolveCurrent = resolve;
  });
  await previous;
  const holder = `process-${crypto.randomUUID()}`;
  localResolvers.set(holder, resolveCurrent);
  return holder;
}

async function releaseProcessLock(holder) {
  const resolve = localResolvers.get(holder);
  if (resolve) {
    localResolvers.delete(holder);
    resolve();
  }
}

async function acquireLock() {
  const holder = crypto.randomUUID();

  try {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const response = await api("/lock/acquire", {
        holder,
        ttlMs: 30000,
      });

      if (response.acquired) return { type: "worker", holder };

      await sleep(100 + Math.floor(Math.random() * 150));
    }

    throw new Error("D1 transaction lock timeout");
  } catch (error) {
    if (error?.status !== 404) throw error;
    return { type: "process", holder: await acquireProcessLock() };
  }
}

async function releaseLock(lock) {
  if (!lock) return;

  if (lock.type === "process") {
    await releaseProcessLock(lock.holder);
    return;
  }

  try {
    await api("/lock/release", { holder: lock.holder });
  } catch (error) {
    console.error("[D1] lock release failed:", error.message);
  }
}

async function runTransaction(callback) {
  const lock = await acquireLock();
  try {
    const txn = new Transaction();
    const result = await callback(txn);
    await txn.commit();
    return result;
  } finally {
    await releaseLock(lock);
  }
}

class CollectionReference extends Query {
  constructor(collection) {
    super(collection);
  }

  doc(id) {
    const documentId =
      id === undefined || id === null || id === ""
        ? crypto.randomUUID().replace(/-/g, "")
        : String(id);

    return new DocumentReference(this.collection, documentId);
  }
}

class D1Database {
  collection(name) {
    return new CollectionReference(String(name));
  }

  batch() {
    return new WriteBatch();
  }

  runTransaction(callback) {
    return runTransaction(callback);
  }
}

const db = new D1Database();

module.exports = {
  ...db,
  collection: db.collection.bind(db),
  batch: db.batch.bind(db),
  runTransaction: db.runTransaction.bind(db),
  FieldValue,
};
