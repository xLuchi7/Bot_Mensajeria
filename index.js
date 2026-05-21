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
});
