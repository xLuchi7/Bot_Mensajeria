const { ejecutar, sql } = require('./db');

// "Reclama" el id del mensaje de WhatsApp: si ya estaba, es un reintento de Meta
// (usp_Bot_WhatsAppMensajeReclamar devuelve yaProcesado = 1).
async function yaFueProcesado(waMessageId) {
  const result = await ejecutar('dbo.usp_Bot_WhatsAppMensajeReclamar', { waMessageId: [sql.NVarChar(100), waMessageId] });
  return Boolean(result.recordset[0]?.yaProcesado);
}

module.exports = { yaFueProcesado };
