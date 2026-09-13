/**
 * utils/session.js
 * ------------------------------------------------------------------
 * In-memory conversation state + current Telegram UI message.
 * ------------------------------------------------------------------
 */

const sessions = new Map();
const uiMessages = new Map();

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
  setMessage,
  getMessage,
};
