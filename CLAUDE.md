# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js/Express server that acts as a Meta webhook receiver and AI-powered messaging bot for WhatsApp Business API, Instagram Messaging API, and Facebook Messenger. Incoming messages are processed by Anthropic Claude and replies are sent back via the Meta Graph API.

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express 5
- **AI:** `@anthropic-ai/sdk` — Anthropic Claude
- **HTTP client:** Axios — outbound calls to Meta Graph API
- **Database:** Azure SQL (via `mssql`) — conversation history persistence
- **Config:** dotenv

## Commands

```bash
npm run dev      # development with auto-reload (nodemon)
npm start        # production
```

No test runner is configured yet.

## Environment Setup

Copy `.env.example` to `.env` and fill in all values before running. Key variables:

| Variable | Purpose |
|---|---|
| `META_APP_SECRET` | HMAC key for webhook signature validation |
| `META_VERIFY_TOKEN` | Any string — must match what you enter in Meta dashboard |
| `WHATSAPP_ACCESS_TOKEN` / `INSTAGRAM_ACCESS_TOKEN` / `FACEBOOK_ACCESS_TOKEN` | Per-platform Graph API tokens |
| `ANTHROPIC_API_KEY` | Claude API key |
| `CLAUDE_MODEL` | Model ID (default: `claude-sonnet-4-6`) |
| `MAX_HISTORY` | Messages kept per user session (default: 20) |
| `DB_SERVER` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` / `DB_PORT` | Azure SQL connection for conversation history |

## Architecture

```
index.js                          Entry point — Express setup, mounts /webhook
src/
  config/index.js                 Single source of truth for all env vars
  routes/webhook.js               GET (verification) + POST (messages) routes
  middleware/verifySignature.js   validateMetaSignature (HMAC-SHA256 middleware)
  controllers/webhookController.js  Dispatches by platform object type
                                    (whatsapp_business_account / instagram / page)
  services/
    claudeService.js              Builds the system prompt (prompts/base.txt + Clientes.contextoNegocio) and runs the tool-use loop for buscar_articulos / escalar_a_humano / crear_pedido
    metaService.js                sendWhatsAppMessage / sendInstagramMessage / sendFacebookMessage / sendTypingIndicator
    conversationService.js        Azure SQL-backed history (Mensajes table) with sliding window, scoped by ClienteId + UserId
    clienteService.js             Resolves ClienteId from the WhatsApp number that received the message
    articuloService.js            Queries Articulos + Stock for a Cliente, used by the buscar_articulos tool
    pedidoService.js              Validates stock and creates a Pedido + DetallePedidos transactionally, used by crear_pedido
    escalamientoService.js        Logs cases the bot hands off to a human (Escalamientos table)
    dedupeService.js              Claims each inbound WhatsApp message id so Meta's webhook retries don't get processed twice
    db.js                         mssql connection pool (singleton via getPool())
