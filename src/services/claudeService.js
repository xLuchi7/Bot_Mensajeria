const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const articulos = require('./articuloService');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const tools = [
  {
    name: 'buscar_articulos',
    description: 'Busca artículos en el catálogo del cliente por nombre, descripción o código, e informa precio y stock disponible.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Palabra clave para buscar, ej: "auriculares"' },
      },
      required: ['texto'],
    },
  },
];

async function ejecutarTool(clienteId, block) {
  if (block.name !== 'buscar_articulos') {
    return `Tool desconocida: ${block.name}`;
  }

  try {
    const rows = await articulos.buscarArticulos(clienteId, block.input.texto);
    return rows.length ? JSON.stringify(rows) : 'No se encontraron artículos que coincidan.';
  } catch (err) {
    return `Error al consultar el catálogo: ${err.message}`;
  }
}

/**
 * @param {number} clienteId
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<string>}
 */
async function generateResponse(clienteId, messages) {
  const conversationMessages = [...messages];

  for (let i = 0; i < 5; i++) {
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system: config.anthropic.systemPrompt,
      messages: conversationMessages,
      tools,
    });

    if (response.stop_reason !== 'tool_use') {
      return response.content.find(block => block.type === 'text')?.text ?? '';
    }

    conversationMessages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: await ejecutarTool(clienteId, block),
      });
    }

    conversationMessages.push({ role: 'user', content: toolResults });
  }

  return 'Lo siento, no pude procesar tu consulta en este momento.';
}

module.exports = { generateResponse };
