const config = require('../config');
const { ejecutar, sql } = require('./db');
const meta = require('./metaService');
const logs = require('./logService');
const portalAviso = require('./portalAvisoService');

// "Revisión humana": cuando alguien pide hablar con una persona o se pone agresivo,
// el bot le contesta MENSAJE_ESPERA, se pausa en ese chat (Chats.botActivo = 0 +
// Chats.revisionHumana = 1, que el Portal muestra como alerta) y le avisa por
// WhatsApp al número de alertas del Cliente (Clientes.telefonoAlertas, se cambia
// desde Mi Negocio en el Portal). Vuelve a responder cuando lo reactivan desde el Portal.

const MENSAJE_ESPERA = 'Esperame un momento que lo estoy consultando y enseguida te respondo.';

const TIPOS = {
  pide_persona: 'pidió hablar con una persona',
  agresion: 'está insultando o muy enojado',
  accion_equipo: 'pidió algo que solo puede hacer el equipo (cancelar o modificar un pedido)',
  error_bot: 'quedó sin respuesta por un error del bot',
  reclamo: 'tiene un reclamo o un problema con un viaje o pasaje',
};

// Red de seguridad antes de llamar a Claude: si el texto es claro, no gastamos
// tokens ni dependemos de que el modelo llame a la tool. Se compara sin tildes,
// en minúscula y con letras estiradas recortadas ("boludooo" -> "boludo").
const PATRON_PIDE_PERSONA = new RegExp([
  String.raw`\b(hablar|hablo|comunicarme|comunicar|pasame|pasarme|pasas|me pasas|atender|atenderme|atienda|derivame|derivar)\b.{0,40}\b(persona|humano|humana|alguien|operador|operadora|asesor|asesora|vendedor|vendedora|encargado|encargada|dueno|duena|gerente|responsable|empleado|empleada)\b`,
  String.raw`\b(persona real|un humano|una humana|alguien real|una persona de verdad|no quiero hablar con (un|una) (bot|robot|maquina|ia))\b`,
].join('|'), 'i');

const PATRON_AGRESION = new RegExp(String.raw`\b(` + [
  'bolud[oa]s?', 'pelotud[oa]s?', 'conchud[oa]s?', 'la concha (de )?(tu|su|la) (madre|hermana)', 'la concha de la lora',
  'hij[oa]s? de (re ?)?puta', 'hdp', 'la (re ?)?puta que (te|los|les) pario', 'put[oa]s?', 'mierda', 'sorete',
  'idiotas?', 'imbecil(es)?', 'estupid[oa]s?', 'tarad[oa]s?', 'mogolic[oa]s?', 'inutil(es)?', 'pajer[oa]s?',
  'garcas?', 'chorr[oa]s?', 'estafador(es|a|as)?', 'ladron(es)?', 'chupame', 'andate a la mierda', 'cagad[oa]s?',
].join('|') + String.raw`)\b`, 'i');

// Cancelar/anular un pedido, una compra o una reserva: el bot no puede hacerlo, así
// que va directo a una persona ("cancelenlo", "quiero cancelar mi pedido", "anulen la compra").
// Prefiere el falso positivo (lo mira una persona) a que el bot siga respondiendo.
const PATRON_ACCION_EQUIPO = new RegExp([
  String.raw`\bcancel(a|ar|e|en|o)(lo|la|los|las|me|melo|mela)?\b`,
  String.raw`\b(anul(a|ar|e|en)(lo|la|los|las|me)?|(dar|dame|denme|den|dan|das|des|darme|darlo|darla) de baja)\b.{0,40}\b(pedido|compra|orden|reserva|pasajes?)\b`,
].join('|'), 'i');

