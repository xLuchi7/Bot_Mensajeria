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
| `CLAUDE_MODEL` | Model ID (default: `claude-sonnet-5`) |
| `MAX_HISTORY` | Messages kept per user session (default: 20) |
| `DB_SERVER` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` / `DB_PORT` | Azure SQL connection for conversation history |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Gmail account + App Password used to email a Cliente when a Pedido is created |

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
    claudeService.js              Builds the system prompt (prompts/base.txt + Clientes.contextoNegocio) and runs the tool-use loop for buscar_articulos / escalar_a_humano / crear_pedido / buscar_pedidos_cliente
    metaService.js                sendWhatsAppMessage / sendInstagramMessage / sendFacebookMessage / sendTypingIndicator
    conversationService.js        Azure SQL-backed history (Mensajes table, never trimmed); getHistory() reads back only the last MAX_HISTORY rows
    clienteService.js             Resolves ClienteId from the WhatsApp number that received the message
    articuloService.js            Queries Articulos + Stock for a Cliente (buscar_articulos), logs every search to ConsultasArticulo
    pedidoService.js              Validates stock and creates a Pedido + DetallePedidos transactionally (crear_pedido); buscarPedidosCliente + registrarConsultaPedido back buscar_pedidos_cliente, logging to ConsultasPedido
    escalamientoService.js        Logs cases the bot hands off to a human (Escalamientos table)
    emailService.js               Emails the Cliente a summary when a Pedido is created (Gmail via nodemailer)
    dedupeService.js              Claims each inbound WhatsApp message id so Meta's webhook retries don't get processed twice
    db.js                         mssql connection pool (singleton via getPool()); resets itself on connect failure or a dropped pool instead of caching a broken connection forever
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

Stored in Azure SQL, table `Mensajes`, scoped by `clienteId` + `userId`. Rows are never deleted on write — `Mensajes` is also the audit log the client Portal reads, so it has to keep everything. `getHistory()` limits what gets sent to Claude to the last `MAX_HISTORY` rows via `TOP (@max) ... ORDER BY id DESC`; that's a read-time limit, not a storage limit. (An earlier version also deleted older rows to bound table growth — that was removed once the Portal needed full history; it was silently destroying the audit trail it was supposed to be part of.) `db.js` holds a single lazily-created `mssql` connection pool for the process.

### Product lookups (tool use)

`claudeService.generateResponse(clienteId, userId, messages)` runs an agentic loop (up to 5 turns) with four tools defined inline:

- `buscar_articulos` — `articuloService.buscarArticulos()` does a `LIKE` search over `Articulos.nombre/descripcion/codigo` scoped to that `clienteId`, left-joined with `Stock`. Every lookup (found or not) is logged to `ConsultasArticulo` for demand analysis, including a `stockAlConsultar` snapshot (NULL if the item doesn't use stock, or if nothing matched) so the Portal can surface "searched while out of stock" cases separately from a plain miss. Testing surfaced a specific reliability gap: once Claude says something like "no vendemos celulares" in one turn (e.g. because `contextoNegocio` describes the business narrowly, or an earlier search for a generic term found nothing), it tends to treat that as settled and skip the tool entirely on a later, more specific question — even though the catalog may have exactly that item. Both `base.txt` and this tool's own description now explicitly call out that a prior "no lo tenemos" in the conversation is not a fact to stay consistent with; both needed reinforcing (base.txt alone got it to call the tool ~2/3 of the time replaying a real contaminated conversation, the tool description got it to 8/8) since the model weighs the two texts differently.
- `escalar_a_humano` — for complaints, returns, or anything outside the bot's scope. Logs to `Escalamientos` (`clienteId`, `userId`, `motivo`, optional `pedidoId`) so the business can follow up; the bot just tells the customer someone from the team will reach out. If Claude identified the order with certainty (usually via `buscar_pedidos_cliente`), it also passes `pedidoId`, and `pedidoService.marcarComoReclamado()` flips that `Pedido` to `estado = 'reclamado'` — but only if it's currently `entregado`, since the Portal's stock-return-on-resolve logic (see "Orders") only makes sense once stock was actually decremented.
- `crear_pedido` — see "Orders" below.
- `buscar_pedidos_cliente` — `pedidoService.buscarPedidosCliente()` returns this specific end-customer's last 10 `Pedidos` with items, so Claude can answer status questions ("¿llegó mi pedido?") directly instead of escalating, and can identify which order a complaint refers to instead of guessing a `Pedido` number. Every call is logged to `ConsultasPedido` (one row per order returned, or one row with a NULL `pedidoId` if the customer has none) for the same "did we forget to follow up" review in the Portal.

Tool-use turns are not persisted to `Mensajes` — only the final user message and final assistant text go into history — so each reply re-queries the catalog fresh rather than remembering past lookups.

`ConsultasArticulo` and `ConsultasPedido` are unioned by a SQL view, `VConsultas` (`tipo` = `'articulo'`/`'pedido'`), so the Portal can list both kinds of consultas in one screen instead of building two separate pages.

### Orders (Pedidos)

The prompt requires a two-step flow: Claude must summarize the order and ask for explicit confirmation in plain text first, and only call `crear_pedido` on the customer's next message once they confirm. `pedidoService.crearPedido()` re-resolves each item by exact `nombre` match (Claude never sees internal `articuloId`s), validates stock is sufficient for every line **without decrementing it** (stock adjustment is manual, left to the client via the future portal — some clients sell through other channels too, so auto-decrementing could desync), and inserts `Pedidos` + `DetallePedidos` inside a single transaction — if any line fails validation, nothing is created. `precioUnitario`/`subtotal` are snapshotted at order time so later price changes don't retroactively alter past orders.

**State machine** (`Pedidos.estado`, enforced in `Portal_Mensajeria`'s `pedidoService.actualizarEstado()`): `pendiente` → `confirmado` → `entregado` | `cancelado` (both final under normal flow; stock is decremented only on the transition to `entregado`, never at creation). Outside that normal flow, this bot can flip an `entregado` order straight to `reclamado` (see `escalar_a_humano` above) — the Portal then only allows `reclamado` → `solucionado`, which reverses the stock decrement and auto-resolves any `Escalamientos` row with a matching `pedidoId`, and is itself final.

**Email notification**: right after a successful `crear_pedido`, `emailService.enviarNotificacionPedido()` sends the Cliente (their `Clientes.email`, if set) a summary of the new order — fire-and-forget (not awaited), so a slow or failing send never delays or breaks the WhatsApp confirmation the customer already got. Uses Gmail via `nodemailer` with an App Password (`GMAIL_USER`/`GMAIL_APP_PASSWORD`) rather than a transactional provider — fine at current volume, but Gmail's sending limits and deliverability make it worth revisiting (e.g. Resend, which needs a verified sending domain the business doesn't have yet) if this scales up. With no `GMAIL_USER` configured, it logs a warning and no-ops instead of failing.

Neither `escalar_a_humano` nor `crear_pedido` are reliably called by the model just because the prompt says to — testing showed Claude will sometimes produce the confirmation-sounding text without invoking the tool, since nothing forces it the way missing catalog data forces `buscar_articulos`. `generateResponse()` returns `escalado`/`pedidoCreado`/`consultoPedidos` booleans reflecting whether each tool actually fired; `webhookController.buildReply()` cross-checks those against simple regexes over the message/reply text (`PATRON_RECLAMO`, `PATRON_PEDIDO_CONFIRMADO`). For escalations, a false negative auto-inserts an `[Auto-detectado]` row into `Escalamientos` (losing a real complaint is worse than a false positive) — but only if `consultoPedidos` is also false, since `PATRON_RECLAMO` matches phrasing ("no me llegó") that's also valid for a plain status question Claude already answered correctly via `buscar_pedidos_cliente`; overriding that informed decision with the regex would create a duplicate, misleading `Escalamiento` for a case that wasn't actually a complaint. For orders, a mismatch only logs a `[pedido] Posible pedido "fantasma"` warning — auto-creating an order from a regex guess of which items/quantities were involved is worse than not creating one.

### System prompt (base + per-Cliente context)

The prompt is no longer a single env var. `prompts/base.txt` holds the general, versioned behavior (tone, WhatsApp formatting, how to interpret `buscar_articulos` results) and is shared by every Cliente. `claudeService.buildSystemPrompt()` appends `Clientes.contextoNegocio` (business name, hours, policies, etc.) to that base before each call — so a client's personality is a DB update, not a redeploy. `Portal_Mensajeria` exposes this as a "Mi Negocio" page (free-text `<textarea>`) so each Cliente edits their own context directly instead of needing someone to run SQL.

The append isn't a bare concatenation — it's prefixed with a line that explicitly gives `contextoNegocio` priority over the base prompt's "Estilo" section specifically (so a Cliente can ask for emojis, a different tone, a fixed sign-off, etc., overriding that section) while every other instruction (catalog handling, order flow, escalation, tool-calling rules) stays non-negotiable. Testing showed this framing matters: without a clear section break telling the model these are instructions to weigh (not just background text), even style requests that didn't conflict with anything (e.g. "terminate every message with '!!!'") were silently ignored.

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
