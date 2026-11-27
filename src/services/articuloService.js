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
// Tope de resultados por búsqueda: sin esto, "a" devolvía todo el catálogo (tokens
// de más y una fila de ConsultasArticulo por artículo).
const MAX_RESULTADOS = 15;

// % _ [ dentro de un LIKE son comodines: se escapan para buscarlos como texto.
const escaparLike = p => p.replace(/[[%_]/g, c => `[${c}]`);

// Devuelve los artículos (hasta MAX_RESULTADOS, los más relevantes primero) y
// `hayMas` si quedaron otros afuera.
async function buscarArticulos(clienteId, texto) {
  const palabras = String(texto || '').trim().split(/\s+/).filter(Boolean).slice(0, 8).map(singularizar).map(escaparLike);
  if (!palabras.length) return Object.assign([], { hayMas: false });

  const params = {
    clienteId: [sql.Int, clienteId],
    palabras: [sql.NVarChar(sql.MAX), JSON.stringify(palabras)],
    max: [sql.Int, MAX_RESULTADOS],
  };
  let result;
  try {
    result = await ejecutar('dbo.usp_Bot_ArticulosBuscar', params);
  } catch (err) {
    // Procedure viejo (todavía no se corrió el SQL nuevo): sin @max.
    if (!/too many arguments/i.test(err.message)) throw err;
    delete params.max;
    result = await ejecutar('dbo.usp_Bot_ArticulosBuscar', params);
  }

  const filas = result.recordset;
  const articulos = filas.slice(0, MAX_RESULTADOS).map(({ imagenes, opciones, ...row }) => ({
    ...row,
    opciones: parsearOpciones(opciones),
    imagenes: parsearImagenes(imagenes),
  }));
  return Object.assign(articulos, { hayMas: filas.length > MAX_RESULTADOS });
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
