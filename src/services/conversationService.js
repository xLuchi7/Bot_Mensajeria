const config = require('../config');
const { getPool, sql } = require('./db');

// Historial para Claude: los últimos MAX_HISTORY mensajes de ese número.
// - Se excluyen los mensajes de error (esError = 1): son avisos genéricos que no
//   aportan contexto y antes eran la razón por la que se borraba el historial.
// - Los mensajes que mandó una persona desde el Portal (enviadoPor) se guardan como
//   role 'assistant', así Claude los toma como dichos por el negocio y tiene el
//   contexto completo cuando se reactiva el bot en ese chat.
// - Con el bot pausado entran varios mensajes seguidos del cliente sin respuesta:
//   se unen los consecutivos del mismo role y se descarta lo que quede antes del
//   primer mensaje del cliente, para que la API siempre reciba user/assistant
//   alternados y empezando por user.
async function getHistory(clienteId, userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('userId', sql.NVarChar, userId)
    .input('max', sql.Int, config.conversation.maxHistory)
    .query(`
      SELECT role, content FROM (
        SELECT TOP (@max) id, role, content
        FROM Mensajes
        WHERE clienteId = @clienteId AND userId = @userId AND esError = 0
        ORDER BY id DESC
      ) recent
      ORDER BY id ASC
    `);

  const historial = [];
  for (const { role, content } of result.recordset) {
    if (!content) continue;
    const ultimo = historial[historial.length - 1];
    if (ultimo && ultimo.role === role) ultimo.content += `\n\n${content}`;
    else if (historial.length || role === 'user') historial.push({ role, content });
  }
  return historial;
}

async function addMessage(clienteId, userId, role, content, platform, meta = {}) {
  const pool = await getPool();
  const { inputTokens = null, outputTokens = null, esError = false, modelo = null, enviadoPor = null } = meta;

  await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('userId', sql.NVarChar, userId)
    .input('platform', sql.NVarChar, platform)
    .input('role', sql.NVarChar, role)
    .input('content', sql.NVarChar(sql.MAX), content)
    .input('inputTokens', sql.Int, inputTokens)
    .input('outputTokens', sql.Int, outputTokens)
    .input('esError', sql.Bit, esError)
    .input('modelo', sql.NVarChar, modelo)
    .input('enviadoPor', sql.NVarChar, enviadoPor)
    .query(`
      INSERT INTO Mensajes (clienteId, userId, platform, role, content, inputTokens, outputTokens, esError, modelo, enviadoPor)
      VALUES (@clienteId, @userId, @platform, @role, @content, @inputTokens, @outputTokens, @esError, @modelo, @enviadoPor)
    `);
}

module.exports = { getHistory, addMessage };
