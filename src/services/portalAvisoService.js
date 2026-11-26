const config = require('../config');

// Tiempo real del Portal: cuando el bot escribe algo que se ve en el Portal
// (mensaje, reclamo, pedido, revisión humana) le avisa con
// POST {PORTAL_URL}/api/interno/eventos, y el Portal actualiza las pantallas
// abiertas de ese Cliente sin que tengan que preguntar cada tanto.
//
// Nunca frena ni rompe el flujo del bot: no se espera la respuesta, tiene
// timeout corto y si el Portal no contesta solo se loguea (como mucho una vez
// por minuto). Si falla, el Portal igual se entera por su respaldo periódico.

const TIMEOUT_MS = 3000;
const AVISO_ERROR_MS = 60 * 1000;
let ultimoError = 0;

function avisar(clienteId, tipo, userId) {
  const { url, apiToken } = config.portal;
  if (!url || !apiToken || !clienteId) return;

  fetch(`${url}/api/interno/eventos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ clienteId, tipo, userId: userId ?? undefined }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); })
    .catch(err => {
      if (Date.now() - ultimoError < AVISO_ERROR_MS) return;
      ultimoError = Date.now();
      console.warn(`[portal] No se pudo avisar "${tipo}" al Portal (cliente ${clienteId}):`, err.message);
    });
}

module.exports = { avisar };
