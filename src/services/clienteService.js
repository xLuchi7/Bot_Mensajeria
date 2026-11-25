const { getPool, sql } = require('./db');

// Clientes.Telefono se guarda solo con dígitos (sin +, espacios ni guiones)
function normalizePhone(phoneNumber) {
  return (phoneNumber || '').replace(/\D/g, '');
}

async function resolveClienteIdByPhone(phoneNumber) {
  const telefono = normalizePhone(phoneNumber);
  if (!telefono) return null;

  const pool = await getPool();
  const result = await pool
    .request()
    .input('telefono', sql.NVarChar, telefono)
    .query('SELECT id FROM Clientes WHERE telefono = @telefono AND activo = 1');

  return result.recordset[0]?.id ?? null;
}

async function getContextoNegocio(clienteId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .query('SELECT contextoNegocio FROM Clientes WHERE id = @clienteId');

  return result.recordset[0]?.contextoNegocio ?? null;
}

async function getEmail(clienteId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .query('SELECT email FROM Clientes WHERE id = @clienteId');

  return result.recordset[0]?.email ?? null;
}

// Interruptores que maneja el Cliente desde el Portal: Clientes.botActivo apaga el
// bot para todos sus chats y Chats.botActivo lo pausa para un número puntual. Se
// lee en cada mensaje, sin caché, para que apagarlo desde el Portal corte las
// respuestas al instante.
//
// La primera vez que escribe un número se le crea su fila en Chats: si es un número
// nuevo (sin Mensajes previos) arranca con Clientes.botChatsNuevosActivo; si ya
// venía conversando de antes de que existiera Chats, queda activo como estaba. Así
// cambiar ese default nunca toca chats que ya existen. La carrera entre dos mensajes
// simultáneos del mismo número la resuelve el UNIQUE (clienteId, userId).
async function botPuedeResponder(clienteId, userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('userId', sql.NVarChar, userId)
    .query(`
      IF NOT EXISTS (SELECT 1 FROM Chats WHERE clienteId = @clienteId AND userId = @userId)
      BEGIN TRY
        INSERT INTO Chats (clienteId, userId, botActivo)
        SELECT c.id, @userId,
          CASE WHEN EXISTS (SELECT 1 FROM Mensajes m WHERE m.clienteId = c.id AND m.userId = @userId)
               THEN 1 ELSE c.botChatsNuevosActivo END
        FROM Clientes c
        WHERE c.id = @clienteId;
      END TRY
      BEGIN CATCH
        IF ERROR_NUMBER() NOT IN (2601, 2627) THROW;
      END CATCH;

      SELECT c.botActivo AS general, ISNULL(ch.botActivo, 1) AS chat
      FROM Clientes c
      LEFT JOIN Chats ch ON ch.clienteId = c.id AND ch.userId = @userId
      WHERE c.id = @clienteId
    `);

  const fila = result.recordset[0];
  if (!fila) return { puede: false, motivo: 'Cliente inexistente' };
  if (!fila.general) return { puede: false, motivo: 'bot apagado para todo el Cliente' };
  if (!fila.chat) return { puede: false, motivo: 'bot pausado para este chat' };
  return { puede: true };
}

// El phone_number_id (lo que pide la Cloud API para enviar) solo llega en el
// webhook: lo guardamos para poder mandar mensajes iniciados desde el Portal.
// El WHERE evita escribir en cada mensaje si no cambió.
async function guardarPhoneNumberId(clienteId, phoneNumberId) {
  if (!phoneNumberId) return;
  const pool = await getPool();
  await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('phoneNumberId', sql.NVarChar, String(phoneNumberId))
    .query(`
      UPDATE Clientes SET whatsappPhoneNumberId = @phoneNumberId
      WHERE id = @clienteId AND (whatsappPhoneNumberId IS NULL OR whatsappPhoneNumberId <> @phoneNumberId)
    `);
}

async function getDatosEnvio(clienteId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .query('SELECT activo, whatsappPhoneNumberId FROM Clientes WHERE id = @clienteId');
  return result.recordset[0] ?? null;
}

// El WHERE evita escribir en cada mensaje si el nombre no cambió.
async function guardarNombrePerfil(clienteId, userId, nombrePerfil) {
  const pool = await getPool();
  await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('userId', sql.NVarChar, userId)
    .input('nombrePerfil', sql.NVarChar, String(nombrePerfil).slice(0, 200))
    .query(`
      UPDATE Chats SET nombrePerfil = @nombrePerfil
      WHERE clienteId = @clienteId AND userId = @userId
        AND (nombrePerfil IS NULL OR nombrePerfil <> @nombrePerfil)
    `);
}

module.exports = { resolveClienteIdByPhone, getContextoNegocio, getEmail, botPuedeResponder, guardarPhoneNumberId, getDatosEnvio, guardarNombrePerfil };
