# Cloudflare Voice Agent

A realtime voice assistant running entirely on Cloudflare's edge. Speech in, speech out, with all inference on Workers AI — no OpenAI, no ElevenLabs, no third-party API keys.

Audio streams over a single WebSocket into a Durable Object, and turn detection happens server-side: there is no push-to-talk button. You speak, it detects when you've finished, and it replies aloud.

## Features

- Continuous audio streaming with automatic end-of-turn detection
- Conversation memory persisted in Durable Object SQLite, surviving reconnects
- 12 selectable voices and three selectable language models
- Barge-in — talk over the assistant to interrupt it
- Live transcript with interim results, and a microphone input meter
- Optional tools (time, reminders) on models that support tool calling
- Built-in observability: structured client and server logging, plus an in-app debug panel

## Architecture

```
Browser                            Durable Object (MyVoiceAgent)
┌──────────┐   binary WS frames    ┌──────────────────────────┐
│ Mic PCM  │ ────────────────────► │ Flux STT (streaming)     │
│ (16 kHz) │                       │   ↓ onUtterance          │
│          │   JSON: transcript    │   ↓                      │
│          │ ◄──────────────────── │ streamText (LLM)         │
│          │   binary: MP3 audio   │   ↓ clause chunking      │
│ Speaker  │ ◄──────────────────── │ Aura-1 TTS               │
└──────────┘                       └──────────────────────────┘
         single WebSocket · /agents/my-voice-agent/:sessionId
```

1. The browser captures microphone audio through an AudioWorklet and streams 16 kHz mono PCM as binary WebSocket frames.
2. `@cf/deepgram/flux` transcribes continuously and detects end-of-turn itself — no client-side silence timer, no button.
3. The transcript goes to the selected model via `streamText()`.
4. Streamed output is split at clause boundaries and synthesized incrementally, so audio begins before the reply finishes generating.
5. Transcript text and MP3 audio stream back over the same socket.

This is a plain Vite + React + Workers project rather than Vinext, because Vinext's Worker entry point cannot also export a Durable Object class, which this architecture requires.

## Models

| Stage | Model |
|---|---|
| Speech-to-text | `@cf/deepgram/flux` — streaming, with built-in end-of-turn detection |
| Language model | `@cf/meta/llama-3.2-1b-instruct` (default), `@cf/deepseek-ai/deepseek-v4-flash-0731`, or `@cf/openai/gpt-oss-20b` |
| Text-to-speech | `@cf/deepgram/aura-1` — 12 voices |

### Model selection

Seven candidate models were benchmarked for time-to-first-token, which is what gates first audio in a streaming pipeline.

| Model | TTFT | Total | Outcome |
|---|---|---|---|
| `llama-3.2-1b-instruct` | 260–390 ms | 0.75–1.3 s | **Default** ("fastest") |
| `deepseek-v4-flash-0731` | 0.95–1.7 s | 2.0–2.3 s | **"Balanced"** — best quality/speed tradeoff |
| `gpt-oss-20b` | 1.0–1.8 s | 1.2–2.1 s | **"Quality"** — reasoning overhead adds latency |
| `llama-3.2-3b-instruct` | 320–440 ms | 0.65–0.75 s | Excluded — `workers-ai-provider` returns duplicated, garbled tokens for this model |
| `llama-3.1-8b-instruct-fp8` | 0.5–1.1 s | 3.0–3.4 s | Not selected |
| `granite-4.0-h-micro` | 1.0–2.6 s | 1.7–3.4 s | Inconsistent |
| `glm-4.7-flash` | 5.7–9.6 s | 6.0–9.9 s | Too slow for voice |

A 1–3 sentence spoken reply does not need a large reasoning model, so selection is biased heavily toward low latency.

### Tool calling

Tools (`get_current_time`, `set_reminder`) are **opt-in** and disabled by default, because a tool call requires two sequential model round trips and adds roughly 1.5–2 s per turn.

Tool-calling support is not universal. Verified against both Cloudflare's model catalog and direct testing:

| Model | Tool calling |
|---|---|
| `llama-3.2-1b-instruct` | Not supported |
| `deepseek-v4-flash-0731` | Supported |
| `gpt-oss-20b` | Supported |

Models without support emit the tool call as plain assistant text rather than through the structured tool-call channel. Three safeguards handle this: the tools checkbox is disabled with an explanation when an unsupported model is selected, the server refuses tool requests for such models regardless of client input, and a guard detects any leaked tool-call JSON before it reaches text-to-speech, retrying the turn without tools so the user still receives a real answer.

## Voices

```
angus (default), asteria, arcas, orion, orpheus, athena,
luna, zeus, perseus, helios, hera, stella
```

Changing the voice or model reconnects the call, taking effect on the next turn.

## Latency

Measured from the SDK's own `turn_metrics` on real end-to-end turns:

