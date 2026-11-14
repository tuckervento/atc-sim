/**
 * The per-transmission log: results/live/session-<timestamp>.jsonl for Q's live sessions and
 * results/live/replay-<timestamp>.jsonl for replays (the server's mode picks the prefix, so the
 * two never mix). One JSON row per transmission. Rows are updated in place when Q presses Y/N
 * or the client reports its timing; the whole file is rewritten atomically (temp + rename) on
 * every change, so it's always one valid row per transmission.
 *
 * Timings: `server` values are ms on the server clock, relative to release received. `client`
 * values are ms on the client's clock, relative to Space released (browser) or release sent
 * (headless replay). Stage durations are only ever computed within one clock.
 */
import { renameSync, writeFileSync } from "node:fs";
import type { Tokens } from "../interp/types.ts";
import type { SttId, TtsId } from "./voices.ts";

export type Ref = { kind: "card"; id: string } | { kind: "line"; num: string };

export interface Row {
  id: number;
  at: string;
  mode: "live" | "replay";
  ref: Ref;
  combo: { stt: SttId; tts: TtsId; assemblySession: string | null };
  /** sha of the interpreter's live context, to re-run the same request offline. */
  contextSha: string;
  audio: { sec: number; chunks: number; file: string | null };
  stt: {
    transcript: string | null;
    connectMs: number | null;
    readyBeforeRelease: boolean | null;
    newSession: boolean | null;
    partials: number | null;
    turns: number | null;
    notes: string[];
    error: string | null;
  };
  interp: {
    called: boolean;
    terse: string | null;
    valid: boolean;
    invalidReason: string | null;
    error: string | null;
    rawText: string | null;
    ms: number | null;
    serverMs: number | null;
    newConnection: boolean | null;
    tokens: Tokens | null;
    promptSha: string;
  };
  /** Terse expected command; null for unscored (script line 34). */
  expected: string | null;
  /** Exact match after normalizeCommand (interp/score.ts scoreLine); null when unscored or no command. */
  exact: boolean | null;
  /** Q's "understood me" (Y/N); null until pressed, and always null in replays. */
  understood: boolean | null;
  readback: {
    kind: "readback" | "say-again" | "generic-say-again" | "unknown-station-repeat" | "none";
    text: string | null;
    voice: { provider: string; name: string; id: string; speed: number; accent: string | null } | null;
    style: string | null;
    chars: number;
    ttsAudioSec: number | null;
    wpm: number | null;
    newConnection: boolean | null;
    transport: string | null;
    connectMs: number | null;
    serverStepMs: number | null;
    error: string | null;
  };
  /** Server clock, ms after release received. */
  server: {
    downToReleaseMs: number | null;
    sttFinalMs: number | null;
    interpDoneMs: number | null;
    readbackReadyMs: number | null;
    firstVoiceByteMs: number | null;
    firstAudioSentMs: number | null;
    ttsDoneMs: number | null;
  };
  /** Durations within the server clock. */
  stages: {
    sttMs: number | null;
    interpMs: number | null;
    templateMs: number | null;
    ttsFirstByteMs: number | null;
    sendMs: number | null;
    serverTotalMs: number | null;
  };
  /** Client clock (browser: Space released; headless: release sent). */
  client: {
    clock: "browser" | "headless";
    e2eMs: number | null;
    firstChunkMs: number | null;
    outputLatencyMs: number | null;
    queuedBehindMs: number | null;
  } | null;
  usd: { stt: number; interp: number; tts: number };
  errors: string[];
}

export class RowLog {
  readonly path: string;
  private readonly rows = new Map<number, Row>();

  constructor(path: string) {
    this.path = path;
  }

  put(row: Row): void {
    this.rows.set(row.id, row);
    this.flush();
  }

  get(id: number): Row | undefined {
    return this.rows.get(id);
  }

  update(id: number, fn: (row: Row) => void): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    fn(row);
    this.flush();
    return true;
  }

  get size(): number {
    return this.rows.size;
  }

  private flush(): void {
    const tmp = `${this.path}.tmp`;
    const text = [...this.rows.values()].sort((a, b) => a.id - b.id).map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(tmp, text.length ? `${text}\n` : "");
    renameSync(tmp, this.path);
  }
}
