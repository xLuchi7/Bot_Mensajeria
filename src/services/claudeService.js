const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const articulos = require('./articuloService');
const cliente = require('./clienteService');
const escalamientos = require('./escalamientoService');
const pedidos = require('./pedidoService');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });
const BASE_PROMPT = fs.readFileSync(path.join(__dirname, '../../prompts/base.txt'), 'utf8');

const tools = [
  {
    name: 'buscar_articulos',
    description: 'Busca artículos en el catálogo del cliente por nombre, descripción o código, e informa precio y disponibilidad. Llamala SIEMPRE que te pregunten por un producto, aunque ya hayas buscado algo parecido antes en la conversación — nunca reutilices una búsqueda vieja ni respondas de memoria, el catálogo puede haber cambiado. El campo "disponibilidad" es info interna para vos (no se la repitas al cliente tal cual): te dice si hay stock (ej: "3 en stock", o "0 en stock" que significa agotado — avisá que está agotado, no digas que no existe en el catálogo) o si el artículo está siempre disponible sin control de stock (en ese caso ofrecelo con normalidad, sin mencionar la frase "sin control de stock").',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Palabra clave para buscar, ej: "auriculares"' },
      },
      required: ['texto'],
    },
  },
  {
    name: 'escalar_a_humano',
    description: 'Llamala cuando el cliente necesite ayuda de una persona real del equipo: reclamos, devoluciones, problemas con un pedido, o cualquier cosa que no puedas resolver vos. Deja registro para que el equipo haga seguimiento; después avisale al cliente que alguien se va a poner en contacto, sin decir que sos un bot.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Breve resumen de por qué se escala, ej: "reclamo por producto dañado"' },
      },
      required: ['motivo'],
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
  return contexto ? `${BASE_PROMPT}\n${contexto}` : BASE_PROMPT;
}

async function ejecutarTool(clienteId, userId, block) {
  console.log(`[claude] Tool call: ${block.name} — cliente=${clienteId} user=${userId} input=${JSON.stringify(block.input)}`);

  if (block.name === 'buscar_articulos') {
    try {
      const rows = await articulos.buscarArticulos(clienteId, block.input.texto);
      await articulos.registrarConsulta(clienteId, userId, block.input.texto, rows);

      if (!rows.length) return 'No se encontraron artículos que coincidan.';

      // No hace falta que Claude vea el id interno ni los campos crudos de stock —
      // le resumimos la disponibilidad en un solo campo legible.
      const paraClaude = rows.map(({ articuloId, usaStock, cantidad, ...resto }) => ({
        ...resto,
        disponibilidad: usaStock ? `${cantidad} en stock` : 'siempre disponible (sin control de stock)',
      }));
      return JSON.stringify(paraClaude);
    } catch (err) {
      return `Error al consultar el catálogo: ${err.message}`;
    }
  }

  if (block.name === 'escalar_a_humano') {
    try {
      await escalamientos.registrarEscalamiento(clienteId, userId, block.input.motivo);
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
      return `Pedido #${resultado.pedidoId} creado con éxito. Total: $${resultado.total}.`;
    } catch (err) {
      return `Error al crear el pedido: ${err.message}`;
    }
  }

  if (block.name === 'buscar_pedidos_cliente') {
    try {
      const rows = await pedidos.buscarPedidosCliente(clienteId, userId);
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
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number, escalado: boolean, pedidoCreado: boolean, consultoPedidos: boolean}>}
 */
async function generateResponse(clienteId, userId, messages) {
  const conversationMessages = [...messages];
  const systemPrompt = await buildSystemPrompt(clienteId);
  let inputTokens = 0;
  let outputTokens = 0;
  let escalado = false;
  let pedidoCreado = false;
  let consultoPedidos = false;

  for (let i = 0; i < 5; i++) {
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: systemPrompt,
      messages: conversationMessages,
      tools,
    });

    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;

    if (response.stop_reason !== 'tool_use') {
      const text = response.content.find(block => block.type === 'text')?.text ?? '';
      return { text, inputTokens, outputTokens, escalado, pedidoCreado, consultoPedidos };
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
        content: await ejecutarTool(clienteId, userId, block),
      });
    }

    conversationMessages.push({ role: 'user', content: toolResults });
  }

  return { text: 'Lo siento, no pude procesar tu consulta en este momento.', inputTokens, outputTokens, escalado, pedidoCreado, consultoPedidos };
}

module.exports = { generateResponse };
