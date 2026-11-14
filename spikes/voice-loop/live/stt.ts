/**
 * Speech-to-text for the live loop, reusing 0.3's endpoints, vocabulary hints and end-of-turn
 * signals (stt/deepgram.ts novaUrl, stt/assemblyai.ts assemblyUrl, stt/vocab.ts via both).
 *
 * Connection setup is hidden behind the push-to-talk hold:
 * - Deepgram Nova-3: a new session per transmission, opened on key-down (~0.3 s to connect in
 *   0.3). Audio that arrives before the socket opens is buffered and flushed when it does.
 *   At release: {"type":"Finalize"}; the final is the Results message with from_finalize: true
 *   and the transcript is every is_final segment joined (as stt/deepgram.ts runNova).
 *   Per-transmission sessions bill only audio sent, and Deepgram's idle billing is unverified.
 * - AssemblyAI Universal-3.6 Pro, one of two explicit modes (server flag --assembly-session):
 *   - "long-lived" (default): one session, opened on the first key-down and kept open; each
 *     transmission is one turn, ended by {"type":"ForceEndpoint"} (0.3's end signal for this
 *     model: stt/assemblyai.ts END_SIGNAL, which isn't exported). 0.3 left multi-turn sessions
 *     untested; this tests them. It avoids the free tier's 5 new sessions/minute limit.
 *     Billing is open time ($0.45/hr), so the session closes after 5 idle minutes and reopens
 *     on the next key-down. AssemblyAI applies no inactivity timeout unless one is set
 *     (streaming API reference, read 2026-11-14).
 *   - "per-turn": a new session per transmission, opened on key-down, ForceEndpoint at
 *     release, then Terminate. Subject to the 5/min limit.
 *   Turns are serialized: a new turn's audio waits (buffered) until the previous turn's final.
 *
 * Errors are never papered over: a missing final is an error, not an empty transcript.
 */
import { performance } from "node:perf_hooks";
import { redact } from "../stt/env.ts";
import { novaUrl } from "../stt/deepgram.ts";
import { assemblyUrl } from "../stt/assemblyai.ts";
import { WsSession, type Json } from "../stt/ws.ts";
import { ASSEMBLY_USD_PER_SEC, record } from "./spend.ts";

const CONNECT_TIMEOUT_MS = 10_000;
const FINAL_TIMEOUT_MS = 5000;
const ASSEMBLY_IDLE_CLOSE_MS = 5 * 60_000;
const ASSEMBLY_MODEL = "universal-3-6-pro";

export type AssemblySessionMode = "long-lived" | "per-turn";

export interface SttFinal {
  transcript: string;
  /** performance.now() when the final message arrived. */
  finalAt: number;
  /** Key-down (turn start) -> provider ready for audio. */
  connectMs: number | null;
  /** The provider was ready before release, i.e. connection setup was hidden. */
  readyBeforeRelease: boolean;
  /** This turn opened a new session (AssemblyAI long-lived: false when reused). */
  newSession: boolean;
  partials: number;
  turns: number;
  notes: string[];
}

export interface SttTurn {
  /** Resolves when audio is flowing to the provider; rejects on connect failure. */
  readonly ready: Promise<void>;
  push(chunk: Buffer): void;
  finish(releaseAt: number): Promise<SttFinal>;
  cancel(reason: string): void;
}

/** Holds audio until a session is attached, then forwards it. */
class Feeder {
  private pending: Buffer[] = [];
  private session: WsSession | null = null;
  private dropped = false;
  push(chunk: Buffer): void {
    if (this.dropped) return;
    if (this.session) this.session.sendBinary(chunk);
    else this.pending.push(chunk);
  }
  attach(s: WsSession): void {
    this.session = s;
    for (const c of this.pending) s.sendBinary(c);
    this.pending = [];
  }
  drop(): void {
    this.dropped = true;
    this.pending = [];
  }
}

// ---- Deepgram Nova-3 -------------------------------------------------------------------

function dgError(msg: Json): string | undefined {
  if (msg.type !== "Error") return undefined;
  return `${String(msg.code ?? "")} ${String(msg.description ?? msg.message ?? JSON.stringify(msg).slice(0, 200))}`.trim();
}

function dgText(msg: Json): string {
  const alts = (msg.channel as Json | undefined)?.alternatives;
  if (!Array.isArray(alts) || alts.length === 0) return "";
  const t = (alts[0] as Json).transcript;
  return typeof t === "string" ? t : "";
}

