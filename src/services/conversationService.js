const config = require('../config');
const { getPool, sql } = require('./db');

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
        WHERE clienteId = @clienteId AND userId = @userId
        ORDER BY id DESC
      ) recent
      ORDER BY id ASC
    `);

  return result.recordset.map(({ role, content }) => ({ role, content }));
}

async function addMessage(clienteId, userId, role, content, platform, meta = {}) {
  const pool = await getPool();
  const { inputTokens = null, outputTokens = null, esError = false, modelo = null } = meta;

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
    .query(`
      INSERT INTO Mensajes (clienteId, userId, platform, role, content, inputTokens, outputTokens, esError, modelo)
      VALUES (@clienteId, @userId, @platform, @role, @content, @inputTokens, @outputTokens, @esError, @modelo)
    `);
}

async function clearHistory(clienteId, userId) {
  const pool = await getPool();
  await pool
    .request()
    .input('clienteId', sql.Int, clienteId)
    .input('userId', sql.NVarChar, userId)
    .query('DELETE FROM Mensajes WHERE clienteId = @clienteId AND userId = @userId');
}

module.exports = { getHistory, addMessage, clearHistory };
