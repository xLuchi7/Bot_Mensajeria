require('dotenv').config();
const express = require('express');
const webhookRoutes = require('./src/routes/webhook');
const config = require('./src/config');

const app = express();

// express.raw captures the body as a raw Buffer (no parsing, no transformation).
// A second middleware then stores it as req.rawBody and parses JSON manually.
// This is more reliable than express.json({ verify }) for HMAC signature validation.
app.use(express.raw({ type: 'application/json', limit: '5mb' }));
app.use((req, _res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    try {
      req.body = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      req.body = {};
    }
  }
  next();
});

app.use('/webhook', webhookRoutes);

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Bot Mensajeria' });
});

app.listen(config.port, () => {
  console.log(`Bot Mensajeria running on port ${config.port}`);

  const secret = config.meta.appSecret?.trim() ?? '';
  console.log(`[config] META_APP_SECRET: ${secret.length} chars | starts="${secret.slice(0, 4)}" ends="${secret.slice(-4)}"`);
  console.log(`[config] META_VERIFY_TOKEN: ${config.meta.verifyToken ? 'set' : 'NOT SET'}`);
  console.log(`[config] ANTHROPIC_API_KEY: ${config.anthropic.apiKey ? 'set' : 'NOT SET'}`);
  console.log(`[config] INSTAGRAM_ACCESS_TOKEN: ${config.meta.instagramToken ? 'set' : 'NOT SET'}`);
});
