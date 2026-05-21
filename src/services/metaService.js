const axios = require('axios');
const config = require('../config');

const BASE = `https://graph.facebook.com/${config.meta.apiVersion}`;

async function sendWhatsAppMessage(phoneNumberId, to, text) {
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
}

async function sendInstagramMessage(recipientId, text) {
  await axios.post(
    `${BASE}/me/messages`,
    { recipient: { id: recipientId }, message: { text } },
    { headers: { Authorization: `Bearer ${config.meta.instagramToken}` } }
  );
}

async function sendFacebookMessage(recipientId, text) {
  await axios.post(
    `${BASE}/me/messages`,
    { recipient: { id: recipientId }, message: { text } },
    { headers: { Authorization: `Bearer ${config.meta.facebookToken}` } }
  );
}

module.exports = { sendWhatsAppMessage, sendInstagramMessage, sendFacebookMessage };
