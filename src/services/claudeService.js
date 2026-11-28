const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const articulos = require('./articuloService');
const cliente = require('./clienteService');
const escalamientos = require('./escalamientoService');
const pedidos = require('./pedidoService');
const email = require('./emailService');
const revision = require('./revisionService');
const logs = require('./logService');
const pasajes = require('./pasajesService');
const linkCompra = require('./linkCompraService');
const { costoUsd } = require('../config/precios');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });
const BASE_PROMPT = fs.readFileSync(path.join(__dirname, '../../prompts/base.txt'), 'utf8');
// Perfil 'pasajes' (Clientes.tipoNegocio): otro prompt base y otras tools (pasajesService).
const PROMPT_PASAJES = fs.readFileSync(path.join(__dirname, '../../prompts/pasajes.txt'), 'utf8');

const tools = [
  {
    name: 'buscar_articulos',
    description: 'Busca artículos en el catálogo del cliente por nombre, descripción o código, e informa precio y disponibilidad. Llamala SIEMPRE que te pregunten por un producto puntual, aunque ya hayas buscado algo parecido antes en la conversación, o aunque en un mensaje anterior ya hayas dicho que no tenían ese tipo de producto — esa respuesta anterior puede haber estado mal, no la repitas de memoria: confirmalo de nuevo con esta tool. Nunca respondas sobre stock o catálogo sin llamarla primero. El campo "disponibilidad" es info interna para vos (no se la repitas al cliente tal cual): te dice si hay stock (ej: "3 en stock", o "0 en stock" que significa agotado — avisá que está agotado, no digas que no existe en el catálogo) o si el artículo está siempre disponible sin control de stock (en ese caso ofrecelo con normalidad, sin mencionar la frase "sin control de stock"). El campo "infoNegocio", si viene, es información que el negocio cargó especialmente para vos sobre ese producto (usos, medidas, cuidados, qué responder): usala como contexto confiable al contestar, con tus palabras; si dice "igual que X", es la misma info del artículo X.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Palabra clave para buscar, ej: "auriculares"' },
      },
      required: ['texto'],
    },
  },
  {
    name: 'ver_productos_disponibles',
    description: 'Lista los productos que hay para vender AHORA (solo los que tienen stock), con precio. Usala cuando el cliente pide información en general, pregunta qué venden o qué tienen, y en la conversación NO se venía hablando de un producto puntual: en vez de preguntarle sobre qué producto quiere info, mostrale directamente lo disponible. Si pregunta por una línea, marca o categoría (ej. "kids", "iluminación"), pasala en filtro para traer solo esos. Si ya se venía hablando de un producto puntual, no uses esta: usá buscar_articulos para ESE producto.',
    input_schema: {
      type: 'object',
      properties: {
        filtro: { type: 'string', description: 'Opcional: línea, marca o categoría que pidió el cliente, ej: "kids". Vacío = todo lo disponible.' },
      },
      required: [],
    },
  },
  {
    name: 'enviar_fotos_articulo',
    description: 'Le manda al cliente por WhatsApp las fotos de un artículo (solo sirve si buscar_articulos dijo que tiene fotos > 0). Las fotos le llegan justo ANTES de tu mensaje de texto, así que podés referirte a ellas ("ahí te pasé las fotos"). Usala cuando el cliente pregunta por un producto puntual o pide verlo; si la búsqueda trajo varios, mandá solo las del que le interesa (como mucho 3 artículos por respuesta) y ofrecé las demás. No reenvíes fotos que ya le mandaste en esta conversación salvo que las pida de nuevo.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre exacto del artículo, tal como lo devolvió buscar_articulos' },
      },
      required: ['nombre'],
    },
  },
  {
    name: 'escalar_a_humano',
    description: 'Llamala cuando el cliente necesite ayuda de una persona real del equipo: reclamos, devoluciones, problemas con un pedido, o cualquier cosa que no puedas resolver vos. Deja registro para que el equipo haga seguimiento; después avisale al cliente que alguien se va a poner en contacto, sin decir que sos un bot. Si el reclamo es sobre un pedido y lo identificaste con certeza (por ejemplo con buscar_pedidos_cliente), pasá también su pedidoId — eso lo marca como reclamado para que el equipo lo vea aparte. Si no estás seguro de cuál pedido es, dejá pedidoId sin completar (nunca lo inventes).',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Breve resumen de por qué se escala, ej: "reclamo por producto dañado"' },
        pedidoId: { type: 'integer', description: 'Número del pedido al que se refiere el reclamo, SOLO si lo identificaste con certeza. Omitilo si no estás seguro.' },
      },
      required: ['motivo'],
    },
  },
  {
    name: 'pasar_a_revision_humana',
    description: 'Llamala cuando el cliente pida hablar con una persona, un humano, un asesor, el dueño o alguien del equipo, cuando insulte, putee o esté muy agresivo, o cuando pida algo que solo puede hacer el equipo y vos no: cancelar o anular un pedido/compra/reserva, modificar uno ya hecho, o un reembolso. Al llamarla el chat pasa a una persona del equipo: no sigas la conversación ni escribas nada más (el sistema le responde al cliente que espere). No la uses para reclamos comunes donde el cliente no pidió una persona ni está agresivo: para eso está escalar_a_humano.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['pide_persona', 'agresion', 'accion_equipo'], description: 'pide_persona: pidió hablar con una persona. agresion: insulta o está muy agresivo. accion_equipo: pidió cancelar/modificar un pedido ya hecho, un reembolso u otra acción que solo puede hacer el equipo.' },
        motivo: { type: 'string', description: 'Resumen breve de lo que pasó, sin inventar datos' },
      },
      required: ['tipo', 'motivo'],
    },
  },
  {
    name: 'crear_pedido',
    description: 'Crea un pedido en el sistema. Llamala ÚNICAMENTE después de que el cliente confirmó explícitamente que quiere el pedido (dijo que sí a tu resumen). Nunca la llames en el mismo mensaje donde recién le proponés el pedido — primero preguntá "¿confirmás el pedido por: ...?" en texto normal, y esperá la respuesta del cliente en su próximo mensaje antes de llamar esta tool.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Artículos del pedido',
          items: {
            type: 'object',
            properties: {
              nombre: { type: 'string', description: 'Nombre exacto del artículo, tal como lo devolvió buscar_articulos' },
              cantidad: { type: 'integer', minimum: 1 },
            },
            required: ['nombre', 'cantidad'],
          },
        },
        notas: { type: 'string', description: 'Notas opcionales del pedido, ej: dirección de entrega si la mencionaron' },
      },
      required: ['items'],
    },
  },
  {
    name: 'buscar_pedidos_cliente',
    description: 'Consulta los pedidos anteriores de ESTE cliente (el que te está escribiendo), con sus artículos, estado y fecha. Dos usos: (1) responder directamente consultas de estado ("¿llegó mi pedido?", "¿en qué está?") sin necesidad de escalar; (2) cuando alguien haga un reclamo y no te haya dado el número, para identificarlo por lo que describe (artículos, fecha) en vez de preguntar el número de una o de asumir cuál es. No sirve para pedidos de otros clientes.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// Venta por link de compra (Shopify): reemplaza a crear_pedido. El link lo agrega el
// código al final del mensaje, Claude nunca escribe la URL (podría cambiarle algo).
const toolLinkCompra = {
  name: 'enviar_link_compra',
  description: 'Genera el link de compra de la tienda online con el carrito ya armado y se lo manda al cliente para que complete sus datos de envío y pague. Llamala ÚNICAMENTE después de que el cliente confirmó explícitamente el pedido (dijo que sí a tu resumen). Nunca la llames en el mismo mensaje donde recién le proponés el pedido. El link se agrega solo al final de tu mensaje: no escribas ninguna URL vos.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Artículos que confirmó el cliente',
        items: {
          type: 'object',
          properties: {
            nombre: { type: 'string', description: 'Nombre exacto del artículo, tal como lo devolvió buscar_articulos' },
            cantidad: { type: 'integer', minimum: 1 },
          },
          required: ['nombre', 'cantidad'],
        },
      },
    },
    required: ['items'],
  },
};
const toolsLinkCompra = tools.map(t => (t.name === 'crear_pedido' ? toolLinkCompra : t));

