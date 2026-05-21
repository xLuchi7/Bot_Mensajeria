const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<string>}
 */
async function generateResponse(messages) {
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    system: config.anthropic.systemPrompt,
    messages,
  });

  return response.content[0].text;
}

module.exports = { generateResponse };
