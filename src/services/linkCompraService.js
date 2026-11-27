const crypto = require('crypto');
const { ejecutar, sql } = require('./db');
const portalAviso = require('./portalAvisoService');
const { validarItems } = require('./pedidoService');

// Venta por link de compra (Clientes con Shopify conectado y la opción activa en
// Integraciones del Portal): cuando el cliente confirma, en vez de crear un Pedido
// el bot le manda un link al checkout de la tienda con el carrito ya armado
// (cart permalink: https://{tienda}.myshopify.com/cart/{variante}:{cantidad},...).
// La persona completa sus datos y paga en Shopify. El link lleva un token
// (attributes[whatsapp] y ref) que vuelve en la orden: el Portal lo usa para
// vincular la compra con el link (tabla LinksCompra: enviado → comprado → pagado).

const CONFIG_CACHE_MS = 30 * 1000;
const DUPLICADO_MS = 10 * 60 * 1000;

// Se lee en cada respuesta: 30 s por Cliente. Sin el SQL nuevo (no existe el
// procedure) o sin Shopify conectado → null, y el bot sigue con crear_pedido.
const configs = new Map(); // clienteId -> { datos, hasta }
let sinProcedure = false;
async function getConfig(clienteId) {
  if (sinProcedure) return null;
  const guardado = configs.get(clienteId);
  if (guardado && guardado.hasta > Date.now()) return guardado.datos;
  let datos = null;
  try {
    const r = await ejecutar('dbo.usp_Bot_LinkCompraConfig', { clienteId: [sql.Int, clienteId] });
    const fila = r.recordset[0];
    const dominio = String(fila?.shopDomain || '').trim().toLowerCase();
    if (fila?.activo && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(dominio)) datos = { shopDomain: dominio };
  } catch (err) {
    if (/Could not find stored procedure/i.test(err.message)) {
      sinProcedure = true;
      return null;
    }
    // Si la base falla justo acá, mejor seguir con el flujo de siempre que no responder.
    console.error(`[link-compra] No se pudo leer la configuración del cliente ${clienteId}:`, err.message);
    return null;
  }
  configs.set(clienteId, { datos, hasta: Date.now() + CONFIG_CACHE_MS });
  return datos;
}

// "gid://shopify/ProductVariant/123" → "123".
function idVariante(gid) {
  const m = /(\d+)\s*$/.exec(String(gid || ''));
  return m ? m[1] : null;
}

function armarUrl(shopDomain, lineas, token) {
  const carrito = lineas.map(l => `${l.variante}:${l.cantidad}`).join(',');
  const params = new URLSearchParams({ 'attributes[whatsapp]': token, ref: `wa-${token}` });
  return `https://${shopDomain}/cart/${carrito}?${params.toString()}`;
}

