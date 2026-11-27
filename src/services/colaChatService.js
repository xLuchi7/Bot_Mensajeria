// Cola por chat (clienteId + userId) para los mensajes que el bot tiene que responder.
//
// - Esperar y juntar: cuando alguien manda varios mensajes seguidos ("hola" /
//   "quiero una remera" / "talle M"), el bot espera ESPERA_MS después del último
//   (como mucho ESPERA_MAX_MS desde el primero) y responde UNA vez a todos juntos.
// - En fila: nunca hay dos respuestas en paralelo para el mismo chat (antes dos
//   mensajes casi juntos generaban dos respuestas y hasta dos pedidos).
// - Tope global: como mucho MAX_CONCURRENTES respuestas generándose a la vez.
// - Límite por número: más de MAX_POR_MINUTO o MAX_POR_HORA mensajes y el bot deja
//   de responder (el mensaje se guarda igual y se ve en el portal) hasta que baje el ritmo.
//
// Vive en memoria: asume una sola instancia del bot, igual que el portal.

const ESPERA_MS = 2000;
const ESPERA_MAX_MS = 8000;
const MAX_CONCURRENTES = 5;
const MAX_POR_MINUTO = 10;
const MAX_POR_HORA = 60;

const chats = new Map(); // clave -> { pendientes, timer, primeroEn, cadena, corriendo, respondidoHasta, ultimoId }

function estadoDe(clave) {
  let c = chats.get(clave);
  if (!c) {
    c = { pendientes: [], timer: null, primeroEn: 0, cadena: Promise.resolve(), corriendo: 0, respondidoHasta: 0, ultimoId: 0 };
    chats.set(clave, c);
  }
  return c;
}

function limpiarSiTermino(clave, c) {
  if (!c.pendientes.length && !c.timer && !c.corriendo && chats.get(clave) === c) chats.delete(clave);
}

// ── Tope global de respuestas en paralelo ──
let activos = 0;
const enEspera = [];
async function conCupo(fn) {
  if (activos >= MAX_CONCURRENTES) await new Promise(r => enEspera.push(r));
  activos++;
  try {
    return await fn();
  } finally {
    activos--;
    enEspera.shift()?.();
  }
}

// ── Límite de mensajes por número ──
const ritmo = new Map(); // clave -> number[] (timestamps de la última hora)
function dentroDelLimite(clave) {
  const ahora = Date.now();
  const marcas = (ritmo.get(clave) || []).filter(t => ahora - t < 60 * 60 * 1000);
  marcas.push(ahora);
  ritmo.set(clave, marcas);
  const ultimoMinuto = marcas.filter(t => ahora - t < 60 * 1000).length;
  return ultimoMinuto <= MAX_POR_MINUTO && marcas.length <= MAX_POR_HORA;
}
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, marcas] of ritmo) if (!marcas.some(t => ahora - t < 60 * 60 * 1000)) ritmo.delete(clave);
}, 10 * 60 * 1000).unref();

/**
 * Suma un mensaje ya guardado a la cola de su chat.
 * @param {string} clave  `${clienteId}:${userId}`
 * @param {{id: number, texto: string, waMessageId: string}} item
 * @param {(lote: object[], marcarLeido: () => void) => Promise<void>} procesar
 *   Recibe los mensajes juntos. Tiene que llamar a marcarLeido() apenas lee el
 *   historial: lo que ya estaba guardado en ese momento ya quedó respondido.
 */
function agendar(clave, item, procesar) {
  const c = estadoDe(clave);
  if (item.id) c.ultimoId = Math.max(c.ultimoId, item.id);
  if (!c.pendientes.length) c.primeroEn = Date.now();
  c.pendientes.push(item);
  clearTimeout(c.timer);
  const espera = Math.max(0, Math.min(ESPERA_MS, c.primeroEn + ESPERA_MAX_MS - Date.now()));
  c.timer = setTimeout(() => disparar(clave, procesar), espera);
}

function disparar(clave, procesar) {
  const c = chats.get(clave);
  if (!c) return;
  c.timer = null;
  if (!c.pendientes.length) return limpiarSiTermino(clave, c);

  const lote = c.pendientes;
  c.pendientes = [];
  c.corriendo++;
  c.cadena = c.cadena
    .then(() => {
      // Si la respuesta anterior ya leyó estos mensajes del historial (llegaron
      // mientras se generaba), ya están respondidos: no se contesta dos veces.
      const sinResponder = lote.filter(m => !m.id || m.id > c.respondidoHasta);
      if (!sinResponder.length) return undefined;
      // Al leer el historial, todo lo guardado hasta ese momento entra en la respuesta.
      const marcarLeido = () => { c.respondidoHasta = Math.max(c.respondidoHasta, c.ultimoId); };
      return conCupo(() => procesar(sinResponder, marcarLeido));
    })
    .catch(err => console.error(`[cola] Error respondiendo el chat ${clave}:`, err?.stack || err))
    .finally(() => {
      c.corriendo--;
      limpiarSiTermino(clave, c);
    });
}

module.exports = { agendar, dentroDelLimite };
