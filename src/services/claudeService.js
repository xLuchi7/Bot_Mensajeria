const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const articulos = require('./articuloService');
const cliente = require('./clienteService');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });
const BASE_PROMPT = fs.readFileSync(path.join(__dirname, '../../prompts/base.txt'), 'utf8');

const tools = [
  {
    name: 'buscar_articulos',
    description: 'Busca artículos en el catálogo del cliente por nombre, descripción o código, e informa precio y stock disponible. Si "cantidad" es 0, el artículo existe pero está sin stock — avisá que está agotado, no digas que no existe en el catálogo.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Palabra clave para buscar, ej: "auriculares"' },
      },
      required: ['texto'],
    },
  },
];

async function buildSystemPrompt(clienteId) {
  const contexto = await cliente.getContextoNegocio(clienteId);
  return contexto ? `${BASE_PROMPT}\n${contexto}` : BASE_PROMPT;
}

async function ejecutarTool(clienteId, userId, block) {
  if (block.name !== 'buscar_articulos') {
    return `Tool desconocida: ${block.name}`;
  }

  try {
    const rows = await articulos.buscarArticulos(clienteId, block.input.texto);
    await articulos.registrarConsulta(clienteId, userId, block.input.texto, rows);

    if (!rows.length) return 'No se encontraron artículos que coincidan.';

    // No hace falta que Claude vea el id interno del artículo
    const paraClaude = rows.map(({ articuloId, ...resto }) => resto);
    return JSON.stringify(paraClaude);
  } catch (err) {
    return `Error al consultar el catálogo: ${err.message}`;
  }
}

/**
 * @param {number} clienteId
 * @param {string} userId
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number}>}
 */
async function generateResponse(clienteId, userId, messages) {
  const conversationMessages = [...messages];
  const systemPrompt = await buildSystemPrompt(clienteId);
  let inputTokens = 0;
  let outputTokens = 0;

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
      return { text, inputTokens, outputTokens };
    }

    conversationMessages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: await ejecutarTool(clienteId, userId, block),
      });
    }

    conversationMessages.push({ role: 'user', content: toolResults });
  }

  return { text: 'Lo siento, no pude procesar tu consulta en este momento.', inputTokens, outputTokens };
}

module.exports = { generateResponse };
