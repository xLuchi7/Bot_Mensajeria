require('dotenv').config();
const path = require('path');
const express = require('express');
const webhookRoutes = require('./src/routes/webhook');
const config = require('./src/config');
const { getPool } = require('./src/services/db');
const logs = require('./src/services/logService');

// Tabla Logs: eventos del bot + todo console.warn/error. Se purga sola a los 7 días.
logs.iniciar();
require('./src/services/dedupeService').iniciarPurga();
logs.info('bot_iniciado', { detalle: { modelo: config.anthropic.model, effort: config.anthropic.effort } });

// Última red: una promesa rechazada sin catch queda en Logs en vez de pasar desapercibida.
process.on('unhandledRejection', (err) => {
  console.error('[proceso] Promesa rechazada sin manejar:', err?.stack || err);
});

const app = express();
app.disable('x-powered-by');

// Tope del body de /webhook: se lee ANTES de validar la firma, así que sin límite
// cualquiera podía mandar un body enorme y llenar la memoria. Meta manda pocos KB.
const MAX_WEBHOOK_BYTES = 1024 * 1024;

// ── PRIMERO: /webhook con captura de raw body directo del stream ──────────────
// Lee los bytes del socket HTTP antes de que cualquier middleware los transforme.
// express.json() global NO debe registrarse antes de esto.
app.use('/webhook', (req, res, next) => {
  if (Number(req.get('content-length')) > MAX_WEBHOOK_BYTES) return res.status(413).send('Demasiado grande');
  const chunks = [];
  let bytes = 0;
  let cortado = false;
  req.on('data', (chunk) => {
    if (cortado) return;
    bytes += chunk.length;
    if (bytes > MAX_WEBHOOK_BYTES) {
      cortado = true;
      res.status(413).send('Demasiado grande');
      req.destroy();
      return;
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  req.on('end', () => {
    if (cortado) return;
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
app.use(express.json({ limit: '256kb' }));

// Endpoints para Portal_Mensajeria (mandar mensajes escritos a mano), con token compartido.
app.use('/portal', require('./src/routes/portal'));

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Bot Mensajeria' });
});

app.get('/privacidad', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacidad.html'));
});

app.get('/terminos', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terminos.html'));
});

app.listen(config.port, () => {
  console.log(`Bot Mensajeria running on port ${config.port}`);

  // Solo si están y su largo: ni un pedazo del valor (los logs quedan en la base).
  const estado = v => (v ? `set (${String(v).trim().length} chars)` : 'NOT SET');
  console.log(`[config] META_APP_SECRET: ${estado(config.meta.appSecret)}`);
  console.log(`[config] META_VERIFY_TOKEN: ${estado(config.meta.verifyToken)}`);
  console.log(`[config] ANTHROPIC_API_KEY: ${estado(config.anthropic.apiKey)}`);
  console.log(`[config] INSTAGRAM_ACCESS_TOKEN: ${estado(config.meta.instagramToken)}`);
  console.log(`[config] PORTAL_API_TOKEN: ${estado(config.portal.apiToken)}`);

  getPool()
    .then(() => console.log(`[db] Connected to ${config.db.database} on ${config.db.server}`))
    .catch(err => console.error(`[db] Connection failed:`, err.message));
});
