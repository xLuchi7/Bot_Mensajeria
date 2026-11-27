const config = require('../config');
const cliente = require('./clienteService');

// Tiempo real del Portal: cuando el bot escribe algo que se ve en el Portal
// (mensaje, reclamo, pedido, revisión humana) le avisa con
// POST {PORTAL_URL}/api/interno/eventos, y el Portal actualiza las pantallas
// abiertas de ese Cliente sin que tengan que preguntar cada tanto.
// Si el Cliente tiene un sistema propio (Clientes.apiExternaUrl, perfil 'pasajes'),
// también le avisa ahí: POST {apiExternaUrl}/eventos con su apiExternaToken (en
// AguirreSRL lo recibe /api/bot/eventos y actualiza el módulo WhatsApp IA).
//
// Nunca frena ni rompe el flujo del bot: no se espera la respuesta, tiene
// timeout corto y si el destino no contesta solo se loguea (como mucho una vez
// por minuto por destino). Si falla, las pantallas se enteran por su respaldo periódico.

const TIMEOUT_MS = 3000;
const AVISO_ERROR_MS = 60 * 1000;
const ultimoError = new Map(); // destino -> ms

function mandar(destino, url, token, cuerpo) {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); })
    .catch(err => {
      if (Date.now() - (ultimoError.get(destino) || 0) < AVISO_ERROR_MS) return;
      ultimoError.set(destino, Date.now());
      console.warn(`[aviso] No se pudo avisar "${cuerpo.tipo}" a ${destino} (cliente ${cuerpo.clienteId}):`, err.message);
    });
}

function avisar(clienteId, tipo, userId) {
  if (!clienteId) return;
  const cuerpo = { clienteId, tipo, userId: userId ?? undefined };

  const { url, apiToken } = config.portal;
  if (url && apiToken) mandar('Portal', `${url}/api/interno/eventos`, apiToken, cuerpo);

  cliente.getNegocio(clienteId)
    .then(negocio => {
      if (negocio.apiExternaUrl && negocio.apiExternaToken) mandar(`sistema del cliente ${clienteId}`, `${negocio.apiExternaUrl}/eventos`, negocio.apiExternaToken, cuerpo);
    })
    .catch(err => console.warn(`[aviso] No se pudo leer el negocio del cliente ${clienteId}:`, err.message));
}

module.exports = { avisar };