| Metric | Before | After |
|---|---|---|
| Time to first token | 1971 ms | 1256 ms |
| End-of-turn → first audio | 2773 ms | 1970 ms |
| Total turn | 4650 ms | 3486 ms |

Improvements came from defaulting to a smaller model, making tools opt-in, and synthesizing the first TTS chunk at a clause boundary rather than a full sentence. On one longer reply, total TTS work was 2504 ms while first audio arrived at 870 ms.

These figures were measured in local development, where every inference call is proxied from the developer's machine to Cloudflare and back. A deployed Worker runs in the same datacenter as the models, and should be substantially faster.

## Observability

Structured logging is built in, since a browser → WebSocket → Durable Object → STT → LLM → TTS pipeline is impractical to debug without it.

- **Client** (`[voice]` prefix, browser console and in-app debug panel): microphone permission results, AudioContext state, WebSocket lifecycle, frames and bytes sent, live input level.
- **Server** (`npm run dev` output, or `wrangler tail` in production): audio frames received, STT session state and transcripts, model selection and timing, TTS chunks and byte counts, all errors with context.

The in-app debug panel is off by default and toggled from the UI.

## Rate limiting

A streaming call has no discrete requests to limit, so the KV fixed-window limiter is applied to **new WebSocket connection attempts**: 40 per hour per IP, returning `429` beyond that.

## Setup

```bash
npm install
npx wrangler login
npm run dev
```

Workers AI always calls Cloudflare's real inference endpoints, including in local development, so you must be logged in — and **usage is billed to your account even locally**.

Open the printed URL, click the orb, allow microphone access, and talk.

## Use your own Cloudflare account

### Prerequisites

- Node.js 22 or later
- A Cloudflare account, logged in via `npx wrangler login`
- Workers AI has a free-tier allowance and is billed beyond it — see [current pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

### 1. Create the KV namespace

```bash
npx wrangler kv namespace create voice-kv
```

### 2. Edit `wrangler.jsonc`

The committed file ships with a placeholder so a missed field fails loudly rather than pointing at another account's resources.

| Field | Set to |
|---|---|
| `kv_namespaces[0].id` | The `id` printed above, replacing `<YOUR_KV_NAMESPACE_ID>` |
| `name` | Your Worker's name, if different |

### 3. Deploy

```bash
npm run build && npm run deploy
```

### Bindings this Worker requires

- `ai` binding named `AI`, with `remote: true` — Workers AI for STT, the LLM, and TTS
- `kv_namespaces` binding named `VOICE_KV` — connection rate limiting
- `durable_objects` binding named `MyVoiceAgent` with `class_name: "MyVoiceAgent"`
- a `migrations` entry enabling SQLite for that class:
  ```jsonc
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyVoiceAgent"] }]
  ```
  This is required — conversation history is persisted in the Durable Object's SQLite storage, which only exists for classes migrated as `new_sqlite_classes`.
- `assets` with `not_found_handling: "single-page-application"` and `run_worker_first: ["/agents/*"]`, so the WebSocket route always reaches the Worker while everything else falls back to the SPA shell.

## Troubleshooting

- **No microphone prompt appears** — check the browser's site permissions. Client logs record the exact `getUserMedia` error under the `[voice]` prefix.
- **Connected, but nothing is transcribed** — open the debug panel and confirm frames and bytes are being sent. A flat input meter indicates capture never started; a moving meter with no response points at the server side.
- **"Speech recognition connection was lost"** — the STT WebSocket dropped. The app retries automatically. This is most common in local development, where that connection is tunnelled through the local dev proxy.
- **Very low input level** — raise the microphone gain in the operating system's sound settings. Low input measurably degrades transcription accuracy.
- **The tools checkbox is disabled** — the selected model does not support tool calling. Switch to "balanced" or "quality".

## Project structure

```
src/
  server.ts              # Durable Object: STT, LLM, TTS pipeline, tools, logging
  App.tsx                  # UI: orb, transcript, pickers, debug panel
  main.tsx                   # React entry point
  lib/client-logger.ts         # Client-side structured logging
lib/
  voice.ts                       # Model and voice config, tool-support flags
  toolcall-guard.ts                # Detects and suppresses leaked tool-call JSON
  tts-chunking.ts                    # Clause-boundary chunking for first audio
  ratelimit.ts                         # Fixed-window KV rate limiter
  clientinfo.ts                          # Client IP extraction
wrangler.jsonc                             # AI, KV, and Durable Object bindings
```

## Testing

`npm test` runs the Vitest suite (49 tests) covering voice and model resolution, tool-support gating, tool-call leak detection, and TTS chunking.

The full pipeline was verified end to end by synthesizing speech with Aura-1, streaming it into the real WebSocket as PCM with no end-of-speech signal, and confirming automatic turn detection, transcription, model response, and synthesized audio return.

**Not verified:** real microphone capture in a browser, including the permission prompt, AudioWorklet behaviour with a physical device, and the input meter responding to live speech. No microphone was available in the development environment.
