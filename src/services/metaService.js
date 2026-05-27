const axios = require('axios');
const config = require('../config');

const BASE = `https://graph.facebook.com/${config.meta.apiVersion}`;

function logApiError(platform, err) {
  const status = err.response?.status;
  const data   = JSON.stringify(err.response?.data ?? {});
  console.error(`[${platform}] API error ${status}: ${data}`);
}

async function sendWhatsAppMessage(phoneNumberId, to, text) {
  try {
    await axios.post(
      `${BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
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

module.exports = { sendWhatsAppMessage, sendInstagramMessage, sendFacebookMessage };
