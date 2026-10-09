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

import { isLlmKey, isSpeakerId, formatDelay } from "../lib/voice";

describe("prototype-key safety (untrusted ?llm= / ?speaker= values)", () => {
  const protoKeys = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];

  it("never treats inherited Object keys as model keys", () => {
    for (const k of protoKeys) {
      expect(isLlmKey(k)).toBe(false);
      expect(resolveLlmModel(k)).toBe(LLM_MODELS[DEFAULT_LLM]);
      expect(typeof resolveLlmModel(k)).toBe("string");
    }
  });

  it("does not report tool support for inherited keys", () => {
    for (const k of protoKeys) {
      expect(modelSupportsTools(k)).toBe(LLM_TOOL_SUPPORT[DEFAULT_LLM]);
      expect(resolveToolsEnabled("1", k)).toBe(LLM_TOOL_SUPPORT[DEFAULT_LLM]);
    }
  });

  it("isLlmKey / isSpeakerId accept only real values", () => {
    expect(isLlmKey("fastest")).toBe(true);
    expect(isLlmKey("nope")).toBe(false);
    expect(isLlmKey(null)).toBe(false);
    expect(isSpeakerId("angus")).toBe(true);
    expect(isSpeakerId("constructor")).toBe(false);
    expect(isSpeakerId(undefined)).toBe(false);
  });
});

describe("formatDelay (spoken reminder confirmations)", () => {
  it("formats seconds, minutes and hours without rounding errors", () => {
    expect(formatDelay(1)).toBe("1 second");
    expect(formatDelay(45)).toBe("45 seconds");
    expect(formatDelay(60)).toBe("1 minute");
    expect(formatDelay(90)).toBe("1 minute 30 seconds");
    expect(formatDelay(300)).toBe("5 minutes");
    expect(formatDelay(3600)).toBe("1 hour");
    expect(formatDelay(5400)).toBe("1 hour 30 minutes");
  });

  it("clamps bad input instead of producing nonsense", () => {
    expect(formatDelay(-5)).toBe("0 seconds");
    expect(formatDelay(Number.NaN)).toBe("0 seconds");
  });
});

import { limitHistory, MAX_LLM_HISTORY_MESSAGES } from "../lib/voice";

describe("limitHistory (keeps the prompt, and therefore the reply time, from growing)", () => {
  const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }));

  it("returns short histories unchanged", () => {
    expect(limitHistory(msgs(3), 10)).toEqual(msgs(3));
    expect(limitHistory([], 10)).toEqual([]);
  });

  it("keeps only the most recent messages", () => {
    const out = limitHistory(msgs(25), 10);
    expect(out).toHaveLength(10);
    expect(out[0].content).toBe("m15");
    expect(out[9].content).toBe("m24");
  });

  it("starts on a user turn so the model never sees an orphaned reply first", () => {
    const history = [
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];
    const out = limitHistory(history, 4); // would start at "u1"? keep last 4 -> a0 dropped
    expect(out[0].role).toBe("user");
    const out2 = limitHistory(history, 3); // last 3 = u2.. no: [a1,u2,a2] -> must drop leading a1
    expect(out2[0].role).toBe("user");
    expect(out2.map((m) => m.content)).toEqual(["u2", "a2"]);
  });

  it("has a sane default cap", () => {
    expect(MAX_LLM_HISTORY_MESSAGES).toBeGreaterThanOrEqual(6);
    expect(MAX_LLM_HISTORY_MESSAGES).toBeLessThanOrEqual(24);
  });
});

import { reasoningSettingsFor } from "../lib/voice";

describe("reasoningSettingsFor (a voice reply must not spend seconds 'thinking' first)", () => {
  it("turns thinking OFF for DeepSeek (its default is 'high', which cost 7+ seconds per reply)", () => {
    expect(reasoningSettingsFor("balanced")).toEqual({ reasoning_effort: null });
  });

  it("uses the lowest level for GPT-OSS, which cannot be fully switched off", () => {
    expect(reasoningSettingsFor("quality")).toEqual({ reasoning_effort: "low" });
  });

  it("sends nothing for the non-reasoning Llama model", () => {
    expect(reasoningSettingsFor("fastest")).toEqual({});
  });

  it("is safe for unknown or hostile keys (no prototype keys, no crash)", () => {
    expect(reasoningSettingsFor("constructor")).toEqual({});
    expect(reasoningSettingsFor(null)).toEqual({});
    expect(reasoningSettingsFor(undefined)).toEqual({});
  });
});

import { usesDeepSeekDirect, DEEPSEEK_DIRECT_MODEL, DEEPSEEK_THINKING_OFF } from "../lib/voice";

describe("DeepSeek direct API option", () => {
  it("is a valid model key and is recognised as the direct provider", () => {
    expect(isLlmKey("deepseek")).toBe(true);
    expect(usesDeepSeekDirect("deepseek")).toBe(true);
    for (const k of ["fastest", "balanced", "quality", "constructor", null, undefined, "nope"]) {
      expect(usesDeepSeekDirect(k as string | null | undefined)).toBe(false);
    }
  });

  it("supports tool calling", () => {
    expect(modelSupportsTools("deepseek")).toBe(true);
    expect(resolveToolsEnabled("1", "deepseek")).toBe(true);
  });

  it("uses DeepSeek's own model name, not a Cloudflare one", () => {
    expect(LLM_MODELS.deepseek).toBe(DEEPSEEK_DIRECT_MODEL);
    expect(DEEPSEEK_DIRECT_MODEL.startsWith("@cf/")).toBe(false);
  });

  it("always sends thinking: disabled (the setting that made replies ~0.7s to first word)", () => {
    expect(DEEPSEEK_THINKING_OFF).toEqual({ deepseek: { thinking: { type: "disabled" } } });
  });

  it("sends no Workers AI reasoning setting for it", () => {
    expect(reasoningSettingsFor("deepseek")).toEqual({});
  });
});

import { DEFAULT_UI_LLM } from "../lib/voice";

describe("default model choice", () => {
  it("the page defaults to DeepSeek direct, a valid model key", () => {
    expect(isLlmKey(DEFAULT_UI_LLM)).toBe(true);
    expect(DEFAULT_UI_LLM).toBe("deepseek");
  });

  it("the SERVER default stays a Cloudflare model, so a request with no ?llm= can never send 'deepseek-flash' to Workers AI", () => {
    expect(LLM_MODELS[DEFAULT_LLM].startsWith("@cf/")).toBe(true);
    expect(resolveLlmModel(null).startsWith("@cf/")).toBe(true);
    expect(resolveLlmModel("nope").startsWith("@cf/")).toBe(true);
  });
});
