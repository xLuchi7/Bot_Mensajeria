const { getPool, sql } = require('./db');

async function registrarEscalamiento(clienteId, userId, motivo) {
  const pool = await getPool();
  await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('userId', sql.NVarChar, userId)
    .input('motivo', sql.NVarChar, motivo)
    .query('INSERT INTO Escalamientos (clienteId, userId, motivo) VALUES (@clienteId, @userId, @motivo)');
}

module.exports = { registrarEscalamiento };
