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
      SELECT a.nombre, a.descripcion, a.precio, ISNULL(s.cantidad, 0) AS cantidad
      FROM Articulos a
      LEFT JOIN Stock s ON s.articuloId = a.id
      WHERE a.clienteId = @clienteId AND a.activo = 1
        AND (a.nombre LIKE @texto OR a.descripcion LIKE @texto OR a.codigo LIKE @texto)
    `);

  return result.recordset;
}

module.exports = { buscarArticulos };
