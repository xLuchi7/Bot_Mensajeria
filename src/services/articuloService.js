const { getPool, sql } = require('./db');

// Búsqueda naive de singular en español: "parlantes" -> "parlante", palabra por
// palabra (no la frase entera), para que "parlantes bluetooth" matchee bien
// contra textos que tienen "Parlante" en singular.
function singularizar(palabra) {
  return palabra.length > 3 && palabra.toLowerCase().endsWith('s') ? palabra.slice(0, -1) : palabra;
}

async function buscarArticulos(clienteId, texto) {
  const pool = await getPool();
  const palabras = texto.trim().split(/\s+/).filter(Boolean).map(singularizar);

  const request = pool.request().input('clienteId', sql.Int, clienteId);
  // Cada palabra tiene que aparecer en algún lado (nombre, descripción, código,
  // marca, tipo, categoría, etiquetas o colecciones), pero las palabras entre sí
  // no tienen que estar en el mismo campo ni en orden.
  const condiciones = palabras
    .map((palabra, i) => {
      request.input(`p${i}`, sql.NVarChar, `%${palabra}%`);
      return `(a.nombre LIKE @p${i} OR a.descripcion LIKE @p${i} OR a.codigo LIKE @p${i} OR a.marca LIKE @p${i}
        OR a.tipoProducto LIKE @p${i} OR a.categoria LIKE @p${i} OR a.etiquetas LIKE @p${i} OR a.colecciones LIKE @p${i})`;
    })
    .join(' AND ');

  const result = await request.query(`
    SELECT a.id AS articuloId, a.nombre, a.descripcion, a.precio, a.precioComparacion, a.marca, a.opciones,
           a.usaStock, ISNULL(s.cantidad, 0) AS cantidad, a.imagenes
    FROM Articulos a
    LEFT JOIN Stock s ON s.articuloId = a.id
    WHERE a.clienteId = @clienteId AND a.activo = 1
      AND (${condiciones || '1=1'})
  `);

  return result.recordset.map(({ imagenes, opciones, ...row }) => ({
    ...row,
    opciones: parsearOpciones(opciones),
    imagenes: parsearImagenes(imagenes),
  }));
}

// Articulos.opciones: [{ nombre: "Talle", valor: "38" }] → "Talle: 38"
function parsearOpciones(valor) {
  try {
    const opciones = JSON.parse(valor || '[]');
    return Array.isArray(opciones) ? opciones.map(o => `${o.nombre}: ${o.valor}`).join(', ') : '';
  } catch {
    return '';
  }
}

// Articulos.imagenes es un JSON array de URLs públicas (hoy las carga el sync de
// Shopify del Portal, ya en JPG porque WhatsApp no acepta WebP).
function parsearImagenes(valor) {
  try {
    const urls = JSON.parse(valor || '[]');
    return Array.isArray(urls) ? urls.filter(u => typeof u === 'string' && u.startsWith('https://')) : [];
  } catch {
    return [];
  }
}

// Mismo criterio que crear_pedido: nombre exacto y activo.
async function obtenerFotos(clienteId, nombre) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('nombre', sql.NVarChar, nombre)
    .query('SELECT TOP 1 nombre, imagenes FROM Articulos WHERE clienteId = @clienteId AND nombre = @nombre AND activo = 1');
  const row = result.recordset[0];
  return row ? { nombre: row.nombre, imagenes: parsearImagenes(row.imagenes) } : null;
}

// Registra qué se buscó y si hubo resultados, para poder analizar demanda de productos después.
// stockAlConsultar guarda el stock que había en ese momento (NULL si el artículo no usa
// stock, ya que "sin stock" no aplica) — así el Portal puede mostrar qué se buscó estando
// agotado, para revisar cuando vuelva a haber.
async function registrarConsulta(clienteId, userId, texto, rows) {
  const pool = await getPool();

  if (rows.length === 0) {
    await pool
      .request()
      .input('clienteId', sql.Int, clienteId)
      .input('userId', sql.NVarChar, userId)
      .input('texto', sql.NVarChar, texto)
      .query(`
        INSERT INTO ConsultasArticulo (clienteId, userId, articuloId, textoBuscado, encontrado, stockAlConsultar)
        VALUES (@clienteId, @userId, NULL, @texto, 0, NULL)
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
      .input('stockAlConsultar', sql.Int, row.usaStock ? row.cantidad : null)
      .query(`
        INSERT INTO ConsultasArticulo (clienteId, userId, articuloId, textoBuscado, encontrado, stockAlConsultar)
        VALUES (@clienteId, @userId, @articuloId, @texto, 1, @stockAlConsultar)
      `);
  }
}

module.exports = { buscarArticulos, registrarConsulta, obtenerFotos };
