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
const { costoUsd } = require('../config/precios');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });
const BASE_PROMPT = fs.readFileSync(path.join(__dirname, '../../prompts/base.txt'), 'utf8');

const tools = [
  {
    name: 'buscar_articulos',
    description: 'Busca artículos en el catálogo del cliente por nombre, descripción o código, e informa precio y disponibilidad. Llamala SIEMPRE que te pregunten por un producto puntual, aunque ya hayas buscado algo parecido antes en la conversación, o aunque en un mensaje anterior ya hayas dicho que no tenían ese tipo de producto — esa respuesta anterior puede haber estado mal, no la repitas de memoria: confirmalo de nuevo con esta tool. Nunca respondas sobre stock o catálogo sin llamarla primero. El campo "disponibilidad" es info interna para vos (no se la repitas al cliente tal cual): te dice si hay stock (ej: "3 en stock", o "0 en stock" que significa agotado — avisá que está agotado, no digas que no existe en el catálogo) o si el artículo está siempre disponible sin control de stock (en ese caso ofrecelo con normalidad, sin mencionar la frase "sin control de stock").',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Palabra clave para buscar, ej: "auriculares"' },
      },
      required: ['texto'],
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
    description: 'Llamala cuando el cliente pida hablar con una persona, un humano, un asesor, el dueño o alguien del equipo, o cuando insulte, putee o esté muy agresivo. Al llamarla el chat pasa a una persona del equipo: no sigas la conversación ni escribas nada más (el sistema le responde al cliente que espere). No la uses para reclamos comunes donde el cliente no pidió una persona ni está agresivo: para eso está escalar_a_humano.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['pide_persona', 'agresion'], description: 'pide_persona: pidió hablar con una persona. agresion: insulta o está muy agresivo.' },
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

async function buildSystemPrompt(clienteId) {
  const contexto = await cliente.getContextoNegocio(clienteId);
  if (!contexto) return BASE_PROMPT;

  return `${BASE_PROMPT}

Información y preferencias de este negocio en particular. Si acá piden algo distinto a la sección "Estilo" de arriba (por ejemplo, usar emojis, un tono distinto, o terminar los mensajes de alguna forma en particular), priorizá lo que pidan acá por sobre esa sección. El resto de las instrucciones (catálogo, pedidos, escalamientos, etc.) siempre se respeta igual, esto no las cambia:
${contexto}`;
}

// Tope de fotos por respuesta, para no inundar el chat.
const MAX_FOTOS_POR_RESPUESTA = 8;
const MAX_FOTOS_POR_ARTICULO = 5;

// `fotos` junta lo que hay que mandar: se envía recién cuando la respuesta está
// lista (y si el bot no se apagó en el medio), no en el momento de la tool.
// Cada tool queda en Logs con lo que pidió Claude, lo que se le devolvió y cuánto tardó.
async function ejecutarTool(clienteId, userId, block, fotos) {
  console.log(`[claude] Tool call: ${block.name} — cliente=${clienteId} user=${userId} input=${JSON.stringify(block.input)}`);
  const inicio = Date.now();
  const resultado = await correrTool(clienteId, userId, block, fotos);
  const fallo = /^(Error|No se pudo|Tool desconocida)/.test(resultado);
  logs.registrar(fallo ? 'warn' : 'info', `tool_${block.name}`, {
    clienteId, userId,
    duracionMs: Date.now() - inicio,
    detalle: { input: block.input, resultado: resultado.length > 4000 ? `${resultado.slice(0, 4000)}…` : resultado },
  });
  return resultado;
}

async function correrTool(clienteId, userId, block, fotos) {
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
      return `Error al buscar las fotos: ${err.message}`;
    }
  }

  if (block.name === 'buscar_articulos') {
    try {
      const rows = await articulos.buscarArticulos(clienteId, block.input.texto);
      await articulos.registrarConsulta(clienteId, userId, block.input.texto, rows);

      if (!rows.length) return 'No se encontraron artículos que coincidan.';

      // No hace falta que Claude vea el id interno ni los campos crudos de stock —
      // le resumimos la disponibilidad en un solo campo legible.
      // Con Shopify la descripción llega completa y se repite en cada talle/color
      // del mismo producto: se recorta para no gastar tokens de más.
      const paraClaude = rows.map(({ articuloId, usaStock, cantidad, imagenes, descripcion, precioComparacion, marca, opciones, ...resto }) => ({
        ...resto,
        ...(descripcion ? { descripcion: descripcion.length > 400 ? `${descripcion.slice(0, 400)}…` : descripcion } : {}),
        ...(precioComparacion && precioComparacion > resto.precio ? { precioAntes: precioComparacion } : {}),
        ...(marca ? { marca } : {}),
        ...(opciones ? { opciones } : {}),
        disponibilidad: usaStock ? `${cantidad} en stock` : 'siempre disponible (sin control de stock)',
        fotos: imagenes.length,
      }));
      return JSON.stringify(paraClaude);
    } catch (err) {
      return `Error al consultar el catálogo: ${err.message}`;
    }
  }

  if (block.name === 'escalar_a_humano') {
    try {
      const { motivo, pedidoId } = block.input;
      await escalamientos.registrarEscalamiento(clienteId, userId, motivo, pedidoId ?? null);
      if (pedidoId) await pedidos.marcarComoReclamado(clienteId, pedidoId);
      return 'Escalamiento registrado. Avisale al cliente que alguien del equipo se va a contactar pronto.';
    } catch (err) {
      return `Error al registrar el escalamiento: ${err.message}`;
    }
  }

  if (block.name === 'crear_pedido') {
    try {
      const resultado = await pedidos.crearPedido(clienteId, userId, block.input.items, block.input.notas);
      if (!resultado.ok) {
        return `No se pudo crear el pedido:\n${resultado.errores.join('\n')}`;
      }

      // No se espera esta promesa: si el mail tarda o falla, no tiene que
      // demorar ni romper la confirmación del pedido por WhatsApp.
      cliente.getEmail(clienteId).then(clienteEmail => {
        email.enviarNotificacionPedido(clienteEmail, resultado.pedidoId, resultado.items, resultado.total);
      }).catch(err => console.error('[email] Error al buscar el email del Cliente:', err.message));

      return `Pedido #${resultado.pedidoId} creado con éxito. Total: $${resultado.total}.`;
    } catch (err) {
      return `Error al crear el pedido: ${err.message}`;
    }
  }

  if (block.name === 'buscar_pedidos_cliente') {
    try {
      const rows = await pedidos.buscarPedidosCliente(clienteId, userId);
      await pedidos.registrarConsultaPedido(clienteId, userId, rows);
      return rows.length ? JSON.stringify(rows) : 'Este cliente no tiene pedidos registrados.';
    } catch (err) {
      return `Error al consultar los pedidos: ${err.message}`;
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
async function generateResponse(clienteId, userId, messages) {
  const conversationMessages = [...messages];
  const fotos = [];
  const systemPrompt = await buildSystemPrompt(clienteId);
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
        // Caché automática: el system prompt y las tools son iguales en cada llamada,
        // así que las siguientes se cobran mucho más barato.
        cache_control: { type: 'ephemeral' },
        system: systemPrompt,
        messages: conversationMessages,
        tools,
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
      const text = response.content.find(block => block.type === 'text')?.text ?? '';
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
      if (block.name === 'crear_pedido') pedidoCreado = true;
      if (block.name === 'buscar_pedidos_cliente') consultoPedidos = true;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: await ejecutarTool(clienteId, userId, block, fotos),
      });
    }

    conversationMessages.push({ role: 'user', content: toolResults });
  }

  logs.warn('claude_sin_respuesta', { clienteId, userId, detalle: 'Se llegó al tope de 5 vueltas de tools sin respuesta final' });
  return { text: 'Lo siento, no pude procesar tu consulta en este momento.', fotos: [], inputTokens, outputTokens, costoUsd: costoTotal, escalado, pedidoCreado, consultoPedidos, revisionHumana: null };
}

module.exports = { generateResponse };
