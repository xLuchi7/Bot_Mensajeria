const crypto = require('crypto');
const config = require('../config');

// Attached to express.json({ verify }) to capture the raw body buffer
function captureRawBody(req, _res, buf) {
  req.rawBody = buf;
}

// Validates x-hub-signature-256 sent by Meta on every POST webhook
function validateMetaSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];

  if (!signature || !config.meta.appSecret) {
    return res.sendStatus(403);
  }

  const expected = crypto
    .createHmac('sha256', config.meta.appSecret)
    .update(req.rawBody)
    .digest('hex');

  const received = signature.replace('sha256=', '');

  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(received, 'hex'),
      Buffer.from(expected, 'hex')
    );
    if (!valid) return res.sendStatus(403);
  } catch {
    return res.sendStatus(403);
  }

  next();
}

module.exports = { captureRawBody, validateMetaSignature };
