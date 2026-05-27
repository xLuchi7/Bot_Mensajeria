const crypto = require('crypto');
const config = require('../config');

function validateMetaSignature(req, res, next) {
  const sigHeader = req.headers['x-hub-signature-256'];
  const secret    = config.meta.appSecret?.trim() ?? '';

  if (!sigHeader) {
    console.error('[auth] REJECTED: missing x-hub-signature-256 header');
    return res.sendStatus(403);
  }

  if (!secret) {
    console.error('[auth] REJECTED: META_APP_SECRET is not set');
    return res.sendStatus(403);
  }

  if (!req.rawBody || req.rawBody.length === 0) {
    console.error('[auth] REJECTED: rawBody is empty');
    return res.sendStatus(403);
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');

  const received = sigHeader.replace('sha256=', '').trim().toLowerCase();

  if (received.length !== expected.length) {
    console.error('[auth] REJECTED: signature length mismatch');
    return res.sendStatus(403);
  }

  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(received, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch (err) {
    console.error('[auth] REJECTED: timingSafeEqual error —', err.message);
    return res.sendStatus(403);
  }

  if (!valid) {
    console.error('[auth] REJECTED: signature mismatch — verify META_APP_SECRET in environment variables');
    return res.sendStatus(403);
  }

  next();
}

module.exports = { validateMetaSignature };
