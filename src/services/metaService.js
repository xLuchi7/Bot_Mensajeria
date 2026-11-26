const axios = require('axios');
const config = require('../config');

const BASE = `https://graph.facebook.com/${config.meta.apiVersion}`;

function logApiError(platform, err) {
  const status = err.response?.status;
  const data   = JSON.stringify(err.response?.data ?? {});
  console.error(`[${platform}] API error ${status}: ${data}`);
}

// Los números argentinos llegan en el webhook con un "9" extra tras el código de
// país (549...), pero la Cloud API rechaza ese mismo formato como destinatario de
// envío — hay que sacarle el 9 (54...) o el mensaje no sale.
function normalizeArgentinaNumber(number) {
  if (/^549\d{10}$/.test(number)) {
    return '54' + number.slice(3);
  }
  return number;
}

// Marca el mensaje entrante como leído y muestra "escribiendo..." en el chat del
// usuario mientras armamos la respuesta (dura hasta 25s o hasta que mandemos el mensaje real).
async function sendTypingIndicator(phoneNumberId, messageId) {
  try {
    await axios.post(
      `${BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      },
      { headers: { Authorization: `Bearer ${config.meta.whatsappToken}` } }
    );
  } catch (err) {
    logApiError('whatsapp', err);
  }
}

async function sendWhatsAppMessage(phoneNumberId, to, text) {
  try {
    await axios.post(
      `${BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizeArgentinaNumber(to),
        type: 'text',
        text: { body: text },
      },
      { headers: { Authorization: `Bearer ${config.meta.whatsappToken}` } }
    );
  } catch (err) {
    logApiError('whatsapp', err);
    throw err;
  }
}

// Imagen por URL pública: Meta la descarga sola (JPG o PNG, hasta 5 MB).
async function sendWhatsAppImage(phoneNumberId, to, link, caption) {
  try {
    await axios.post(
      `${BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizeArgentinaNumber(to),
        type: 'image',
        image: caption ? { link, caption } : { link },
      },
      { headers: { Authorization: `Bearer ${config.meta.whatsappToken}` } }
    );
  } catch (err) {
    logApiError('whatsapp', err);
    throw err;
  }
}

async function sendInstagramMessage(pageId, recipientId, text) {
  try {
    await axios.post(
      `${BASE}/${pageId}/messages`,
      { recipient: { id: recipientId }, message: { text } },
      { headers: { Authorization: `Bearer ${config.meta.instagramToken}` } }
    );
  } catch (err) {
    logApiError('instagram', err);
    throw err;
  }
}

async function sendFacebookMessage(pageId, recipientId, text) {
  try {
    await axios.post(
      `${BASE}/${pageId}/messages`,
      { recipient: { id: recipientId }, message: { text } },
      { headers: { Authorization: `Bearer ${config.meta.facebookToken}` } }
    );
  } catch (err) {
    logApiError('facebook', err);
    throw err;
  }
}

// Plantilla aprobada por Meta: es lo único que se puede mandar pasadas las 24 h
// desde el último mensaje del cliente. `parametros` llena {{1}}, {{2}}… del cuerpo.
async function sendWhatsAppTemplate(phoneNumberId, to, nombre, idioma, parametros = []) {
  const template = { name: nombre, language: { code: idioma } };
  if (parametros.length) {
    template.components = [{ type: 'body', parameters: parametros.map(p => ({ type: 'text', text: String(p) })) }];
  }
  try {
    await axios.post(
      `${BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizeArgentinaNumber(to),
        type: 'template',
        template,
      },
      { headers: { Authorization: `Bearer ${config.meta.whatsappToken}` } }
    );
  } catch (err) {
    logApiError('whatsapp', err);
    throw err;
  }
}

module.exports = { sendTypingIndicator, sendWhatsAppMessage, sendWhatsAppImage, sendWhatsAppTemplate, sendInstagramMessage, sendFacebookMessage };
