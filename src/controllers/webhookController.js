const config = require('../config');
const conversation = require('../services/conversationService');
const claude = require('../services/claudeService');
const meta = require('../services/metaService');

// GET /webhook — Meta hub verification handshake
function verify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`[verify] mode=${mode} token_match=${token === config.meta.verifyToken}`);

  if (mode === 'subscribe' && token === config.meta.verifyToken) {
    console.log('[verify] OK — webhook verified by Meta');
    return res.status(200).send(challenge);
  }

  console.error('[verify] REJECTED: mode or verify_token mismatch');
  res.sendStatus(403);
}

// POST /webhook — incoming messages from Meta
async function handleMessage(req, res) {
  // Acknowledge immediately; Meta requires a 200 within 20 s
  res.sendStatus(200);

  const { object, entry } = req.body;

  if (!object || !Array.isArray(entry)) {
    console.warn('[webhook] Payload missing object or entry array');
    return;
  }

  console.log(`[webhook] Received event: object=${object} entries=${entry.length}`);

  for (const e of entry) {
    try {
      if (object === 'whatsapp_business_account') await processWhatsApp(e);
      else if (object === 'instagram') await processInstagram(e);
      else if (object === 'page') await processFacebook(e);
      else console.warn(`[webhook] Unknown object type: ${object}`);
    } catch (err) {
      console.error(`[webhook] Unhandled error processing ${object} entry:`, err.message);
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
      if (msg.type !== 'text') {
        console.log(`[whatsapp] Ignored non-text message type: ${msg.type}`);
        continue;
      }

      const userId = msg.from;
      const text = msg.text?.body;
      if (!text) continue;

      console.log(`[whatsapp] Message from ${userId}: "${text.slice(0, 60)}"`);
      const reply = await buildReply('whatsapp', userId, text);
      await meta.sendWhatsAppMessage(phoneNumberId, userId, reply);
      console.log(`[whatsapp] Reply sent to ${userId}`);
    }
  }
}

async function processInstagram(entry) {
  const pageId = entry.id; // Instagram Business Account ID from webhook payload
  for (const messaging of entry.messaging || []) {
    const userId = messaging.sender?.id;
    const text = messaging.message?.text;

    if (!userId || !text) continue;
    if (messaging.message?.is_echo) {
      console.log('[instagram] Skipped echo message');
      continue;
    }

    console.log(`[instagram] Message from ${userId}: "${text.slice(0, 60)}"`);
    const reply = await buildReply('instagram', userId, text);
    await meta.sendInstagramMessage(pageId, userId, reply);
    console.log(`[instagram] Reply sent to ${userId}`);
  }
}

async function processFacebook(entry) {
  const pageId = entry.id; // Facebook Page ID from webhook payload
  for (const messaging of entry.messaging || []) {
    const userId = messaging.sender?.id;
    const text = messaging.message?.text;

    if (!userId || !text) continue;
    if (messaging.message?.is_echo) {
      console.log('[facebook] Skipped echo message');
      continue;
    }

    console.log(`[facebook] Message from ${userId}: "${text.slice(0, 60)}"`);
    const reply = await buildReply('facebook', userId, text);
    await meta.sendFacebookMessage(pageId, userId, reply);
    console.log(`[facebook] Reply sent to ${userId}`);
  }
}

// ── Shared core ──────────────────────────────────────────────────────────────

async function buildReply(platform, userId, text) {
  conversation.addMessage(userId, 'user', text);

  try {
    console.log(`[claude] Calling API for ${platform} user ${userId} (history: ${conversation.getHistory(userId).length} msgs)`);
    const reply = await claude.generateResponse(conversation.getHistory(userId));
    conversation.addMessage(userId, 'assistant', reply);
    console.log(`[claude] Response for ${userId}: "${reply.slice(0, 80)}"`);
    return reply;
  } catch (err) {
    console.error(`[claude] API error for ${userId}:`, err.message);
    conversation.clearHistory(userId);
    return 'Lo siento, ocurrió un error al procesar tu mensaje. Por favor intenta de nuevo.';
  }
}

module.exports = { verify, handleMessage };
