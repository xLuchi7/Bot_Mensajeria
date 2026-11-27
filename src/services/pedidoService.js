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
const MAX_ITEMS = 30;
const MAX_CANTIDAD = 100;
const MAX_NOTAS = 500; // Pedidos.notas es NVARCHAR(500)
const DUPLICADO_MS = 10 * 60 * 1000;

// Lo que manda Claude no se usa tal cual: una conversación manipulada ("pedí -5",
// "pedí 1e12") no tiene que llegar a la base. Devuelve { items } o { errores }.
function validarItems(items) {
  if (!Array.isArray(items) || !items.length) return { errores: ['El pedido no tiene artículos.'] };
  if (items.length > MAX_ITEMS) return { errores: [`Un pedido puede tener hasta ${MAX_ITEMS} artículos distintos.`] };
  const errores = [];
  const limpios = items.map((i, n) => {
    const nombre = typeof i?.nombre === 'string' ? i.nombre.trim().slice(0, 200) : '';
    const cantidad = Number(i?.cantidad);
    if (!nombre) errores.push(`Al artículo ${n + 1} le falta el nombre.`);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD) {
      errores.push(`La cantidad de "${nombre || `artículo ${n + 1}`}" tiene que ser un número entero entre 1 y ${MAX_CANTIDAD}.`);
    }
    return { nombre, cantidad };
  });
  if (errores.length) return { errores };

  // El mismo artículo en dos líneas se junta en una (sumando cantidades): así el
  // stock se valida por el total y el pedido no queda con renglones repetidos.
  const porNombre = new Map();
  for (const i of limpios) {
    const clave = i.nombre.toLowerCase();
    const previo = porNombre.get(clave);
    if (previo) previo.cantidad += i.cantidad;
    else porNombre.set(clave, { ...i });
  }
  const juntos = [...porNombre.values()];
  const pasado = juntos.find(i => i.cantidad > MAX_CANTIDAD);
  if (pasado) return { errores: [`La cantidad total de "${pasado.nombre}" no puede pasar de ${MAX_CANTIDAD}.`] };
  return { items: juntos };
}

// Freno a pedidos duplicados: el mismo pedido (mismos artículos y cantidades) del
// mismo número en los últimos 10 minutos no se vuelve a crear (ej. el cliente
// confirma dos veces: "sí" y "dale").
const ultimos = new Map(); // `${clienteId}|${userId}` -> { firma, en, pedidoId }
function firmaDe(items) {
  return items.map(i => `${i.nombre.toLowerCase()}×${i.cantidad}`).sort().join('|');
}

async function crearPedido(clienteId, userId, items, notas) {
  const validacion = validarItems(items);
  if (validacion.errores) return { ok: false, errores: validacion.errores };

  const clave = `${clienteId}|${userId}`;
  const firma = firmaDe(validacion.items);
  const anterior = ultimos.get(clave);
  if (anterior && anterior.firma === firma && Date.now() - anterior.en < DUPLICADO_MS) {
    return { ok: false, duplicado: true, errores: [`Este mismo pedido ya se creó hace unos minutos (pedido #${anterior.pedidoId}). No lo crees de nuevo: confirmale al cliente el pedido #${anterior.pedidoId}.`] };
  }

  const result = await ejecutar('dbo.usp_Bot_PedidoCrear', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
    items: [sql.NVarChar(sql.MAX), JSON.stringify(validacion.items)],
    notas: [sql.NVarChar(sql.MAX), typeof notas === 'string' && notas.trim() ? notas.trim().slice(0, MAX_NOTAS) : null],
  });

  const [errores = [], pedido = [], detalle = []] = result.recordsets;
  if (errores.length) return { ok: false, errores: errores.map(e => e.mensaje) };
  ultimos.set(clave, { firma, en: Date.now(), pedidoId: pedido[0].pedidoId });
  if (ultimos.size > 5000) ultimos.delete(ultimos.keys().next().value);
  portalAviso.avisar(clienteId, 'pedido', userId);
  return { ok: true, pedidoId: pedido[0].pedidoId, total: Number(pedido[0].total), items: detalle };
}

// ¿Ese pedido es de este número? El pedidoId lo manda Claude: sin esto, alguien
// podía reclamar un pedido ajeno diciendo un número cualquiera.
async function esDelCliente(clienteId, userId, pedidoId) {
  if (!Number.isInteger(pedidoId) || pedidoId < 1) return false;
  const propios = await buscarPedidosCliente(clienteId, userId);
  return propios.some(p => p.pedidoId === pedidoId);
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
// userId: el procedure además exige que el pedido sea de ese número.
async function marcarComoReclamado(clienteId, pedidoId, userId) {
  const params = {
    clienteId: [sql.Int, clienteId],
    pedidoId: [sql.Int, pedidoId],
    userId: [sql.NVarChar(100), userId],
  };
  let result;
  try {
    result = await ejecutar('dbo.usp_Bot_PedidoMarcarReclamado', params);
  } catch (err) {
    // Procedure viejo (todavía no se corrió el SQL nuevo): sin @userId (igual ya se validó en esDelCliente).
    if (!/too many arguments/i.test(err.message)) throw err;
    delete params.userId;
    result = await ejecutar('dbo.usp_Bot_PedidoMarcarReclamado', params);
  }
  const cambio = (result.recordset[0]?.cambiados ?? 0) > 0;
  if (cambio) portalAviso.avisar(clienteId, 'pedido');
  return cambio;
}

module.exports = { crearPedido, buscarPedidosCliente, esDelCliente, registrarConsultaPedido, marcarComoReclamado, validarItems };