export function novaTurn(key: string): SttTurn {
  const started = performance.now();
  const feeder = new Feeder();
  let session: WsSession | null = null;
  let readyAt: number | null = null;
  let streamFrom = 0;
  const ready = WsSession.connect(novaUrl("nova-3"), { Authorization: `Token ${key}` }, CONNECT_TIMEOUT_MS).then((s) => {
    session = s;
    readyAt = performance.now();
    streamFrom = s.log.length;
    feeder.attach(s);
  });
  ready.catch(() => undefined); // reported by finish() and by the caller's ready handler
  return {
    ready,
    push: (c) => feeder.push(c),
    async finish(releaseAt) {
      await ready;
      const s = session!;
      try {
        s.sendJson({ type: "Finalize" });
        const final = await s.waitFor(
          (m) => {
            const e = dgError(m);
            if (e) throw new Error(`Deepgram error: ${e}`);
            return m.type === "Results" && m.from_finalize === true ? true : undefined;
          },
          FINAL_TIMEOUT_MS,
          "Deepgram Results with from_finalize",
          streamFrom,
        );
        const results = s.log.slice(streamFrom, final.index + 1).filter(({ msg }) => msg.type === "Results");
        const transcript = results.filter(({ msg }) => msg.is_final === true).map(({ msg }) => dgText(msg).trim()).filter(Boolean).join(" ");
        return {
          transcript,
          finalAt: final.at,
          connectMs: readyAt! - started,
          readyBeforeRelease: readyAt! <= releaseAt,
          newSession: true,
          partials: results.filter(({ msg }) => msg.is_final !== true && dgText(msg).trim() !== "").length,
          turns: 1,
          notes: [],
        };
      } finally {
        try {
          s.sendJson({ type: "CloseStream" });
        } catch {
          // already closed
        }
        void s.close();
      }
    },
    cancel() {
      feeder.drop();
      ready.then(() => void session?.close(), () => undefined);
    },
  };
}

// ---- AssemblyAI Universal-3.6 Pro ------------------------------------------------------

function aaiError(msg: Json): string | undefined {
  if (msg.type === "Error" || (msg.type === undefined && msg.error !== undefined)) {
    return typeof msg.error === "string" ? msg.error : JSON.stringify(msg).slice(0, 300);
  }
  return undefined;
}

interface OpenSession {
  ws: WsSession;
  readyAt: number;
  /** Turns completed on this session. */
  turns: number;
}

export class AssemblyStt {
  readonly mode: AssemblySessionMode;
  private readonly key: string;
  private current: OpenSession | null = null;
  private opening: Promise<OpenSession> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  /** Seconds billed by sessions that have closed (session_duration_seconds). */
  closedSessionSec = 0;
  sessionsOpened = 0;
  /** Called with a message when a long-lived session ends on its own. */
  onNotice: (message: string) => void = () => undefined;

  constructor(key: string, mode: AssemblySessionMode) {
    this.key = key;
    this.mode = mode;
  }

  /** Estimated cost of the session(s) open right now, for the spend guard. */
  openUsd(): number {
    return this.current ? ((performance.now() - this.current.ws.connectStartedAt) / 1000) * ASSEMBLY_USD_PER_SEC : 0;
  }

  private async open(): Promise<OpenSession> {
    const ws = await WsSession.connect(assemblyUrl(ASSEMBLY_MODEL), { Authorization: this.key }, CONNECT_TIMEOUT_MS);
    try {
      await ws.waitFor(
        (m) => {
          const e = aaiError(m);
          if (e) throw new Error(`AssemblyAI error: ${e}`);
          return m.type === "Begin" ? true : undefined;
        },
        CONNECT_TIMEOUT_MS,
        "AssemblyAI Begin",
      );
    } catch (err) {
      void ws.close();
      throw err;
    }
    this.sessionsOpened++;
    const s: OpenSession = { ws, readyAt: performance.now(), turns: 0 };
    return s;
  }

  /** A live session, opening one if there's none (or the last one ended). */
  private async session(): Promise<{ s: OpenSession; fresh: boolean }> {
    if (this.current && this.current.ws.ended === null) return { s: this.current, fresh: false };
    if (this.current) {
      const why = this.current.ws.ended;
      const sec = ((this.current.ws.closedAt ?? performance.now()) - this.current.ws.connectStartedAt) / 1000;
      this.closedSessionSec += sec;
      this.recordSession(sec, "ended on its own; open time estimated");
      this.onNotice(`AssemblyAI session ended on its own (${why}); opening a new one`);
      this.current = null;
    }
    this.opening ??= this.open().finally(() => { this.opening = null; });
    const s = await this.opening;
    this.current = s;
    return { s, fresh: true };
  }

