// Precios de Claude en USD por millón de tokens (API de Anthropic, nov-2026).
// entrada: tokens sin caché · salida: incluye el razonamiento · leerCache: tokens
// servidos desde la caché · escribirCache: tokens escritos en la caché (TTL 5 min).
// Si se cambia de modelo, agregarlo acá: si no está, el costo se loguea vacío.
const PRECIOS = {
  'claude-haiku-5-5': {
    entrada: 0.10, salida: 0.50, leerCache: 0.01, escribirCache: 0.125,
    // Con prompts de más de 100K tokens Haiku 5.5 cobra 5 veces más.
    largo: { desde: 100000, entrada: 0.50, salida: 2.50, leerCache: 0.05, escribirCache: 0.625 },
  },
  'claude-haiku-4-5': { entrada: 1, salida: 5, leerCache: 0.10, escribirCache: 1.25 },
  'claude-sonnet-5-5': { entrada: 2, salida: 10, leerCache: 0.10, escribirCache: 2.50 },
  'claude-sonnet-5': { entrada: 2, salida: 10, leerCache: 0.20, escribirCache: 2.50 },
  'claude-sonnet-4-6': { entrada: 3, salida: 15, leerCache: 0.30, escribirCache: 3.75 },
  'claude-opus-5-5': { entrada: 4, salida: 20, leerCache: 0.20, escribirCache: 5 },
  'claude-opus-5': { entrada: 5, salida: 25, leerCache: 0.50, escribirCache: 6.25 },
};

// "claude-haiku-4-5-20251001" usa el precio de "claude-haiku-4-5".
function precioDe(modelo) {
  if (PRECIOS[modelo]) return PRECIOS[modelo];
  const base = Object.keys(PRECIOS).sort((a, b) => b.length - a.length).find(k => modelo?.startsWith(k));
  return base ? PRECIOS[base] : null;
}

/**
 * Costo en USD de una llamada, a partir de response.usage.
 * @returns {number|null} null si el modelo no está en la tabla
 */
function costoUsd(modelo, usage = {}) {
  const p = precioDe(modelo);
  if (!p) return null;
  const entrada = usage.input_tokens || 0;
  const leer = usage.cache_read_input_tokens || 0;
  const escribir = usage.cache_creation_input_tokens || 0;
  const salida = usage.output_tokens || 0;
  const t = p.largo && entrada + leer + escribir > p.largo.desde ? p.largo : p;
  return (entrada * t.entrada + salida * t.salida + leer * t.leerCache + escribir * t.escribirCache) / 1e6;
}

module.exports = { PRECIOS, costoUsd };
