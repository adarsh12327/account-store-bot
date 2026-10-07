/**
 * utils/session.js
 * ------------------------------------------------------------------
 * In-memory conversation state + current Telegram UI message.
 * ------------------------------------------------------------------
 */

const sessions = new Map();
const uiMessages = new Map();
const server2AuthSessions = new Map();

function get(telegramId) {
  return sessions.get(String(telegramId)) || null;
}

function set(telegramId, data) {
  sessions.set(String(telegramId), data);
}

function clear(telegramId) {
  const id = String(telegramId);

  sessions.delete(id);
  uiMessages.delete(id);
}

/**
 * Save the Telegram message currently being used as the UI screen.
 */
function setServer2Auth(telegramId, ttlMs = 12 * 60 * 60 * 1000) {
  const id = String(telegramId);
  server2AuthSessions.set(id, { expiresAt: Date.now() + ttlMs });
}

function isServer2Authenticated(telegramId) {
  const id = String(telegramId);
  const auth = server2AuthSessions.get(id);
  if (!auth) return false;
  if (Date.now() >= auth.expiresAt) {
    server2AuthSessions.delete(id);
    return false;
  }
  return true;
}

function clearServer2Auth(telegramId) {
  server2AuthSessions.delete(String(telegramId));
}

function setMessage(telegramId, message) {
  if (!telegramId || !message) return;

  const id = String(telegramId);

  const chatId = message.chat?.id;
  const messageId = message.message_id;

  if (chatId == null || messageId == null) return;

  uiMessages.set(id, {
    chatId,
    messageId,
  });
}

/**
 * Get the saved Telegram UI message.
 */
function getMessage(telegramId) {
  return uiMessages.get(String(telegramId)) || null;
}

module.exports = {
  get,
  set,
  clear,
  setServer2Auth,
  isServer2Authenticated,
  clearServer2Auth,
  setMessage,
  getMessage,
};
