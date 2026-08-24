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
 * @returns {Promise<{ok: true, pedidoId: number, total: number} | {ok: false, errores: string[]}>}
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
    return { ok: true, pedidoId, total };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

module.exports = { crearPedido };
