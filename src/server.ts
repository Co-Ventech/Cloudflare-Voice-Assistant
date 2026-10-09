import {
  Agent,
  routeAgentRequest,
  type Connection,
  type WSMessage,
} from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type VoiceTurnContext,
  type Transcriber,
  type TranscriberSessionOptions,
  type TranscriberSession,
  type TTSProvider,
} from "agents/voice";
import { streamText, tool, isStepCount } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { z } from "zod";
import {
  SYSTEM_PROMPT,
  resolveLlmModel,
  resolveSpeaker,
  resolveToolsEnabled,
  formatDelay,
  limitHistory,
  MAX_LLM_HISTORY_MESSAGES,
  MAX_REPLY_TOKENS,
  reasoningSettingsFor,
  usesDeepSeekDirect,
  DEEPSEEK_DIRECT_MODEL,
  DEEPSEEK_THINKING_OFF,
} from "../lib/voice";
import { checkRateLimit } from "../lib/ratelimit";
import { getClientIp } from "../lib/clientinfo";
import { patchSentenceChunkerForClauseStreaming } from "../lib/tts-chunking";
import { guardToolCallLeakStream, TOOLCALL_LEAK_FALLBACK_REPLY, type LeakGuardChunk } from "../lib/toolcall-guard";
import { withFirstChunkTimeout, STALL_TIMEOUT_MS, STALL_FALLBACK_REPLY } from "../lib/stall-guard";

// See lib/tts-chunking.ts for why this patches the `agents` package instead
// of using a config option (there isn't one). Applied once at module load.
patchSentenceChunkerForClauseStreaming();

interface Env {
  AI: Ai;
  VOICE_KV: KVNamespace;
  /** Optional secret for the "DeepSeek, direct API" model option. */
  DEEPSEEK_API_KEY?: string;
  MyVoiceAgent: DurableObjectNamespace;
}

// --- Server-side diagnostics -------------------------------------------
// Prefixed console.log/console.error so the whole pipeline is visible in
// `npm run dev` / `wrangler tail` output: connection accepted, audio frames
// received, STT session lifecycle + transcripts, LLM start/finish, TTS
// submit/return. Nothing here is swallowed — every catch below logs before
// continuing. This is what answers "how do I know it's listening" on the
// server side: frames + transcripts show up here in real time.
const SLOG_PREFIX = "[voice-server]";

function slog(event: string, data?: Record<string, unknown>): void {
  console.log(`${SLOG_PREFIX} ${event}`, data ?? {});
}

function serr(event: string, err: unknown, data?: Record<string, unknown>): void {
  const errInfo = err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) };
  console.error(`${SLOG_PREFIX} ${event}`, { ...errInfo, ...data });
}

/** Wraps a Transcriber so every STT lifecycle event (session open/close,
 * interim results, end-of-turn, fatal errors) and audio frame throughput
 * (throttled to ~1/sec) is logged server-side. Delegates all behavior to
 * the wrapped provider unchanged. */
class LoggingTranscriber implements Transcriber {
  constructor(private readonly inner: Transcriber) {}

  createSession(options?: TranscriberSessionOptions): TranscriberSession {
    slog("stt.session.opening");
    let framesSinceLog = 0;
    let bytesSinceLog = 0;
    let lastLogTime = Date.now();

    const wrappedOptions: TranscriberSessionOptions = {
      ...options,
      onInterim: (text) => {
        slog("stt.interim", { chars: text.length });
        options?.onInterim?.(text);
      },
      onSpeechStart: (text) => {
        slog("stt.speech_start", text ? { chars: text.length } : undefined);
        options?.onSpeechStart?.(text);
      },
      onUtterance: (transcript) => {
        slog("stt.end_of_turn", { chars: transcript.length, preview: transcript.slice(0, 80) });
        options?.onUtterance?.(transcript);
      },
      onFatalError: (error) => {
        serr("stt.fatal_error", error);
        options?.onFatalError?.(error);
      },
    };

    const session = this.inner.createSession(wrappedOptions);
    slog("stt.session.opened");

    return {
      feed: (chunk) => {
        framesSinceLog += 1;
        bytesSinceLog += chunk.byteLength;
        const now = Date.now();
        if (now - lastLogTime >= 1000) {
          slog("stt.audio.received", { frames: framesSinceLog, bytes: bytesSinceLog });
          framesSinceLog = 0;
          bytesSinceLog = 0;
          lastLogTime = now;
        }
        session.feed(chunk);
      },
      waitUntilReady: session.waitUntilReady ? () => session.waitUntilReady!() : undefined,
      updateAgentContext: session.updateAgentContext
        ? (text: string) => session.updateAgentContext!(text)
        : undefined,
      close: () => {
        slog("stt.session.closed");
        session.close();
      },
    };
  }
}

