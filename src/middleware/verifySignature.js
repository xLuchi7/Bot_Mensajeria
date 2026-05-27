const crypto = require('crypto');
const config = require('../config');

function validateMetaSignature(req, res, next) {
  const sigHeader = req.headers['x-hub-signature-256'] ?? '(missing)';
  const secret    = config.meta.appSecret?.trim() ?? '';

  // Log key headers to detect proxy interference (content-encoding, transfer-encoding)
  console.log(`[auth] content-type     : ${req.headers['content-type'] ?? '(none)'}`);
  console.log(`[auth] content-encoding : ${req.headers['content-encoding'] ?? '(none)'}`);
  console.log(`[auth] transfer-encoding: ${req.headers['transfer-encoding'] ?? '(none)'}`);
  console.log(`[auth] x-hub-sig-256    : ${sigHeader}`);
  console.log(`[auth] secret           : len=${secret.length} starts="${secret.slice(0,4)}" ends="${secret.slice(-4)}"`);

  if (!req.rawBody || req.rawBody.length === 0) {
    console.error('[auth] REJECTED: rawBody is empty');
    return res.sendStatus(403);
  }

  // Full body as base64 — copy this value to use with scripts/test-hmac.js
  console.log(`[auth] rawBody bytes    : ${req.rawBody.length}`);
  console.log(`[auth] bodyBase64       : ${req.rawBody.toString('base64')}`);

  if (sigHeader === '(missing)') {
    console.error('[auth] REJECTED: missing x-hub-signature-256 header');
    return res.sendStatus(403);
  }

  if (!secret) {
    console.error('[auth] REJECTED: META_APP_SECRET is not set');
    return res.sendStatus(403);
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');

  const received = sigHeader.replace('sha256=', '').trim().toLowerCase();

  console.log(`[auth] received sig     : ${received}`);
  console.log(`[auth] expected sig     : ${expected}`);
  console.log(`[auth] match            : ${received === expected}`);

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
    console.error('[auth] REJECTED: signature mismatch');
    return res.sendStatus(403);
  }

  console.log('[auth] OK — signature valid');
  next();
}

module.exports = { validateMetaSignature };
