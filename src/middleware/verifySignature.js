const crypto = require('crypto');
const config = require('../config');

function validateMetaSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];

  if (!signature) {
    console.error('[auth] REJECTED: missing x-hub-signature-256 header');
    return res.sendStatus(403);
  }

  const secret = config.meta.appSecret?.trim();
  if (!secret) {
    console.error('[auth] REJECTED: META_APP_SECRET is not set in environment variables');
    return res.sendStatus(403);
  }

  if (!req.rawBody || req.rawBody.length === 0) {
    console.error('[auth] REJECTED: rawBody not captured');
    return res.sendStatus(403);
  }

  const bodyStr = req.rawBody.toString('utf8');
  console.log(`[auth] rawBody bytes=${req.rawBody.length} first100="${bodyStr.slice(0, 100)}"`);

  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');

  const received = signature.replace('sha256=', '').trim().toLowerCase();

  if (received.length !== expected.length) {
    console.error(`[auth] REJECTED: signature length mismatch — received ${received.length} chars, expected ${expected.length}`);
    return res.sendStatus(403);
  }

  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(received, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch (err) {
    console.error('[auth] REJECTED: error comparing signatures —', err.message);
    return res.sendStatus(403);
  }

  if (!valid) {
    console.error(
      `[auth] REJECTED: signature mismatch\n` +
      `  received : ${received.slice(0, 8)}...${received.slice(-8)}\n` +
      `  expected : ${expected.slice(0, 8)}...${expected.slice(-8)}\n` +
      `  secret   : starts="${secret.slice(0, 4)}" ends="${secret.slice(-4)}" len=${secret.length}`
    );
    return res.sendStatus(403);
  }

  next();
}

module.exports = { validateMetaSignature };
