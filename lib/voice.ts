export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const CHAT_MODEL = "@cf/openai/gpt-oss-20b";
export const TTS_MODEL = "@cf/deepgram/aura-1";

export const SYSTEM_PROMPT =
  "You are a helpful voice assistant. Keep replies short and conversational — " +
  "one or two sentences, plain text, no markdown, no lists — since they will be spoken aloud.";

export const MAX_HISTORY_TURNS = 6;

export type ChatRole = "user" | "assistant";
export interface ChatTurn {
  role: ChatRole;
  content: string;
}

/** Keeps only well-formed turns and caps how much prior conversation gets
 * replayed to the model — voice replies need to stay fast, and a long
 * history both slows inference and drifts the "keep it short" instruction. */
export function sanitizeHistory(history: unknown): ChatTurn[] {
  if (!Array.isArray(history)) return [];
  const cleaned = history.filter(
    (turn): turn is ChatTurn =>
      typeof turn === "object" &&
      turn !== null &&
      (turn.role === "user" || turn.role === "assistant") &&
      typeof turn.content === "string" &&
      turn.content.trim().length > 0,
  );
  return cleaned.slice(-MAX_HISTORY_TURNS);
}

export function buildChatMessages(history: ChatTurn[], userText: string) {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: userText }];
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
