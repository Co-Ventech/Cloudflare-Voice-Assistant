// Shared model/voice configuration used by both the Durable Object (src/server.ts)
// and the client UI (src/App.tsx). Kept dependency-free (no Workers/DOM types) so
// it's trivially unit-testable.

export const STT_MODEL = "@cf/deepgram/flux";
export const TTS_MODEL = "@cf/deepgram/aura-1";

// Benchmarked on Workers AI (time-to-first-token + total, `npx wrangler ai models
// list` confirmed availability) before picking these three. Numbers are from a
// couple of short conversational prompts, single-turn, no tool calls:
//
//   model                                    TTFT      total    notes
//   @cf/meta/llama-3.2-1b-instruct           260-390ms  0.75-1.3s  clean, on-topic, a bit terse
//   @cf/meta/llama-3.2-3b-instruct           320-440ms  0.65-0.75s BROKEN: workers-ai-provider streams
//                                                                  every word doubled/garbled for this
//                                                                  model ("II'd'd be be happy happy") —
//                                                                  excluded despite good numbers
//   @cf/meta/llama-3.1-8b-instruct-fp8       0.5-1.1s   3.0-3.4s   slow tail, no TTFT win worth it
//   @cf/ibm-granite/granite-4.0-h-micro      1.0-2.6s   1.7-3.4s   inconsistent TTFT
//   @cf/zai-org/glm-4.7-flash                5.7-9.6s   6.0-9.9s   far too slow, was a selectable model
//   @cf/deepseek-ai/deepseek-v4-flash-0731   0.95-1.7s  2.0-2.3s   best quality/speed balance
//   @cf/openai/gpt-oss-20b (old default)     1.0-1.8s   1.2-2.1s   reasoning overhead adds ~300ms+
//
// "fastest" (1B) is the new default — the system prompt already asks for 1-3
// spoken sentences, well within a 1B model's ability, and it's 3-6x faster to
// first token than the old default. "balanced" and "quality" stay selectable
// for when the user wants noticeably better reasoning and is fine trading
// ~1-2s of extra latency for it.
export const LLM_MODELS = {
  fastest: "@cf/meta/llama-3.2-1b-instruct",
  balanced: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  quality: "@cf/openai/gpt-oss-20b",
} as const;

export type LlmKey = keyof typeof LLM_MODELS;
export const DEFAULT_LLM: LlmKey = "fastest";

export function resolveLlmModel(key: string | null | undefined): string {
  if (key && key in LLM_MODELS) return LLM_MODELS[key as LlmKey];
  return LLM_MODELS[DEFAULT_LLM];
}

// Whether each model reliably supports *structured* tool calling — verified
// two ways, which agreed in all three cases:
//
//   1. Empirically, against a real Workers AI endpoint: streamText() called
//      exactly like onTurn() does (tools attached, default "auto" tool
//      choice) with the prompt "What is the day today?", inspecting whether
//      a structured tool-call part appears in the stream vs the model
//      writing the call out as plain JSON text.
//   2. Workers AI's own model catalog (`npx wrangler ai models list --json`
//      → each model's `properties[].property_id === "function_calling"`).
//
//   model                                    catalog flag   empirical result
//   @cf/meta/llama-3.2-1b-instruct           absent         BROKEN — leaks
//                                                            `{"name":"get_current_time","parameters":{...},"type":"function"}`
//                                                            as plain assistant text, finishReason "stop" (not
//                                                            "tool-calls"), reproduced 3/3 runs.
//   @cf/deepseek-ai/deepseek-v4-flash-0731   "true"         WORKS — real tool-call part, finishReason
//                                                            "tool-calls" then a second step with the answer.
//   @cf/openai/gpt-oss-20b                   "true"         WORKS — same as above.
//
// Root cause (confirmed by reading workers-ai-provider@4.0.0's source):
// `workers-ai-provider` *does* recover ("salvage") a tool call leaked as text
// (see `salvageToolCallsFromText` in its dist), but only when the tool choice
// was *forced* (required / a named function) — onTurn() uses the default
// "auto" choice, so nothing recovers it there for a model that leaks under
// "auto". `lib/toolcall-guard.ts` is the runtime backstop for this; this map
// is what keeps the UI honest and stops the server from attaching tools to a
// model it already knows can't use them (see resolveToolsEnabled below).
export const LLM_TOOL_SUPPORT: Record<LlmKey, boolean> = {
  fastest: false,
  balanced: true,
  quality: true,
};

export function modelSupportsTools(key: string | null | undefined): boolean {
  if (key && key in LLM_TOOL_SUPPORT) return LLM_TOOL_SUPPORT[key as LlmKey];
  return LLM_TOOL_SUPPORT[DEFAULT_LLM];
}

// Tools (get_current_time, set_reminder) force a second sequential LLM round
// trip whenever the model decides to call one — measured at roughly 2-3x the
// latency of a plain reply (single step ~0.8-1.1s vs a forced tool step
// ~2.6-3.3s for gpt-oss-20b). For a casual voice chat that overhead is rarely
// worth it, so tools default OFF and are opt-in via ?tools=1.
//
// Also refuses tools for a model that doesn't reliably support them
// (`modelSupportsTools`), regardless of what the client requested — this is
// the server-side half of "don't offer tools on models that can't do them":
// the UI disables the checkbox for such a model, but a client could still
// send `?tools=1` by hand, so this is enforced again here rather than
// trusted from the query string.
export function resolveToolsEnabled(value: string | null | undefined, llmKey: string | null | undefined): boolean {
  const requested = value === "1" || value === "true";
  if (!requested) return false;
  return modelSupportsTools(llmKey);
}

export const SYSTEM_PROMPT =
  "You are a helpful, warm voice assistant running on Cloudflare Workers AI. " +
  "Keep replies concise and conversational — 1 to 3 sentences, plain text, no " +
  "markdown, no lists — because they will be spoken aloud, not read.";

// Full, verified list of @cf/deepgram/aura-1 `speaker` enum values, per the
// Cloudflare Workers AI model page (developers.cloudflare.com/workers-ai/models/aura-1/).
// Default per the API is "angus".
export const AURA_SPEAKERS = [
  { id: "angus", label: "Angus", gender: "male" },
  { id: "asteria", label: "Asteria", gender: "female" },
  { id: "arcas", label: "Arcas", gender: "male" },
  { id: "orion", label: "Orion", gender: "male" },
  { id: "orpheus", label: "Orpheus", gender: "male" },
  { id: "athena", label: "Athena", gender: "female" },
  { id: "luna", label: "Luna", gender: "female" },
  { id: "zeus", label: "Zeus", gender: "male" },
  { id: "perseus", label: "Perseus", gender: "male" },
  { id: "helios", label: "Helios", gender: "male" },
  { id: "hera", label: "Hera", gender: "female" },
  { id: "stella", label: "Stella", gender: "female" },
] as const;

export type AuraSpeakerId = (typeof AURA_SPEAKERS)[number]["id"];
export const DEFAULT_SPEAKER: AuraSpeakerId = "angus";

const SPEAKER_IDS = new Set<string>(AURA_SPEAKERS.map((s) => s.id));

/** Validates an untrusted speaker id (e.g. from a query string) against the
 * known Aura-1 speaker enum, falling back to the default on anything unknown. */
export function resolveSpeaker(value: string | null | undefined): AuraSpeakerId {
  if (value && SPEAKER_IDS.has(value)) return value as AuraSpeakerId;
  return DEFAULT_SPEAKER;
}
