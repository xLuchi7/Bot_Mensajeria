const config = require('../config');
const conversation = require('../services/conversationService');
const claude = require('../services/claudeService');
const meta = require('../services/metaService');

// GET /webhook — Meta hub verification handshake
function verify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.meta.verifyToken) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
}

// POST /webhook — incoming messages from Meta
async function handleMessage(req, res) {
  // Acknowledge immediately; Meta requires a 200 within 20 s
  res.sendStatus(200);

  const { object, entry } = req.body;
  if (!object || !Array.isArray(entry)) return;

  for (const e of entry) {
    try {
      if (object === 'whatsapp_business_account') await processWhatsApp(e);
      else if (object === 'instagram') await processInstagram(e);
      else if (object === 'page') await processFacebook(e);
    } catch (err) {
      console.error(`Error processing ${object} entry:`, err.message);
    }
  }
}

// ── Platform handlers ────────────────────────────────────────────────────────

async function processWhatsApp(entry) {
  for (const change of entry.changes || []) {
    if (change.field !== 'messages') continue;

    const { metadata, messages = [] } = change.value || {};
    const phoneNumberId = metadata?.phone_number_id;

    for (const msg of messages) {
      if (msg.type !== 'text') continue;

      const userId = msg.from;
      const text = msg.text?.body;
      if (!text) continue;

      const reply = await buildReply(userId, text);
      await meta.sendWhatsAppMessage(phoneNumberId, userId, reply);
    }
  }
}

async function processInstagram(entry) {
  for (const messaging of entry.messaging || []) {
    const userId = messaging.sender?.id;
    const text = messaging.message?.text;

    // Skip echoes (messages sent by the page itself)
    if (!userId || !text || messaging.message?.is_echo) continue;

    const reply = await buildReply(userId, text);
    await meta.sendInstagramMessage(userId, reply);
  }
}

async function processFacebook(entry) {
  for (const messaging of entry.messaging || []) {
    const userId = messaging.sender?.id;
    const text = messaging.message?.text;

    if (!userId || !text || messaging.message?.is_echo) continue;

    const reply = await buildReply(userId, text);
    await meta.sendFacebookMessage(userId, reply);
  }
}

// ── Shared core ──────────────────────────────────────────────────────────────

async function buildReply(userId, text) {
  conversation.addMessage(userId, 'user', text);

  try {
    const reply = await claude.generateResponse(conversation.getHistory(userId));
    conversation.addMessage(userId, 'assistant', reply);
    return reply;
  } catch (err) {
    console.error(`Claude error for user ${userId}:`, err.message);
    // Remove the failed user message so the history stays consistent
    conversation.clearHistory(userId);
    return 'Lo siento, ocurrió un error al procesar tu mensaje. Por favor intenta de nuevo.';
  }
}

module.exports = { verify, handleMessage };
