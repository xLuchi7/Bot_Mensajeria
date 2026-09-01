const { getPool, sql } = require('./db');

async function buscarArticuloExacto(pool, clienteId, nombre) {
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('nombre', sql.NVarChar, nombre)
    .query(`
      SELECT a.id AS articuloId, a.nombre, a.precio, a.usaStock, ISNULL(s.cantidad, 0) AS stockDisponible
      FROM Articulos a
      LEFT JOIN Stock s ON s.articuloId = a.id
      WHERE a.clienteId = @clienteId AND a.activo = 1 AND a.nombre = @nombre
    `);

  return result.recordset[0] ?? null;
}

/**
 * @param {number} clienteId
 * @param {string} userId
 * @param {Array<{nombre: string, cantidad: number}>} items
 * @param {string|null} notas
 * @returns {Promise<{ok: true, pedidoId: number, total: number, items: object[]} | {ok: false, errores: string[]}>}
 */
async function crearPedido(clienteId, userId, items, notas) {
  const pool = await getPool();

  // Valida todo antes de tocar la base: no queremos pedidos parciales.
  const resueltos = [];
  const errores = [];
  for (const { nombre, cantidad } of items) {
    const articulo = await buscarArticuloExacto(pool, clienteId, nombre);
    if (!articulo) {
      errores.push(`No se encontró el artículo "${nombre}" en el catálogo.`);
      continue;
    }
    if (articulo.usaStock && articulo.stockDisponible < cantidad) {
      errores.push(`No hay stock suficiente de "${articulo.nombre}" (pedido: ${cantidad}, disponible: ${articulo.stockDisponible}).`);
      continue;
    }
    resueltos.push({ ...articulo, cantidad });
  }

  if (errores.length) return { ok: false, errores };

  const total = resueltos.reduce((acc, r) => acc + r.precio * r.cantidad, 0);

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const pedidoResult = await new sql.Request(transaction)
      .input('clienteId', sql.Int, clienteId)
      .input('userId', sql.NVarChar, userId)
      .input('total', sql.Decimal(12, 2), total)
      .input('notas', sql.NVarChar, notas ?? null)
      .query(`
        INSERT INTO Pedidos (clienteId, userId, total, notas)
        OUTPUT INSERTED.id
        VALUES (@clienteId, @userId, @total, @notas)
      `);

    const pedidoId = pedidoResult.recordset[0].id;

    for (const item of resueltos) {
      await new sql.Request(transaction)
        .input('pedidoId', sql.Int, pedidoId)
        .input('articuloId', sql.Int, item.articuloId)
        .input('cantidad', sql.Int, item.cantidad)
        .input('precioUnitario', sql.Decimal(12, 2), item.precio)
        .input('subtotal', sql.Decimal(12, 2), item.precio * item.cantidad)
        .query(`
          INSERT INTO DetallePedidos (pedidoId, articuloId, cantidad, precioUnitario, subtotal)
          VALUES (@pedidoId, @articuloId, @cantidad, @precioUnitario, @subtotal)
        `);
    }

    await transaction.commit();
    return { ok: true, pedidoId, total, items: resueltos };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// Pedidos anteriores de este cliente puntual (no de otros), para que Claude pueda
// identificar a cuál se refiere un reclamo sin tener que confiar solo en lo que
// recuerda de la conversación actual.
async function buscarPedidosCliente(clienteId, userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('userId', sql.NVarChar, userId)
    .query(`
      SELECT p.id AS pedidoId, p.estado, p.total, FORMAT(p.fechaAlta, 'dd/MM/yyyy') AS fecha,
             d.cantidad, a.nombre
      FROM (
        SELECT TOP (10) id, estado, total, fechaAlta
        FROM Pedidos
        WHERE clienteId = @clienteId AND userId = @userId
        ORDER BY id DESC
      ) p
      JOIN DetallePedidos d ON d.pedidoId = p.id
      JOIN Articulos a ON a.id = d.articuloId
      ORDER BY p.id DESC
    `);

  const pedidos = new Map();
  for (const row of result.recordset) {
    if (!pedidos.has(row.pedidoId)) {
      pedidos.set(row.pedidoId, {
        pedidoId: row.pedidoId,
        estado: row.estado,
        total: row.total,
        fecha: row.fecha,
        items: [],
      });
    }
    pedidos.get(row.pedidoId).items.push({ nombre: row.nombre, cantidad: row.cantidad });
  }

  return [...pedidos.values()];
}

// Registra que este cliente consultó el estado de sus pedidos, para que el negocio pueda
// revisar en el Portal si alguien preguntó y se olvidaron de hacer seguimiento. Un registro
// por pedido encontrado (igual que registrarConsulta en articuloService); si no tiene
// pedidos, un único registro con pedidoId NULL.
async function registrarConsultaPedido(clienteId, userId, pedidosEncontrados) {
  const pool = await getPool();

  if (!pedidosEncontrados.length) {
    await pool
      .request()
      .input('clienteId', sql.Int, clienteId)
      .input('userId', sql.NVarChar, userId)
      .query(`
        INSERT INTO ConsultasPedido (clienteId, userId, pedidoId)
        VALUES (@clienteId, @userId, NULL)
      `);
    return;
  }

  for (const p of pedidosEncontrados) {
    await pool
      .request()
      .input('clienteId', sql.Int, clienteId)
      .input('userId', sql.NVarChar, userId)
      .input('pedidoId', sql.Int, p.pedidoId)
      .query(`
        INSERT INTO ConsultasPedido (clienteId, userId, pedidoId)
        VALUES (@clienteId, @userId, @pedidoId)
      `);
  }
}

// Si el pedido reclamado está "entregado", lo pasa a "reclamado" — el Portal solo
// devuelve Stock al marcarlo "solucionado", y eso solo tiene sentido si el Stock ya
// se había descontado (eso pasa recién al entregar). Si está en otro estado (ej.
// todavía pendiente) no lo tocamos: no tiene sentido reclamar algo que ni se decidió
// si se entrega.
async function marcarComoReclamado(clienteId, pedidoId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('pedidoId', sql.Int, pedidoId)
    .query("UPDATE Pedidos SET estado = 'reclamado' WHERE id = @pedidoId AND clienteId = @clienteId AND estado = 'entregado'");
  return result.rowsAffected[0] > 0;
}

module.exports = { crearPedido, buscarPedidosCliente, registrarConsultaPedido, marcarComoReclamado };
