import { describe, expect, it } from "vitest";
import { sanitizeHistory, buildChatMessages, arrayBufferToBase64, SYSTEM_PROMPT, MAX_HISTORY_TURNS } from "../lib/voice";

describe("sanitizeHistory", () => {
  it("returns an empty array for non-array input", () => {
    expect(sanitizeHistory(undefined)).toEqual([]);
    expect(sanitizeHistory(null)).toEqual([]);
    expect(sanitizeHistory("nope")).toEqual([]);
  });

  it("drops malformed turns", () => {
    const input = [
      { role: "user", content: "hi" },
      { role: "bot", content: "invalid role" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "  " },
      { content: "missing role" },
      { role: "assistant", content: "hello there" },
    ];
    expect(sanitizeHistory(input)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
    ]);
  });

  it("caps history to the last MAX_HISTORY_TURNS entries", () => {
    const input = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    const result = sanitizeHistory(input);
    expect(result).toHaveLength(MAX_HISTORY_TURNS);
    expect(result[result.length - 1].content).toBe("turn 19");
  });
});

describe("buildChatMessages", () => {
  it("prepends the system prompt and appends the new user turn", () => {
    const history = [{ role: "user" as const, content: "earlier" }];
    const messages = buildChatMessages(history, "what's the weather?");
    expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(messages[1]).toEqual({ role: "user", content: "earlier" });
    expect(messages[2]).toEqual({ role: "user", content: "what's the weather?" });
  });
});

describe("arrayBufferToBase64", () => {
  it("round-trips through atob", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const b64 = arrayBufferToBase64(bytes.buffer);
    expect(atob(b64)).toBe("Hello");
  });

  it("handles buffers larger than the chunk size", () => {
    const bytes = new Uint8Array(70000).fill(65); // "A" * 70000
    const b64 = arrayBufferToBase64(bytes.buffer);
    const decoded = atob(b64);
    expect(decoded.length).toBe(70000);
    expect(decoded[0]).toBe("A");
    expect(decoded[decoded.length - 1]).toBe("A");
  });
});
