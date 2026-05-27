const crypto = require('crypto');
const config = require('../config');

function validateMetaSignature(req, res, next) {
  const sigHeader = req.headers['x-hub-signature-256'] ?? '(missing)';
  const secret = config.meta.appSecret?.trim() ?? '';

  console.log(`[auth] x-hub-signature-256 header : "${sigHeader}"`);
  console.log(`[auth] algorithm                   : hmac-sha256`);
  console.log(`[auth] secret                      : len=${secret.length} starts="${secret.slice(0, 4)}" ends="${secret.slice(-4)}"`);
  console.log(`[auth] rawBody                     : bytes=${req.rawBody?.length ?? 0} first100="${req.rawBody?.toString('utf8').slice(0, 100)}"`);

  if (sigHeader === '(missing)') {
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

  console.log(`[auth] received sig : ${received.slice(0, 8)}...${received.slice(-8)} (len=${received.length})`);
  console.log(`[auth] expected sig : ${expected.slice(0, 8)}...${expected.slice(-8)} (len=${expected.length})`);

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
    console.error('[auth] REJECTED: signature mismatch — verify META_APP_SECRET matches Meta App Dashboard → Settings → Basic → App Secret');
    return res.sendStatus(403);
  }

  console.log('[auth] OK — signature valid');
  next();
}

module.exports = { validateMetaSignature };
