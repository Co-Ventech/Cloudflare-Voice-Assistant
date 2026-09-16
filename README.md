# cf-voice-agent

A voice assistant that runs entirely on Cloudflare's edge — no OpenAI, no ElevenLabs, no third-party API keys. Speech in, speech out, all inference done by Workers AI.

Built on [Vinext](https://github.com/cloudflare/vinext) — Cloudflare's experimental Vite plugin that reimplements the Next.js API surface, deployed natively to Cloudflare Workers.

## How it works

1. Press the mic button and talk. Recording stops when you press it again.
2. The clip is sent to `/api/voice`, which runs three Workers AI models in sequence:
   - **[Whisper large-v3-turbo](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)** (`@cf/openai/whisper-large-v3-turbo`) — speech to text
   - **[GPT-OSS-20B](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)** (`@cf/openai/gpt-oss-20b`) — generates a short conversational reply, given the transcript and recent turns
   - **[Aura-1](https://developers.cloudflare.com/workers-ai/models/aura-1/)** (`@cf/deepgram/aura-1`) — text to speech
3. The reply transcript and synthesized audio come back in one response and play automatically.

Conversation history is kept client-side (in memory, cleared on refresh) and replayed to the model on each turn, capped at the last 6 turns to keep replies fast.

## Features

- Push-to-talk voice UI with a live waveform-style pulse while recording
- Full conversational memory within a session
- Rate limited per IP (30 requests/hour) to control Workers AI usage
- No accounts, no external API keys — only your own Cloudflare account

## Stack

- Vinext (App Router, Route Handlers) + TypeScript + Tailwind CSS
- Workers AI (Whisper, GPT-OSS-20B, Aura-1) via the `AI` binding
- Workers KV for rate limiting

## Getting started

```bash
npm install
npm run dev
```

Workers AI bindings always call Cloudflare's real inference endpoints — even in local dev — so you need to be logged in (`npx wrangler login`) for the mic to produce a reply.

## Deploying to Cloudflare Workers

1. `npx wrangler login`
2. Create the two KV namespaces this app needs:
   ```bash
   npx wrangler kv namespace create cf_voice_agent_cache
   npx wrangler kv namespace create cf_voice_agent_voice
   ```
   Paste each returned `id` into the matching entry in `wrangler.jsonc`.
3. `npm run build && npm run deploy`

## Project structure

```
app/
  page.tsx                # Push-to-talk UI, conversation transcript
  api/voice/route.ts        # POST — transcribe, generate a reply, synthesize speech
lib/
  voice.ts                     # Model ids, history sanitization, base64 helpers
  ratelimit.ts                    # Fixed-window KV rate limiter
  clientinfo.ts                      # Client IP extraction
wrangler.jsonc                         # Worker config: name, KV bindings, AI binding
```

## Testing notes

The full pipeline (record → transcribe → reply → speak) was verified locally by generating a synthetic speech clip via Aura-1 ("Hello, what is the capital of France?"), posting it to `/api/voice`, and confirming Whisper transcribed it correctly, GPT-OSS-20B replied "Paris.", and Aura-1 returned valid playable MP3 audio — including a second turn that correctly used the prior exchange as context. `lib/voice.ts` and `lib/ratelimit.ts` are covered by the Vitest suite (`npm test`).
