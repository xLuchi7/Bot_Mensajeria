const crypto = require('crypto');
const config = require('../config');
const conversation = require('../services/conversationService');
const claude = require('../services/claudeService');
const meta = require('../services/metaService');
const cliente = require('../services/clienteService');
const dedupe = require('../services/dedupeService');
const escalamientos = require('../services/escalamientoService');
const revision = require('../services/revisionService');
const logs = require('../services/logService');
const cola = require('../services/colaChatService');
const portalAviso = require('../services/portalAvisoService');
const horario = require('../services/horarioService');

// Lo que va a Claude por mensaje: un texto gigante gasta tokens sin sumar nada.
const MAX_TEXTO_CLAUDE = 2000;
// El reclamo automático (PATRON_RECLAMO) se registra como mucho una vez cada 6 h por chat.
const RECLAMO_AUTO_CADA_MS = 6 * 60 * 60 * 1000;
const ultimoReclamoAuto = new Map(); // `${clienteId}:${userId}` -> ms
const ESPERA_DERIVACION_MS = 2500;

// Red de seguridad: si el modelo no llama a la tool escalar_a_humano pero el
// mensaje suena a reclamo, lo registramos igual — perder un reclamo real cuesta
// más que un falso positivo ocasional. Se salta si Claude ya consultó
// buscar_pedidos_cliente en esta respuesta: si miró los pedidos reales y decidió
// no escalar, confiamos en esa decisión informada en vez de pisarla con el regex
// (frases como "no me llegó" también valen para una simple consulta de estado).
const PATRON_RECLAMO = /reclamo|reclam[oó]|devoluci[oó]n|se rompi[oó]|lleg[oó] roto|lleg[oó] da[ñn]ado|no recib[ií]|no me lleg[oó]|no lleg[oó] (el|mi) pedido|problema con (mi|el) (pedido|compra|producto)/i;

// Igual idea que arriba pero para pedidos: acá NO auto-creamos nada (adivinar mal
// qué compró alguien es peor que no detectarlo), solo dejamos un log visible para
// revisar a mano y afinar el prompt si pasa seguido.
const PATRON_PEDIDO_CONFIRMADO = /pedido.*(confirmad|cread|registrad|list[oa])|#\d+.*(pedido|total)/i;

// GET /webhook — Meta hub verification handshake
function igualesSeguro(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = String(req.query['hub.challenge'] ?? '');

  // Sin META_VERIFY_TOKEN configurado no se verifica nada (antes undefined === undefined pasaba).
  if (!config.meta.verifyToken) {
    console.error('[verify] REJECTED: META_VERIFY_TOKEN no está configurado');
    return res.sendStatus(403);
  }
  const coincide = typeof token === 'string' && igualesSeguro(token, config.meta.verifyToken);
  console.log(`[verify] mode=${mode} token_match=${coincide}`);

  // El challenge de Meta es un número: se devuelve como texto plano (devolverlo
  // como HTML permitía inyectar código en el dominio del bot).
  if (mode === 'subscribe' && coincide && /^\d{1,64}$/.test(challenge)) {
    console.log('[verify] OK — webhook verified by Meta');
    return res.status(200).type('text/plain').send(challenge);
  }

  console.error('[verify] REJECTED: mode or verify_token mismatch');
  res.sendStatus(403);
}

// POST /webhook — incoming messages from Meta
async function handleMessage(req, res) {
  // Acknowledge immediately; Meta requires a 200 within 20 s
  res.sendStatus(200);

  const { object, entry } = req.body;

  if (!object || !Array.isArray(entry)) {
    console.warn('[webhook] Payload missing object or entry array');
    return;
  }

  console.log(`[webhook] Received event: object=${object} entries=${entry.length}`);

  for (const e of entry) {
    try {
      if (object === 'whatsapp_business_account') await processWhatsApp(e);
      else if (object === 'instagram') await processInstagram(e);
      else if (object === 'page') await processFacebook(e);
      else console.warn(`[webhook] Unknown object type: ${object}`);
    } catch (err) {
      console.error(`[webhook] Unhandled error processing ${object} entry:`, err.message);
    }
  }
}

// ── Platform handlers ────────────────────────────────────────────────────────

