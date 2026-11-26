const { ejecutar, sql } = require('./db');
const portalAviso = require('./portalAvisoService');

/**
 * Valida y crea el Pedido con sus DetallePedidos en una sola transacción
 * (usp_Bot_PedidoCrear: si algo falla, ROLLBACK y no queda nada a medias).
 * @param {number} clienteId
 * @param {string} userId
 * @param {Array<{nombre: string, cantidad: number}>} items
 * @param {string|null} notas
 * @returns {Promise<{ok: true, pedidoId: number, total: number, items: object[]} | {ok: false, errores: string[]}>}
 */
async function crearPedido(clienteId, userId, items, notas) {
  const result = await ejecutar('dbo.usp_Bot_PedidoCrear', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
    items: [sql.NVarChar(sql.MAX), JSON.stringify((items || []).map(i => ({ nombre: i.nombre, cantidad: i.cantidad })))],
    notas: [sql.NVarChar(sql.MAX), notas ?? null],
  });

  const [errores = [], pedido = [], detalle = []] = result.recordsets;
  if (errores.length) return { ok: false, errores: errores.map(e => e.mensaje) };
  portalAviso.avisar(clienteId, 'pedido', userId);
  return { ok: true, pedidoId: pedido[0].pedidoId, total: Number(pedido[0].total), items: detalle };
}

// Pedidos anteriores de este cliente puntual (no de otros), para que Claude pueda
// identificar a cuál se refiere un reclamo sin tener que confiar solo en lo que
// recuerda de la conversación actual.
async function buscarPedidosCliente(clienteId, userId) {
  const result = await ejecutar('dbo.usp_Bot_PedidosDeCliente', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
  });

  const pedidos = new Map();
  for (const row of result.recordset) {
    if (!pedidos.has(row.pedidoId)) {
      pedidos.set(row.pedidoId, { pedidoId: row.pedidoId, estado: row.estado, total: row.total, fecha: row.fecha, items: [] });
    }
    pedidos.get(row.pedidoId).items.push({ nombre: row.nombre, cantidad: row.cantidad });
  }
  return [...pedidos.values()];
}

// Registra que este cliente consultó el estado de sus pedidos (uno por pedido
// encontrado; si no tiene, uno con pedidoId NULL).
async function registrarConsultaPedido(clienteId, userId, pedidosEncontrados) {
  await ejecutar('dbo.usp_Bot_ConsultaPedidoRegistrar', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
    pedidoIds: [sql.NVarChar(sql.MAX), JSON.stringify(pedidosEncontrados.map(p => p.pedidoId))],
  });
}

// Si el pedido reclamado está "entregado", lo pasa a "reclamado" — el Portal solo
// devuelve Stock al marcarlo "solucionado", y eso solo tiene sentido si el Stock ya
// se había descontado (eso pasa recién al entregar).
async function marcarComoReclamado(clienteId, pedidoId) {
  const result = await ejecutar('dbo.usp_Bot_PedidoMarcarReclamado', {
    clienteId: [sql.Int, clienteId],
    pedidoId: [sql.Int, pedidoId],
  });
  const cambio = (result.recordset[0]?.cambiados ?? 0) > 0;
  if (cambio) portalAviso.avisar(clienteId, 'pedido');
  return cambio;
}

module.exports = { crearPedido, buscarPedidosCliente, registrarConsultaPedido, marcarComoReclamado };
