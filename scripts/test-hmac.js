#!/usr/bin/env node
/**
 * Test script para verificar si la firma HMAC coincide localmente.
 *
 * Uso:
 *   node scripts/test-hmac.js <received_sig_hex> <body_base64>
 *
 * Los valores se copian del log de Railway:
 *   received_sig_hex → la parte después de "sha256=" del header x-hub-signature-256
 *   body_base64      → el campo "bodyBase64" del log [auth]
 *
 * Ejemplo:
 *   node scripts/test-hmac.js 5a4c2075...47f2b54a eyJvYmplY3QiOiJpbnN0YWdyYW0i...
 */
require('dotenv').config();
const crypto = require('crypto');

const receivedHex = process.argv[2];
const bodyBase64  = process.argv[3];

if (!receivedHex || !bodyBase64) {
  console.error('Faltan argumentos. Ver instrucciones arriba.');
  process.exit(1);
}

const secret = (process.env.META_APP_SECRET || '').trim();
if (!secret) {
  console.error('META_APP_SECRET no está en .env');
  process.exit(1);
}

const body     = Buffer.from(bodyBase64, 'base64');
const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');

console.log('\n── Datos ──────────────────────────────────────────────────');
console.log(`Secret  : len=${secret.length}  starts="${secret.slice(0,4)}"  ends="${secret.slice(-4)}"`);
console.log(`Body    : ${body.length} bytes`);
console.log(`Body    : ${body.toString('utf8').slice(0, 120)}...`);
console.log('\n── Resultado ───────────────────────────────────────────────');
console.log(`Received: ${receivedHex}`);
console.log(`Expected: ${expected}`);
console.log(`\nMatch: ${receivedHex === expected ? '✅  SÍ — firma correcta' : '❌  NO — firma incorrecta'}`);

if (receivedHex !== expected) {
  console.log('\nPosibles causas:');
  console.log('  1. META_APP_SECRET en .env no coincide con el App Secret en Meta');
  console.log('  2. Railway modificó el body antes de que llegue a Node.js');
  console.log('     (en ese caso el test local NO puede matchear)');
}
