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

async function getContextoNegocio(clienteId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .query('SELECT contextoNegocio FROM Clientes WHERE id = @clienteId');

  return result.recordset[0]?.contextoNegocio ?? null;
}

async function getEmail(clienteId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .query('SELECT email FROM Clientes WHERE id = @clienteId');

  return result.recordset[0]?.email ?? null;
}

module.exports = { resolveClienteIdByPhone, getContextoNegocio, getEmail };