function redondear(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Mismo carrito del mismo número en los últimos 10 minutos → se reusa el link
// (ej. el cliente confirma dos veces: "sí" y "dale").
const ultimos = new Map(); // `${clienteId}|${userId}` -> { firma, en, resultado }
function firmaDe(items) {
  return items.map(i => `${i.nombre.toLowerCase()}×${i.cantidad}`).sort().join('|');
}

/**
 * @returns {Promise<{ok: true, id: number, url: string, total: number, items: object[], repetido?: boolean} | {ok: false, errores: string[]}>}
 */
async function crearLink(clienteId, userId, config, items) {
  const validacion = validarItems(items);
  if (validacion.errores) return { ok: false, errores: validacion.errores };

  const clave = `${clienteId}|${userId}`;
  const firma = firmaDe(validacion.items);
  const anterior = ultimos.get(clave);
  if (anterior && anterior.firma === firma && Date.now() - anterior.en < DUPLICADO_MS) {
    return { ...anterior.resultado, repetido: true };
  }

  const r = await ejecutar('dbo.usp_Bot_LinkCompraArticulos', {
    clienteId: [sql.Int, clienteId],
    items: [sql.NVarChar(sql.MAX), JSON.stringify(validacion.items)],
  });

  const errores = [];
  const lineas = [];
  for (const f of r.recordset) {
    const nombre = f.nombre || f.nombrePedido;
    if (!f.articuloId) {
      errores.push(`No se encontró el artículo "${f.nombrePedido}" en el catálogo. Usá el nombre exacto que devolvió buscar_articulos.`);
      continue;
    }
    const variante = idVariante(f.shopifyVariantId);
    if (!variante) {
      errores.push(`"${nombre}" no se puede comprar por la tienda online. Ofrecé los demás artículos por link, o pasá el caso a alguien del equipo (escalar_a_humano) para este artículo.`);
      continue;
    }
    if (f.usaStock && Number(f.stock) < f.cantidad) {
      errores.push(Number(f.stock) > 0
        ? `No hay stock suficiente de "${nombre}" (pedido: ${f.cantidad}, disponible: ${f.stock}).`
        : `"${nombre}" está agotado.`);
      continue;
    }
    lineas.push({ articuloId: f.articuloId, nombre, cantidad: f.cantidad, precio: Number(f.precio) || 0, variante });
  }
  if (r.recordset.length !== validacion.items.length) errores.push('No se pudieron leer todos los artículos del pedido.');
  if (errores.length) return { ok: false, errores };

  const token = crypto.randomBytes(12).toString('base64url');
  const url = armarUrl(config.shopDomain, lineas, token);
  const total = redondear(lineas.reduce((s, l) => s + l.precio * l.cantidad, 0));
  const unidades = lineas.reduce((s, l) => s + l.cantidad, 0);
  const detalle = lineas.map(({ variante, ...l }) => l);

  const creado = await ejecutar('dbo.usp_Bot_LinkCompraCrear', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
    token: [sql.VarChar(40), token],
    url: [sql.NVarChar(2000), url],
    items: [sql.NVarChar(sql.MAX), JSON.stringify(detalle)],
    unidades: [sql.Int, unidades],
    total: [sql.Decimal(18, 2), total],
  });

  const resultado = { ok: true, id: creado.recordset[0].id, url, total, items: detalle };
  ultimos.set(clave, { firma, en: Date.now(), resultado });
  if (ultimos.size > 5000) ultimos.delete(ultimos.keys().next().value);
  portalAviso.avisar(clienteId, 'pedido', userId);
  return resultado;
}

const ESTADO_TEXTO = {
  enviado: 'link enviado, todavía no completó la compra',
  comprado: 'compra hecha en la tienda, pago pendiente',
  pagado: 'compra pagada',
  cancelado: 'compra cancelada',
};
const ENVIO_TEXTO = { sin_enviar: 'sin despachar', parcial: 'despachado en parte', despachado: 'despachado', entregado: 'entregado' };

// Compras por link de este número, resumidas para Claude (buscar_pedidos_cliente).
async function comprasDeCliente(clienteId, userId) {
  if (sinProcedure) return [];
  const r = await ejecutar('dbo.usp_Bot_LinkCompraDeCliente', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
  });
  return r.recordset.map((f) => {
    let items = [];
    try { items = JSON.parse(f.items).map(i => ({ nombre: i.nombre, cantidad: i.cantidad })); } catch { /* sin detalle */ }
    return {
      fecha: f.fecha,
      estado: ESTADO_TEXTO[f.estado] || f.estado,
      ...(f.shopifyOrderName ? { pedidoTienda: f.shopifyOrderName } : {}),
      ...(f.shopifyEnvio && f.estado !== 'cancelado' ? { envio: ENVIO_TEXTO[f.shopifyEnvio] || f.shopifyEnvio } : {}),
      total: Number(f.totalCompra ?? f.total),
      items,
    };
  });
}

module.exports = { getConfig, crearLink, comprasDeCliente, armarUrl, idVariante };