// Reemplaza la sección "Cómo tomar pedidos" de base.txt cuando el negocio vende por link.
const PEDIDOS_POR_LINK = `Cómo tomar pedidos (este negocio vende con link de compra de su tienda online):
- Cuando el cliente quiera comprar algo, primero armá el pedido usando datos reales de buscar_articulos (nunca inventes precios).
- Antes de mandar nada, resumilo en un mensaje de texto normal y pedí confirmación explícita: por ejemplo "¿Te armo el pedido con: 2x Auriculares Bluetooth ($50.000)? Total: $50.000 más el envío". NO llames a ninguna tool en este mensaje.
- Recién en tu SIGUIENTE respuesta, si el cliente confirmó que sí, llamá a enviar_link_compra con los artículos y cantidades exactas que confirmó. Si pidió cambios, volvé a resumir y pedir confirmación antes.
- El link se agrega solo al final de tu mensaje: NO escribas ninguna URL ni inventes links. Escribí un mensaje corto diciendo que le dejás el link con su pedido ya cargado, donde completa sus datos de envío y paga, y que el pedido queda confirmado cuando termina la compra ahí.
- No le pidas dirección, nombre ni datos de pago por WhatsApp: todo eso lo completa en el link.
- Si enviar_link_compra devuelve un error (por ejemplo, no hay stock suficiente), explicaselo con naturalidad y ofrecé alternativas — no digas que le mandaste el link si no fue así.
- Si el cliente quiere cambiar algo después de recibir el link, armá el pedido de nuevo, confirmalo y mandá un link nuevo.
- Si el cliente dice que el link no le funciona o tiene problemas para pagar, pasá el caso a alguien del equipo con escalar_a_humano.
- Nunca digas que un pedido quedó confirmado o pagado: eso pasa recién cuando completa la compra en el link.`;