/** Wraps a TTSProvider so every synthesize call logs the submitted text
 * (truncated), bytes returned, and duration. Delegates unchanged. */
class LoggingTTS implements TTSProvider {
  constructor(private readonly inner: TTSProvider) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    const start = Date.now();
    slog("tts.synthesize.start", { chars: text.length, preview: text.slice(0, 80) });
    try {
      const result = await this.inner.synthesize(text, signal);
      slog("tts.synthesize.done", { bytes: result?.byteLength ?? 0, ms: Date.now() - start });
      return result;
    } catch (err) {
      serr("tts.synthesize.error", err, { ms: Date.now() - start });
      throw err;
    }
  }
}

// diagnostics.browserConsole streams the library's own connection/mic/
// speech/playback lifecycle events to the browser console as
// "[voice:client] ..." / "[voice:server] ..." — free, structured visibility
// into the capture path that complements the explicit logging above.
const VoiceAgent = withVoice(Agent, { diagnostics: { browserConsole: true } });

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber: Transcriber = new LoggingTranscriber(new WorkersAIFluxSTT(this.env.AI));
  tts = new LoggingTTS(new WorkersAITTS(this.env.AI, { speaker: "angus" }));

  /** Picks up the ?speaker= and ?llm= query params sent by the client the
   * moment a call starts, so a reconnect (e.g. after changing the voice
   * picker) takes effect immediately without a fresh Durable Object. */
  beforeCallStart(connection: Connection): boolean {
    const url = new URL(connection.uri ?? "http://localhost");
    const speaker = resolveSpeaker(url.searchParams.get("speaker"));
    const llm = resolveLlmModel(url.searchParams.get("llm"));
    const tools = resolveToolsEnabled(url.searchParams.get("tools"), url.searchParams.get("llm"));
    slog("call.starting", { connectionId: connection.id, speaker, llm, tools });
    this.tts = new LoggingTTS(new WorkersAITTS(this.env.AI, { speaker }));
    return true;
  }

  onMessage(connection: Connection, message: WSMessage) {
    // Voice protocol messages (start_call, binary audio frames, etc.) are
    // intercepted by the withVoice mixin before they reach here — this only
    // sees whatever (if anything) falls through, so log it for visibility
    // rather than assuming it's dead code.
    const kind = typeof message === "string" ? "text" : "binary";
    const size = typeof message === "string" ? message.length : (message as ArrayBuffer).byteLength;
    slog("connection.message.passthrough", { connectionId: connection.id, kind, size });
  }

  /** Tools force a second sequential LLM round trip whenever the model
   * decides to call one (measured ~2-3x the latency of a plain reply — see
   * lib/voice.ts). For casual voice chat that's rarely worth it, so tools
   * are opt-in via ?tools=1 rather than always attached. The capability
   * stays available, just not paid for on every turn by default. */
  private buildTools() {
    return {
      get_current_time: tool({
        description: "Get the current date and time. Use when the user asks what time it is.",
        inputSchema: z.object({}),
        execute: async () => {
          const now = new Date();
          return {
            time: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" }),
            date: now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
          };
        },
      }),
      set_reminder: tool({
        description: "Set a reminder that will be spoken aloud after a delay.",
        inputSchema: z.object({
          message: z.string().describe("The reminder message to speak to the user"),
          // Bounded: a model can emit 0, negative or absurd values, which
          // would either throw in schedule() or park a reminder for years.
          delay_seconds: z
            .number()
            .min(1)
            .max(86_400)
            .describe("How many seconds from now to trigger the reminder (1 to 86400)"),
        }),
        execute: async ({ message, delay_seconds }: { message: string; delay_seconds: number }) => {
          const delay = Math.round(delay_seconds);
          await this.schedule(delay, "speakReminder", { message });
          return { confirmed: true, message, delay: formatDelay(delay) };
        },
      }),
    };
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const workersAi = createWorkersAI({ binding: this.env.AI });
    const url = new URL(context.connection.uri ?? "http://localhost");
    const llmKey = url.searchParams.get("llm");
    // "DeepSeek, direct API" talks to DeepSeek's own endpoint with thinking
    // switched off. Without the secret it falls back to the Cloudflare-hosted
    // DeepSeek so a call never fails just because the key isn't set.
    const wantsDirect = usesDeepSeekDirect(llmKey);
    const directKey = this.env.DEEPSEEK_API_KEY;
    const useDirect = wantsDirect && !!directKey;
    const effectiveKey = wantsDirect && !directKey ? "balanced" : llmKey;
    if (wantsDirect && !directKey) slog("llm.deepseek_direct.no_key", { fallback: "balanced" });
    const llmModel = useDirect ? DEEPSEEK_DIRECT_MODEL : resolveLlmModel(effectiveKey);
    const chatModel =
      useDirect && directKey
        ? createDeepSeek({ apiKey: directKey })(DEEPSEEK_DIRECT_MODEL)
        : workersAi(llmModel as Parameters<typeof workersAi>[0], {
            sessionAffinity: this.sessionAffinity,
            ...reasoningSettingsFor(effectiveKey),
          });
    // Server-side enforcement of "don't offer tools on models that can't do
    // them" (Task 3): resolveToolsEnabled already refuses tools for a model
    // lib/voice.ts knows doesn't support them, regardless of what the client
    // requested — the UI disables the checkbox for such a model, but this
    // does not trust that the client actually obeyed it.
    const toolsEnabled = resolveToolsEnabled(url.searchParams.get("tools"), llmKey);
    const turnStart = Date.now();
    slog("llm.turn.start", {
      connectionId: context.connection.id,
      model: llmModel,
      tools: toolsEnabled,
      transcriptChars: transcript.length,
      historyMessages: context.messages.length,
    });

    const messages = [
      ...limitHistory(context.messages, MAX_LLM_HISTORY_MESSAGES).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user" as const, content: transcript },
    ];

    // If the model request hangs (no error, no first word — seen in local
    // development), cancel it and apologise out loud instead of leaving the
    // user in silence. Also follows the library's own cancellation (barge-in).
    const stall = new AbortController();
    if (context.signal.aborted) stall.abort();
    else context.signal.addEventListener("abort", () => stall.abort(), { once: true });

    // Shared by the primary call and the no-tools retry below (see
    // runLeakGuard's onLeak) so both go through identical logging/model
    // config, differing only in whether `tools` is attached.
    const runLlm = (withTools: boolean, label: string) =>
      streamText({
        model: chatModel,
        providerOptions: useDirect ? DEEPSEEK_THINKING_OFF : undefined,
        instructions: SYSTEM_PROMPT,
        messages,
        maxOutputTokens: MAX_REPLY_TOKENS,
        tools: withTools ? this.buildTools() : undefined,
        stopWhen: isStepCount(3),
        abortSignal: stall.signal,
        onFinish: ({ text, finishReason, totalUsage }) => {
          slog("llm.turn.finish", {
            connectionId: context.connection.id,
            model: llmModel,
            label,
            ms: Date.now() - turnStart,
            finishReason,
            replyChars: text.length,
            usage: totalUsage,
          });
        },
        onError: ({ error }) => {
          serr("llm.turn.error", error, { connectionId: context.connection.id, model: llmModel, label, ms: Date.now() - turnStart });
        },
      });

    const result = runLlm(toolsEnabled, "primary");

    // Defence in depth against exactly the bug this app shipped with: a
    // model with tools attached (auto tool choice) that doesn't reliably
    // support structured tool calling writes the call out as raw JSON text
    // instead — see lib/toolcall-guard.ts for the full story. Guarding here
    // means it's caught regardless of whether it's this app's own UI, a
    // stale client, or a hand-typed ?tools=1 request that got tools attached
    // in the first place; and regardless of which model is in use, not just
    // the one currently known to have this problem.
    const guardedStream = withFirstChunkTimeout(
      result.stream,
      STALL_TIMEOUT_MS,
      () => {
        serr("llm.turn.stalled", new Error(`no reply within ${STALL_TIMEOUT_MS}ms, cancelled`), {
          connectionId: context.connection.id,
          model: llmModel,
        });
        stall.abort();
      },
      { type: "text-delta", text: STALL_FALLBACK_REPLY } as never,
      // Only actual words satisfy the deadline (see lib/stall-guard.ts).
      (chunk) => (chunk as { type?: string }).type === "text-delta",
    );

    return guardToolCallLeakStream(guardedStream, async (leakedText) => {
      serr(
        "llm.tool_call_leak.suppressed",
        new Error("assistant text was a serialized tool call, not spoken/shown"),
        { connectionId: context.connection.id, model: llmModel, leakedText },
      );
      if (!toolsEnabled) {
        // No tools were even attached this turn — a false-ish positive is
        // vanishingly unlikely (requires brace-leading text that also
        // parses as a tool-call shape), but retrying without tools would be
        // identical to the primary call, so go straight to the canned reply.
        return TOOLCALL_LEAK_FALLBACK_REPLY;
      }
      try {
        const retry = runLlm(false, "retry_no_tools");
        const retryText = await retry.text;
        return retryText.trim().length > 0 ? retryText : TOOLCALL_LEAK_FALLBACK_REPLY;
      } catch (err) {
        serr("llm.tool_call_leak.retry_failed", err, { connectionId: context.connection.id, model: llmModel });
        return TOOLCALL_LEAK_FALLBACK_REPLY;
      }
    });
  }

  async onCallStart(connection: Connection) {
    slog("call.started", { connectionId: connection.id });
    // The history table doesn't exist until the first message is saved, so on
    // a brand-new session this query used to throw "no such table:
    // cf_voice_messages" and the whole call failed to start.
    let messageCount = 0;
    try {
      messageCount = this.sql<{ count: number }>`SELECT COUNT(*) as count FROM cf_voice_messages`[0]?.count ?? 0;
    } catch {
      /* new session: no history yet */
    }
    const greeting =
      messageCount > 0
        ? "Welcome back. How can I help?"
        : "Hi, I'm your voice assistant. Just start talking whenever you're ready.";
    try {
      await this.speak(connection, greeting);
    } catch (err) {
      serr("call.greeting.error", err, { connectionId: connection.id });
      throw err;
    }
  }

  async onCallEnd(connection: Connection) {
    slog("call.ended", { connectionId: connection.id });
  }

  async speakReminder(payload: { message: string }) {
    slog("reminder.speaking", { chars: payload.message.length });
    try {
      await this.speakAll(`Reminder: ${payload.message}`);
    } catch (err) {
      serr("reminder.error", err);
      throw err;
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Abuse protection: cap new WebSocket sessions per IP. This runs on every
    // request into the agent routing namespace (connect + reconnect), which
    // is the right unit to rate-limit for a persistent-connection protocol —
    // there's no "per request" cost once a call is streaming.
    if (url.pathname.startsWith("/agents/")) {
      const ip = getClientIp(request);
      const result = await checkRateLimit(env.VOICE_KV, `session:${ip}`, { limit: 40, windowSeconds: 3600 });
      if (!result.allowed) {
        serr("connection.rate_limited", new Error("rate limit exceeded"), { ip, path: url.pathname });
        return new Response(JSON.stringify({ error: "Too many connection attempts. Try again shortly." }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": String(result.resetSeconds) },
        });
      }
      slog("connection.accepted", { path: url.pathname, query: Object.fromEntries(url.searchParams) });
    }

    const response = await routeAgentRequest(request, env);
    if (!response) {
      serr("connection.not_found", new Error("no route matched"), { path: url.pathname });
      return new Response("Not found", { status: 404 });
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
