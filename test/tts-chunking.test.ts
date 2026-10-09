import { describe, expect, it } from "vitest";
import { extractChunks, findChunkBoundary, MIN_FIRST_CHUNK_LENGTH } from "../lib/tts-chunking";

describe("findChunkBoundary", () => {
  it("finds a sentence terminator regardless of allowClause", () => {
    const buffer = "Hello there. More text";
    const expected = buffer.indexOf(".");
    expect(findChunkBoundary(buffer, false)).toBe(expected);
    expect(findChunkBoundary(buffer, true)).toBe(expected);
  });

  it("finds a clause boundary only when allowClause is true and the candidate is past the minimum length", () => {
    const buffer = "This is a sufficiently long clause right here, and then some more text after it";
    const idx = buffer.indexOf(",");
    expect(buffer.slice(0, idx + 1).length).toBeGreaterThanOrEqual(MIN_FIRST_CHUNK_LENGTH);
    expect(findChunkBoundary(buffer, false)).toBe(-1); // no sentence terminator yet
    expect(findChunkBoundary(buffer, true)).toBe(idx);
  });

  it("ignores a clause boundary that is too short and waits for the next boundary", () => {
    const buffer = "Well, that is odd. Longer sentence follows after this one here";
    expect("Well,".length).toBeLessThan(MIN_FIRST_CHUNK_LENGTH);
    const sentenceIdx = buffer.indexOf(".");
    expect(findChunkBoundary(buffer, true)).toBe(sentenceIdx);
  });

  it("does not split on a hyphen inside a word", () => {
    const buffer = "This is a well-known fact about long compound words in English";
    expect(findChunkBoundary(buffer, true)).toBe(-1);
  });
});

describe("extractChunks", () => {
  it("emits the first chunk at a clause boundary, then falls back to sentence boundaries", () => {
    const state = { buffer: "", emittedFirstChunk: false };
    state.buffer =
      "Sure thing, I can help you with that request right now, " +
      "it will only take a moment to finish up the rest of the details. ";
    const chunks = extractChunks(state);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBeGreaterThanOrEqual(MIN_FIRST_CHUNK_LENGTH);
    expect(chunks[1]).toContain("it will only take a moment");
  });

  it("never emits an empty or whitespace-only chunk", () => {
    const state = { buffer: "   .  ", emittedFirstChunk: false };
    const chunks = extractChunks(state);
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });

  it("only uses clause boundaries for the very first chunk of a turn", () => {
    const state = { buffer: "", emittedFirstChunk: false };
    state.buffer = "First clause here that is sufficiently long to qualify, ";
    const first = extractChunks(state);
    expect(first.length).toBe(1);
    expect(state.emittedFirstChunk).toBe(true);
    // A second, equally long clause should NOT split early now that
    // emittedFirstChunk is true — it must wait for a real sentence end.
    state.buffer += "second clause here that is also sufficiently long, but still no period yet";
    const second = extractChunks(state);
    expect(second.length).toBe(0);
  });
});

import { endsWithSentenceBoundary } from "../lib/tts-chunking";

describe("a finished sentence at the very end of the buffer can start speaking immediately", () => {
  it("accepts a clean sentence ending", () => {
    expect(endsWithSentenceBoundary("I'm doing well, thanks for asking.")).toBe(true);
    expect(endsWithSentenceBoundary("What can I do for you?")).toBe(true);
    expect(endsWithSentenceBoundary("Great, that works!")).toBe(true);
  });

  it("does not treat abbreviations, decimals or ellipses as the end", () => {
    expect(endsWithSentenceBoundary("Please ask Dr.")).toBe(false);
    expect(endsWithSentenceBoundary("It costs about 3.")).toBe(false); // could be 3.5
    expect(endsWithSentenceBoundary("Well, I was thinking...")).toBe(false);
    expect(endsWithSentenceBoundary("Use e.g.")).toBe(false);
  });

  it("ignores text that is too short or has no terminator", () => {
    expect(endsWithSentenceBoundary("Yes.")).toBe(false); // shorter than the minimum chunk
    expect(endsWithSentenceBoundary("I am about to say")).toBe(false);
    expect(endsWithSentenceBoundary("")).toBe(false);
  });

  it("extractChunks emits a complete short reply without waiting for the stream to end", () => {
    const state = { buffer: "I'm doing well, thanks for asking.", emittedFirstChunk: false };
    expect(extractChunks(state)).toEqual(["I'm doing well, thanks for asking."]);
    expect(state.buffer).toBe("");
  });
});