function seccionPedidosPorLink(prompt) {
  const inicio = prompt.indexOf('Cómo tomar pedidos:');
  const fin = prompt.indexOf('Consultas de estado de un pedido:');
  if (inicio === -1 || fin <= inicio) return `${prompt}\n\n${PEDIDOS_POR_LINK}`;
  return `${prompt.slice(0, inicio)}${PEDIDOS_POR_LINK}\n\n${prompt.slice(fin)}`;
}

const TEXTO_LINK = 'Te dejo el link con tu pedido ya cargado. Ahí completás tus datos de envío y pagás:';

// Mensaje final cuando se generó un link: lo que escribió Claude (sin URLs, por si
// igual escribió alguna) + el link real en su propia línea.
function conLink(texto, link) {
  const limpio = String(texto || '').replace(/https?:\/\/\S+/gi, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${limpio && limpio !== TEXTO_VACIO ? limpio : TEXTO_LINK}\n\n${link.url}`;
}

// Pasajes: catálogo y pedidos no aplican, y tampoco escalar_a_humano: TODO reclamo pasa a una
// persona con pasar_a_revision_humana (tipo 'reclamo'), que pausa el chat y avisa al número de alertas.
const toolRevisionBase = tools.find(t => t.name === 'pasar_a_revision_humana');
const toolRevisionPasajes = {
  ...toolRevisionBase,
  description: 'Llamala cuando el cliente pida hablar con una persona, un humano, un asesor, el dueño o alguien del equipo; cuando insulte o esté muy agresivo; cuando tenga CUALQUIER reclamo o queja (un viaje que no salió o se demoró, un problema con el chofer, el colectivo o el equipaje, un cobro mal hecho, mala atención, etc.); o cuando pida algo que solo puede hacer el equipo: cancelar, cambiar o devolver un pasaje o una reserva, o un reembolso. Al llamarla el chat pasa a una persona del equipo: no sigas la conversación ni escribas nada más (el sistema le responde al cliente que espere).',
  input_schema: {
    ...toolRevisionBase.input_schema,
    properties: {
      ...toolRevisionBase.input_schema.properties,
      tipo: { type: 'string', enum: ['pide_persona', 'agresion', 'reclamo', 'accion_equipo'], description: 'pide_persona: pidió hablar con una persona. agresion: insulta o está muy agresivo. reclamo: cualquier reclamo o queja. accion_equipo: pidió cancelar, cambiar o devolver un pasaje/reserva, un reembolso u otra acción que solo puede hacer el equipo.' },
    },
  },
};
const toolsPasajes = [...pasajes.tools, toolRevisionPasajes];

function toolsDe(negocio, checkout) {
  if (negocio.tipoNegocio === 'pasajes') return toolsPasajes;
  return checkout ? toolsLinkCompra : tools;
}

// Día, hora y saludo en hora de Argentina (UTC-3 fijo, sin horario de verano). Va en un
// bloque aparte del system prompt, después del punto de caché: el prompt fijo (y las tools)
// se siguen leyendo de caché aunque cambie la hora. Solo la hora (no los minutos): dentro
// de la misma hora el bloque es igual y también se reusa la caché de la conversación.
function momentoActual({ fueraDeHorario = false } = {}) {
  const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const dia = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][ahora.getUTCDay()];
  const dos = n => String(n).padStart(2, '0');
  const hora = ahora.getUTCHours();
  const saludo = hora >= 5 && hora < 12 ? 'buen día' : hora >= 12 && hora < 20 ? 'buenas tardes' : 'buenas noches';
  let texto = `Momento actual (Argentina): ${dia} ${dos(ahora.getUTCDate())}/${dos(ahora.getUTCMonth() + 1)}/${ahora.getUTCFullYear()}, entre las ${dos(hora)}:00 y las ${dos(hora)}:59. Usalo para entender "hoy", "mañana", "el viernes", etc. Si saludás, decí "${saludo}".`;
  if (fueraDeHorario) {
    texto += ' Los últimos mensajes del cliente llegaron fuera del horario de atención y recién ahora se le responden: respondé todo lo que preguntó (podés disculparte en pocas palabras por la demora).';
  }
  return texto;
}

async function buildSystemPrompt(clienteId, negocio, checkout) {
  const esPasajes = negocio.tipoNegocio === 'pasajes';
  const [contexto, aprendizajes] = await Promise.all([
    cliente.getContextoNegocio(clienteId),
    // Si la tabla todavía no existe o falla la lectura, el bot sigue respondiendo sin aprendizajes.
    cliente.getAprendizajes(clienteId).catch(err => {
      console.warn(`[claude] No se pudieron leer los aprendizajes del cliente ${clienteId}: ${err.message}`);
      return [];
    }),
  ]);

  let prompt = esPasajes ? PROMPT_PASAJES : checkout ? seccionPedidosPorLink(BASE_PROMPT) : BASE_PROMPT;
  if (contexto) {
    prompt += `

Información y preferencias de este negocio en particular. Si acá piden algo distinto a la sección "Estilo" de arriba (por ejemplo, usar emojis, un tono distinto, o terminar los mensajes de alguna forma en particular), priorizá lo que pidan acá por sobre esa sección. El resto de las instrucciones (${esPasajes ? 'viajes, reservas' : 'leer la conversación, catálogo, pedidos'}, escalamientos, etc.) siempre se respeta igual, esto no las cambia: por ejemplo, si acá dice cómo presentarte o qué preguntar al empezar, eso aplica solo cuando la conversación recién empieza y el cliente todavía no dijo qué busca:
${contexto}`;
  }
  // Van al final y en orden fijo: el system prompt queda igual entre mensajes y se lee de caché.
  if (aprendizajes.length) {
    prompt += `

Respuestas aprendidas de este negocio (las cargó el equipo del negocio a partir de consultas reales). Cuando el cliente pregunte algo que coincida con una de estas, respondé según lo indicado, con tus palabras y adaptado a la conversación. No reemplazan a las tools: ${esPasajes ? 'viajes, asientos y precios' : 'precios, stock y pedidos'} se consultan siempre con ellas.
${aprendizajes.map(a => `- P: ${a.pregunta}\n  R: ${a.respuesta}`).join('\n')}`;
  }
  return prompt;
}

// Artículos como los ve Claude: sin el id interno ni los campos crudos de stock (la
// disponibilidad va resumida en un solo campo legible). Con Shopify la descripción
// llega completa y se repite en cada talle/color del mismo producto: se recorta.
// infoBot (metacampo custom.info_bot de Shopify) es lo que el negocio escribió para
// el bot: va más largo, y solo en el primer artículo que lo trae (las otras
// variantes del producto lo referencian).
function resumirArticulos(rows, { descripcion: maxDescripcion = 400, infoNegocio: maxInfo = 2000 } = {}) {
  const corto = (texto, max) => (texto.length > max ? `${texto.slice(0, max)}…` : texto);
  const infoVista = new Map();
  return rows.map(({ articuloId, usaStock, cantidad, imagenes, descripcion, infoBot, precioComparacion, marca, opciones, ...resto }) => ({
    ...resto,
    ...(descripcion ? { descripcion: corto(descripcion, maxDescripcion) } : {}),
    ...(infoBot ? (infoVista.has(infoBot)
      ? { infoNegocio: `igual que "${infoVista.get(infoBot)}"` }
      : (infoVista.set(infoBot, resto.nombre), { infoNegocio: corto(infoBot, maxInfo) })) : {}),
    ...(precioComparacion && precioComparacion > resto.precio ? { precioAntes: precioComparacion } : {}),
    ...(marca ? { marca } : {}),
    ...(opciones ? { opciones } : {}),
    disponibilidad: usaStock ? `${cantidad} en stock` : 'siempre disponible (sin control de stock)',
    fotos: imagenes.length,
  }));
}

// Tope de fotos por respuesta, para no inundar el chat.
const MAX_FOTOS_POR_RESPUESTA = 8;
const MAX_FOTOS_POR_ARTICULO = 5;

// El detalle técnico de un error (SQL, procedures...) queda en el log; a Claude solo
// le llega un aviso genérico, que podría terminar repitiéndole al cliente.
function errorInterno(que, err) {
  console.error(`[claude] Error al ${que}:`, err.message);
  return `Error: no se pudo ${que} en este momento. Pedile disculpas al cliente y ofrecele que alguien del equipo lo contacte (escalar_a_humano).`;
}

// Si Claude no devuelve texto (se cortó por max_tokens o se negó), algo hay que mandar.
const TEXTO_VACIO = 'Perdón, ¿me lo podés repetir con otras palabras? Quiero asegurarme de entenderte bien.';

// `fotos` junta lo que hay que mandar: se envía recién cuando la respuesta está
// lista (y si el bot no se apagó en el medio), no en el momento de la tool.
// Cada tool queda en Logs con lo que pidió Claude, lo que se le devolvió y cuánto tardó.
async function ejecutarTool(clienteId, userId, block, fotos, turno) {
  console.log(`[claude] Tool call: ${block.name} — cliente=${clienteId} user=${userId} input=${JSON.stringify(block.input)}`);
  const inicio = Date.now();
  const resultado = await correrTool(clienteId, userId, block, fotos, turno);
  const fallo = /^(Error|No se pudo|Tool desconocida)/.test(resultado);
  logs.registrar(fallo ? 'warn' : 'info', `tool_${block.name}`, {
    clienteId, userId,
    duracionMs: Date.now() - inicio,
    detalle: { input: block.input, resultado: resultado.length > 4000 ? `${resultado.slice(0, 4000)}…` : resultado },
  });
  return resultado;
}

async function correrTool(clienteId, userId, block, fotos, turno) {
  if (turno.negocio?.tipoNegocio === 'pasajes' && pasajes.NOMBRES.has(block.name)) {
    return pasajes.ejecutar(turno.negocio, clienteId, userId, block, turno, fotos);
  }

  if (block.name === 'enviar_fotos_articulo') {
    try {
      const articulo = await articulos.obtenerFotos(clienteId, block.input.nombre);
      if (!articulo) return 'No encontré un artículo activo con ese nombre exacto. Usá el nombre tal como lo devolvió buscar_articulos.';
      if (!articulo.imagenes.length) return 'Ese artículo no tiene fotos cargadas. No le prometas fotos al cliente.';
      if (fotos.some(f => f.nombre === articulo.nombre)) return 'Las fotos de ese artículo ya quedaron para enviar en esta respuesta.';

      const enviadas = fotos.reduce((n, f) => n + f.urls.length, 0);
      const urls = articulo.imagenes.slice(0, Math.min(MAX_FOTOS_POR_ARTICULO, Math.max(0, MAX_FOTOS_POR_RESPUESTA - enviadas)));
      if (!urls.length) return 'Ya se juntaron muchas fotos en esta respuesta; ofrecele mandar las de este artículo en el próximo mensaje.';

      fotos.push({ nombre: articulo.nombre, urls });
      return `Listo: ${urls.length === 1 ? 'la foto le llega' : `las ${urls.length} fotos le llegan`} justo antes de tu mensaje.`;
    } catch (err) {
      return errorInterno('buscar las fotos', err);
    }
  }

  if (block.name === 'buscar_articulos') {
    try {
      const texto = String(block.input?.texto || '').slice(0, 200); // ConsultasArticulo.textoBuscado es NVARCHAR(200)
      const rows = await articulos.buscarArticulos(clienteId, texto);
      await articulos.registrarConsulta(clienteId, userId, texto, rows);

      if (!rows.length) return 'No se encontraron artículos que coincidan.';

      const paraClaude = resumirArticulos(rows);
      // Si quedaron resultados afuera, que pida más detalle en vez de inventar que no hay.
      return rows.hayMas
        ? `${JSON.stringify(paraClaude)}\n(Hay más artículos que coinciden: estos son los ${rows.length} más relevantes. Si no está lo que busca, pedile más detalle —modelo, talle, color— y buscá de nuevo.)`
        : JSON.stringify(paraClaude);
    } catch (err) {
      return errorInterno('consultar el catálogo', err);
    }
  }

  if (block.name === 'ver_productos_disponibles') {
    try {
      const filtro = String(block.input?.filtro || '').slice(0, 100);
      const rows = await articulos.listarDisponibles(clienteId, filtro);
      if (!rows.length) {
        return filtro
          ? `No hay productos disponibles que coincidan con "${filtro}". Probá ver_productos_disponibles sin filtro o buscar_articulos con otras palabras antes de decirle al cliente que no hay.`
          : 'Ahora no hay productos con stock. No ofrezcas nada: decile que por el momento no hay stock y ofrecele avisarle cuando entre.';
      }
      // Descripción corta: es una lista para elegir, el detalle sale después con buscar_articulos.
      return `${JSON.stringify(resumirArticulos(rows, { descripcion: 150, infoNegocio: 300 }))}\n(Estos son TODOS los productos con stock${filtro ? ` que coinciden con "${filtro}"` : ''}. Mostráselos al cliente en una lista corta con nombre y precio —si hay variantes del mismo producto, agrupalas— y preguntale cuál le interesa. No ofrezcas ningún producto que no esté en esta lista.)`;
    } catch (err) {
      return errorInterno('consultar el catálogo', err);
    }
  }

  if (block.name === 'escalar_a_humano') {
    try {
      const motivo = String(block.input?.motivo || '').trim().slice(0, 480) || 'Sin detalle';
      // El pedidoId lo pone Claude: solo se usa si ese pedido es de este número.
      const pedidoPedido = Number(block.input?.pedidoId);
      const pedidoId = (await pedidos.esDelCliente(clienteId, userId, pedidoPedido)) ? pedidoPedido : null;
      if (block.input?.pedidoId != null && !pedidoId) {
        console.warn(`[claude] escalar_a_humano con un pedido que no es de este cliente (${block.input.pedidoId}): se registra sin pedido.`);
      }
      await escalamientos.registrarEscalamiento(clienteId, userId, motivo, pedidoId);
      if (pedidoId) await pedidos.marcarComoReclamado(clienteId, pedidoId, userId);
      return 'Escalamiento registrado. Avisale al cliente que alguien del equipo se va a contactar pronto.';
    } catch (err) {
      return errorInterno('registrar el reclamo', err);
    }
  }

  if (block.name === 'crear_pedido') {
    // Un solo pedido por respuesta: si Claude pide crear dos, el segundo es casi
    // seguro un duplicado del mismo pedido.
    if (turno.pedidoCreado) return 'Ya creaste un pedido en esta respuesta: no crees otro. Si el cliente quiere sumar algo, confirmalo con él en el próximo mensaje.';
    try {
      const resultado = await pedidos.crearPedido(clienteId, userId, block.input?.items, block.input?.notas);
      if (!resultado.ok) {
        return `No se pudo crear el pedido:\n${resultado.errores.join('\n')}`;
      }
      turno.pedidoCreado = true;

      // No se espera esta promesa: si el mail tarda o falla, no tiene que
      // demorar ni romper la confirmación del pedido por WhatsApp.
      cliente.getEmail(clienteId).then(clienteEmail => {
        email.enviarNotificacionPedido(clienteEmail, resultado.pedidoId, resultado.items, resultado.total);
      }).catch(err => console.error('[email] Error al buscar el email del Cliente:', err.message));

      return `Pedido #${resultado.pedidoId} creado con éxito. Total: $${resultado.total}.`;
    } catch (err) {
      return errorInterno('crear el pedido', err);
    }
  }

  if (block.name === 'enviar_link_compra') {
    if (!turno.checkout) return 'Tool desconocida: enviar_link_compra';
    if (turno.linkCompra) return 'Ya generaste el link de compra en esta respuesta: no generes otro. Si el cliente quiere cambiar algo, confirmalo con él en el próximo mensaje.';
    try {
      const resultado = await linkCompra.crearLink(clienteId, userId, turno.checkout, block.input?.items);
      if (!resultado.ok) return `No se pudo generar el link:\n${resultado.errores.join('\n')}`;
      turno.linkCompra = resultado;
      const resumen = resultado.items.map(i => `${i.cantidad}x ${i.nombre}`).join(', ');
      return `Link de compra generado (${resumen}; total de productos $${resultado.total}, sin el envío). El link se agrega automáticamente al final de tu mensaje: NO escribas ninguna URL. Escribí un mensaje corto para acompañarlo.`;
    } catch (err) {
      return errorInterno('generar el link de compra', err);
    }
  }

  if (block.name === 'buscar_pedidos_cliente') {
    try {
      const rows = await pedidos.buscarPedidosCliente(clienteId, userId);
      await pedidos.registrarConsultaPedido(clienteId, userId, rows);
      if (turno.checkout) {
        // Con venta por link, las compras están en la tienda (LinksCompra), no en Pedidos.
        const compras = await linkCompra.comprasDeCliente(clienteId, userId).catch((err) => {
          console.error('[claude] No se pudieron leer las compras por link:', err.message);
          return [];
        });
        if (!rows.length && !compras.length) return 'Este cliente no tiene pedidos ni compras registradas.';
        return JSON.stringify({ ...(rows.length ? { pedidos: rows } : {}), ...(compras.length ? { comprasPorLink: compras } : {}) });
      }
      return rows.length ? JSON.stringify(rows) : 'Este cliente no tiene pedidos registrados.';
    } catch (err) {
      return errorInterno('consultar los pedidos', err);
    }
  }

  return `Tool desconocida: ${block.name}`;
}

