require('dotenv').config();
const express = require('express');
const webhookRoutes = require('./src/routes/webhook');
const config = require('./src/config');

const app = express();

// ── PRIMERO: /webhook con captura de raw body directo del stream ──────────────
// Lee los bytes del socket HTTP antes de que cualquier middleware los transforme.
// express.json() global NO debe registrarse antes de esto.
app.use('/webhook', (req, _res, next) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    if (req.rawBody.length > 0) {
      try {
        req.body = JSON.parse(req.rawBody.toString('utf8'));
      } catch {
        req.body = {};
      }
    }
    next();
  });
  req.on('error', next);
});
app.use('/webhook', webhookRoutes);

// ── DESPUÉS: express.json() para el resto de rutas ───────────────────────────
app.use(express.json());

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
