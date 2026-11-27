const axios = require('axios');
const config = require('../config');
const logs = require('./logService');

const BASE = `https://graph.facebook.com/${config.meta.apiVersion}`;
// Sin timeout, una llamada colgada a Meta dejaba trabada la respuesta de ese chat.
const http = axios.create({ timeout: 15 * 1000 });
// Tope de WhatsApp para un mensaje de texto.
const MAX_TEXTO = 4096;

// Parte un texto largo en pedazos de hasta MAX_TEXTO, cortando en un salto de
// línea o un espacio cuando se puede (no en el medio de una palabra).
function partirTexto(texto) {
  const partes = [];
  let resto = String(texto);
  while (resto.length > MAX_TEXTO) {
    const ventana = resto.slice(0, MAX_TEXTO);
    let corte = ventana.lastIndexOf('\n');
    if (corte < MAX_TEXTO / 2) corte = ventana.lastIndexOf(' ');
    if (corte < MAX_TEXTO / 2) corte = MAX_TEXTO;
    partes.push(resto.slice(0, corte).trimEnd());
    resto = resto.slice(corte).trimStart();
  }
  if (resto) partes.push(resto);
  return partes;
}

function logApiError(platform, err) {
  const status = err.response?.status;
  const data   = JSON.stringify(err.response?.data ?? {});
  console.error(`[${platform}] API error ${status}: ${data}`);
}

// Manda un mensaje por la Cloud API y lo deja en Logs (OK con el id de WhatsApp,
// o el error de Meta con su código). Tira el error para que el que llama decida.
async function postWhatsApp(phoneNumberId, to, tipo, cuerpo, detalleLog) {
  const inicio = Date.now();
  try {
    const { data } = await http.post(
      `${BASE}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: normalizeArgentinaNumber(to), type: tipo, ...cuerpo },
      { headers: { Authorization: `Bearer ${config.meta.whatsappToken}` } }
    );
    logs.info(`whatsapp_envio_${tipo}`, { userId: to, duracionMs: Date.now() - inicio, detalle: { ...detalleLog, waMessageId: data?.messages?.[0]?.id ?? null } });
  } catch (err) {
    const e = err.response?.data?.error;
    logs.error(`whatsapp_envio_${tipo}_error`, {
      userId: to,
      duracionMs: Date.now() - inicio,
      detalle: { ...detalleLog, status: err.response?.status ?? null, codigo: e?.code ?? null, mensaje: e?.message ?? err.message, detalleMeta: e?.error_data ?? null },
    });
    process.stderr.write(`[whatsapp] API error ${err.response?.status}: ${JSON.stringify(err.response?.data ?? {})}\n`);
    throw err;
  }
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
    await http.post(
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

// Más de 4096 caracteres: se manda en varios mensajes, en orden.
async function sendWhatsAppMessage(phoneNumberId, to, text) {
  for (const parte of partirTexto(text)) {
    await postWhatsApp(phoneNumberId, to, 'text', { text: { body: parte } }, { texto: parte });
  }
}

// Imagen por URL pública: Meta la descarga sola (JPG o PNG, hasta 5 MB).
async function sendWhatsAppImage(phoneNumberId, to, link, caption) {
  await postWhatsApp(phoneNumberId, to, 'image', { image: caption ? { link, caption } : { link } }, { imagen: link, caption: caption ?? null });
}

async function sendInstagramMessage(pageId, recipientId, text) {
  try {
    await http.post(
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
    await http.post(
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
  await postWhatsApp(phoneNumberId, to, 'template', { template }, { plantilla: nombre, idioma, parametros });
}

module.exports = { sendTypingIndicator, sendWhatsAppMessage, sendWhatsAppImage, sendWhatsAppTemplate, sendInstagramMessage, sendFacebookMessage };
