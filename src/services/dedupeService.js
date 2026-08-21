const { getPool, sql } = require('./db');

const SQL_UNIQUE_VIOLATION = [2627, 2601];

// Intenta "reclamar" el id del mensaje de WhatsApp insertándolo. Si ya existe,
// la violación de UNIQUE nos dice que ya se procesó (reintento de Meta).
async function yaFueProcesado(waMessageId) {
  const pool = await getPool();
  try {
    await pool
      .request()
      .input('waMessageId', sql.NVarChar, waMessageId)
      .query('INSERT INTO MensajesWhatsAppProcesados (waMessageId) VALUES (@waMessageId)');
    return false;
  } catch (err) {
    if (SQL_UNIQUE_VIOLATION.includes(err.number)) return true;
    throw err;
  }
}

module.exports = { yaFueProcesado };