/**
 * @param {number} clienteId
 * @param {string} userId
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<{text: string, fotos: Array<{nombre: string, urls: string[]}>, inputTokens: number, outputTokens: number, costoUsd: number|null, escalado: boolean, pedidoCreado: boolean, consultoPedidos: boolean, revisionHumana: {tipo: string, motivo: string} | null}>}
 */
async function generateResponse(clienteId, userId, messages, { fueraDeHorario = false } = {}) {
  const conversationMessages = [...messages];
  const fotos = [];
  const negocio = await cliente.getNegocio(clienteId);
  const checkout = negocio.tipoNegocio === 'pasajes' ? null : await linkCompra.getConfig(clienteId);
  const turno = { pedidoCreado: false, negocio, derivacion: null, checkout, linkCompra: null };
  const toolsDelNegocio = toolsDe(negocio, checkout);
  // [prompt fijo con punto de caché, momento actual]: ver momentoActual().
  const systemPrompt = [
    { type: 'text', text: await buildSystemPrompt(clienteId, negocio, checkout), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: momentoActual({ fueraDeHorario }) },
  ];
  // Si se generó un link de compra, va pegado al final del mensaje que se manda.
  const final = texto => (turno.linkCompra ? conLink(texto, turno.linkCompra) : texto);
  // inputTokens = todo lo que entró (sin caché + leído de caché + escrito en caché),
  // así en Mensajes se ve el tamaño real del prompt.
  let inputTokens = 0;
  let outputTokens = 0;
  let costoTotal = 0;
  let escalado = false;
  let pedidoCreado = false;
  let consultoPedidos = false;

  for (let i = 0; i < 5; i++) {
    const inicio = Date.now();
    let response;
    try {
      response = await client.messages.create({
        model: config.anthropic.model,
        max_tokens: config.anthropic.maxTokens,
        output_config: { effort: config.anthropic.effort },
        // Caché: las tools y el prompt fijo (punto de caché en systemPrompt[0]) son iguales
        // en cada llamada; la automática suma la conversación (sirve dentro de la misma hora).
        cache_control: { type: 'ephemeral' },
        system: systemPrompt,
        messages: conversationMessages,
        tools: toolsDelNegocio,
      });
    } catch (err) {
      logs.error('claude_error', {
        clienteId, userId,
        modelo: config.anthropic.model,
        duracionMs: Date.now() - inicio,
        detalle: { vuelta: i + 1, status: err.status ?? null, tipo: err.error?.error?.type ?? err.name, mensaje: err.message, requestId: err.requestID ?? err.request_id ?? null },
      });
      throw err;
    }

    const u = response.usage || {};
    const costo = costoUsd(response.model || config.anthropic.model, u);
    inputTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    outputTokens += u.output_tokens || 0;
    if (costo != null) costoTotal += costo;

    // Una fila por llamada a la API: es la que tiene el costo (sumando costoUsd de
    // las filas 'claude_llamada' se obtiene el gasto real).
    logs.registrar(response.stop_reason === 'max_tokens' || response.stop_reason === 'refusal' ? 'warn' : 'info', 'claude_llamada', {
      clienteId, userId,
      modelo: response.model || config.anthropic.model,
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheLecturaTokens: u.cache_read_input_tokens || 0,
      cacheEscrituraTokens: u.cache_creation_input_tokens || 0,
      costoUsd: costo ?? undefined,
      duracionMs: Date.now() - inicio,
      detalle: {
        vuelta: i + 1,
        id: response.id,
        stopReason: response.stop_reason,
        effort: config.anthropic.effort,
        maxTokens: config.anthropic.maxTokens,
        mensajesEnviados: conversationMessages.length,
        tools: response.content.filter(b => b.type === 'tool_use').map(b => b.name),
        texto: response.content.find(b => b.type === 'text')?.text?.slice(0, 2000) ?? null,
        ...(costo == null ? { aviso: `Sin precio cargado para ${response.model} en src/config/precios.js` } : {}),
      },
    });

    if (response.stop_reason !== 'tool_use') {
      const text = final(response.content.find(block => block.type === 'text')?.text?.trim() || TEXTO_VACIO);
      return { text, fotos, inputTokens, outputTokens, costoUsd: costoTotal, escalado, pedidoCreado, consultoPedidos, revisionHumana: null };
    }

    // Revisión humana: se corta acá, sin otra vuelta a Claude. La respuesta al
    // cliente es siempre la misma y el controller pausa el chat y avisa.
    const pedidoRevision = response.content.find(b => b.type === 'tool_use' && b.name === 'pasar_a_revision_humana');
    if (pedidoRevision) {
      logs.info('tool_pasar_a_revision_humana', { clienteId, userId, detalle: { input: pedidoRevision.input } });
      const tipo = revision.TIPOS[pedidoRevision.input?.tipo] ? pedidoRevision.input.tipo : 'pide_persona';
      const motivo = String(pedidoRevision.input?.motivo || '').slice(0, 300) || revision.TIPOS[tipo];
      return { text: revision.MENSAJE_ESPERA, fotos: [], inputTokens, outputTokens, costoUsd: costoTotal, escalado, pedidoCreado, consultoPedidos, revisionHumana: { tipo, motivo } };
    }

    conversationMessages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'escalar_a_humano') escalado = true;
      if (block.name === 'crear_pedido' || block.name === 'enviar_link_compra') pedidoCreado = true;
      if (block.name === 'buscar_pedidos_cliente') consultoPedidos = true;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: await ejecutarTool(clienteId, userId, block, fotos, turno),
      });
    }

    conversationMessages.push({ role: 'user', content: toolResults });

    // Pasajes: la reserva salió. Se corta acá, sin otra vuelta a Claude: el mensaje al
    // cliente es el fijo de derivación y el controller pausa el chat para la persona asignada.
    if (turno.derivacion) {
      const text = pasajes.mensajeDerivacion(negocio, turno.derivacion);
      return { text, fotos: [], inputTokens, outputTokens, costoUsd: costoTotal, escalado, pedidoCreado, consultoPedidos, revisionHumana: null, derivacion: turno.derivacion };
    }
  }

  logs.warn('claude_sin_respuesta', { clienteId, userId, detalle: 'Se llegó al tope de 5 vueltas de tools sin respuesta final' });
  if (!turno.linkCompra) throw new Error('Se llegó al tope de 5 vueltas de tools sin respuesta final');
  return { text: final(''), fotos, inputTokens, outputTokens, costoUsd: costoTotal, escalado, pedidoCreado, consultoPedidos, revisionHumana: null };
}

module.exports = { generateResponse };
