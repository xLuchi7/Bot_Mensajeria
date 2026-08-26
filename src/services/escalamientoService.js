const { getPool, sql } = require('./db');

// pedidoId es opcional: solo se completa cuando Claude identificó con certeza a qué
// Pedido se refiere el reclamo (vía buscar_pedidos_cliente), para que el Portal pueda
// resolver este Escalamiento automáticamente cuando el Pedido se marque "solucionado".
async function registrarEscalamiento(clienteId, userId, motivo, pedidoId = null) {
  const pool = await getPool();
  await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('userId', sql.NVarChar, userId)
    .input('motivo', sql.NVarChar, motivo)
    .input('pedidoId', sql.Int, pedidoId)
    .query('INSERT INTO Escalamientos (clienteId, userId, motivo, pedidoId) VALUES (@clienteId, @userId, @motivo, @pedidoId)');
}

module.exports = { registrarEscalamiento };
