const crypto = require('crypto');
const { Router } = require('express');
const config = require('../config');
const meta = require('../services/metaService');
const cliente = require('../services/clienteService');
const conversation = require('../services/conversationService');
const { getPool, sql } = require('../services/db');

// Endpoints que usa Portal_Mensajeria. El token de WhatsApp vive solo acá: el
// Portal no habla con Meta, le pide al bot que mande el mensaje.
const router = Router();

const VENTANA_HORAS = 24; // WhatsApp solo deja mandar texto libre hasta 24 h después del último mensaje del cliente
const MAX_LARGO = 4096; // límite de la Cloud API para un mensaje de texto

function autorizado(req) {
  const esperado = config.portal.apiToken;
  const recibido = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!esperado || !recibido) return false;
  const a = Buffer.from(esperado);
  const b = Buffer.from(recibido);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  if (!config.portal.apiToken) return res.status(503).json({ ok: false, error: 'sin_configurar' });
  if (!autorizado(req)) return res.status(401).json({ ok: false, error: 'no_autorizado' });
  next();
});

// POST /portal/enviar { clienteId, userId, texto, enviadoPor }
// Manda un mensaje escrito por una persona del negocio y lo guarda en Mensajes
// (role 'assistant' + enviadoPor) para que el bot tenga el contexto si se reactiva.
router.post('/enviar', async (req, res) => {
  const clienteId = parseInt(req.body?.clienteId, 10);
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
  const texto = typeof req.body?.texto === 'string' ? req.body.texto.trim() : '';
  const enviadoPor = typeof req.body?.enviadoPor === 'string' ? req.body.enviadoPor.slice(0, 255) : null;

  if (!clienteId || !userId || !texto || texto.length > MAX_LARGO) {
    return res.status(400).json({ ok: false, error: 'datos_invalidos' });
  }

  try {
    const datos = await cliente.getDatosEnvio(clienteId);
    if (!datos || !datos.activo) return res.status(404).json({ ok: false, error: 'cliente_inexistente' });
    if (!datos.whatsappPhoneNumberId) return res.status(409).json({ ok: false, error: 'sin_numero' });

    // Solo se responde a chats que ya existen: el Portal no puede escribirle a
    // cualquier número. Y de paso se chequea la ventana de 24 h.
    const pool = await getPool();
    const chat = await pool
      .request()
      .input('clienteId', sql.Int, clienteId)
      .input('userId', sql.NVarChar, userId)
      .query(`
        SELECT DATEDIFF(MINUTE, MAX(createdAt), SYSUTCDATETIME()) AS minutos
        FROM Mensajes
        WHERE clienteId = @clienteId AND userId = @userId AND role = 'user'
      `);
    const minutos = chat.recordset[0]?.minutos;
    if (minutos == null) return res.status(404).json({ ok: false, error: 'chat_inexistente' });
    if (minutos >= VENTANA_HORAS * 60) return res.status(409).json({ ok: false, error: 'fuera_de_ventana' });

    try {
      await meta.sendWhatsAppMessage(datos.whatsappPhoneNumberId, userId, texto);
    } catch (err) {
      const codigo = err.response?.data?.error?.code;
      // 131047: pasaron más de 24 h (re-engagement). Por si el reloj de la base y el de Meta no coinciden.
      if (codigo === 131047) return res.status(409).json({ ok: false, error: 'fuera_de_ventana' });
      return res.status(502).json({ ok: false, error: 'whatsapp_error' });
    }

    await conversation.addMessage(clienteId, userId, 'assistant', texto, 'whatsapp', { enviadoPor });
    console.log(`[portal] Mensaje manual enviado a ${userId} (cliente ${clienteId}) por ${enviadoPor || 'desconocido'}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[portal] Error enviando mensaje manual:', err.message);
    res.status(500).json({ ok: false, error: 'error_interno' });
  }
});

// POST /portal/plantilla { clienteId, userId, plantilla, idioma, parametros, texto, enviadoPor }
// Avisos automáticos del Portal (pedido despachado, pago recibido…) fuera de la
// ventana de 24 h: van como plantilla aprobada por Meta. `texto` es cómo quedó
// el mensaje armado, para guardarlo en Mensajes y que se vea en el chat.
router.post('/plantilla', async (req, res) => {
  const clienteId = parseInt(req.body?.clienteId, 10);
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
  const plantilla = typeof req.body?.plantilla === 'string' ? req.body.plantilla.trim() : '';
  const idioma = typeof req.body?.idioma === 'string' && req.body.idioma.trim() ? req.body.idioma.trim() : 'es_AR';
  const parametros = Array.isArray(req.body?.parametros) ? req.body.parametros.map(p => String(p ?? '').slice(0, 1000)) : [];
  const texto = typeof req.body?.texto === 'string' ? req.body.texto.trim().slice(0, MAX_LARGO) : '';
  const enviadoPor = typeof req.body?.enviadoPor === 'string' ? req.body.enviadoPor.slice(0, 255) : null;

  if (!clienteId || !userId || !/^[a-z0-9_]{1,512}$/.test(plantilla) || parametros.length > 10) {
    return res.status(400).json({ ok: false, error: 'datos_invalidos' });
  }

  try {
    const datos = await cliente.getDatosEnvio(clienteId);
    if (!datos || !datos.activo) return res.status(404).json({ ok: false, error: 'cliente_inexistente' });
    if (!datos.whatsappPhoneNumberId) return res.status(409).json({ ok: false, error: 'sin_numero' });

    // Igual que /enviar: solo a personas que ya le escribieron a este Cliente.
    const pool = await getPool();
    const chat = await pool
      .request()
      .input('clienteId', sql.Int, clienteId)
      .input('userId', sql.NVarChar, userId)
      .query("SELECT TOP 1 1 AS existe FROM Mensajes WHERE clienteId = @clienteId AND userId = @userId AND role = 'user'");
    if (!chat.recordset.length) return res.status(404).json({ ok: false, error: 'chat_inexistente' });

    try {
      await meta.sendWhatsAppTemplate(datos.whatsappPhoneNumberId, userId, plantilla, idioma, parametros);
    } catch (err) {
      const detalle = err.response?.data?.error?.message || err.message;
      return res.status(502).json({ ok: false, error: 'plantilla_error', detalle });
    }

    await conversation.addMessage(clienteId, userId, 'assistant', texto || `[Plantilla ${plantilla}]`, 'whatsapp', { enviadoPor });
    console.log(`[portal] Plantilla ${plantilla} enviada a ${userId} (cliente ${clienteId})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[portal] Error enviando plantilla:', err.message);
    res.status(500).json({ ok: false, error: 'error_interno' });
  }
});

module.exports = router;
