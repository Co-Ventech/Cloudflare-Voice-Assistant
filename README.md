# Voice assistant on Cloudflare

A real-time voice assistant. You speak, it listens, thinks and answers out loud. There is no button to hold: it detects when you have finished talking.

Speech-to-text (Deepgram Flux) and text-to-speech (Deepgram Aura) run on Cloudflare Workers AI. The language model is either a Workers AI model or DeepSeek through its own API. Audio travels over one WebSocket into a Durable Object that keeps the conversation.

## Run it

You need Node 22+, a Cloudflare account and a microphone.

```bash
npm install
npx wrangler login
npm run dev          # http://127.0.0.1:5173
```

Open the link in Chrome, press **Start talking**, allow the microphone and speak. Headphones are recommended so the assistant doesn't hear itself.

Before you run it, edit `wrangler.jsonc`:

- Create a KV namespace (`npx wrangler kv namespace create VOICE_KV`) and replace `<YOUR_KV_NAMESPACE_ID>` with its id.

Workers AI is used even in local development (`remote: true`), so usage is billed to your Cloudflare account.

## DeepSeek direct API (optional)

The **DeepSeek direct API** model option calls `api.deepseek.com` with thinking switched off. In testing it gave the first word of a reply in under a second. It needs a key:

```bash
# local development: create .dev.vars (git-ignored)
echo DEEPSEEK_API_KEY=your-key > .dev.vars

# deployed Worker
npx wrangler secret put DEEPSEEK_API_KEY
```

Without a key, choosing this option falls back to the Cloudflare-hosted DeepSeek model.

## Deploy

```bash
npm run deploy
```

Run the deployed Worker rather than local development for real use or demos. Speech and voice requests then stay inside Cloudflare's network, which is noticeably faster and more stable than going through the local dev proxy.

## Using it

The page shows the state of the call: idle, listening (microphone live), thinking and speaking. Your words and the replies appear large on screen like subtitles, above a live waveform. Settings:

- **Voice:** 12 voices.
- **Model:**
  - **DeepSeek direct API:** fast and capable. Needs `DEEPSEEK_API_KEY`.
  - **Fastest** (Llama 3.2 1B): about 1 second per reply, but a small model.
  - **Balanced** (DeepSeek V4 Flash on Workers AI): slower, with reasoning turned off.
  - **Quality** (GPT-OSS 20B): slower still.
- **Tools:** optional. Lets the assistant tell the time and set reminders. Not available with the Fastest model.

You can also mute the microphone, download the conversation as text and open a debug panel.

## Behaviour worth knowing

- A reply is timed in stages: speech recognition, the model, then speech synthesis for each sentence.
- Only the last 12 messages and 256 tokens of reply are used, so long chats stay fast.
- If you speak while the assistant is answering, the answer in progress is cancelled.
- If the model sends nothing for several seconds, the turn is cancelled and retried on a fallback instead of leaving the call silent.

## Known issue in local development

"Speech recognition connection was lost" can appear when running through the local development proxy. The app reconnects, but the turn in progress is lost. Deploying the Worker avoids the local proxy.

## Tests

```bash
npm test
```

## Where things are

- `src/App.tsx`, `src/styles.css`: the page
- `src/server.ts`: the Durable Object (speech, model, voice, tools)
- `lib/`: voices and models, history limits, stall guard, sentence chunking, rate limiting, tool-call guard
- `README.original.md`: the original README