async function processWhatsApp(entry) {
  for (const change of entry.changes || []) {
    if (change.field === 'smb_message_echoes') {
      await procesarEcos(change.value || {});
      continue;
    }
    if (change.field !== 'messages') continue;

    const { metadata, messages = [], contacts = [], statuses = [] } = change.value || {};
    const phoneNumberId = metadata?.phone_number_id;
    const { clienteId, porTelefono } = await cliente.resolverCliente(phoneNumberId, metadata?.display_phone_number);

    if (!clienteId) {
      console.error(`[whatsapp] No hay Cliente registrado para el número ${metadata?.display_phone_number} — se ignoran sus mensajes`);
      continue;
    }

    // Estados de lo que mandamos (enviado / entregado / leído / falló).
    for (const st of statuses) {
      logs.registrar(st.status === 'failed' ? 'error' : 'info', `whatsapp_${st.status}`, {
        clienteId,
        userId: st.recipient_id,
        detalle: { waMessageId: st.id, estado: st.status, timestamp: st.timestamp, errores: st.errors, conversacion: st.conversation, precio: st.pricing },
      });
    }

    // Se encontró por el número visible (todavía no teníamos su phone_number_id):
    // se guarda para los próximos mensajes y para los envíos desde el Portal.
    if (messages.length && porTelefono) {
      await cliente.guardarPhoneNumberId(clienteId, phoneNumberId).catch(err =>
        console.error('[whatsapp] No se pudo guardar el phone_number_id:', err.message));
    }

    for (const msg of messages) {
      // Todo lo que se loguee mientras se procesa este mensaje (incluidos los
      // console.error de cualquier servicio) queda con su clienteId y userId.
      // Un error en un mensaje no corta los demás del mismo aviso.
      await logs.conContexto({ clienteId, userId: msg.from }, async () => {
        try {
          await procesarMensajeWhatsApp(clienteId, phoneNumberId, msg, contacts);
        } catch (err) {
          console.error(`[whatsapp] Error procesando el mensaje ${msg.id}:`, err?.stack || err?.message || err);
        }
      });
    }
  }
}

// Coexistencia (número usado a la vez en la app WhatsApp Business y en la API):
// lo que el negocio escribe desde el celular llega como "eco" (campo
// smb_message_echoes; hay que tenerlo suscripto en el webhook de la app de Meta).
// Se guarda en Mensajes como lo que manda una persona desde el Portal (role
// 'assistant' + enviadoPor), así se ve en el chat y el bot tiene el contexto, y si
// ese chat esperaba una persona pasa a "Atendido". El bot sigue pausado.
const ENVIADO_DESDE_CELULAR = 'Celular (WhatsApp Business)';

async function procesarEcos({ metadata, message_echoes: ecos = [] }) {
  if (!ecos.length) return;
  const { clienteId } = await cliente.resolverCliente(metadata?.phone_number_id, metadata?.display_phone_number);
  if (!clienteId) {
    console.error(`[whatsapp] Eco de un número sin Cliente registrado (${metadata?.display_phone_number}) — se ignora`);
    return;
  }

  for (const eco of ecos) {
    const userId = eco.to;
    if (!userId) continue;
    await logs.conContexto({ clienteId, userId }, async () => {
      if (await dedupe.yaFueProcesado(eco.id)) return;

      const texto = eco.type === 'text' ? eco.text?.body : null;
      logs.info('mensaje_desde_celular', { detalle: { waMessageId: eco.id, tipo: eco.type, texto, timestamp: eco.timestamp } });
      if (texto) {
        await conversation.addMessage(clienteId, userId, 'assistant', texto, 'whatsapp', { enviadoPor: ENVIADO_DESDE_CELULAR });
      }
      await revision.atender(clienteId, userId, ENVIADO_DESDE_CELULAR);
    });
  }
}

