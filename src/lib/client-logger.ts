// Lightweight browser-side logger for the voice capture/playback pipeline.
//
// Why this exists: the mic-capture bug that prompted this file was invisible
// because nothing logged *anything* between "WebSocket opened" and "nothing
// happened" — no getUserMedia attempt, no AudioContext state, no frame
// counts. Every meaningful step in App.tsx now goes through `log()` so it's
// greppable in the console with a consistent "[voice]" prefix AND visible in
// the in-app debug panel (see App.tsx) without needing DevTools open.
//
// Kept dependency-free and framework-agnostic on purpose: it just needs a
// ring buffer + pub/sub so React can subscribe for the debug panel.

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  time: number;
  level: LogLevel;
  message: string;
}

const MAX_ENTRIES = 300;
const PREFIX = "[voice]";

let entries: LogEntry[] = [];
const listeners = new Set<(entries: LogEntry[]) => void>();

function notify() {
  for (const listener of listeners) listener(entries);
}

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Log one line. Always mirrors to console AND the in-app debug panel. */
export function log(level: LogLevel, message: string, ...args: unknown[]): void {
  const suffix = args.length ? " " + args.map(formatArg).join(" ") : "";
  const line = `${message}${suffix}`;
  entries = [...entries.slice(-(MAX_ENTRIES - 1)), { time: Date.now(), level, message: line }];
  notify();
  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(PREFIX, message, ...args);
}

const lastThrottled = new Map<string, number>();

/** Same as log(), but drops calls for the same `key` more often than `intervalMs`.
 * Use for anything that fires per-frame (audio level, byte counters) so the
 * console/debug panel doesn't get flooded with 50 lines/second. */
export function throttledLog(key: string, intervalMs: number, level: LogLevel, message: string, ...args: unknown[]): void {
  const now = Date.now();
  const last = lastThrottled.get(key) ?? 0;
  if (now - last < intervalMs) return;
  lastThrottled.set(key, now);
  log(level, message, ...args);
}

export function getEntries(): LogEntry[] {
  return entries;
}

export function clearEntries(): void {
  entries = [];
  notify();
}

/** Subscribe to log updates. Fires immediately with the current buffer. */
export function subscribeLog(listener: (entries: LogEntry[]) => void): () => void {
  listeners.add(listener);
  listener(entries);
  return () => {
    listeners.delete(listener);
  };
}
