import { useEffect, useMemo, useRef, useState } from "react";
import { useVoiceAgent, type VoiceStatus } from "agents/voice/react";
import { AURA_SPEAKERS, DEFAULT_SPEAKER, LLM_MODELS, DEFAULT_LLM, modelSupportsTools, type LlmKey, type AuraSpeakerId } from "../lib/voice";
import { log, throttledLog, subscribeLog, type LogEntry } from "./lib/client-logger";

function getSessionId(): string {
  const KEY = "voice-agent-session-id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

// Above this raw audioLevel (RMS, 0-1) we consider the user to be actively
// speaking rather than just "listening" in silence. Matches the VoiceClient
// library's own default silence threshold (0.04) so the UI and the
// server-side turn-taking agree on what counts as speech.
const SPEAKING_THRESHOLD = 0.045;

// The UI's own honest state machine. `status` from the hook only reflects
// what the *server* has confirmed (it stays "idle" for the brief window
// between clicking the orb and the server acknowledging start_call) — so we
// layer `starting` (local, set the instant the user clicks) on top of it.
// This is also the fix for the original bug: the call-active/inactive
// decision now comes from this, never from the raw `connected` flag (which
// only means "the WebSocket is open" and was already true before the user
// ever clicked anything).
type UiPhase = "idle" | "connecting" | "listening" | "you_are_speaking" | "thinking" | "speaking";

const PHASE_LABEL: Record<UiPhase, string> = {
  idle: "tap to start talking",
  connecting: "connecting…",
  listening: "listening…",
  you_are_speaking: "you're speaking",
  thinking: "thinking…",
  speaking: "speaking…",
};

const LLM_LABELS: Record<LlmKey, string> = {
  fastest: "Fastest · Llama 3.2 1B",
  balanced: "Balanced · DeepSeek V4 Flash",
  quality: "Quality · GPT-OSS 20B",
};

// Short, model-specific reason shown under the (disabled) tools checkbox —
// see lib/voice.ts LLM_TOOL_SUPPORT for how this was determined.
const TOOLS_UNSUPPORTED_REASON: Record<LlmKey, string> = {
  fastest: "Llama 3.2 1B doesn't support tool calling — switch to Balanced or Quality to use tools.",
  balanced: "",
  quality: "",
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

/** Off-by-default activity panel: recent client log lines + live connection
 * state, so a broken capture path is visible in the app itself instead of
 * requiring DevTools. Toggled by the "debug" link at the bottom of the page. */
function DebugPanel(props: {
  connected: boolean;
  status: VoiceStatus;
  starting: boolean;
  audioLevel: number;
  isMuted: boolean;
  error: string | null;
  outputDeviceError: string | null;
}) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeLog(setEntries), []);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries]);

  const levelColor: Record<LogEntry["level"], string> = {
    info: "text-[var(--ink-dim)]",
    warn: "text-[var(--amber)]",
    error: "text-[var(--err)]",
  };

  return (
    <div className="glass fade-in-up mt-3 w-full rounded-2xl p-4 text-xs">
      <p className="mb-2 text-[11px] tracking-[0.15em] text-[var(--ink-dim)] uppercase">Activity</p>
      <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 font-[family-name:var(--font-mono)] text-[11px] text-[var(--ink-dim)] sm:grid-cols-3">
        <span>ws: {props.connected ? "open" : "closed"}</span>
        <span>status: {props.status}</span>
        <span>starting: {String(props.starting)}</span>
        <span>mic level: {props.audioLevel.toFixed(3)}</span>
        <span>muted: {String(props.isMuted)}</span>
        <span className={props.error ? "text-[var(--err)]" : ""}>error: {props.error ?? "none"}</span>
        {props.outputDeviceError ? <span className="text-[var(--amber)]">output: {props.outputDeviceError}</span> : null}
      </div>
      <div ref={listRef} className="transcript-scroll max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-black/20 p-2 font-[family-name:var(--font-mono)]">
        {entries.length === 0 ? (
          <p className="text-[var(--ink-dim)]/60">no activity yet</p>
        ) : (
          entries.map((e, i) => (
            <p key={i} className={`${levelColor[e.level]} whitespace-pre-wrap break-words`}>
              <span className="text-[var(--ink-dim)]/50">{formatTime(e.time)}</span> {e.message}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

export default function App() {
  const sessionId = useMemo(getSessionId, []);
  const [speaker, setSpeaker] = useState<AuraSpeakerId>(() => {
    return (localStorage.getItem("voice-agent-speaker") as AuraSpeakerId) || DEFAULT_SPEAKER;
  });
  const [llm, setLlm] = useState<LlmKey>(() => {
    return (localStorage.getItem("voice-agent-llm") as LlmKey) || DEFAULT_LLM;
  });
  const [toolsEnabled, setToolsEnabled] = useState<boolean>(() => {
    return localStorage.getItem("voice-agent-tools") === "1";
  });
  const [showDebug, setShowDebug] = useState(false);

  useEffect(() => localStorage.setItem("voice-agent-speaker", speaker), [speaker]);
  useEffect(() => localStorage.setItem("voice-agent-llm", llm), [llm]);
  useEffect(() => localStorage.setItem("voice-agent-tools", toolsEnabled ? "1" : "0"), [toolsEnabled]);

  // Whether the *selected* model supports structured tool calling at all
  // (lib/voice.ts LLM_TOOL_SUPPORT, verified empirically — see README). The
  // checkbox reflects the user's stored preference (`toolsEnabled`) even
  // while it's disabled, so switching back to a supporting model restores
  // it automatically instead of silently losing the choice; only the
  // *effective* value sent to the server is gated on model support.
  const toolsSupported = modelSupportsTools(llm);
  const effectiveToolsEnabled = toolsEnabled && toolsSupported;

  useEffect(() => {
    log("info", "app mounted", { session: sessionId, llm, speaker, tools: effectiveToolsEnabled });
    // Only log once per mount — deliberately excludes llm/speaker/toolsEnabled
    // from deps so changing a picker doesn't re-fire this line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const {
    status,
    transcript,
    interimTranscript,
    audioLevel,
    isMuted,
    connected,
    error,
    outputDeviceError,
    turnMetrics,
    startCall,
    endCall,
    toggleMute,
  } = useVoiceAgent({
    agent: "my-voice-agent",
    name: sessionId,
    query: { llm, speaker, tools: effectiveToolsEnabled ? "1" : "0" },
  });

  // Local "did the user ask to start a call" flag. Set the instant the orb
  // is clicked, cleared once the server confirms (status leaves "idle") or
  // an error/end arrives. This closes the gap between "clicked start" and
  // "server acknowledged" with an honest "connecting…" state instead of
  // silence, and — combined with never reading `connected` for call state —
  // is the fix for the original bug (see callActive below).
  const [starting, setStarting] = useState(false);

  const prevStatusRef = useRef<VoiceStatus>(status);
  useEffect(() => {
    if (prevStatusRef.current !== status) {
      log("info", "status changed", { from: prevStatusRef.current, to: status });
      prevStatusRef.current = status;
      if (status !== "idle") setStarting(false);
    }
  }, [status]);

  const prevConnectedRef = useRef(connected);
  useEffect(() => {
    if (prevConnectedRef.current !== connected) {
      log(connected ? "info" : "warn", "websocket connection changed", { connected });
      prevConnectedRef.current = connected;
    }
  }, [connected]);

  useEffect(() => {
    if (error) {
      log("error", "voice error", error);
      setStarting(false);
    }
  }, [error]);

  useEffect(() => {
    if (outputDeviceError) log("warn", "output device error", outputDeviceError);
  }, [outputDeviceError]);

  useEffect(() => {
    if (turnMetrics) log("info", "turn metrics", turnMetrics);
  }, [turnMetrics]);

  const prevTranscriptLenRef = useRef(0);
  useEffect(() => {
    for (let i = prevTranscriptLenRef.current; i < transcript.length; i++) {
      const turn = transcript[i];
      log("info", `transcript [${turn.role}]`, { chars: turn.text.length });
    }
    prevTranscriptLenRef.current = transcript.length;
  }, [transcript]);

  useEffect(() => {
    if (interimTranscript) throttledLog("interim", 400, "info", "interim transcript", { chars: interimTranscript.length });
  }, [interimTranscript]);

  useEffect(() => {
    if (status === "listening" || starting) {
      throttledLog("audio-level", 1000, "info", "mic level heartbeat", { level: Number(audioLevel.toFixed(3)), muted: isMuted });
    }
  }, [audioLevel, status, starting, isMuted]);

  // The call is "active" — and the orb should show the stop icon — the
  // instant the user asks to start, through to the server confirming a
  // non-idle status. This intentionally ignores `connected` (WebSocket
  // open/closed), which is unrelated to whether a call is in progress: the
  // WebSocket opens automatically on page load, long before anyone clicks
  // anything, so using it for the button's state was the original bug — the
  // orb rendered as "active" immediately on load and the very first click
  // called endCall() instead of startCall(), meaning getUserMedia was never
  // invoked.
  const callActive = starting || status !== "idle";

  const phase: UiPhase = !connected
    ? "connecting"
    : starting && status === "idle"
      ? "connecting"
      : status === "listening"
        ? audioLevel > SPEAKING_THRESHOLD
          ? "you_are_speaking"
          : "listening"
        : status === "thinking"
          ? "thinking"
          : status === "speaking"
            ? "speaking"
            : "idle";

  const handleOrbClick = () => {
    if (callActive) {
      log("info", "user clicked: end call");
      setStarting(false);
      endCall();
      return;
    }
    log("info", "user clicked: start call", { llm, speaker, tools: effectiveToolsEnabled });
    setStarting(true);
    // startCall() is not try/caught inside the library and the hook forwards
    // its promise as-is — an unhandled rejection here (e.g. AudioContext
    // construction throwing) would otherwise fail completely silently, with
    // no error rendered anywhere. Never leave this floating.
    startCall()
      .then(() => log("info", "startCall() resolved"))
      .catch((err: unknown) => {
        log("error", "startCall() rejected", err);
        setStarting(false);
      });
  };

  const handleToggleMute = () => {
    log("info", "user clicked: toggle mute", { wasMuted: isMuted });
    toggleMute();
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript, interimTranscript]);

  const isActive = phase !== "idle" && phase !== "connecting";
  // Meter fill (0-1): audioLevel is raw RMS, typically well under 1 for
  // normal speech, so scale it up for a meter that actually visibly moves.
  const level = Math.min(1, audioLevel * 3.2);
  const latencyMs = turnMetrics?.turnTotalMs;
  const meterBars = 12;
  const litBars = Math.round(level * meterBars);

  const combinedError = error ?? outputDeviceError;

  return (
    <main className="relative z-10 mx-auto flex min-h-screen max-w-2xl flex-col items-center px-6 py-14">
      {/* Header */}
      <div className="flex w-full flex-col items-center text-center">
        <p className="text-xs tracking-[0.3em] text-[var(--accent)] uppercase">workers ai · realtime voice agent</p>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-4xl font-extrabold tracking-tight text-[var(--ink)] sm:text-5xl">
          Just start talking.
        </h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--ink-dim)]">
          Streaming speech-to-text detects when you're done — no button to hold. One WebSocket carries audio in,
          transcript and speech back out, all inside a single Durable Object.
        </p>
      </div>

      {/* Orb */}
      <div className="relative mt-12 flex h-44 w-44 items-center justify-center">
        <span className={`orb-ring ${phase === "listening" || phase === "you_are_speaking" ? "active" : ""}`} />
        <span className={`orb-ring ${phase === "listening" || phase === "you_are_speaking" ? "active" : ""}`} />
        <span className={`orb-ring ${phase === "listening" || phase === "you_are_speaking" ? "active" : ""}`} />

        <button
          type="button"
          onClick={handleOrbClick}
          disabled={!connected}
          aria-label={callActive ? "End call" : "Start call"}
          className="relative flex h-32 w-32 items-center justify-center rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            borderColor: callActive ? "var(--accent)" : "var(--border-strong)",
            background:
              phase === "listening" || phase === "you_are_speaking"
                ? `radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--accent) ${20 + level * 55}%, transparent), rgba(20,41,38,0.6))`
                : phase === "speaking"
                  ? "radial-gradient(circle at 50% 50%, rgba(45,212,191,0.32), rgba(20,41,38,0.6))"
                  : phase === "thinking"
                    ? "radial-gradient(circle at 50% 50%, rgba(245,185,105,0.22), rgba(20,41,38,0.6))"
                    : "var(--surface)",
            boxShadow: callActive ? `0 0 ${30 + level * 60}px -10px var(--accent)` : "none",
            transform: phase === "listening" || phase === "you_are_speaking" ? `scale(${1 + level * 0.08})` : "scale(1)",
          }}
        >
          {phase === "thinking" ? (
            <svg className="think-spin h-9 w-9 text-[var(--amber)]" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeDasharray="42 14" strokeLinecap="round" />
            </svg>
          ) : callActive ? (
            <span className="h-8 w-8 rounded-md bg-[var(--accent)]" />
          ) : (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--ink)]">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" strokeLinecap="round" />
              <line x1="12" y1="19" x2="12" y2="22" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>

      <div className="mt-6 flex flex-col items-center gap-1">
        <p className="flex items-center gap-2 text-sm text-[var(--ink-dim)]">
          {isActive ? <span className="spin-dot h-1.5 w-1.5 rounded-full bg-[var(--accent)]" /> : null}
          {PHASE_LABEL[phase]}
        </p>
        {latencyMs ? <p className="text-[11px] text-[var(--ink-dim)]/70">responded in {Math.round(latencyMs)}ms</p> : null}
      </div>

      {/* Live mic input-level meter — the single most important piece of
          feedback here: it moves in real time with actual mic amplitude
          (RMS computed from the AudioWorklet, the same signal that's
          streamed to the server), so the user can see at a glance that
          capture is actually working, independent of anything else. */}
      {callActive ? (
        <div className="fade-in-up mt-4 flex w-full max-w-xs flex-col items-center gap-1.5">
          <div className="flex h-6 w-full items-end justify-center gap-[3px]" role="img" aria-label={`microphone input level ${Math.round(level * 100)}%`}>
            {Array.from({ length: meterBars }).map((_, i) => (
              <span
                key={i}
                className="w-full rounded-sm transition-colors"
                style={{
                  height: `${20 + (i / meterBars) * 80}%`,
                  background: i < litBars ? (i > meterBars * 0.8 ? "var(--amber)" : "var(--accent)") : "var(--border)",
                }}
              />
            ))}
          </div>
          <p className="text-[10px] tracking-[0.15em] text-[var(--ink-dim)]/70 uppercase">
            {isMuted ? "muted" : `mic input ${Math.round(level * 100)}%`}
          </p>
        </div>
      ) : null}

      {callActive ? (
        <button
          type="button"
          onClick={handleToggleMute}
          className="mt-4 rounded-full border border-[var(--border)] px-4 py-1.5 text-xs text-[var(--ink-dim)] transition-colors hover:border-[var(--accent)] hover:text-[var(--ink)]"
        >
          {isMuted ? "unmute mic" : "mute mic"}
        </button>
      ) : null}

      {combinedError ? (
        <div className="fade-in-up mt-3 flex w-full max-w-md items-start gap-2 rounded-xl border border-[var(--err)]/40 bg-[var(--err)]/10 px-4 py-3">
          <span className="mt-0.5 text-[var(--err)]">⚠</span>
          <div className="text-sm text-[var(--err)]">
            <p>{combinedError}</p>
            {combinedError.toLowerCase().includes("microphone") ? (
              <p className="mt-1 text-xs text-[var(--err)]/80">
                Check your browser's site permissions (the icon left of the address bar) and allow microphone access, then tap the
                orb again.
              </p>
            ) : combinedError.toLowerCase().includes("connect") ? (
              <p className="mt-1 text-xs text-[var(--err)]/80">Check your network connection. The app will keep retrying automatically.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Voice + model pickers */}
      <div className="glass fade-in-up mt-10 grid w-full grid-cols-1 gap-4 rounded-2xl p-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] tracking-[0.15em] text-[var(--ink-dim)] uppercase">Aura voice</span>
          <select
            value={speaker}
            onChange={(e) => setSpeaker(e.target.value as AuraSpeakerId)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-solid)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          >
            {AURA_SPEAKERS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} · {s.gender}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] tracking-[0.15em] text-[var(--ink-dim)] uppercase">Model</span>
          <select
            value={llm}
            onChange={(e) => setLlm(e.target.value as LlmKey)}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface-solid)] px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          >
            {(Object.keys(LLM_MODELS) as LlmKey[]).map((key) => (
              <option key={key} value={key}>
                {LLM_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label
        className={`glass fade-in-up mt-3 flex w-full items-center justify-between gap-3 rounded-2xl p-4 ${
          toolsSupported ? "" : "opacity-70"
        }`}
      >
        <span className="flex flex-col gap-0.5">
          <span className="text-[11px] tracking-[0.15em] text-[var(--ink-dim)] uppercase">Tools</span>
          <span className="text-xs text-[var(--ink-dim)]/70">
            {toolsSupported
              ? "time & reminders — off by default, costs a slower second round trip when used"
              : TOOLS_UNSUPPORTED_REASON[llm]}
          </span>
        </span>
        <input
          type="checkbox"
          checked={effectiveToolsEnabled}
          disabled={!toolsSupported}
          onChange={(e) => setToolsEnabled(e.target.checked)}
          className="h-5 w-5 accent-[var(--accent)] disabled:cursor-not-allowed"
        />
      </label>

      {callActive ? (
        <p className="mt-2 text-center text-[11px] text-[var(--ink-dim)]/70">
          changing voice, model, or tools reconnects the call
        </p>
      ) : null}

      {/* Transcript */}
      {transcript.length > 0 || interimTranscript ? (
        <div className="fade-in-up mt-8 w-full">
          <p className="text-xs tracking-[0.2em] text-[var(--ink-dim)] uppercase">transcript</p>
          <div ref={scrollRef} className="transcript-scroll glass mt-3 flex max-h-96 flex-col gap-3 overflow-y-auto rounded-2xl p-4">
            {transcript.map((turn, i) => (
              <div
                key={i}
                className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                  turn.role === "user"
                    ? "self-end bg-[var(--accent)]/15 text-[var(--ink)]"
                    : "self-start border border-[var(--border)] text-[var(--ink-dim)]"
                }`}
              >
                {turn.text}
              </div>
            ))}
            {interimTranscript ? (
              <div className="max-w-[85%] self-end rounded-xl px-4 py-2.5 text-sm leading-relaxed text-[var(--ink)]/50 italic">
                {interimTranscript}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Debug / activity panel — off by default. Answers "how do I know
          it's listening" without needing DevTools: shows the same log lines
          that go to the console, plus live connection state. */}
      <button
        type="button"
        onClick={() => setShowDebug((v) => !v)}
        className="mt-8 text-[11px] tracking-[0.1em] text-[var(--ink-dim)]/50 uppercase transition-colors hover:text-[var(--ink-dim)]"
      >
        {showDebug ? "hide debug" : "debug"}
      </button>
      {showDebug ? (
        <DebugPanel
          connected={connected}
          status={status}
          starting={starting}
          audioLevel={audioLevel}
          isMuted={isMuted}
          error={error}
          outputDeviceError={outputDeviceError}
        />
      ) : null}
    </main>
  );
}