```

Table creation scripts live outside the repo: `D:\Projects Prog\Queries\BotMensajeria\BotMensajeria.sql` (run manually in SSMS).

### Webhook flow

1. Meta sends POST to `/webhook` with `x-hub-signature-256` header.
2. A scoped stream-reader middleware on `/webhook` captures raw bytes directly from the HTTP socket into `req.rawBody`, then manually parses JSON into `req.body`.
3. `validateMetaSignature` verifies HMAC-SHA256 of `req.rawBody` against the header.
4. Controller responds `200` immediately (Meta requires < 20 s), then processes async.
5. `buildReply()` appends the user message to history, calls Claude, appends the assistant reply, and returns the text.
6. `metaService` sends the reply via the appropriate Graph API endpoint.

### Critical: middleware order in index.js

The raw body capture for `/webhook` **must** be registered before any `express.json()` global middleware. `express.json()` consumes the request stream; if it runs first the raw bytes are gone and HMAC validation will always fail.

```
app.use('/webhook', rawStreamReader)   // 1st — captures req.rawBody
app.use('/webhook', webhookRoutes)     // 2nd — routes with validateMetaSignature
app.use(express.json())                // 3rd — for all other routes only
```

`express.raw({ type: 'application/json' })` was tried but caused the same mismatch — it applies globally and may transform the body before HMAC validation. The direct stream reader is the reliable solution.

### Multi-tenant model (Clientes)

`Bot_Mensajeria` serves multiple business clients from one deployment — `Clientes` is *our* customers (e.g. a company using the bot), not the end users texting them. Each `Cliente` row has a `telefono` (their WhatsApp Business number, digits only, no `+`/spaces/dashes).

On every inbound WhatsApp message, `clienteService.resolveClienteIdByPhone()` looks up the `Cliente` by matching `metadata.display_phone_number` from the webhook payload against `Clientes.telefono`. If no match is found, the message is logged and dropped — **adding a new client only requires inserting a row in `Clientes`, no code changes or redeploy.**

Instagram and Facebook don't have this resolution wired up yet (`Clientes` has no page-ID column) — `processInstagram`/`processFacebook` currently just log and skip. WhatsApp is the only platform live for now; Instagram and Facebook are next.

### Duplicate webhook deliveries

Meta retries the webhook if it doesn't get a fast `200`, which would otherwise process (and reply to) the same inbound message twice. `dedupeService.yaFueProcesado()` tries to `INSERT` the WhatsApp message's `id` into `MensajesWhatsAppProcesados` (`UNIQUE` constraint); a unique-violation means it's a retry, so `processWhatsApp` skips it silently.

### Conversation history

Stored in Azure SQL, table `Mensajes`, scoped by `clienteId` + `userId`. `conversationService.js` inserts each message and deletes rows beyond the `MAX_HISTORY` window per (`clienteId`, `userId`) pair on every write, so the table never grows past the active window per conversation. `db.js` holds a single lazily-created `mssql` connection pool for the process.

### Product lookups (tool use)

`claudeService.generateResponse(clienteId, userId, messages)` runs an agentic loop (up to 5 turns) with three tools defined inline:

- `buscar_articulos` — `articuloService.buscarArticulos()` does a `LIKE` search over `Articulos.nombre/descripcion/codigo` scoped to that `clienteId`, left-joined with `Stock`. Every lookup (found or not) is logged to `ConsultasArticulo` for demand analysis.
- `escalar_a_humano` — for complaints, returns, or anything outside the bot's scope. Logs to `Escalamientos` (`clienteId`, `userId`, `motivo`) so the business can follow up; the bot just tells the customer someone from the team will reach out.
- `crear_pedido` — see "Orders" below.

Tool-use turns are not persisted to `Mensajes` — only the final user message and final assistant text go into history — so each reply re-queries the catalog fresh rather than remembering past lookups.

### Orders (Pedidos)

The prompt requires a two-step flow: Claude must summarize the order and ask for explicit confirmation in plain text first, and only call `crear_pedido` on the customer's next message once they confirm. `pedidoService.crearPedido()` re-resolves each item by exact `nombre` match (Claude never sees internal `articuloId`s), validates stock is sufficient for every line **without decrementing it** (stock adjustment is manual, left to the client via the future portal — some clients sell through other channels too, so auto-decrementing could desync), and inserts `Pedidos` + `DetallePedidos` inside a single transaction — if any line fails validation, nothing is created. `precioUnitario`/`subtotal` are snapshotted at order time so later price changes don't retroactively alter past orders.

Neither `escalar_a_humano` nor `crear_pedido` are reliably called by the model just because the prompt says to — testing showed Claude will sometimes produce the confirmation-sounding text without invoking the tool, since nothing forces it the way missing catalog data forces `buscar_articulos`. `generateResponse()` returns `escalado`/`pedidoCreado` booleans reflecting whether each tool actually fired; `webhookController.buildReply()` cross-checks those against simple regexes over the message/reply text (`PATRON_RECLAMO`, `PATRON_PEDIDO_CONFIRMADO`). For escalations, a false negative auto-inserts an `[Auto-detectado]` row into `Escalamientos` (losing a real complaint is worse than a false positive). For orders, a mismatch only logs a `[pedido] Posible pedido "fantasma"` warning — auto-creating an order from a regex guess of which items/quantities were involved is worse than not creating one.

### System prompt (base + per-Cliente context)

The prompt is no longer a single env var. `prompts/base.txt` holds the general, versioned behavior (tone, WhatsApp formatting, how to interpret `buscar_articulos` results) and is shared by every Cliente. `claudeService.buildSystemPrompt()` appends `Clientes.contextoNegocio` (business name, hours, policies, etc.) to that base before each call — so onboarding a new client's personality is a DB update, not a redeploy.

Azure SQL requires the connecting IP to be allow-listed in the server's firewall (Networking blade in the Azure portal). Since the bot runs on Railway (not Azure), the "Allow Azure services" toggle doesn't help — Railway's outbound IP (or an open range, if Railway has no static IP on the current plan) needs to be added explicitly.

### Adding a new platform

1. Add its access token to `src/config/index.js` and `.env.example`.
2. Add a `sendXxxMessage()` function to `metaService.js`.
3. Add a `processXxx(entry)` handler in `webhookController.js` and dispatch on `object` value.
4. Wire up `clienteId` resolution for that platform (extend `Clientes` with a platform-specific ID column and resolve it in `clienteService.js`, same pattern as WhatsApp's phone lookup).

## Meta Webhook Registration

- **Callback URL:** `https://<your-domain>/webhook` or `/webhook/instagram`, `/webhook/whatsapp`, `/webhook/facebook`
- **Verify token:** value of `META_VERIFY_TOKEN`
- **Subscribed fields:** `messages` (WhatsApp), `messages` (Instagram), `messages` (Messenger)
- **App Secret (Instagram):** the correct secret is **NOT** the main Meta App Secret (Settings → Basic). For Instagram webhooks, use the **Instagram App Secret**: Meta App Dashboard → Instagram → panel left → "Clave secreta de la app de Instagram". Using the wrong secret causes persistent HMAC `signature mismatch` errors even though the body and code are correct.
