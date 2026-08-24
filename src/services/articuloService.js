const { getPool, sql } = require('./db');

// Búsqueda naive de singular en español: "parlantes" -> "parlante", para que
// matchee contra nombres guardados en singular vía LIKE.
function singularizar(texto) {
  const t = texto.trim();
  return t.length > 3 && t.toLowerCase().endsWith('s') ? t.slice(0, -1) : t;
}

async function buscarArticulos(clienteId, texto) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('texto', sql.NVarChar, `%${singularizar(texto)}%`)
    .query(`
      SELECT a.id AS articuloId, a.nombre, a.descripcion, a.precio, a.usaStock, ISNULL(s.cantidad, 0) AS cantidad
      FROM Articulos a
      LEFT JOIN Stock s ON s.articuloId = a.id
      WHERE a.clienteId = @clienteId AND a.activo = 1
        AND (a.nombre LIKE @texto OR a.descripcion LIKE @texto OR a.codigo LIKE @texto)
    `);

  return result.recordset;
}

// Registra qué se buscó y si hubo resultados, para poder analizar demanda de productos después.
async function registrarConsulta(clienteId, userId, texto, rows) {
  const pool = await getPool();

  if (rows.length === 0) {
    await pool
      .request()
      .input('clienteId', sql.Int, clienteId)
      .input('userId', sql.NVarChar, userId)
      .input('texto', sql.NVarChar, texto)
      .query(`
        INSERT INTO ConsultasArticulo (clienteId, userId, articuloId, textoBuscado, encontrado)
        VALUES (@clienteId, @userId, NULL, @texto, 0)
      `);
    return;
  }

  for (const row of rows) {
    await pool
      .request()
      .input('clienteId', sql.Int, clienteId)
      .input('userId', sql.NVarChar, userId)
      .input('texto', sql.NVarChar, texto)
      .input('articuloId', sql.Int, row.articuloId)
      .query(`
        INSERT INTO ConsultasArticulo (clienteId, userId, articuloId, textoBuscado, encontrado)
        VALUES (@clienteId, @userId, @articuloId, @texto, 1)
      `);
  }
}

module.exports = { buscarArticulos, registrarConsulta };
