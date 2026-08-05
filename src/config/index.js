module.exports = {
  port: process.env.PORT || 3000,
  meta: {
    appSecret: process.env.META_APP_SECRET,
    verifyToken: process.env.META_VERIFY_TOKEN,
    whatsappToken: process.env.WHATSAPP_ACCESS_TOKEN,
    instagramToken: process.env.INSTAGRAM_ACCESS_TOKEN,
    facebookToken: process.env.FACEBOOK_ACCESS_TOKEN,
    apiVersion: process.env.META_API_VERSION || 'v25.0',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    systemPrompt:
      process.env.SYSTEM_PROMPT ||
      'Eres un asistente útil, amigable y conciso. Responde siempre en el mismo idioma que el usuario.',
    maxTokens: parseInt(process.env.MAX_TOKENS || '1024', 10),
  },
  conversation: {
    maxHistory: parseInt(process.env.MAX_HISTORY || '20', 10),
  },
};
