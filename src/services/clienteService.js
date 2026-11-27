const { ejecutar, sql } = require('./db');

// Clientes.Telefono se guarda solo con dígitos (sin +, espacios ni guiones)
function normalizePhone(phoneNumber) {
  return (phoneNumber || '').replace(/\D/g, '');
}

async function resolveClienteIdByPhone(phoneNumber) {
  const telefono = normalizePhone(phoneNumber);
  if (!telefono) return null;
  const result = await ejecutar('dbo.usp_Bot_ClienteResolverPorTelefono', { telefono: [sql.NVarChar(20), telefono] });
  return result.recordset[0]?.id ?? null;
}

// El Cliente se busca primero por phone_number_id (el id fijo que manda Meta) y,
// si todavía no lo tenemos guardado (primer mensaje), por el número visible, que es
// texto con formato y puede cambiar. Devuelve { clienteId, porTelefono }.
let sinProcedurePorId = false;
async function resolverCliente(phoneNumberId, displayPhoneNumber) {
  if (phoneNumberId && !sinProcedurePorId) {
    try {
      const r = await ejecutar('dbo.usp_Bot_ClienteResolverPorPhoneNumberId', { phoneNumberId: [sql.NVarChar(50), String(phoneNumberId)] });
      if (r.recordset.length === 1) return { clienteId: r.recordset[0].id, porTelefono: false };
    } catch (err) {
      // Todavía no se corrió el SQL nuevo: se sigue con el número visible, como antes.
      if (/Could not find stored procedure/i.test(err.message)) sinProcedurePorId = true;
      else throw err;
    }
  }
  const clienteId = await resolveClienteIdByPhone(displayPhoneNumber);
  return { clienteId, porTelefono: Boolean(clienteId) };
}

async function getContextoNegocio(clienteId) {
  const result = await ejecutar('dbo.usp_Bot_ClienteContexto', { clienteId: [sql.Int, clienteId] });
  return result.recordset[0]?.contextoNegocio ?? null;
}

// Pares pregunta → respuesta que el negocio cargó desde el portal (Aprendizajes).
async function getAprendizajes(clienteId) {
  const result = await ejecutar('dbo.usp_Bot_AprendizajesActivos', { clienteId: [sql.Int, clienteId] });
  return result.recordset;
}

async function getEmail(clienteId) {
  const result = await ejecutar('dbo.usp_Bot_ClienteEmail', { clienteId: [sql.Int, clienteId] });
  return result.recordset[0]?.email ?? null;
}

// Interruptores que maneja el Cliente desde el Portal: Clientes.botActivo apaga el
// bot para todos sus chats y Chats.botActivo lo pausa para un número puntual. Se
// lee en cada mensaje, sin caché, para que apagarlo desde el Portal corte las
// respuestas al instante. La primera vez que escribe un número el procedure le
// crea su fila en Chats (ver usp_Bot_ChatPuedeResponder).
async function botPuedeResponder(clienteId, userId) {
  const result = await ejecutar('dbo.usp_Bot_ChatPuedeResponder', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
  });
  const fila = result.recordset[0];
  if (!fila) return { puede: false, motivo: 'Cliente inexistente' };
  if (!fila.general) return { puede: false, motivo: 'bot apagado para todo el Cliente' };
  if (!fila.chat) return { puede: false, motivo: 'bot pausado para este chat' };
  return { puede: true };
}

// El phone_number_id (lo que pide la Cloud API para enviar) solo llega en el
// webhook: lo guardamos para poder mandar mensajes iniciados desde el Portal.
async function guardarPhoneNumberId(clienteId, phoneNumberId) {
  if (!phoneNumberId) return;
  await ejecutar('dbo.usp_Bot_ClienteGuardarPhoneNumberId', {
    clienteId: [sql.Int, clienteId],
    phoneNumberId: [sql.NVarChar(50), String(phoneNumberId)],
  });
}

async function getDatosEnvio(clienteId) {
  const result = await ejecutar('dbo.usp_Bot_ClienteDatosEnvio', { clienteId: [sql.Int, clienteId] });
  return result.recordset[0] ?? null;
}

async function guardarNombrePerfil(clienteId, userId, nombrePerfil) {
  await ejecutar('dbo.usp_Bot_ChatGuardarNombrePerfil', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
    nombrePerfil: [sql.NVarChar(200), String(nombrePerfil).slice(0, 200)],
  });
}

// Minutos desde el último mensaje del cliente (null si nunca escribió): ventana de 24 hs de WhatsApp.
async function minutosDesdeCliente(clienteId, userId) {
  const result = await ejecutar('dbo.usp_Bot_ChatMinutosDesdeCliente', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
  });
  return result.recordset[0]?.minutos ?? null;
}

// Perfil del negocio: tipoNegocio 'articulos' (catálogo de Articulos, el de siempre) o
// 'pasajes' (vende pasajes consultando la API de un sistema externo, ver pasajesService).
// Se lee en cada respuesta: se guarda 30 s por Cliente para no ir a la base cada vez.
// Si todavía no se corrió el SQL nuevo (no existe el procedure), queda 'articulos'.
const NEGOCIO_CACHE_MS = 30 * 1000;
const negocios = new Map(); // clienteId -> { datos, hasta }
const NEGOCIO_POR_DEFECTO = { tipoNegocio: 'articulos', apiExternaUrl: null, apiExternaToken: null, mensajeDerivacion: null };
async function getNegocio(clienteId) {
  const guardado = negocios.get(clienteId);
  if (guardado && guardado.hasta > Date.now()) return guardado.datos;
  let datos = NEGOCIO_POR_DEFECTO;
  try {
    const result = await ejecutar('dbo.usp_Bot_ClienteNegocio', { clienteId: [sql.Int, clienteId] });
    const fila = result.recordset[0];
    if (fila) {
      datos = {
        tipoNegocio: fila.tipoNegocio === 'pasajes' ? 'pasajes' : 'articulos',
        apiExternaUrl: fila.apiExternaUrl ? String(fila.apiExternaUrl).replace(/\/+$/, '') : null,
        apiExternaToken: fila.apiExternaToken || null,
        mensajeDerivacion: fila.mensajeDerivacion || null,
      };
    }
  } catch (err) {
    if (!/Could not find stored procedure/i.test(err.message)) throw err;
  }
  negocios.set(clienteId, { datos, hasta: Date.now() + NEGOCIO_CACHE_MS });
  return datos;
}

// Pausa el bot en un chat sin marcarlo como revisión humana (ej. derivación de una venta a una persona).
async function pausarChat(clienteId, userId, por) {
  await ejecutar('dbo.usp_Bot_ChatPausar', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
    por: [sql.NVarChar(255), String(por).slice(0, 255)],
  });
}

module.exports = { resolveClienteIdByPhone, resolverCliente, getContextoNegocio, getAprendizajes, getEmail, botPuedeResponder, guardarPhoneNumberId, getDatosEnvio, guardarNombrePerfil, minutosDesdeCliente, getNegocio, pausarChat };
