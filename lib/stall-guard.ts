// A language-model request can occasionally hang: no error, no first word. In
// testing that left the user in silence until they spoke again (which then
// cancelled the stuck request and answered the wrong thing). This wraps the
// reply stream so that if no actual WORDS arrive within a deadline, the request
// is cancelled and a short apology is spoken instead.
//
// Reasoning models (DeepSeek) send bookkeeping chunks ("start", "reasoning")
// almost immediately and only then, sometimes much later, the words — so the
// deadline must be for the first content chunk, not for the first chunk.

export const STALL_TIMEOUT_MS = 10_000;
export const STALL_FALLBACK_REPLY = "Sorry, that took too long. Could you say it again?";

/**
 * Passes `source` through unchanged, except: if no chunk for which
 * `isContent` is true arrives within `timeoutMs` of the start, `onTimeout`
 * is called once and `fallback` is emitted. Chunks that arrive before the
 * deadline (bookkeeping) are still passed through. Once content has started the
 * deadline no longer applies, so long answers are never cut off. Errors from
 * the source propagate.
 */
export async function* withFirstChunkTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout: () => void,
  fallback: T,
  isContent: (chunk: T) => boolean = () => true,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  const TIMED_OUT = Symbol("timed-out");
  let seenContent = false;

  while (!seenContent) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let next: IteratorResult<T> | typeof TIMED_OUT;
    try {
      next = await Promise.race([
        iterator.next(),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (next === TIMED_OUT) {
      try {
        onTimeout();
      } finally {
        // Best effort: let the source clean up; never wait on a hung source.
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      }
      yield fallback;
      return;
    }
    if (next.done) return;
    yield next.value;
    if (isContent(next.value)) seenContent = true;
  }

  while (true) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}
