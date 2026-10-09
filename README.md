# voice: talk to an AI assistant

A real-time voice assistant. You speak, it listens, thinks and answers out loud. There's no button to hold: it detects when you've finished talking.

Everything runs on Cloudflare Workers AI: speech-to-text (Deepgram Flux), a language model, and text-to-speech (Deepgram Aura). Audio travels over one WebSocket into a Durable Object that keeps the conversation.

## Run it

You need Node 22+, a Cloudflare account and a microphone.

```bash
npm install
npx wrangler login
npm run dev          # http://127.0.0.1:5173
```

Open the link in Chrome, press **Start talking**, allow the microphone, and speak. Headphones are strongly recommended, so the assistant doesn't hear itself.

`wrangler.jsonc` uses this account's KV namespace. For a different account, create your own and replace its id.

The AI always runs on Cloudflare, even locally, so usage is billed to your account.

## What you'll see

The page itself shows the state of the call:

- **Grey:** idle or thinking
- **Red ("on air"):** your microphone is live
- **Black:** the assistant is speaking

Your words and its replies appear huge on screen like subtitles, above a live waveform. Below are the settings:

- **Voice:** 12 voices to pick from.
- **Model:**
  - **Fastest** (Llama 3.2 1B): the default, and about 1 second per reply in testing.
  - **Balanced** (DeepSeek V4 Flash): about 2.6 to 3.9 seconds.
  - **Quality** (GPT-OSS 20B): slower still.
- **Tools:** optional. Lets the assistant tell the time and set reminders. Only the Balanced and Quality models support it.

You can also mute the mic, download the conversation as text, and open a debug panel from the top bar.

## Why it can feel slow

- **Replies are timed in stages:** speech recognition, the model, and about 0.5 to 1.3 seconds of speech synthesis per sentence. The Fastest model keeps it quickest.
- **Kept lean:** only the last 12 messages and 256 tokens of reply are used, so long chats don't slow it down.
- **If you speak again while it's answering,** the answer in progress is cancelled.

## Known issue in local development

"Speech recognition connection was lost" can appear. The speech service connection drops when run through the local development proxy. The app reconnects, but the turn is lost. Running the deployed version should avoid it. I haven't verified that.

## Tests

```bash
npm test             # 58 tests
```

## Where things are

- `src/App.tsx` and `src/styles.css`: the page
- `src/server.ts`: the Durable Object (speech, model, voice, tools)
- `lib/`: voices and models, history limits, rate limiting, tool-call guard
- `README.original.md`: the original, longer README
