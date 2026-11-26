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
    // Haiku 5.5: ~20 veces más barato que Sonnet 5 y le sobra para atención por WhatsApp.
    model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
    // low | medium | high. En Haiku 5.5 el razonamiento viene prendido; 'low' alcanza
    // para un chat, gasta menos tokens y responde más rápido.
    effort: process.env.CLAUDE_EFFORT || 'low',
    // El razonamiento también cuenta para este tope: con menos de ~2000 se puede cortar la respuesta.
    maxTokens: parseInt(process.env.MAX_TOKENS || '2048', 10),
  },
  // Revisión humana: si el número de alertas no le escribió al bot en 24 hs, WhatsApp
  // solo deja mandarle una plantilla aprobada ({{1}} número del cliente, {{2}} motivo).
  alertas: {
    plantilla: process.env.ALERTA_PLANTILLA || null,
    idioma: process.env.ALERTA_PLANTILLA_IDIOMA || 'es_AR',
  },
  conversation: {
    maxHistory: parseInt(process.env.MAX_HISTORY || '20', 10),
  },
  db: {
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '1433', 10),
  },
  // Token compartido con Portal_Mensajeria (su BOT_API_TOKEN) para /portal/*.
  // Sin esto configurado, el Portal no puede mandar mensajes.
  // PORTAL_URL (opcional, sin "/" final): para avisarle al Portal en tiempo real
  // cuando hay mensajes, reclamos o pedidos nuevos (usa el mismo token).
  portal: {
    apiToken: process.env.PORTAL_API_TOKEN,
    url: (process.env.PORTAL_URL || '').replace(/\/+$/, ''),
  },
  email: {
    gmailUser: process.env.GMAIL_USER,
    gmailAppPassword: process.env.GMAIL_APP_PASSWORD,
  },
};
