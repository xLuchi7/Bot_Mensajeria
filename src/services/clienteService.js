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

async function getContextoNegocio(clienteId) {
  const result = await ejecutar('dbo.usp_Bot_ClienteContexto', { clienteId: [sql.Int, clienteId] });
  return result.recordset[0]?.contextoNegocio ?? null;
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

module.exports = { resolveClienteIdByPhone, getContextoNegocio, getEmail, botPuedeResponder, guardarPhoneNumberId, getDatosEnvio, guardarNombrePerfil, minutosDesdeCliente };
