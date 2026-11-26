const config = require('../config');
const { ejecutar, sql } = require('./db');
const portalAviso = require('./portalAvisoService');

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
  const result = await ejecutar('dbo.usp_Bot_MensajesHistorial', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
    max: [sql.Int, config.conversation.maxHistory],
  });

  const historial = [];
  for (const { role, content } of result.recordset) {
    if (!content) continue;
    const ultimo = historial[historial.length - 1];
    if (ultimo && ultimo.role === role) ultimo.content += `\n\n${content}`;
    else if (historial.length || role === 'user') historial.push({ role, content });
  }
  return historial;
}

// Devuelve el id del mensaje guardado.
async function addMessage(clienteId, userId, role, content, platform, meta = {}) {
  const { inputTokens = null, outputTokens = null, esError = false, modelo = null, enviadoPor = null } = meta;
  const result = await ejecutar('dbo.usp_Bot_MensajeInsertar', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
    platform: [sql.NVarChar(20), platform],
    role: [sql.NVarChar(20), role],
    content: [sql.NVarChar(sql.MAX), content],
    inputTokens: [sql.Int, inputTokens],
    outputTokens: [sql.Int, outputTokens],
    esError: [sql.Bit, esError],
    modelo: [sql.NVarChar(50), modelo],
    enviadoPor: [sql.NVarChar(255), enviadoPor],
  });
  portalAviso.avisar(clienteId, 'mensaje', userId);
  return result.recordset[0]?.id ?? null;
}

module.exports = { getHistory, addMessage };