// Perfil pasajes: TODO reclamo va directo a una persona (revisión humana), nunca a un Escalamiento.
// Se compara sobre el texto normalizado (sin tildes). Prefiere el falso positivo: lo mira una persona.
const PATRON_RECLAMO_PASAJES = new RegExp([
  String.raw`\b(reclamo|reclamos|reclamar|reclamarles|queja|quejas|quejarme|denuncia|denunciar|defensa del consumidor)\b`,
  String.raw`\b(devolucion|devuelvan|devolver(me)?|reintegro|reembolso)\b`,
  String.raw`\b(me cobraron|cobraron (de mas|mal|dos veces)|cobro (de mas|mal|doble))\b`,
  String.raw`\b(no (salio|paso|vino|llego|aparecio) el (colectivo|micro|bondi|coche|chofer))\b`,
  String.raw`\b(me dejo (el|en) (colectivo|micro|bondi)|me dejaron (a pie|en|tirad[oa]))\b`,
  String.raw`\b(perdi|perdieron|rompieron|se perdio|me robaron)\b.{0,30}\b(valija|equipaje|bolso|mochila|maleta|encomienda)\b`,
  String.raw`\b(mal(isimo)? servicio|pesimo|pesima atencion|una verguenza|vergonzoso|maltrat(o|aron|ado))\b`,
].join('|'), 'i');

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\w)\1{2,}/g, '$1');
}

/** opciones.pasajes: también detecta reclamos (Aguirre: un reclamo siempre lo atiende una persona) */
/** @returns {{tipo: string, motivo: string} | null} */
function detectar(texto, { pasajes = false } = {}) {
  const t = normalizar(texto);
  if (PATRON_AGRESION.test(t)) return { tipo: 'agresion', motivo: 'Mensaje con insultos o agresivo (detectado automáticamente)' };
  if (PATRON_PIDE_PERSONA.test(t)) return { tipo: 'pide_persona', motivo: 'Pidió hablar con una persona (detectado automáticamente)' };
  if (PATRON_ACCION_EQUIPO.test(t)) return { tipo: 'accion_equipo', motivo: 'Pidió cancelar un pedido o compra (detectado automáticamente)' };
  if (pasajes && PATRON_RECLAMO_PASAJES.test(t)) return { tipo: 'reclamo', motivo: 'Mensaje con un reclamo (detectado automáticamente)' };
  return null;
}

// Pausa el bot en el chat y lo marca para revisión. La fila de Chats ya existe
// (la crea botPuedeResponder con el primer mensaje), igual se cubre el caso.
// Nunca tira error: si la base falla, el cliente igual recibe el "esperame" y sale la alerta.
async function activar(clienteId, userId, datos, textoCliente) {
  try {
    await marcar(clienteId, userId, datos, textoCliente);
    portalAviso.avisar(clienteId, 'revision', userId);
    return true;
  } catch (err) {
    console.error(`[revision] No se pudo marcar el chat ${userId} (cliente ${clienteId}):`, err.message);
    // Lo importante es que el bot deje de responder: si falló la marca (ej. faltan
    // las columnas revisionHumana*), al menos se pausa el chat.
    try {
      await ejecutar('dbo.usp_Bot_ChatPausar', {
        clienteId: [sql.Int, clienteId],
        userId: [sql.NVarChar(100), userId],
        por: [sql.NVarChar(255), 'Bot (humano solicitado)'],
      });
      portalAviso.avisar(clienteId, 'chat', userId);
      return true;
    } catch (err2) {
      console.error(`[revision] Tampoco se pudo pausar el chat ${userId}:`, err2.message);
      return false;
    }
  }
}

async function marcar(clienteId, userId, { tipo, motivo }, textoCliente) {
  const detalle = `${TIPOS[tipo] ? TIPOS[tipo][0].toUpperCase() + TIPOS[tipo].slice(1) : 'Revisión humana'}: ${motivo}`.slice(0, 500);
  await ejecutar('dbo.usp_Bot_RevisionHumanaActivar', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
    motivo: [sql.NVarChar(500), detalle],
  });

  // No se registra como Escalamiento: pedir una persona no es un reclamo, y el
  // Portal ya lo muestra como "Humano Solicitado" con Chats.revisionHumana.

  logs.warn('revision_humana', { clienteId, userId, detalle: { tipo, motivo, mensaje: String(textoCliente).slice(0, 500) } });
  console.log(`[revision] Chat ${userId} (cliente ${clienteId}) pasó a revisión humana: ${detalle}`);
}

