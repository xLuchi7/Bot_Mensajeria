const { ejecutar, sql } = require('./db');
const portalAviso = require('./portalAvisoService');

// pedidoId es opcional: solo se completa cuando Claude identificó con certeza a qué
// Pedido se refiere el reclamo (vía buscar_pedidos_cliente), para que el Portal pueda
// resolver este Escalamiento automáticamente cuando el Pedido se marque "solucionado".
async function registrarEscalamiento(clienteId, userId, motivo, pedidoId = null) {
  const result = await ejecutar('dbo.usp_Bot_EscalamientoRegistrar', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
    motivo: [sql.NVarChar(sql.MAX), motivo],
    pedidoId: [sql.Int, pedidoId],
  });
  portalAviso.avisar(clienteId, 'escalamiento', userId);
  return result.recordset[0]?.id ?? null;
}

module.exports = { registrarEscalamiento };
