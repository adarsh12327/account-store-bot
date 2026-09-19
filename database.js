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