async function procesarMensajeWhatsApp(clienteId, phoneNumberId, msg, contacts) {
  const userId = msg.from;
  const nombrePerfil = contacts.find(c => c.wa_id === userId)?.profile?.name;

  if (msg.type !== 'text') {
    console.log(`[whatsapp] Ignored non-text message type: ${msg.type}`);
    logs.info('mensaje_no_texto', { detalle: { waMessageId: msg.id, tipo: msg.type, nombrePerfil, contenido: msg[msg.type] ?? null } });
    return;
  }

  if (await dedupe.yaFueProcesado(msg.id)) {
    console.log(`[whatsapp] Mensaje duplicado ignorado: ${msg.id}`);
    logs.info('mensaje_duplicado', { detalle: { waMessageId: msg.id } });
    return;
  }

  const text = msg.text?.body;
  if (!text) return;

  console.log(`[whatsapp] Message from ${userId}: "${text.slice(0, 60)}"`);
  logs.info('mensaje_recibido', { detalle: { waMessageId: msg.id, texto: text, nombrePerfil, timestamp: msg.timestamp, phoneNumberId } });

  // Bot apagado (general o para este chat): guardamos el mensaje igual para
  // que el Cliente lo vea en el Portal, pero no llamamos a Claude ni respondemos.
  const estadoBot = await cliente.botPuedeResponder(clienteId, userId);

  // Nombre que la persona tiene en su perfil de WhatsApp (la API no da la foto
  // ni cómo la tiene agendada el negocio). botPuedeResponder ya creó la fila en Chats.
  if (nombrePerfil) {
    await cliente.guardarNombrePerfil(clienteId, userId, nombrePerfil).catch(err =>
      console.error('[whatsapp] No se pudo guardar el nombre de perfil:', err.message));
  }

  // El mensaje se guarda siempre al llegar (lo ve el portal), responda o no el bot.
  const mensajeId = await conversation.addMessage(clienteId, userId, 'user', text, 'whatsapp');

  if (!estadoBot.puede) {
    console.log(`[whatsapp] Sin respuesta a ${userId}: ${estadoBot.motivo}`);
    logs.info('bot_no_responde', { detalle: { motivo: estadoBot.motivo, waMessageId: msg.id } });
    return;
  }

  // Fuera del horario de atención del Cliente: queda guardado y se responde a la hora de
  // apertura (horarioService levanta de Mensajes todo lo que quedó sin responder).
  if (!(await horario.estaAbierto(clienteId))) {
    console.log(`[whatsapp] Fuera de horario: ${userId} queda para la apertura`);
    logs.info('fuera_de_horario', { detalle: { waMessageId: msg.id } });
    return;
  }

  const clave = `${clienteId}:${userId}`;
  if (!cola.dentroDelLimite(clave)) {
    console.warn(`[whatsapp] ${userId} superó el límite de mensajes: no se responde (el mensaje quedó guardado).`);
    logs.warn('rate_limit', { detalle: { waMessageId: msg.id } });
    return;
  }

  // Se responde después de una pausa corta, juntando los mensajes seguidos (ver colaChatService).
  cola.agendar(clave, { id: mensajeId, texto: text, waMessageId: msg.id }, (lote, marcarLeido) =>
    logs.conContexto({ clienteId, userId }, () => responderLote(clienteId, phoneNumberId, userId, lote, marcarLeido)));
}

// A la hora de apertura: los mensajes que llegaron con el negocio cerrado entran a la cola
// del chat como si recién llegaran (si en ese momento escribe algo nuevo, se junta todo).
function responderPendientes(clienteId, phoneNumberId, userId, items) {
  const clave = `${clienteId}:${userId}`;
  for (const item of items) {
    cola.agendar(clave, item, (lote, marcarLeido) =>
      logs.conContexto({ clienteId, userId }, () => responderLote(clienteId, phoneNumberId, userId, lote, marcarLeido)));
  }
}

// Responde de una vez a los mensajes juntados de un chat.
async function responderLote(clienteId, phoneNumberId, userId, lote, marcarLeido) {
  // Pudieron apagar el bot (o atender el chat a mano) mientras se juntaban.
  const estadoBot = await cliente.botPuedeResponder(clienteId, userId);
  if (!estadoBot.puede) {
    logs.info('bot_no_responde', { detalle: { motivo: estadoBot.motivo, mensajes: lote.length } });
    return;
  }

  const text = lote.map(m => m.texto).join('\n');
  const ultimo = lote.findLast(m => m.waMessageId);
  const fueraDeHorario = lote.some(m => m.fueraDeHorario);
  const inicio = Date.now();
  // Los pendientes de la noche no tienen el id de WhatsApp (no se guarda en Mensajes).
  if (ultimo) await meta.sendTypingIndicator(phoneNumberId, ultimo.waMessageId);
  const respuesta = await buildReply(clienteId, 'whatsapp', userId, text, { marcarLeido, fueraDeHorario });
  if (respuesta === null) return;
  // Derivación de una venta (pasajes): el mensaje es siempre el mismo y sale al instante; se
  // espera un poco con el "escribiendo..." prendido para que no parezca automático.
  if (respuesta.derivacion) await new Promise(r => setTimeout(r, ESPERA_DERIVACION_MS));
  // Falló Claude: no se le manda nada al cliente, solo el aviso al negocio.
  if (!respuesta.text) {
    if (respuesta.revisionHumana) await revision.alertar(phoneNumberId, clienteId, userId, respuesta.revisionHumana, text);
    return;
  }
  await enviarFotos(phoneNumberId, userId, respuesta.fotos);
  await meta.sendWhatsAppMessage(phoneNumberId, userId, respuesta.text);
  console.log(`[whatsapp] Reply sent to ${userId}`);
  // Resumen de toda la respuesta: lo que costó en total está acá en el detalle (el
  // costo por llamada, en las filas 'claude_llamada').
  logs.info('respuesta_enviada', {
    duracionMs: Date.now() - inicio,
    detalle: {
      texto: respuesta.text,
      mensajesJuntados: lote.length,
      fueraDeHorario,
      fotos: respuesta.fotos.reduce((n, f) => n + f.urls.length, 0),
      modelo: respuesta.modelo ?? null,
      inputTokens: respuesta.inputTokens ?? 0,
      outputTokens: respuesta.outputTokens ?? 0,
      costoUsdTotal: respuesta.costoUsd ?? null,
      revisionHumana: respuesta.revisionHumana,
    },
  });

  // El cliente ya recibió "esperame que lo consulto": ahora el aviso al número de alertas.
  if (respuesta.revisionHumana) {
    await revision.alertar(phoneNumberId, clienteId, userId, respuesta.revisionHumana, text);
  }
}

