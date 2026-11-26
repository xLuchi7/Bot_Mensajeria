const { AsyncLocalStorage } = require('async_hooks');
const { ejecutar, sql } = require('./db');

// Tabla Logs (compartida con Portal_Mensajeria): todo lo que pasa en el bot.
// - Los eventos se juntan en memoria y se mandan de a lotes cada pocos segundos a
//   usp_Logs_Insertar, así loguear nunca demora ni rompe la respuesta al cliente.
// - La fecha la pone SQL en hora de Argentina (GETDATE() - 3 hs), corrida por los
//   milisegundos que el evento esperó en la cola, así queda exacta.
// - clienteId / userId / usuario salen solos del contexto (conContexto): todo lo
//   que se loguea mientras se procesa un mensaje queda asociado a ese chat, incluso
//   los console.warn/error de cualquier parte del código.
// - Las llamadas a Claude guardan aparte modelo, tokens, costo en USD y duración.
const ORIGEN = 'bot';
const FLUSH_MS = 3000;
const MAX_LOTE = 200;
const MAX_COLA = 5000;         // si la base está caída no crece sin límite
const MAX_DETALLE = 16000;
const DIAS_RETENCION = 7;
const PURGA_MS = 60 * 60 * 1000;

const consolaOriginal = { warn: console.warn.bind(console), error: console.error.bind(console) };
const contexto = new AsyncLocalStorage();
let cola = [];
let escribiendo = false;

/**
 * Corre fn con datos de contexto (clienteId, userId, usuario...) que se suman a
 * cada log que se registre adentro, también en lo asincrónico que dispare. Los
 * valores pueden ser getters (se leen recién al loguear).
 */
function conContexto(datos, fn) {
  const store = Object.create(contexto.getStore() ?? null, Object.getOwnPropertyDescriptors(datos));
  return contexto.run(store, fn);
}

function aTexto(detalle) {
  if (detalle == null) return null;
  if (detalle instanceof Error) return detalle.stack || detalle.message;
  const s = typeof detalle === 'string' ? detalle : JSON.stringify(detalle);
  return s.length > MAX_DETALLE ? `${s.slice(0, MAX_DETALLE)}…` : s;
}

const entero = v => (Number.isFinite(v) ? Math.round(v) : null);
const corto = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));

/**
 * @param {'info'|'warn'|'error'} nivel
 * @param {string} evento  ej. 'mensaje_recibido', 'claude_llamada'
 * @param {{clienteId?: number, userId?: string, usuario?: string, detalle?: any, modelo?: string,
 *   inputTokens?: number, outputTokens?: number, cacheLecturaTokens?: number, cacheEscrituraTokens?: number,
 *   costoUsd?: number, duracionMs?: number}} datos
 */
function registrar(nivel, evento, datos = {}) {
  const ctx = contexto.getStore() || {};
  const clienteId = datos.clienteId ?? ctx.clienteId ?? null;
  if (cola.length >= MAX_COLA) cola.shift();
  cola.push({
    t: Date.now(),
    nivel,
    evento: String(evento).slice(0, 100),
    clienteId: Number.isInteger(clienteId) ? clienteId : null,
    userId: corto(datos.userId ?? ctx.userId, 100),
    usuario: corto(datos.usuario ?? ctx.usuario, 255),
    detalle: aTexto(datos.detalle),
    modelo: corto(datos.modelo, 100),
    inputTokens: entero(datos.inputTokens),
    outputTokens: entero(datos.outputTokens),
    cacheLecturaTokens: entero(datos.cacheLecturaTokens),
    cacheEscrituraTokens: entero(datos.cacheEscrituraTokens),
    costoUsd: Number.isFinite(datos.costoUsd) ? Number(datos.costoUsd.toFixed(8)) : null,
    duracionMs: entero(datos.duracionMs),
  });
}

const info = (evento, datos) => registrar('info', evento, datos);
const warn = (evento, datos) => registrar('warn', evento, datos);
const error = (evento, datos) => registrar('error', evento, datos);

async function flush() {
  if (escribiendo || !cola.length) return;
  escribiendo = true;
  const lote = cola.splice(0, MAX_LOTE);
  const ahora = Date.now();
  try {
    await ejecutar('dbo.usp_Logs_Insertar', {
      origen: [sql.NVarChar(20), ORIGEN],
      logs: [sql.NVarChar(sql.MAX), JSON.stringify(lote.map(({ t, ...l }) => ({ hace: ahora - t, ...l })))],
    });
  } catch (err) {
    consolaOriginal.error(`[logs] No se pudieron guardar ${lote.length} logs:`, err.message);
  } finally {
    escribiendo = false;
  }
  if (cola.length >= MAX_LOTE) setImmediate(flush);
}

async function purgar() {
  try {
    const r = await ejecutar('dbo.usp_Logs_Purgar', { dias: [sql.Int, DIAS_RETENCION] });
    const borrados = r.recordset[0]?.borrados || 0;
    if (borrados) info('logs_purgados', { detalle: `${borrados} registros de más de ${DIAS_RETENCION} días` });
  } catch (err) {
    consolaOriginal.error('[logs] Error purgando logs viejos:', err.message);
  }
}

// console.warn / console.error de cualquier parte del bot también van a Logs
// (con el chat del contexto), así ningún error queda solo en la consola.
function capturarConsola() {
  for (const nivel of ['warn', 'error']) {
    console[nivel] = (...args) => {
      consolaOriginal[nivel](...args);
      const texto = args.map(a => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      const etiqueta = /^\[([\w-]+)\]/.exec(texto)?.[1];
      registrar(nivel, etiqueta ? `consola_${etiqueta}` : 'consola', { detalle: texto });
    };
  }
}

function iniciar() {
  capturarConsola();
  setInterval(flush, FLUSH_MS).unref();
  setTimeout(purgar, 30 * 1000).unref();
  setInterval(purgar, PURGA_MS).unref();
  // Al apagar (deploy en Railway) se manda lo que quedó en la cola.
  for (const senal of ['SIGTERM', 'SIGINT']) {
    process.once(senal, () => { flush().finally(() => process.exit(0)); });
  }
}

module.exports = { iniciar, conContexto, registrar, info, warn, error, flush, DIAS_RETENCION };
