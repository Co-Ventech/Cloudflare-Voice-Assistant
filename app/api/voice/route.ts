import { env } from "cloudflare:workers";
import { getClientIp } from "@/lib/clientinfo";
import { checkRateLimit } from "@/lib/ratelimit";
import { WHISPER_MODEL, CHAT_MODEL, TTS_MODEL, sanitizeHistory, buildChatMessages, arrayBufferToBase64 } from "@/lib/voice";

const RATE_LIMIT = { limit: 30, windowSeconds: 3600 };

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rate = await checkRateLimit(env.VOICE_KV, `voice:${ip}`, RATE_LIMIT);
  if (!rate.allowed) {
    return Response.json(
      { error: `Rate limit exceeded. Try again in ${rate.resetSeconds}s.` },
      { status: 429 },
    );
  }

  const formData = await request.formData();
  const audio = formData.get("audio");
  const historyRaw = formData.get("history");

  if (!(audio instanceof Blob) || audio.size === 0) {
    return Response.json({ error: "No audio received." }, { status: 400 });
  }
  if (audio.size > 8 * 1024 * 1024) {
    return Response.json({ error: "Audio clip too large." }, { status: 413 });
  }

  const history = sanitizeHistory(historyRaw ? JSON.parse(String(historyRaw)) : []);

  const audioBuffer = await audio.arrayBuffer();
  const transcribed = (await env.AI.run(WHISPER_MODEL, {
    audio: arrayBufferToBase64(audioBuffer),
  })) as { text?: string; transcription_info?: { text?: string } };

  const transcript = (transcribed.text ?? transcribed.transcription_info?.text ?? "").trim();
  if (!transcript) {
    return Response.json({ error: "Couldn't make out any speech in that clip." }, { status: 422 });
  }

  const chatResponse = (await env.AI.run(CHAT_MODEL, {
    messages: buildChatMessages(history, transcript),
    max_tokens: 200,
  })) as { response?: string; result?: { response?: string }; choices?: { message?: { content?: string } }[] };

  const reply =
    (
      chatResponse.response ??
      chatResponse.result?.response ??
      chatResponse.choices?.[0]?.message?.content ??
      ""
    ).trim() || "Sorry, I didn't catch that — could you say it again?";

  const ttsStream = await env.AI.run(TTS_MODEL, {
    text: reply,
    encoding: "mp3",
  });
  const ttsBuffer = await new Response(ttsStream as ReadableStream).arrayBuffer();

  return Response.json({
    transcript,
    reply,
    audio: arrayBufferToBase64(ttsBuffer),
  });
}