// Pasa el pedido de persona a "Atendido" (mismo procedure que usa el Portal al
// responder desde ahí). El bot sigue pausado: se reactiva aparte desde el Portal.
// Devuelve true si cambió (false = no estaba pendiente). Nunca tira error.
async function atender(clienteId, userId, por) {
  try {
    const r = await ejecutar('dbo.usp_Portal_HumanoSolicitadoEstado', {
      clienteId: [sql.Int, clienteId],
      userId: [sql.NVarChar(100), userId],
      estado: [sql.NVarChar(20), 'atendido'],
      por: [sql.NVarChar(255), por ? String(por).slice(0, 255) : null],
    });
    const cambio = (r.recordset[0]?.cambiados || 0) > 0;
    if (cambio) {
      portalAviso.avisar(clienteId, 'revision', userId);
      logs.info('revision_humana_atendida', { clienteId, userId, detalle: { por } });
    }
    return cambio;
  } catch (err) {
    console.error(`[revision] No se pudo marcar como atendido el chat ${userId} (cliente ${clienteId}):`, err.message);
    return false;
  }
}

async function datosAlerta(clienteId, userId) {
  const r = await ejecutar('dbo.usp_Bot_RevisionHumanaDatosAlerta', {
    clienteId: [sql.Int, clienteId],
    userId: [sql.NVarChar(100), userId],
  });
  return r.recordset[0] ?? null;
}

// Aviso por WhatsApp al número de alertas. Primero texto libre (anda si ese número
// le escribió al bot en las últimas 24 hs); si WhatsApp lo rechaza y hay una
// plantilla configurada (ALERTA_PLANTILLA), se manda la plantilla.
async function alertar(phoneNumberId, clienteId, userId, { tipo, motivo }, textoCliente) {
  try {
    const datos = await datosAlerta(clienteId, userId);
    const destino = (datos?.telefonoAlertas || '').replace(/\D/g, '');
    if (!destino) {
      logs.warn('alerta_sin_numero', { clienteId, userId, detalle: 'El Cliente no tiene número de alertas configurado (Mi Negocio)' });
      return;
    }

    const quien = datos.nombre ? `${datos.nombre} (+${userId})` : `+${userId}`;
    const texto = [
      `⚠️ Revisión humana — ${datos.razonSocial}`,
      `${quien} ${TIPOS[tipo] || 'necesita atención'}.`,
      // Sin links: el aviso sale desde el número del propio negocio y un link
      // escrito por un desconocido no tiene que llegarle al dueño como si fuera nuestro.
      `Último mensaje: "${String(textoCliente).replace(/(https?:\/\/|www\.)\S+/gi, '[link]').slice(0, 300)}"`,
      'El bot quedó pausado en ese chat. Respondele desde el portal y reactivalo cuando termines.',
    ].join('\n');

    try {
      await meta.sendWhatsAppMessage(phoneNumberId, destino, texto);
      logs.info('alerta_enviada', { clienteId, userId, detalle: { destino, via: 'texto' } });
      return;
    } catch (err) {
      const detalle = err.response?.data?.error?.message || err.message;
      if (!config.alertas.plantilla) {
        logs.error('alerta_fallida', { clienteId, userId, detalle: { destino, error: detalle, ayuda: 'Si pasaron más de 24 hs desde que ese número le escribió al bot, configurá ALERTA_PLANTILLA' } });
        return;
      }
    }

    await meta.sendWhatsAppTemplate(phoneNumberId, destino, config.alertas.plantilla, config.alertas.idioma, [`+${userId}`, (TIPOS[tipo] || motivo).slice(0, 200)]);
    logs.info('alerta_enviada', { clienteId, userId, detalle: { destino, via: 'plantilla', plantilla: config.alertas.plantilla } });
  } catch (err) {
    logs.error('alerta_fallida', { clienteId, userId, detalle: err.response?.data?.error?.message || err.message });
  }
}

module.exports = { MENSAJE_ESPERA, TIPOS, detectar, activar, atender, alertar };
