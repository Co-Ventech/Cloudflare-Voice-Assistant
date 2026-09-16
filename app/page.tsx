"use client";

import { useCallback, useRef, useState } from "react";

type Role = "user" | "assistant";
interface Turn {
  role: Role;
  content: string;
}

type Status = "idle" | "recording" | "processing" | "speaking" | "error";

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export default function HomePage() {
  const [status, setStatus] = useState<Status>("idle");
  const [conversation, setConversation] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const conversationRef = useRef<Turn[]>([]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : undefined,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        await sendClip(blob);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setStatus("recording");
    } catch {
      setError("Couldn't access the microphone. Check your browser permissions.");
      setStatus("error");
    }
  }, []);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setStatus("processing");
  }, []);

  async function sendClip(blob: Blob) {
    try {
      const formData = new FormData();
      formData.append("audio", blob, "clip.webm");
      formData.append("history", JSON.stringify(conversationRef.current));

      const response = await fetch("/api/voice", { method: "POST", body: formData });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? "Something went wrong.");
        setStatus("error");
        return;
      }

      const next: Turn[] = [
        ...conversationRef.current,
        { role: "user", content: data.transcript },
        { role: "assistant", content: data.reply },
      ];
      conversationRef.current = next;
      setConversation(next);

      const audioBlob = base64ToBlob(data.audio, "audio/mpeg");
      const url = URL.createObjectURL(audioBlob);
      if (audioElRef.current) {
        audioElRef.current.src = url;
        setStatus("speaking");
        await audioElRef.current.play().catch(() => {});
      } else {
        setStatus("idle");
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
      setStatus("error");
    }
  }

  function handleAudioEnded() {
    setStatus("idle");
  }

  function clearConversation() {
    conversationRef.current = [];
    setConversation([]);
    setError(null);
    setStatus("idle");
  }

  const isRecording = status === "recording";
  const isBusy = status === "processing" || status === "speaking";

  const statusLabel =
    status === "recording"
      ? "listening…"
      : status === "processing"
        ? "thinking…"
        : status === "speaking"
          ? "speaking…"
          : status === "error"
            ? "something went wrong"
            : "tap to talk";

  return (
    <main className="relative z-10 flex min-h-screen flex-col items-center px-6 py-16">
      <audio ref={audioElRef} onEnded={handleAudioEnded} className="hidden" />

      <div className="flex w-full max-w-xl flex-col items-center text-center">
        <p className="text-xs tracking-[0.3em] text-[var(--accent)] uppercase">workers ai · voice agent</p>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-4xl font-extrabold tracking-tight text-[var(--ink)] sm:text-5xl">
          Say something.
        </h1>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-[var(--ink-dim)]">
          Whisper transcribes, Llama replies, Aura speaks — all inference runs on Cloudflare's edge.
        </p>

        <div className="relative mt-14 flex h-40 w-40 items-center justify-center">
          <span className={`mic-ring ${isRecording ? "active" : ""}`} />
          <span className={`mic-ring ${isRecording ? "active" : ""}`} />
          <span className={`mic-ring ${isRecording ? "active" : ""}`} />
          <button
            type="button"
            disabled={isBusy}
            onClick={isRecording ? stopRecording : startRecording}
            className={`relative flex h-28 w-28 items-center justify-center rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
              isRecording
                ? "border-[var(--accent)] bg-[var(--accent)]/20 shadow-[0_0_40px_-8px_var(--accent)]"
                : "border-[var(--border-strong)] bg-[var(--surface)] hover:border-[var(--accent)]"
            }`}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
          >
            {isRecording ? (
              <span className="h-8 w-8 rounded-md bg-[var(--accent)]" />
            ) : (
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0" strokeLinecap="round" />
                <line x1="12" y1="19" x2="12" y2="22" strokeLinecap="round" />
              </svg>
            )}
          </button>
        </div>

        <p className="mt-6 flex items-center gap-2 text-sm text-[var(--ink-dim)]">
          {isBusy ? <span className="spin-dot h-1.5 w-1.5 rounded-full bg-[var(--accent)]" /> : null}
          {statusLabel}
        </p>

        {error ? <p className="fade-in-up mt-2 text-sm text-[var(--err)]">{error}</p> : null}
      </div>

      {conversation.length > 0 ? (
        <div className="fade-in-up mt-14 w-full max-w-xl">
          <div className="flex items-center justify-between">
            <p className="text-xs tracking-[0.2em] text-[var(--ink-dim)] uppercase">transcript</p>
            <button
              type="button"
              onClick={clearConversation}
              className="text-xs text-[var(--ink-dim)] underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
            >
              clear
            </button>
          </div>
          <div className="glass mt-3 flex flex-col gap-3 rounded-2xl p-4">
            {conversation.map((turn, i) => (
              <div
                key={i}
                className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                  turn.role === "user"
                    ? "self-end bg-[var(--accent)]/15 text-[var(--ink)]"
                    : "self-start border border-[var(--border)] text-[var(--ink-dim)]"
                }`}
              >
                {turn.content}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </main>
  );
}