async function processInstagram(entry) {
  // TODO: resolver ClienteId para Instagram (todavía no hay columna para mapear pageId -> Cliente)
  console.warn('[instagram] Soporte multi-cliente pendiente — se ignoran los mensajes por ahora');
}

async function processFacebook(entry) {
  // TODO: resolver ClienteId para Facebook (todavía no hay columna para mapear pageId -> Cliente)
  console.warn('[facebook] Soporte multi-cliente pendiente — se ignoran los mensajes por ahora');
}

// ── Shared core ──────────────────────────────────────────────────────────────

// Claude tarda unos segundos: si en ese rato apagaron el bot desde el Portal, la
// respuesta (o el mensaje de error) se descarta en vez de mandarse.
async function seApagoMientrasTanto(clienteId, userId) {
  const estadoBot = await cliente.botPuedeResponder(clienteId, userId);
  if (estadoBot.puede) return false;
  console.log(`[claude] Respuesta descartada para ${userId}: ${estadoBot.motivo} mientras se generaba`);
  return true;
}

// De a una y en orden (si se mandan en paralelo WhatsApp las puede mezclar). Si
// una falla (ej. URL caída) se sigue con las demás y con el texto igual.
async function enviarFotos(phoneNumberId, userId, fotos = []) {
  for (const { nombre, urls } of fotos) {
    for (const [i, url] of urls.entries()) {
      try {
        await meta.sendWhatsAppImage(phoneNumberId, userId, url, i === 0 ? nombre : undefined);
      } catch (err) {
        console.error(`[whatsapp] No se pudo mandar una foto de "${nombre}" a ${userId}:`, err.message);
      }
    }
  }
}

// Nota que queda en el historial (y se ve en el Portal) para que Claude sepa
// qué fotos ya mandó y no las repita.
function notaFotos(fotos) {
  return fotos.map(f => `(Se ${f.urls.length === 1 ? 'envió 1 foto' : `enviaron ${f.urls.length} fotos`} de «${f.nombre}»)`).join('\n');
}

// Mensajes muy largos del cliente: a Claude le llega el principio (en la base y
// en el portal queda completo).
function recortarHistorial(history) {
  return history.map(m => (m.role === 'user' && typeof m.content === 'string' && m.content.length > MAX_TEXTO_CLAUDE
    ? { ...m, content: `${m.content.slice(0, MAX_TEXTO_CLAUDE)}… (mensaje recortado)` }
    : m));
}

// Pasajes: después de la Reserva Bot el chat lo sigue la persona que asignó el sistema
// externo (Derivación de Ventas). Se pausa el bot SIN marcar revisión humana; el sistema
// lo reactiva al vender o liberar la reserva. Nunca tira error: el mensaje sale igual.
async function derivarVenta(clienteId, userId, derivacion) {
  try {
    await cliente.pausarChat(clienteId, userId, `Bot (venta derivada a ${derivacion.asignadaA || 'sin asignar'}, Reserva Bot N° ${derivacion.idReserva})`);
    portalAviso.avisar(clienteId, 'chat', userId);
  } catch (err) {
    console.error(`[pasajes] No se pudo pausar el chat ${userId} después de la reserva:`, err.message);
  }
}

function reclamoAutoPermitido(clienteId, userId) {
  const clave = `${clienteId}:${userId}`;
  const ultimo = ultimoReclamoAuto.get(clave) || 0;
  if (Date.now() - ultimo < RECLAMO_AUTO_CADA_MS) return false;
  ultimoReclamoAuto.set(clave, Date.now());
  if (ultimoReclamoAuto.size > 5000) ultimoReclamoAuto.delete(ultimoReclamoAuto.keys().next().value);
  return true;
}

