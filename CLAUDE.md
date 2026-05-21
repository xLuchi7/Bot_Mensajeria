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
  middleware/verifySignature.js   captureRawBody (express.json verify hook)
                                  + validateMetaSignature (HMAC middleware)
  controllers/webhookController.js  Dispatches by platform object type
                                    (whatsapp_business_account / instagram / page)
  services/
    claudeService.js              Wraps client.messages.create with system prompt
    metaService.js                sendWhatsAppMessage / sendInstagramMessage / sendFacebookMessage
    conversationService.js        In-memory Map<userId, Message[]> with sliding window
```

### Webhook flow

1. Meta sends POST to `/webhook` with `x-hub-signature-256` header.
2. `captureRawBody` stores the raw buffer; `validateMetaSignature` verifies HMAC-SHA256.
3. Controller responds `200` immediately (Meta requires < 20 s), then processes async.
4. `buildReply()` appends the user message to history, calls Claude, appends the assistant reply, and returns the text.
5. `metaService` sends the reply via the appropriate Graph API endpoint.

### Conversation history

Stored in a `Map` in `conversationService.js`. The sliding window trims entries older than `MAX_HISTORY`. This is in-memory only — data is lost on restart. Database persistence is a planned next step.

### Adding a new platform

1. Add its access token to `src/config/index.js` and `.env.example`.
2. Add a `sendXxxMessage()` function to `metaService.js`.
3. Add a `processXxx(entry)` handler in `webhookController.js` and dispatch on `object` value.

## Meta Webhook Registration

- **Callback URL:** `https://<your-domain>/webhook`
- **Verify token:** value of `META_VERIFY_TOKEN`
- **Subscribed fields:** `messages` (WhatsApp), `messages` (Instagram), `messages` (Messenger)

Use [ngrok](https://ngrok.com/) or a tunnel for local development: `ngrok http 3000`.
