const { ejecutar, sql } = require('./db');

// Búsqueda naive de singular en español, palabra por palabra (no la frase
// entera), para que "parlantes bluetooth" matchee contra "Parlante". Los
// plurales en "-es" pierden las dos letras ("solares" -> "solar", "leds" ->
// "led"): con solo sacar la "s" quedaba "solare" y no matcheaba "Estaca Solar".
// Recortar de más no pierde resultados (es un LIKE '%palabra%'): "calles" ->
// "call" sigue matcheando "Calle".
function singularizar(palabra) {
  const p = palabra.toLowerCase();
  if (p.length > 4 && p.endsWith('es')) return palabra.slice(0, -2);
  if (p.length > 3 && p.endsWith('s')) return palabra.slice(0, -1);
  return palabra;
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

// Lo que hay para vender ahora (activo y con stock, o sin control de stock), para
// cuando el cliente pide "info" en general. Usa el mismo procedure de búsqueda:
// sin filtro se manda una palabra vacía (LIKE '%%' matchea todo); con filtro
// (ej. "kids") se buscan esas palabras. Los agotados nunca se devuelven.
const MAX_CATALOGO = 60;
async function listarDisponibles(clienteId, filtro) {
  const palabras = String(filtro || '').trim().split(/\s+/).filter(Boolean).slice(0, 8).map(singularizar).map(escaparLike);
  const result = await ejecutar('dbo.usp_Bot_ArticulosBuscar', {
    clienteId: [sql.Int, clienteId],
    palabras: [sql.NVarChar(sql.MAX), JSON.stringify(palabras.length ? palabras : [''])],
    max: [sql.Int, MAX_CATALOGO],
  });
  return result.recordset
    .filter(r => !r.usaStock || Number(r.cantidad) > 0)
    .map(({ imagenes, opciones, ...row }) => ({ ...row, opciones: parsearOpciones(opciones), imagenes: parsearImagenes(imagenes) }));
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

module.exports = { buscarArticulos, listarDisponibles, registrarConsulta, obtenerFotos };
