const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const articulos = require('./articuloService');
const cliente = require('./clienteService');
const escalamientos = require('./escalamientoService');

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

      // No hace falta que Claude vea el id interno del artículo
      const paraClaude = rows.map(({ articuloId, ...resto }) => resto);
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

  return `Tool desconocida: ${block.name}`;
}

/**
 * @param {number} clienteId
 * @param {string} userId
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number, escalado: boolean}>}
 */
async function generateResponse(clienteId, userId, messages) {
  const conversationMessages = [...messages];
  const systemPrompt = await buildSystemPrompt(clienteId);
  let inputTokens = 0;
  let outputTokens = 0;
  let escalado = false;

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
      return { text, inputTokens, outputTokens, escalado };
    }

    conversationMessages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'escalar_a_humano') escalado = true;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: await ejecutarTool(clienteId, userId, block),
      });
    }

    conversationMessages.push({ role: 'user', content: toolResults });
  }

  return { text: 'Lo siento, no pude procesar tu consulta en este momento.', inputTokens, outputTokens, escalado };
}

module.exports = { generateResponse };
