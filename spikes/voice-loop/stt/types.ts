/** Shared types for the speech-to-text bench. */

export interface ClipAudio {
  num: string;
  pcm: Buffer;
  sampleRate: number;
  durationSec: number;
}

export interface ClipTimings {
  /** Connect started -> session ready to take audio (not part of latency). */
  connectMs: number | null;
  /** Audio start -> first non-empty partial text. */
  firstTextMs: number | null;
  /** Audio start -> last chunk sent (should equal the audio duration). */
  streamMs: number | null;
  /** How late the last chunk left versus the audio clock. */
  driftMs: number | null;
  /** Session length the provider bills on (AssemblyAI's reported session_duration_seconds). */
  billedSessionSec: number | null;
}

export interface ClipRun {
  /** Final transcript, or null if none arrived. */
  transcript: string | null;
  /** Last audio chunk sent -> final transcript received (ms). Null if no final. */
  latencyMs: number | null;
  timings: ClipTimings;
  /** Number of non-empty partial / interim messages before the final. */
  partials: number;
  error: string | null;
  /**
   * Transcript text that arrived in the 1 s after the final (e.g. audio the provider put in
   * a new turn). Non-null means the "final" was incomplete; scoring uses `transcript` only.
   */
  lateText: string | null;
  notes: string[];
  /** Message types with arrival time in ms relative to the last chunk sent. */
  trace: Array<{ t: number; type: string }>;
}

export interface RunOptions {
  chunkMs: number;
  finalTimeoutMs: number;
  /** Provider-specific overrides from --opt key=value (unknown keys are an error). */
  opts: Map<string, string>;
}

export function emptyRun(): ClipRun {
  return {
    transcript: null,
    latencyMs: null,
    timings: { connectMs: null, firstTextMs: null, streamMs: null, driftMs: null, billedSessionSec: null },
    partials: 0,
    error: null,
    lateText: null,
    notes: [],
    trace: [],
  };
}

export const round1 = (n: number): number => Math.round(n * 10) / 10;

/** How long to keep listening after the final, to catch text the final left out. */
export const LATE_TEXT_WINDOW_MS = 1000;