// Devuelve { text, fotos, revisionHumana } a enviar, o null si el bot se apagó mientras se generaba.
// El mensaje del cliente ya está guardado (procesarMensajeWhatsApp). `text` son
// los mensajes juntados, para las detecciones; Claude los ve en el historial.
async function buildReply(clienteId, platform, userId, text, { marcarLeido, fueraDeHorario = false } = {}) {
  // Pide una persona o está insultando (y en pasajes, cualquier reclamo): sin pasar por
  // Claude, se pausa el chat y se le pide que espere (ver revisionService).
  const negocio = await cliente.getNegocio(clienteId);
  const esPasajes = negocio.tipoNegocio === 'pasajes';
  const detectado = revision.detectar(text, { pasajes: esPasajes });
  if (detectado) {
    await revision.activar(clienteId, userId, detectado, text);
    await conversation.addMessage(clienteId, userId, 'assistant', revision.MENSAJE_ESPERA, platform);
    return { text: revision.MENSAJE_ESPERA, fotos: [], revisionHumana: detectado };
  }

  try {
    const history = recortarHistorial(await conversation.getHistory(clienteId, userId));
    marcarLeido?.();
    console.log(`[claude] Calling API for ${platform} user ${userId} (history: ${history.length} msgs)`);
    const { text: reply, fotos, inputTokens, outputTokens, costoUsd, escalado, pedidoCreado, consultoPedidos, revisionHumana, derivacion } = await claude.generateResponse(clienteId, userId, history, { fueraDeHorario });
    // La reserva ya está hecha en el sistema externo: aunque hayan apagado el bot mientras tanto,
    // el cliente tiene que enterarse de que tiene el lugar guardado.
    if (!derivacion && await seApagoMientrasTanto(clienteId, userId)) return null;
    if (revisionHumana) await revision.activar(clienteId, userId, revisionHumana, text);
    if (derivacion) await derivarVenta(clienteId, userId, derivacion);
    if (fotos.length) {
      await conversation.addMessage(clienteId, userId, 'assistant', notaFotos(fotos), platform);
    }
    await conversation.addMessage(clienteId, userId, 'assistant', reply, platform, {
      inputTokens,
      outputTokens,
      modelo: config.anthropic.model,
    });
    console.log(`[claude] Response for ${userId}: "${reply.slice(0, 80)}" (tokens in=${inputTokens} out=${outputTokens})`);

    // Pasajes no usa Escalamientos: sus reclamos ya pasaron a revisión humana (regex de arriba o la tool).
    if (!esPasajes && !escalado && !consultoPedidos && !revisionHumana && PATRON_RECLAMO.test(text) && reclamoAutoPermitido(clienteId, userId)) {
      console.warn(`[escalamiento] Fallback disparado — Claude no llamó la tool pero el mensaje parece un reclamo: "${text.slice(0, 80)}"`);
      await escalamientos.registrarEscalamiento(clienteId, userId, `[Auto-detectado] "${text.slice(0, 200)}"`);
      logs.warn('escalamiento_auto', { detalle: { mensaje: text } });
    }

    if (!pedidoCreado && PATRON_PEDIDO_CONFIRMADO.test(reply)) {
      console.warn(`[pedido] Posible pedido "fantasma" — la respuesta suena a confirmación pero no se llamó crear_pedido: "${reply.slice(0, 80)}"`);
    }

    return { text: reply, fotos, revisionHumana, derivacion, modelo: config.anthropic.model, inputTokens, outputTokens, costoUsd };
  } catch (err) {
    // Antes acá se borraba todo el historial del número (DELETE en Mensajes) para
    // "resetear" la conversación, pero Mensajes es también el historial que ve el
    // Portal y se perdía el chat entero. Ya no hace falta: getHistory() deja afuera
    // los mensajes de error y arma un historial válido aunque haya filas raras.
    // Al cliente NUNCA se le manda un mensaje de error: no sale nada, el chat pasa a
    // Atención Humana (bot pausado) y se avisa al número de alertas para que lo
    // responda una persona.
    console.error(`[claude] API error for ${userId}:`, err.message);
    logs.error('claude_error', { clienteId, userId, detalle: err.message });
    if (await seApagoMientrasTanto(clienteId, userId)) return null;
    const datos = { tipo: 'error_bot', motivo: String(err.message || 'Error al generar la respuesta').slice(0, 300) };
    await revision.activar(clienteId, userId, datos, text);
    return { text: null, fotos: [], revisionHumana: datos };
  }
}

module.exports = { verify, handleMessage, responderPendientes };
