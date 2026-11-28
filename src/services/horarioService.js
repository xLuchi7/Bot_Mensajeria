// Horario de atención del bot por Cliente (Clientes.horarioBotDesde / horarioBotHasta, hora
// de Argentina; NULL = responde las 24 hs). Fuera de horario el mensaje se guarda igual (lo
// ve el portal) pero no se responde. A la hora de apertura se buscan en la base los chats
// que quedaron con mensajes sin responder desde el cierre y se responden con la cola normal
// (colaChatService), así Claude lee todo el historial y contesta una sola vez a todo junto.
//
// La "cola" nocturna es la propia tabla Mensajes: no se pierde con un deploy o un reinicio.
// Si el bot arranca con el negocio abierto, revisa el cierre anterior apenas levanta.

const { ejecutar, sql } = require('./db');

const OFFSET_ARGENTINA_MS = -3 * 60 * 60 * 1000; // UTC-3 fijo (Argentina no tiene horario de verano)
const DIA_MIN = 24 * 60;
const CACHE_MS = 30 * 1000;
const REVISAR_CADA_MS = 30 * 1000;

let cache = { hasta: 0, horarios: new Map() }; // clienteId -> { desde, hasta, phoneNumberId }
let sinProcedure = false;

async function horarios() {
  if (sinProcedure || cache.hasta > Date.now()) return cache.horarios;
  try {
    const r = await ejecutar('dbo.usp_Bot_ClientesHorario', {});
    const mapa = new Map();
    for (const f of r.recordset) {
      if (f.desdeMin == null || f.hastaMin == null || f.desdeMin === f.hastaMin) continue;
      mapa.set(f.id, { desde: f.desdeMin, hasta: f.hastaMin, phoneNumberId: f.whatsappPhoneNumberId || null });
    }
    cache = { hasta: Date.now() + CACHE_MS, horarios: mapa };
  } catch (err) {
    // Todavía no se corrió el SQL: el bot sigue respondiendo las 24 hs, como antes.
    if (/Could not find stored procedure/i.test(err.message)) {
      sinProcedure = true;
      console.warn('[horario] Falta dbo.usp_Bot_ClientesHorario: el bot responde las 24 hs.');
    } else {
      console.error('[horario] No se pudieron leer los horarios:', err.message);
    }
  }
  return cache.horarios;
}

// Estado del horario en un momento dado.
// { abierto, aperturaMs: cuándo abrió por última vez, cierreMs: cuándo cerró antes de esa apertura }
function estado({ desde, hasta }, ahoraMs = Date.now()) {
  const local = ahoraMs + OFFSET_ARGENTINA_MS;
  const minuto = Math.floor(local / 60000) % DIA_MIN;
  const abierto = desde < hasta ? minuto >= desde && minuto < hasta : minuto >= desde || minuto < hasta;
  const desdeApertura = (minuto - desde + DIA_MIN) % DIA_MIN; // minutos desde la última apertura
  const aperturaMs = ahoraMs - (local % 60000) - desdeApertura * 60000;
  const cerrado = (desde - hasta + DIA_MIN) % DIA_MIN; // cuánto dura el cierre
  return { abierto, aperturaMs, cierreMs: aperturaMs - cerrado * 60000 };
}

// true si el bot le puede responder ahora a este Cliente. Ante cualquier duda, responde.
async function estaAbierto(clienteId) {
  const h = (await horarios()).get(clienteId);
  return !h || estado(h).abierto;
}

// ── Barrido a la hora de apertura ──
const barridos = new Map(); // clienteId -> aperturaMs ya barrida
let corriendo = false;

async function revisar(responder) {
  if (corriendo) return;
  corriendo = true;
  try {
    const mapa = await horarios();
    for (const [clienteId, h] of mapa) {
      const { abierto, aperturaMs, cierreMs } = estado(h);
      if (!abierto || barridos.get(clienteId) === aperturaMs) continue;
      if (!h.phoneNumberId) { barridos.set(clienteId, aperturaMs); continue; }
      try {
        await barrer(clienteId, h.phoneNumberId, cierreMs, responder);
        barridos.set(clienteId, aperturaMs);
      } catch (err) {
        // No se marca: se reintenta en la próxima vuelta.
        console.error(`[horario] No se pudieron levantar los mensajes pendientes del cliente ${clienteId}:`, err.message);
      }
    }
    for (const id of barridos.keys()) if (!mapa.has(id)) barridos.delete(id);
  } finally {
    corriendo = false;
  }
}

async function barrer(clienteId, phoneNumberId, cierreMs, responder) {
  const segundos = Math.max(0, Math.ceil((Date.now() - cierreMs) / 1000));
  const r = await ejecutar('dbo.usp_Bot_PendientesFueraDeHorario', {
    clienteId: [sql.Int, clienteId],
    segundosDesdeCierre: [sql.Int, segundos],
  });
  const porChat = new Map();
  for (const f of r.recordset) {
    if (!porChat.has(f.userId)) porChat.set(f.userId, []);
    porChat.get(f.userId).push({ id: f.id, texto: f.content, waMessageId: null, fueraDeHorario: true });
  }
  if (porChat.size) console.log(`[horario] Cliente ${clienteId}: respondiendo ${porChat.size} chat(s) que escribieron fuera de horario`);
  for (const [userId, items] of porChat) responder(clienteId, phoneNumberId, userId, items);
}

function iniciar(responder) {
  const vuelta = () => revisar(responder).catch(err => console.error('[horario] Error revisando horarios:', err.message));
  setTimeout(vuelta, 10 * 1000).unref();
  setInterval(vuelta, REVISAR_CADA_MS).unref();
}

module.exports = { estaAbierto, iniciar, estado };
