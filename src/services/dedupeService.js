const { ejecutar, sql } = require('./db');

// "Reclama" el id del mensaje de WhatsApp: si ya estaba, es un reintento de Meta
// (usp_Bot_WhatsAppMensajeReclamar devuelve yaProcesado = 1).
async function yaFueProcesado(waMessageId) {
  const result = await ejecutar('dbo.usp_Bot_WhatsAppMensajeReclamar', { waMessageId: [sql.NVarChar(100), waMessageId] });
  return Boolean(result.recordset[0]?.yaProcesado);
}

// Los ids solo sirven para descartar reintentos de Meta (minutos/horas): una vez
// por día se borran los de más de 30 días, si no la tabla crece para siempre.
const DIAS_RETENCION = 30;
function purgar() {
  ejecutar('dbo.usp_Bot_MensajesProcesadosPurgar', { dias: [sql.Int, DIAS_RETENCION] })
    .then(r => { if (r.recordset[0]?.borrados) console.log(`[dedupe] ${r.recordset[0].borrados} ids de mensajes viejos borrados`); })
    .catch((err) => {
      // Todavía no se corrió el SQL nuevo: no es grave, se reintenta mañana.
      if (/Could not find stored procedure/i.test(err.message)) console.log('[dedupe] Falta usp_Bot_MensajesProcesadosPurgar (correr el SQL nuevo)');
      else console.error('[dedupe] No se pudieron purgar los ids procesados:', err.message);
    });
}

function iniciarPurga() {
  setTimeout(purgar, 60 * 1000).unref();
  setInterval(purgar, 24 * 60 * 60 * 1000).unref();
}

module.exports = { yaFueProcesado, iniciarPurga };
