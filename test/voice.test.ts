import { describe, expect, it } from "vitest";
import {
  AURA_SPEAKERS,
  DEFAULT_SPEAKER,
  DEFAULT_LLM,
  LLM_MODELS,
  LLM_TOOL_SUPPORT,
  resolveSpeaker,
  resolveLlmModel,
  modelSupportsTools,
  resolveToolsEnabled,
  SYSTEM_PROMPT,
} from "../lib/voice";

describe("AURA_SPEAKERS", () => {
  it("matches the verified @cf/deepgram/aura-1 speaker enum", () => {
    const ids = AURA_SPEAKERS.map((s) => s.id).sort();
    expect(ids).toEqual(
      ["angus", "arcas", "asteria", "athena", "helios", "hera", "luna", "orion", "orpheus", "perseus", "stella", "zeus"].sort(),
    );
  });

  it("has no duplicate ids", () => {
    const ids = AURA_SPEAKERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveSpeaker", () => {
  it("accepts a known speaker id", () => {
    expect(resolveSpeaker("asteria")).toBe("asteria");
    expect(resolveSpeaker("stella")).toBe("stella");
  });

  it("falls back to the default for unknown, empty, or missing values", () => {
    expect(resolveSpeaker("not-a-real-voice")).toBe(DEFAULT_SPEAKER);
    expect(resolveSpeaker("")).toBe(DEFAULT_SPEAKER);
    expect(resolveSpeaker(null)).toBe(DEFAULT_SPEAKER);
    expect(resolveSpeaker(undefined)).toBe(DEFAULT_SPEAKER);
  });

  it("is case-sensitive (does not silently normalize casing)", () => {
    expect(resolveSpeaker("Asteria")).toBe(DEFAULT_SPEAKER);
  });
});

describe("resolveLlmModel", () => {
  it("resolves each known key to its model id", () => {
    for (const [key, modelId] of Object.entries(LLM_MODELS)) {
      expect(resolveLlmModel(key)).toBe(modelId);
    }
  });

  it("falls back to the default model for unknown or missing keys", () => {
    expect(resolveLlmModel("not-a-model")).toBe(LLM_MODELS[DEFAULT_LLM]);
    expect(resolveLlmModel(null)).toBe(LLM_MODELS[DEFAULT_LLM]);
    expect(resolveLlmModel(undefined)).toBe(LLM_MODELS[DEFAULT_LLM]);
  });
});

describe("LLM_TOOL_SUPPORT", () => {
  it("has an entry for every configured model", () => {
    for (const key of Object.keys(LLM_MODELS)) {
      expect(LLM_TOOL_SUPPORT).toHaveProperty(key);
    }
  });

  it("marks the fastest (llama-3.2-1b) model as not supporting tools, verified broken", () => {
    // See README "LLM tool-calling support" — empirically confirmed to leak
    // raw tool-call JSON as text instead of a structured tool call.
    expect(LLM_TOOL_SUPPORT.fastest).toBe(false);
  });

  it("marks balanced and quality models as supporting tools, verified working", () => {
    expect(LLM_TOOL_SUPPORT.balanced).toBe(true);
    expect(LLM_TOOL_SUPPORT.quality).toBe(true);
  });
});

describe("modelSupportsTools", () => {
  it("resolves each known key to its configured support flag", () => {
    for (const [key, supported] of Object.entries(LLM_TOOL_SUPPORT)) {
      expect(modelSupportsTools(key)).toBe(supported);
    }
  });

  it("falls back to the default model's support flag for unknown or missing keys", () => {
    expect(modelSupportsTools("not-a-model")).toBe(LLM_TOOL_SUPPORT[DEFAULT_LLM]);
    expect(modelSupportsTools(null)).toBe(LLM_TOOL_SUPPORT[DEFAULT_LLM]);
    expect(modelSupportsTools(undefined)).toBe(LLM_TOOL_SUPPORT[DEFAULT_LLM]);
  });
});

describe("resolveToolsEnabled", () => {
  it("is false when the client didn't request tools, regardless of model", () => {
    expect(resolveToolsEnabled(null, "balanced")).toBe(false);
    expect(resolveToolsEnabled("0", "balanced")).toBe(false);
    expect(resolveToolsEnabled(undefined, "quality")).toBe(false);
  });

  it("is true when the client requested tools on a model that supports them", () => {
    expect(resolveToolsEnabled("1", "balanced")).toBe(true);
    expect(resolveToolsEnabled("true", "quality")).toBe(true);
  });

  it("stays false when the client requested tools on a model that doesn't support them — server-side enforcement, not trusting the client", () => {
    expect(resolveToolsEnabled("1", "fastest")).toBe(false);
    expect(resolveToolsEnabled("true", "fastest")).toBe(false);
  });

  it("uses the default model's support when no model key is given", () => {
    expect(resolveToolsEnabled("1", null)).toBe(LLM_TOOL_SUPPORT[DEFAULT_LLM]);
  });
});

describe("SYSTEM_PROMPT", () => {
  it("instructs short, spoken-friendly, markdown-free replies", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("concise");
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("no markdown");
  });
});