  private recordSession(sec: number, how: string): void {
    record(`assemblyai ${ASSEMBLY_MODEL} session (${this.mode}, ${how})`, sec * ASSEMBLY_USD_PER_SEC, sec / 60);
  }

  /** Terminate the current session and record its billed time. */
  async close(how: string): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const cur = this.current;
    this.current = null;
    if (!cur) return;
    const from = cur.ws.log.length;
    let billed: number | null = null;
    try {
      if (cur.ws.ended === null) {
        cur.ws.sendJson({ type: "Terminate" });
        const term = await cur.ws.waitFor((m) => (m.type === "Termination" ? m : undefined), 5000, "Termination", from);
        const secs = term.value.session_duration_seconds;
        if (typeof secs === "number") billed = secs;
      }
    } catch {
      // fall through to the open-time estimate
    }
    if (billed === null) billed = ((cur.ws.closedAt ?? performance.now()) - cur.ws.connectStartedAt) / 1000;
    this.closedSessionSec += billed;
    this.recordSession(billed, how);
    await cur.ws.close();
  }

  startTurn(): SttTurn {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const started = performance.now();
    const feeder = new Feeder();
    let release!: () => void;
    const turnDone = new Promise<void>((r) => { release = r; });
    const previous = this.queue;
    this.queue = previous.then(() => turnDone);
    let bound: { s: OpenSession; fresh: boolean; startIndex: number; readyAt: number } | null = null;
    const ready = previous.then(async () => {
      const { s, fresh } = await this.session();
      bound = { s, fresh, startIndex: s.ws.log.length, readyAt: performance.now() };
      feeder.attach(s.ws);
    });
    ready.catch(() => release());
    const afterTurn = async (): Promise<void> => {
      if (this.mode === "per-turn") await this.close("per-turn");
      else {
        this.idleTimer = setTimeout(() => void this.close("idle 5 min"), ASSEMBLY_IDLE_CLOSE_MS);
        this.idleTimer.unref();
      }
    };
    return {
      ready,
      push: (c) => feeder.push(c),
      finish: async (releaseAt) => {
        try {
          await ready;
          const b = bound!;
          const ws = b.s.ws;
          const endFrom = ws.log.length;
          ws.sendJson({ type: "ForceEndpoint" });
          const final = await ws.waitFor(
            (m) => {
              const e = aaiError(m);
              if (e) throw new Error(`AssemblyAI error: ${e}`);
              return m.type === "Turn" && m.end_of_turn === true ? true : undefined;
            },
            FINAL_TIMEOUT_MS,
            "AssemblyAI end-of-turn Turn",
            endFrom,
          );
          // Every end-of-turn Turn since this turn's audio started, by turn_order (normally one).
          const turns = new Map<number, string>();
          for (const { msg } of ws.log.slice(b.startIndex, final.index + 1)) {
            if (msg.type === "Turn" && msg.end_of_turn === true) {
              turns.set(Number(msg.turn_order ?? turns.size), typeof msg.transcript === "string" ? msg.transcript.trim() : "");
            }
          }
          const partials = ws.log.slice(b.startIndex, final.index)
            .filter(({ msg }) => msg.type === "Turn" && msg.end_of_turn !== true && typeof msg.transcript === "string" && msg.transcript.trim() !== "").length;
          b.s.turns++;
          const notes = [`session turn #${b.s.turns}`];
          if (turns.size > 1) notes.push(`${turns.size} end-of-turns in one transmission`);
          return {
            transcript: [...turns.entries()].sort(([x], [y]) => x - y).map(([, t]) => t).filter(Boolean).join(" "),
            finalAt: final.at,
            connectMs: b.fresh ? b.readyAt - started : null,
            readyBeforeRelease: b.readyAt <= releaseAt,
            newSession: b.fresh,
            partials,
            turns: turns.size,
            notes,
          };
        } catch (err) {
          // A broken session must not be reused.
          if (this.current && bound && this.current === (bound as { s: OpenSession }).s && this.current.ws.ended === null) await this.close("after an error");
          throw new Error(redact(err instanceof Error ? err.message : String(err)));
        } finally {
          release();
          void afterTurn();
        }
      },
      cancel: () => {
        feeder.drop();
        // Audio already sent belongs to the session's current turn: end it and discard it, so it
        // can't leak into the next transmission.
        ready.then(async () => {
          const ws = bound!.s.ws;
          const from = ws.log.length;
          ws.sendJson({ type: "ForceEndpoint" });
          await ws.waitFor((m) => (m.type === "Turn" && m.end_of_turn === true ? true : undefined), 3000, "discarded turn", from).catch(() => undefined);
        }).catch(() => undefined).finally(() => {
          release();
          void afterTurn();
        });
      },
    };
  }
}
