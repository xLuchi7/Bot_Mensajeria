# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js/Express server that acts as a Meta webhook receiver and AI-powered messaging bot for WhatsApp Business API, Instagram Messaging API, and Facebook Messenger. Incoming messages are processed by Anthropic Claude and replies are sent back via the Meta Graph API.

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express 5
- **AI:** `@anthropic-ai/sdk` — Anthropic Claude
- **HTTP client:** Axios — outbound calls to Meta Graph API
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
| `SYSTEM_PROMPT` | Bot personality / instructions |
| `CLAUDE_MODEL` | Model ID (default: `claude-sonnet-4-6`) |
| `MAX_HISTORY` | Messages kept per user session (default: 20) |

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
    claudeService.js              Wraps client.messages.create with system prompt
    metaService.js                sendWhatsAppMessage / sendInstagramMessage / sendFacebookMessage
    conversationService.js        In-memory Map<userId, Message[]> with sliding window
```

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

### Conversation history

Stored in a `Map` in `conversationService.js`. The sliding window trims entries older than `MAX_HISTORY`. This is in-memory only — data is lost on restart. Database persistence is a planned next step.

### Adding a new platform

1. Add its access token to `src/config/index.js` and `.env.example`.
2. Add a `sendXxxMessage()` function to `metaService.js`.
3. Add a `processXxx(entry)` handler in `webhookController.js` and dispatch on `object` value.

## Meta Webhook Registration

- **Callback URL:** `https://<your-domain>/webhook` or `/webhook/instagram`, `/webhook/whatsapp`, `/webhook/facebook`
- **Verify token:** value of `META_VERIFY_TOKEN`
- **Subscribed fields:** `messages` (WhatsApp), `messages` (Instagram), `messages` (Messenger)
- **App Secret:** from Meta App Dashboard → Settings → Basic → App Secret. Must match `META_APP_SECRET` exactly — regenerate and redeploy if there's any doubt.
