const { ejecutar, sql } = require('./db');

// Búsqueda naive de singular en español: "parlantes" -> "parlante", palabra por
// palabra (no la frase entera), para que "parlantes bluetooth" matchee bien
// contra textos que tienen "Parlante" en singular.
function singularizar(palabra) {
  return palabra.length > 3 && palabra.toLowerCase().endsWith('s') ? palabra.slice(0, -1) : palabra;
}

// Cada palabra tiene que aparecer en algún lado (nombre, descripción, código,
// marca, tipo, categoría, etiquetas o colecciones), pero las palabras entre sí
// no tienen que estar en el mismo campo ni en orden (usp_Bot_ArticulosBuscar).
async function buscarArticulos(clienteId, texto) {
  const palabras = texto.trim().split(/\s+/).filter(Boolean).map(singularizar);
  const result = await ejecutar('dbo.usp_Bot_ArticulosBuscar', {
    clienteId: [sql.Int, clienteId],
    palabras: [sql.NVarChar(sql.MAX), JSON.stringify(palabras)],
  });

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
  const result = await ejecutar('dbo.usp_Bot_ArticuloFotos', {
    clienteId: [sql.Int, clienteId],
    nombre: [sql.NVarChar(200), String(nombre).slice(0, 200)],
  });
  const row = result.recordset[0];
  return row ? { nombre: row.nombre, imagenes: parsearImagenes(row.imagenes) } : null;
}

// Registra qué se buscó y si hubo resultados, para poder analizar demanda de productos después.
// stockAlConsultar guarda el stock que había en ese momento (NULL si el artículo no usa
// stock) — así el Portal puede mostrar qué se buscó estando agotado.
async function registrarConsulta(clienteId, userId, texto, rows) {
  const resultados = rows.map(r => ({ articuloId: r.articuloId, stock: r.usaStock ? r.cantidad : null }));
  await ejecutar('dbo.usp_Bot_ConsultaArticuloRegistrar', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
    texto: [sql.NVarChar(200), String(texto).slice(0, 200)],
    resultados: [sql.NVarChar(sql.MAX), JSON.stringify(resultados)],
  });
}

module.exports = { buscarArticulos, registrarConsulta, obtenerFotos };
