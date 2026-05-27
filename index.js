require('dotenv').config();
const express = require('express');
const { captureRawBody } = require('./src/middleware/verifySignature');
const webhookRoutes = require('./src/routes/webhook');
const config = require('./src/config');

const app = express();

// express.json with verify hook to capture raw body for HMAC validation
app.use(express.json({ verify: captureRawBody }));

app.use('/webhook', webhookRoutes);

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Bot Mensajeria' });
});

app.listen(config.port, () => {
  console.log(`Bot Mensajeria running on port ${config.port}`);

  // Startup diagnostics — partial values only, never log full secrets
  const secret = config.meta.appSecret?.trim() ?? '';
  console.log(
    `[config] META_APP_SECRET: ${secret.length} chars | starts="${secret.slice(0, 4)}" ends="${secret.slice(-4)}"`
  );
  console.log(`[config] META_VERIFY_TOKEN: ${config.meta.verifyToken ? 'set' : 'NOT SET'}`);
  console.log(`[config] ANTHROPIC_API_KEY: ${config.anthropic.apiKey ? 'set' : 'NOT SET'}`);
  console.log(`[config] INSTAGRAM_ACCESS_TOKEN: ${config.meta.instagramToken ? 'set' : 'NOT SET'}`);
});
