import { describe, expect, it } from "vitest";
import { guardToolCallLeakStream, isToolCallLeakText, type LeakGuardChunk } from "../lib/toolcall-guard";

// The exact string reported by the user — reproduced empirically against
// @cf/meta/llama-3.2-1b-instruct with tools attached (auto tool choice), see
// README "LLM tool-calling support".
const REAL_LEAK =
  '{"name":"get_current_time","parameters":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{}},"type":"function"}';

describe("isToolCallLeakText", () => {
  it("detects the exact leaked tool call reported by the user", () => {
    expect(isToolCallLeakText(REAL_LEAK)).toBe(true);
  });

  it("detects a leaked tool call with 'arguments' instead of 'parameters'", () => {
    expect(isToolCallLeakText('{"name":"set_reminder","arguments":{"message":"call mom","delay_seconds":60}}')).toBe(true);
  });

  it("detects an array of leaked tool calls", () => {
    expect(isToolCallLeakText('[{"name":"calc","parameters":{"a":1}}]')).toBe(true);
  });

  it("detects a leaked tool call across leading/trailing whitespace and newlines", () => {
    expect(isToolCallLeakText(`\n  ${REAL_LEAK}  \n`)).toBe(true);
  });

  it("does not flag a normal spoken sentence", () => {
    expect(isToolCallLeakText("Today is Sunday, September 14th, 2026.")).toBe(false);
    expect(isToolCallLeakText("Sure, I can help you with that!")).toBe(false);
  });

  it("does not flag a sentence containing the word 'function'", () => {
    expect(isToolCallLeakText("The kitchen sink has one function: to clean dishes.")).toBe(false);
    expect(isToolCallLeakText("This function returns the current time.")).toBe(false);
  });

  it("does not flag a sentence containing braces that isn't JSON", () => {
    expect(isToolCallLeakText("The set is defined as {1, 2, 3}.")).toBe(false);
    expect(isToolCallLeakText("Use curly braces like { and } in most languages.")).toBe(false);
  });

  it("does not flag valid JSON that isn't a tool call", () => {
    expect(isToolCallLeakText('{"greeting": "hello there"}')).toBe(false);
    expect(isToolCallLeakText('[1, 2, 3]')).toBe(false);
    expect(isToolCallLeakText('{"result": {"nested": true}}')).toBe(false);
  });

  it("does not flag multi-line / partial (invalid) JSON", () => {
    expect(isToolCallLeakText('{\n  "name": "get_current_time",\n')).toBe(false); // truncated, invalid JSON
    expect(isToolCallLeakText("{")).toBe(false);
    expect(isToolCallLeakText('{"name": "get_current_time"')).toBe(false);
  });

  it("does flag valid multi-line JSON with tool-call shape", () => {
    expect(
      isToolCallLeakText(`{
        "name": "get_current_time",
        "parameters": {}
      }`),
    ).toBe(true);
  });

  it("handles empty/whitespace-only text", () => {
    expect(isToolCallLeakText("")).toBe(false);
    expect(isToolCallLeakText("   \n  ")).toBe(false);
  });

  it("does not flag an object with 'name' but no parameters/arguments/function type", () => {
    expect(isToolCallLeakText('{"name": "Alice"}')).toBe(false);
  });
});

// --- guardToolCallLeakStream -------------------------------------------

async function* toStream(chunks: LeakGuardChunk[]): AsyncGenerator<LeakGuardChunk> {
  for (const c of chunks) yield c;
}

async function collect(gen: AsyncGenerator<LeakGuardChunk>): Promise<LeakGuardChunk[]> {
  const out: LeakGuardChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

function textDelta(text: string): LeakGuardChunk {
  return { type: "text-delta", text };
}

describe("guardToolCallLeakStream", () => {
  it("suppresses a leaked tool call and substitutes the fallback text", async () => {
    const chunks = [
      { type: "text-start" },
      textDelta('{"name":"get_current_time",'),
      textDelta('"parameters":{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{}},'),
      textDelta('"type":"function"}'),
      { type: "text-end" },
      { type: "finish", finishReason: "stop" },
    ];
    let leakSeen = "";
    const out = await collect(
      guardToolCallLeakStream(toStream(chunks), async (leaked) => {
        leakSeen = leaked;
        return "Sorry, I couldn't do that on this model.";
      }),
    );
    expect(isToolCallLeakText(leakSeen)).toBe(true);
    // No original leaked text-delta chunk made it through.
    const emittedText = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    expect(emittedText).toBe("Sorry, I couldn't do that on this model.");
    expect(emittedText).not.toContain("get_current_time");
    // Non-text chunks (boundaries, finish) still pass through.
    expect(out.some((c) => c.type === "finish")).toBe(true);
  });

  it("passes a normal reply through unchanged, chunk for chunk", async () => {
    const chunks = [{ type: "text-start" }, textDelta("Today is "), textDelta("Sunday."), { type: "text-end" }, { type: "finish" }];
    const out = await collect(guardToolCallLeakStream(toStream(chunks), async () => null));
    expect(out).toEqual(chunks);
  });

  it("does not buffer/delay text that doesn't start with a brace, even mentioning 'function'", async () => {
    const chunks = [textDelta("This function returns the time."), { type: "finish" }];
    let onLeakCalled = false;
    const out = await collect(
      guardToolCallLeakStream(toStream(chunks), async () => {
        onLeakCalled = true;
        return null;
      }),
    );
    expect(onLeakCalled).toBe(false);
    expect(out.filter((c) => c.type === "text-delta").map((c) => c.text).join("")).toBe("This function returns the time.");
  });

  it("does not suppress a reply that merely contains braces incidentally", async () => {
    const chunks = [textDelta("The set is defined as {1, 2, 3}."), { type: "finish" }];
    const out = await collect(guardToolCallLeakStream(toStream(chunks), async () => "should not be used"));
    expect(out.filter((c) => c.type === "text-delta").map((c) => c.text).join("")).toBe("The set is defined as {1, 2, 3}.");
  });

  it("flushes buffered brace-leading text that turns out not to be a valid/tool-call JSON", async () => {
    const chunks = [textDelta("{not json at all"), { type: "finish" }];
    const out = await collect(guardToolCallLeakStream(toStream(chunks), async () => "should not be used"));
    expect(out.filter((c) => c.type === "text-delta").map((c) => c.text).join("")).toBe("{not json at all");
  });

  it("re-arms detection per text run, guarding a real tool-call turn's second (post-tool) text block normally", async () => {
    // Simulates a working tool-call turn: step 1 has a structured tool-call
    // (not text), step 2 has the final spoken answer.
    const chunks = [
      { type: "tool-call", toolName: "get_current_time" },
      { type: "tool-result" },
      { type: "text-start" },
      textDelta("Today is Sunday, September 14th."),
      { type: "text-end" },
      { type: "finish" },
    ];
    const out = await collect(guardToolCallLeakStream(toStream(chunks), async () => "should not be used"));
    expect(out.filter((c) => c.type === "text-delta").map((c) => c.text).join("")).toBe("Today is Sunday, September 14th.");
  });

  it("suppresses without a fallback reply when onLeak returns null", async () => {
    const chunks = [textDelta(REAL_LEAK), { type: "finish" }];
    const out = await collect(guardToolCallLeakStream(toStream(chunks), async () => null));
    expect(out.filter((c) => c.type === "text-delta")).toHaveLength(0);
    expect(out.some((c) => c.type === "finish")).toBe(true);
  });
});
