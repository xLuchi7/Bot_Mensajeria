const { getPool, sql } = require('./db');

// Clientes.Telefono se guarda solo con dígitos (sin +, espacios ni guiones)
function normalizePhone(phoneNumber) {
  return (phoneNumber || '').replace(/\D/g, '');
}

async function resolveClienteIdByPhone(phoneNumber) {
  const telefono = normalizePhone(phoneNumber);
  if (!telefono) return null;

  const pool = await getPool();
  const result = await pool
    .request()
    .input('telefono', sql.NVarChar, telefono)
    .query('SELECT id FROM Clientes WHERE telefono = @telefono AND activo = 1');

  return result.recordset[0]?.id ?? null;
}

module.exports = { resolveClienteIdByPhone };
