// Defence-in-depth guard against a specific failure mode: a small instruct
// model (verified: @cf/meta/llama-3.2-1b-instruct — see README "LLM
// tool-calling support") that has tools attached but doesn't reliably support
// structured tool calling sometimes "calls" a tool by writing the call out as
// plain JSON text instead of using the provider's tool-call channel, e.g.:
//
//   {"name":"get_current_time","parameters":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{}},"type":"function"}
//
// `workers-ai-provider` only recovers ("salvages") that shape when the tool
// choice was *forced* (see `salvageToolCallsFromText` in
// node_modules/workers-ai-provider/dist/index.mjs) — our onTurn() uses the
// default "auto" tool choice, so nothing recovers it there. Left unguarded,
// it flows through `streamText()` as ordinary assistant text, straight into
// the sentence chunker and out to TTS/transcript — which is exactly the bug
// reported (raw JSON spoken aloud). This module is the last line of defence
// before that text reaches either.
//
// Task 3 (tagging models by tool-call support, disabling the UI checkbox)
// prevents this in the common case; this module protects every other case
// (client bypassing the checkbox, ?tools=1 hand-typed, a future model that
// turns out to be less reliable than its catalog entry claims, etc).

/** True only for text that is a complete, valid JSON parse of a tool-call
 * shape: an object with a string `name` plus (`parameters` or `arguments`),
 * or an explicit `type: "function"`; or a non-empty array of such objects.
 *
 * Deliberately narrow to avoid false positives on legitimate speech:
 *  - Requires the *entire* trimmed text to parse as JSON — a sentence that
 *    merely mentions "function" or contains stray braces mid-sentence
 *    ("The set is {1, 2, 3}.") does not parse as JSON and is left alone.
 *  - Requires the specific tool-call shape (`name` + `parameters`/`arguments`,
 *    or `type: "function"`) — a bare JSON object/array the model legitimately
 *    produced (e.g. echoing structured data back) is not flagged just for
 *    being valid JSON.
 */
export function isToolCallLeakText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  return looksLikeToolCallValue(parsed);
}

function looksLikeToolCallValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isToolCallShape);
  }
  return isToolCallShape(value);
}

function isToolCallShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const hasName = typeof obj.name === "string" && obj.name.length > 0;
  if (!hasName) return false;
  const hasParams = "parameters" in obj || "arguments" in obj;
  const isFunctionType = obj.type === "function";
  return hasParams || isFunctionType;
}

/** Minimal shape shared by the AI SDK's `TextStreamPart` union that this
 * guard cares about: `text-delta` chunks carry the streamed text (as `text`
 * or, in some SDK versions, `delta`); every other chunk type (`text-start`,
 * `text-end`, `tool-call`, `finish`, `error`, ...) is treated as an opaque
 * boundary and passed through unchanged, and doubles as the point where a
 * buffered run of text is resolved as either "flush it" or "it was a leak". */
export interface LeakGuardChunk {
  type: string;
  text?: string;
  delta?: string;
  [key: string]: unknown;
}

function chunkText(chunk: LeakGuardChunk): string {
  if (typeof chunk.text === "string") return chunk.text;
  if (typeof chunk.delta === "string") return chunk.delta;
  return "";
}

/**
 * Wraps a chunk stream (as returned by `streamText().stream`) so that a run
 * of `text-delta` chunks which together form a leaked tool call is never
 * yielded downstream — instead `onLeak` is invoked with the full leaked text
 * (for logging + producing a fallback reply) and its resolved string, if
 * any, is emitted as a single replacement `text-delta` chunk.
 *
 * Fast path: as soon as a run of text has a non-whitespace first character
 * that isn't `{`/`[`, it is known not to be a JSON leak and is flushed
 * immediately, chunk by chunk, exactly as it arrived — normal replies (the
 * overwhelming majority) stream with zero added latency. Only text that
 * *starts* with `{`/`[` is held back, and only until the run's boundary
 * (the next non-`text-delta` chunk, or end of stream), where it's parsed and
 * classified in one shot via `isToolCallLeakText`.
 */
export async function* guardToolCallLeakStream(
  source: AsyncIterable<LeakGuardChunk>,
  onLeak: (leakedText: string) => Promise<string | null>,
): AsyncGenerator<LeakGuardChunk> {
  let buffer = "";
  let decided = false;
  let held: LeakGuardChunk[] = [];

  async function* resolveHeld(): AsyncGenerator<LeakGuardChunk> {
    if (held.length === 0) {
      buffer = "";
      decided = false;
      return;
    }
    if (isToolCallLeakText(buffer)) {
      const fallback = await onLeak(buffer);
      if (fallback) yield { type: "text-delta", text: fallback };
    } else {
      for (const c of held) yield c;
    }
    held = [];
    buffer = "";
    decided = false;
  }

  for await (const chunk of source) {
    if (chunk.type === "text-delta") {
      if (decided) {
        yield chunk;
        continue;
      }
      buffer += chunkText(chunk);
      const trimmed = buffer.trimStart();
      if (trimmed.length === 0) {
        held.push(chunk);
        continue;
      }
      if (trimmed[0] !== "{" && trimmed[0] !== "[") {
        decided = true;
        yield* held;
        held = [];
        yield chunk;
        continue;
      }
      held.push(chunk);
      continue;
    }
    yield* resolveHeld();
    yield chunk;
  }
  yield* resolveHeld();
}

/** Canned last-resort reply if even the no-tools retry fails (network error,
 * etc). Kept short and voice-appropriate, matching SYSTEM_PROMPT's style. */
export const TOOLCALL_LEAK_FALLBACK_REPLY =
  "Sorry, I couldn't do that one — could you try asking again?";
