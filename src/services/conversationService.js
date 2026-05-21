const config = require('../config');

// userId (phone number or platform user id) -> Array<{role, content}>
const store = new Map();

function getHistory(userId) {
  return store.get(userId) || [];
}

function addMessage(userId, role, content) {
  const history = store.get(userId) || [];
  history.push({ role, content });

  // Trim oldest messages when the window exceeds the limit
  const max = config.conversation.maxHistory;
  if (history.length > max) {
    history.splice(0, history.length - max);
  }

  store.set(userId, history);
}

function clearHistory(userId) {
  store.delete(userId);
}

function getActiveUsers() {
  return [...store.keys()];
}

module.exports = { getHistory, addMessage, clearHistory, getActiveUsers };
