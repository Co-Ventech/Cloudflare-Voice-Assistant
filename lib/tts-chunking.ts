// Patches the `agents` package's internal SentenceChunker — used by
// withVoice()'s streaming TTS pipeline — so the FIRST chunk of a reply fires
// TTS at the earliest clause boundary (comma / semicolon / colon / dash) past
// a minimum length, instead of waiting for a full sentence. Every chunk after
// the first still waits for a full sentence boundary, so prosody stays
// reasonable through the rest of the reply.
//
// Why a prototype patch and not a config option: agents@0.23.0's
// `withVoice()` instantiates `new SentenceChunker()` directly inside its own
// closure (node_modules/agents/dist/voice/index.js) and does not expose any
// option for chunking granularity — verified by reading both the mixin
// source and the chunker source (node_modules/agents/dist/text-stream-*.js).
// There is no injectable chunker, no `voiceOptions.chunker`, nothing. Given
// that, the two options were: (a) reimplement the entire streaming pipeline
// (audio_config/status/transcript wire protocol, barge-in, turn diagnostics,
// turn_metrics, the TTS-queue draining that keeps chunk N+1 synthesizing
// while chunk N is still sending) ourselves, or (b) change only the one
// piece of behavior that needed to change. (a) is a lot of surface area to
// re-test for a boilerplate; (b) is a ~60 line, independently unit-testable
// patch that leaves everything else — which is already correct — alone. We
// went with (b).
//
// The patch replaces `add`/`flush`/`reset` on the SentenceChunker prototype
// with an implementation that tracks its own buffer via a WeakMap (the
// original's buffer is a private class field we can't reach from outside,
// but we don't need it — every call to add/flush goes through the patched
// methods, so our own state is authoritative).

import { SentenceChunker } from "agents/voice";

const SENTENCE_TERMINATORS = new Set([".", "!", "?"]);
const CLAUSE_BOUNDARIES = new Set([",", ";", ":", "—"]);
const MIN_SENTENCE_LENGTH = 10;
// How long the first spoken piece must be before a comma/dash can end it. It was
// 40 characters, which made short replies wait for the whole sentence before
// any speech was requested. 24 starts speaking at the first natural pause
// ("Sure, I can do that,") while still avoiding one-word fragments.
export const MIN_FIRST_CHUNK_LENGTH = 24;

interface ChunkerState {
  buffer: string;
  emittedFirstChunk: boolean;
}

const chunkerState = new WeakMap<object, ChunkerState>();

function getState(instance: object): ChunkerState {
  let s = chunkerState.get(instance);
  if (!s) {
    s = { buffer: "", emittedFirstChunk: false };
    chunkerState.set(instance, s);
  }
  return s;
}

/**
 * Find the end index of the first usable chunk boundary in `buffer`.
 * Sentence terminators (. ! ?) always count; clause boundaries (, ; : —)
 * count only for the first chunk of a reply (`allowClause`), and only once
 * the candidate chunk is at least MIN_FIRST_CHUNK_LENGTH characters — short
 * enough clauses read as choppy, so we let those roll into the next one.
 */
export function findChunkBoundary(buffer: string, allowClause: boolean): number {
  for (let i = 0; i < buffer.length; i++) {
    const char = buffer[i];
    const isSentenceEnd = SENTENCE_TERMINATORS.has(char);
    const isClause = allowClause && CLAUSE_BOUNDARIES.has(char);
    if (!isSentenceEnd && !isClause) continue;
    const next = buffer[i + 1];
    if (next === undefined) continue;
    if (next !== " " && next !== "\n") continue;
    const candidateLen = buffer.slice(0, i + 1).trim().length;
    const minLen = isClause ? MIN_FIRST_CHUNK_LENGTH : MIN_SENTENCE_LENGTH;
    if (candidateLen >= minLen) return i;
  }
  return -1;
}

/** Pure extraction logic, independent of the patched class — unit-tested directly. */
export function extractChunks(state: ChunkerState): string[] {
  const out: string[] = [];
  while (true) {
    const allowClause = !state.emittedFirstChunk;
    let boundary = findChunkBoundary(state.buffer, allowClause);
    if (boundary === -1 && endsWithSentenceBoundary(state.buffer)) {
      boundary = state.buffer.trimEnd().length - 1;
    }
    if (boundary === -1) break;
    const piece = state.buffer.slice(0, boundary + 1).trim();
    state.buffer = state.buffer.slice(boundary + 1).trimStart();
    if (piece.length > 0) {
      out.push(piece);
      state.emittedFirstChunk = true;
    }
  }
  return out;
}

// A sentence that ENDS the buffer (no following character yet) used to wait
// for the model stream to close before any speech was requested. In real use
// the stream's tail (waiting for its "finish" event) took up to 4-5 seconds
// after the last word, so a one-sentence reply was only spoken after the whole
// stream ended (measured: first audio 6.1s vs first text 1.5s). A clean
// sentence ending is safe to speak right away; abbreviations, decimals and
// ellipses are not, because more text may follow them in the same sentence.
const ABBREVIATION_END = /(?:^|[\s(])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|no)\.$/i;

export function endsWithSentenceBoundary(buffer: string): boolean {
  const text = buffer.trimEnd();
  if (text.length < MIN_SENTENCE_LENGTH) return false;
  const last = text[text.length - 1];
  if (last !== "." && last !== "!" && last !== "?") return false;
  if (last === ".") {
    if (text.endsWith("..") || text.endsWith("…")) return false; // ellipsis
    if (/\d\.$/.test(text)) return false; // "3." might continue as "3.5"
    if (ABBREVIATION_END.test(text)) return false;
  }
  return true;
}

let patched = false;

export function patchSentenceChunkerForClauseStreaming(): void {
  if (patched) return;
  patched = true;
  const proto = SentenceChunker.prototype as unknown as {
    add(text: string): string[];
    flush(): string[];
    reset(): void;
  };
  proto.add = function (this: object, text: string) {
    const state = getState(this);
    state.buffer += text;
    return extractChunks(state);
  };
  proto.flush = function (this: object) {
    const state = getState(this);
    const remaining = state.buffer.trim();
    state.buffer = "";
    state.emittedFirstChunk = false;
    return remaining.length > 0 ? [remaining] : [];
  };
  proto.reset = function (this: object) {
    const state = getState(this);
    state.buffer = "";
    state.emittedFirstChunk = false;
  };
}
