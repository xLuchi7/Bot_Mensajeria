const config = require('../config');
const conversation = require('../services/conversationService');
const claude = require('../services/claudeService');
const meta = require('../services/metaService');
const cliente = require('../services/clienteService');

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
    const clienteId = await cliente.resolveClienteIdByPhone(metadata?.display_phone_number);

    if (!clienteId) {
      console.error(`[whatsapp] No hay Cliente registrado para el número ${metadata?.display_phone_number} — se ignoran sus mensajes`);
      continue;
    }

    for (const msg of messages) {
      if (msg.type !== 'text') {
        console.log(`[whatsapp] Ignored non-text message type: ${msg.type}`);
        continue;
      }

      const userId = msg.from;
      const text = msg.text?.body;
      if (!text) continue;

      console.log(`[whatsapp] Message from ${userId}: "${text.slice(0, 60)}"`);
      const reply = await buildReply(clienteId, 'whatsapp', userId, text);
      await meta.sendWhatsAppMessage(phoneNumberId, userId, reply);
      console.log(`[whatsapp] Reply sent to ${userId}`);
    }
  }
}

async function processInstagram(entry) {
  // TODO: resolver ClienteId para Instagram (todavía no hay columna para mapear pageId -> Cliente)
  console.warn('[instagram] Soporte multi-cliente pendiente — se ignoran los mensajes por ahora');
}

async function processFacebook(entry) {
  // TODO: resolver ClienteId para Facebook (todavía no hay columna para mapear pageId -> Cliente)
  console.warn('[facebook] Soporte multi-cliente pendiente — se ignoran los mensajes por ahora');
}

// ── Shared core ──────────────────────────────────────────────────────────────

async function buildReply(clienteId, platform, userId, text) {
  await conversation.addMessage(clienteId, userId, 'user', text, platform);

  try {
    const history = await conversation.getHistory(clienteId, userId);
    console.log(`[claude] Calling API for ${platform} user ${userId} (history: ${history.length} msgs)`);
    const { text: reply, inputTokens, outputTokens } = await claude.generateResponse(clienteId, userId, history);
    await conversation.addMessage(clienteId, userId, 'assistant', reply, platform, {
      inputTokens,
      outputTokens,
      modelo: config.anthropic.model,
    });
    console.log(`[claude] Response for ${userId}: "${reply.slice(0, 80)}" (tokens in=${inputTokens} out=${outputTokens})`);
    return reply;
  } catch (err) {
    console.error(`[claude] API error for ${userId}:`, err.message);
    await conversation.clearHistory(clienteId, userId);
    const errorReply = 'Lo siento, ocurrió un error al procesar tu mensaje. Por favor intenta de nuevo.';
    await conversation.addMessage(clienteId, userId, 'assistant', errorReply, platform, {
      esError: true,
      modelo: config.anthropic.model,
    });
    return errorReply;
  }
}

module.exports = { verify, handleMessage };
