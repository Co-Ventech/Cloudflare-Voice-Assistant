import { describe, expect, it } from "vitest";
import { withFirstChunkTimeout, STALL_TIMEOUT_MS, STALL_FALLBACK_REPLY } from "../lib/stall-guard";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

async function* chunks(...xs: string[]) {
  for (const x of xs) yield x;
}

const hung = (): AsyncIterable<string> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise<IteratorResult<string>>(() => {}), // never settles
    return: async () => ({ done: true as const, value: undefined }),
  }),
});

describe("withFirstChunkTimeout (a hung model request must not leave the user in silence)", () => {
  it("passes a normal stream through unchanged", async () => {
    let timedOut = 0;
    const out = await collect(withFirstChunkTimeout(chunks("a", "b", "c"), 500, () => timedOut++, "FALLBACK"));
    expect(out).toEqual(["a", "b", "c"]);
    expect(timedOut).toBe(0);
  });

  it("emits the fallback and calls onTimeout once when the first chunk never arrives", async () => {
    let timedOut = 0;
    const started = Date.now();
    const out = await collect(withFirstChunkTimeout(hung(), 60, () => timedOut++, "FALLBACK"));
    expect(out).toEqual(["FALLBACK"]);
    expect(timedOut).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not cut off a long answer once it has started", async () => {
    async function* slowAfterStart() {
      yield "first";
      await new Promise((r) => setTimeout(r, 150)); // longer than the deadline
      yield "second";
    }
    const out = await collect(withFirstChunkTimeout(slowAfterStart(), 60, () => {}, "FALLBACK"));
    expect(out).toEqual(["first", "second"]);
  });

  it("handles an empty stream", async () => {
    expect(await collect(withFirstChunkTimeout(chunks(), 60, () => {}, "FALLBACK"))).toEqual([]);
  });

  it("propagates errors from the source", async () => {
    async function* boom(): AsyncGenerator<string> {
      yield "ok";
      throw new Error("model failed");
    }
    await expect(collect(withFirstChunkTimeout(boom(), 60, () => {}, "FALLBACK"))).rejects.toThrow("model failed");
  });

  it("has a sane default deadline and a spoken-friendly apology", () => {
    expect(STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(4_000);
    expect(STALL_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(STALL_FALLBACK_REPLY.length).toBeLessThan(80);
  });
});

describe("withFirstChunkTimeout only counts real content (reasoning models send bookkeeping chunks first)", () => {
  type C = { type: string; text?: string };
  const isText = (c: C) => c.type === "text-delta";

  it("still times out when only non-text chunks arrive and the words never come", async () => {
    async function* thinkingForever(): AsyncGenerator<C> {
      yield { type: "start" };
      yield { type: "reasoning-delta", text: "hmm" };
      await new Promise(() => {}); // never produces text
    }
    let timedOut = 0;
    const out = await collect(
      withFirstChunkTimeout<C>(thinkingForever(), 80, () => timedOut++, { type: "text-delta", text: "FALLBACK" }, isText),
    );
    expect(timedOut).toBe(1);
    expect(out[out.length - 1]).toEqual({ type: "text-delta", text: "FALLBACK" });
  });

  it("passes everything through when text arrives in time, including earlier bookkeeping chunks", async () => {
    async function* normal(): AsyncGenerator<C> {
      yield { type: "start" };
      yield { type: "text-delta", text: "Hello" };
      yield { type: "text-delta", text: " there" };
      yield { type: "finish" };
    }
    let timedOut = 0;
    const out = await collect(withFirstChunkTimeout<C>(normal(), 200, () => timedOut++, { type: "text-delta", text: "X" }, isText));
    expect(timedOut).toBe(0);
    expect(out.map((c) => c.type)).toEqual(["start", "text-delta", "text-delta", "finish"]);
  });

  it("does not cut off a long answer after the first words", async () => {
    async function* slow(): AsyncGenerator<C> {
      yield { type: "text-delta", text: "first" };
      await new Promise((r) => setTimeout(r, 180)); // longer than the deadline
      yield { type: "text-delta", text: "second" };
    }
    const out = await collect(withFirstChunkTimeout<C>(slow(), 70, () => {}, { type: "text-delta", text: "X" }, isText));
    expect(out.map((c) => c.text)).toEqual(["first", "second"]);
  });
});
