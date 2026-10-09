import { useEffect, useMemo, useRef, useState } from "react";
import { useVoiceAgent, type VoiceStatus } from "agents/voice/react";
import {
  AURA_SPEAKERS,
  DEFAULT_SPEAKER,
  LLM_MODELS,
  DEFAULT_UI_LLM,
  modelSupportsTools,
  isLlmKey,
  isSpeakerId,
  type LlmKey,
  type AuraSpeakerId,
} from "../lib/voice";
import { log, throttledLog, subscribeLog, type LogEntry } from "./lib/client-logger";

// localStorage can throw (private windows, blocked site data) — and used to
// crash the whole page on first render. Reads/writes are best-effort now.
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preference simply won't persist */
  }
}

function getSessionId(): string {
  const KEY = "voice-agent-session-id";
  let id = readStored(KEY);
  if (!id) {
    id = crypto.randomUUID();
    writeStored(KEY, id);
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
// between clicking the button and the server acknowledging start_call) — so
// we layer `starting` (local, set the instant the user clicks) on top of it.
// The call-active/inactive decision comes from this, never from the raw
// `connected` flag (which only means "the WebSocket is open" and is already
// true before the user ever clicks anything).
type UiPhase = "idle" | "connecting" | "listening" | "you_are_speaking" | "thinking" | "speaking";

const PHASE_LABEL: Record<UiPhase, string> = {
  idle: "Ready when you are",
  connecting: "Connecting…",
  listening: "Listening",
  you_are_speaking: "Hearing you",
  thinking: "Thinking…",
  speaking: "Speaking",
};

const LLM_LABELS: Record<LlmKey, string> = {
  fastest: "Fastest: Llama 3.2 1B",
  deepseek: "DeepSeek direct API: fast and smart",
  balanced: "Balanced: DeepSeek V4 Flash",
  quality: "Quality: GPT-OSS 20B",
};

// Short, model-specific reason shown under the (disabled) tools checkbox —
// see lib/voice.ts LLM_TOOL_SUPPORT for how this was determined.
const TOOLS_UNSUPPORTED_REASON: Record<LlmKey, string> = {
  fastest: "Llama 3.2 1B can't use tools. Pick DeepSeek, Balanced or Quality to turn them on.",
  deepseek: "",
  balanced: "",
  quality: "",
};

// Fixed pseudo-random per-bar weights so the waveform has a natural,
// non-uniform shape that doesn't reshuffle on every render.
const BAR_COUNT = 48;
const BAR_WEIGHTS = Array.from({ length: BAR_COUNT }, (_, i) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return 0.35 + 0.65 * (x - Math.floor(x));
});

type StageTheme = "idle" | "listening" | "thinking" | "speaking";

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

/** Off-by-default activity panel: recent client log lines + live connection
 * state, so a broken capture path is visible in the app itself instead of
 * requiring DevTools. Toggled by the "Debug" link in the top bar. */
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

  return (
    <section className="debug" aria-label="Activity">
      <dl>
        <div>
          <dt>Socket</dt>
          <dd>{props.connected ? "open" : "closed"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{props.status}</dd>
        </div>
        <div>
          <dt>Starting</dt>
          <dd>{String(props.starting)}</dd>
        </div>
        <div>
          <dt>Mic level</dt>
          <dd>{props.audioLevel.toFixed(3)}</dd>
        </div>
        <div>
          <dt>Muted</dt>
          <dd>{String(props.isMuted)}</dd>
        </div>
        <div>
          <dt>Error</dt>
          <dd>{props.error ?? "none"}</dd>
        </div>
        {props.outputDeviceError ? (
          <div>
            <dt>Output</dt>
            <dd>{props.outputDeviceError}</dd>
          </div>
        ) : null}
      </dl>
      <div ref={listRef} className="debug-log scroll-thin">
        {entries.length === 0 ? (
          <p>No activity yet.</p>
        ) : (
          entries.map((e, i) => (
            <p key={i} className={e.level}>
              <span style={{ opacity: 0.6 }}>{formatTime(e.time)}</span> {e.message}
            </p>
          ))
        )}
      </div>
    </section>
  );
}

export default function App() {
  const sessionId = useMemo(getSessionId, []);
  // Stored values are validated: a stale or hand-edited value (for example a
  // model that no longer exists) used to leave the picker blank and the
  // label lookup undefined.
  const [speaker, setSpeaker] = useState<AuraSpeakerId>(() => {
    const stored = readStored("voice-agent-speaker");
    return isSpeakerId(stored) ? stored : DEFAULT_SPEAKER;
  });
  const [llm, setLlm] = useState<LlmKey>(() => {
    const stored = readStored("voice-agent-llm");
    return isLlmKey(stored) ? stored : DEFAULT_UI_LLM;
  });
  const [toolsEnabled, setToolsEnabled] = useState<boolean>(() => {
    return readStored("voice-agent-tools") === "1";
  });
  const [showDebug, setShowDebug] = useState(false);

  useEffect(() => writeStored("voice-agent-speaker", speaker), [speaker]);
  useEffect(() => writeStored("voice-agent-llm", llm), [llm]);
  useEffect(() => writeStored("voice-agent-tools", toolsEnabled ? "1" : "0"), [toolsEnabled]);

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

  // Local "did the user ask to start a call" flag. Set the instant the button
  // is clicked, cleared once the server confirms (status leaves "idle") or
  // an error/end arrives. This closes the gap between "clicked start" and
  // "server acknowledged" with an honest "connecting…" state instead of
  // silence.
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

  // The call is "active" — and the button shows "End call" — the instant the
  // user asks to start, through to the server confirming a non-idle status.
  // This intentionally ignores `connected` (WebSocket open/closed), which is
  // unrelated to whether a call is in progress: the WebSocket opens
  // automatically on page load, long before anyone clicks anything.
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

  const handleCallClick = () => {
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

  const turnsRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    turnsRef.current?.scrollTo({ top: turnsRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript]);

  // Page theme follows the call: red while your microphone is live, black
  // while the assistant is speaking, concrete otherwise.
  const theme: StageTheme =
    phase === "listening" || phase === "you_are_speaking"
      ? "listening"
      : phase === "speaking"
        ? "speaking"
        : phase === "thinking"
          ? "thinking"
          : "idle";

  // Level for the waveform (0-1): audioLevel is raw RMS, typically well under
  // 1 for normal speech, so scale it up so the bars visibly move.
  const level = Math.min(1, audioLevel * 3.2);
  const latencyMs = turnMetrics?.turnTotalMs;
  const combinedError = error ?? outputDeviceError;

  // The hero is whatever is being said right now, shown huge like subtitles.
  const lastUser = [...transcript].reverse().find((t) => t.role === "user");
  const lastAssistant = [...transcript].reverse().find((t) => t.role === "assistant");
  const lastTurn = transcript[transcript.length - 1];
  let heroText: string;
  let heroWho: string;
  let heroRole: "hint" | "interim" | "text";
  if (interimTranscript) {
    heroText = interimTranscript;
    heroWho = "You";
    heroRole = "interim";
  } else if (phase === "speaking" && lastAssistant) {
    heroText = lastAssistant.text;
    heroWho = "Assistant";
    heroRole = "text";
  } else if (phase === "thinking") {
    heroText = lastUser?.text ?? "Thinking…";
    heroWho = "You said";
    heroRole = "text";
  } else if (callActive && (phase === "listening" || phase === "you_are_speaking")) {
    heroText = "Go ahead, I'm listening.";
    heroWho = "Microphone is live";
    heroRole = "hint";
  } else if (callActive) {
    heroText = "Starting the call…";
    heroWho = "One moment";
    heroRole = "hint";
  } else if (lastTurn) {
    heroText = lastTurn.text;
    heroWho = lastTurn.role === "user" ? "You said" : "Assistant said";
    heroRole = "text";
  } else {
    heroText = "Say something.";
    heroWho = "Voice assistant";
    heroRole = "hint";
  }

  const downloadTranscript = () => {
    const body = transcript.map((t) => `${t.role === "user" ? "You" : "Assistant"}: ${t.text}`).join("\n\n");
    const blob = new Blob([body + "\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `voice-transcript-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const callLabel = callActive ? "End call" : !connected ? "Connecting…" : "Start talking";

  return (
    <div className="stage" data-theme={theme}>
      <div className="stage-inner">
        <header className="topbar">
          <p className="wordmark">
            <span className="rec-dot" aria-hidden />
            voice
          </p>
          <button type="button" className="link-btn" onClick={() => setShowDebug((v) => !v)} aria-expanded={showDebug}>
            {showDebug ? "Hide debug" : "Debug"}
          </button>
        </header>

        <main className="hero" aria-live="polite">
          <p className="hero-who">{heroWho}</p>
          <h1 className="hero-text" data-role={heroRole} dir="auto">
            {heroText}
          </h1>
        </main>

        <div
          className="wave"
          data-mode={theme}
          role="img"
          aria-label={
            theme === "listening" ? `Microphone level ${Math.round(level * 100)} percent` : `Assistant is ${PHASE_LABEL[phase].toLowerCase()}`
          }
        >
          {BAR_WEIGHTS.map((w, i) => (
            <span
              key={i}
              style={
                theme === "listening"
                  ? { height: `${6 + level * 94 * w}%` }
                  : theme === "speaking" || theme === "thinking"
                    ? { animationDelay: `${(i % 12) * 0.07}s`, animationDuration: `${0.6 + w * 0.6}s` }
                    : undefined
              }
            />
          ))}
        </div>

        <div className="controls">
          <button
            type="button"
            className="btn-call"
            onClick={handleCallClick}
            // Only block *starting* while offline. If the socket drops mid-call
            // the button used to become disabled too, leaving no way to end
            // the call or stop the mic.
            disabled={!connected && !callActive}
          >
            {callActive ? (
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
                <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
                <rect x="9" y="2.5" width="6" height="12" rx="3" />
                <path d="M5 10.5a7 7 0 0 0 14 0" strokeLinecap="round" />
                <path d="M12 19v3" strokeLinecap="round" />
              </svg>
            )}
            {callLabel}
          </button>

          {callActive ? (
            <button type="button" className="btn-outline" onClick={handleToggleMute}>
              {isMuted ? "Unmute mic" : "Mute mic"}
            </button>
          ) : null}

          <p className="meta" role="status">
            {PHASE_LABEL[phase]}
            {latencyMs ? ` — last reply took ${Math.round(latencyMs)} ms` : ""}
          </p>
        </div>

        {combinedError ? (
          <div className="alert" role="alert">
            <span aria-hidden>⚠</span>
            <div>
              <p style={{ margin: 0 }}>{combinedError}</p>
              {combinedError.toLowerCase().includes("microphone") ? (
                <small>
                  Allow microphone access in your browser's site settings (the icon left of the address bar), then press
                  Start talking again.
                </small>
              ) : combinedError.toLowerCase().includes("connect") ? (
                <small>Check your network connection. The app keeps retrying automatically.</small>
              ) : null}
            </div>
          </div>
        ) : null}

        <section className="settings" aria-label="Call settings">
          <div className="setting">
            <label htmlFor="speaker">Voice</label>
            <select
              id="speaker"
              className="select"
              value={speaker}
              onChange={(e) => setSpeaker(e.target.value as AuraSpeakerId)}
            >
              {AURA_SPEAKERS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} ({s.gender})
                </option>
              ))}
            </select>
          </div>

          <div className="setting">
            <label htmlFor="llm">Model</label>
            <select id="llm" className="select" value={llm} onChange={(e) => setLlm(e.target.value as LlmKey)}>
              {(Object.keys(LLM_MODELS) as LlmKey[]).map((key) => (
                <option key={key} value={key}>
                  {LLM_LABELS[key]}
                </option>
              ))}
            </select>
          </div>

          <div className="setting">
            <span className="label">Tools</span>
            <label className="toggle" data-off={!toolsSupported} style={{ fontWeight: 500, marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={effectiveToolsEnabled}
                disabled={!toolsSupported}
                onChange={(e) => setToolsEnabled(e.target.checked)}
              />
              <span>
                Let the assistant tell the time and set reminders
                <span className="note" style={{ display: "block" }}>
                  {toolsSupported ? "Adds about a second to replies that use a tool." : TOOLS_UNSUPPORTED_REASON[llm]}
                </span>
              </span>
            </label>
          </div>

          {callActive ? (
            <p className="note" style={{ gridColumn: "1 / -1", marginTop: 0 }}>
              Changing the voice, model or tools reconnects the call.
            </p>
          ) : null}
        </section>

        {transcript.length > 0 ? (
          <section className="transcript" aria-label="Conversation">
            <div className="transcript-head">
              <h2>Conversation</h2>
              <button type="button" className="link-btn" onClick={downloadTranscript}>
                Download as text
              </button>
            </div>
            <ul ref={turnsRef} className="turns scroll-thin">
              {transcript.map((turn, i) => (
                <li key={i} className="turn" data-role={turn.role}>
                  <span className="who">{turn.role === "user" ? "You" : "Assistant"}</span>
                  <p dir="auto">{turn.text}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

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
      </div>
    </div>
  );
}
