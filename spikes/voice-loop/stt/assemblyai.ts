/**
 * AssemblyAI Universal-Streaming v3: universal-streaming-english and universal-3-6-pro.
 * Docs read 2026-11-14: assemblyai.com/docs/api-reference/streaming-api/streaming-api.md,
 * /docs/streaming/migration-guides/universal-to-u3-pro-streaming, /docs/streaming/rate-limits.
 *
 * - wss://streaming.assemblyai.com/v3/ws, "Authorization: <key>", pcm_s16le 16 kHz.
 * - keyterms_prompt is a JSON array in the query string (max 100 terms).
 * - min_turn_silence / max_turn_silence are raised to 5 s so the model doesn't end the turn
 *   on a mid-sentence pause; push-to-talk release sends ForceEndpoint or Terminate, per model
 *   (see END_SIGNAL below for why they differ).
 * - universal-streaming-english gets format_turns=false: the unformatted end-of-turn Turn is
 *   the final (a formatted copy would arrive later and only change case/punctuation, which
 *   scoring ignores). universal-3-6-pro has one end-of-turn Turn, always formatted.
 * - After the final: {"type":"Terminate"} -> Termination, which reports
 *   session_duration_seconds, the billed quantity.
 * - Free accounts may open 5 new streaming sessions per minute. Sessions are throttled to
 *   that (--opt sessions_per_min=N to change), and a "too many sessions" close is retried
 *   once after a minute.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { requireKey, redact } from "./env.ts";
import { streamPaced } from "./audio.ts";
import { VOCAB } from "./vocab.ts";
import { WsSession, type Json } from "./ws.ts";
import { emptyRun, round1, LATE_TEXT_WINDOW_MS, type ClipAudio, type ClipRun, type RunOptions } from "./types.ts";

export const ASSEMBLYAI_RATE = 16_000;
const CONNECT_TIMEOUT_MS = 10_000;
const WINDOW_MS = 61_000;
const TURN_SILENCE_MS = "5000";
const KNOWN_OPTS = new Set(["sessions_per_min"]);

const sessionStarts: number[] = [];

async function throttle(perMinute: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (sessionStarts.length > 0 && now - sessionStarts[0]! > WINDOW_MS) sessionStarts.shift();
    if (sessionStarts.length < perMinute) break;
    const waitMs = WINDOW_MS - (now - sessionStarts[0]!) + 50;
    console.error(`  assemblyai: ${perMinute} sessions opened in the last minute; waiting ${(waitMs / 1000).toFixed(1)} s`);
    await sleep(waitMs);
  }
  sessionStarts.push(Date.now());
}

export function assemblyUrl(model: string): string {
  const params = new URLSearchParams({
    sample_rate: String(ASSEMBLYAI_RATE),
    encoding: "pcm_s16le",
    speech_model: model,
    keyterms_prompt: JSON.stringify(VOCAB),
    min_turn_silence: TURN_SILENCE_MS,
    max_turn_silence: TURN_SILENCE_MS,
  });
  if (model === "universal-streaming-english") params.set("format_turns", "false");
  return `wss://streaming.assemblyai.com/v3/ws?${params}`;
}

function aaiError(msg: Json): string | undefined {
  if (msg.type === "Error" || (msg.type === undefined && msg.error !== undefined)) {
    return typeof msg.error === "string" ? msg.error : JSON.stringify(msg).slice(0, 300);
  }
  return undefined;
}

const isRateLimit = (text: string): boolean => /too many|concurren|rate limit/i.test(text);

const turnText = (m: Json): string | undefined => (m.type === "Turn" && typeof m.transcript === "string" ? m.transcript : undefined);

/**
 * Push-to-talk end-of-turn message per model (probed 2026-11-14 on lines 01 and 11):
 * - universal-streaming-english: ForceEndpoint ends the turn at whatever audio the server
 *   has processed so far, and the last word(s) spill into a new turn that doesn't end until
 *   the next endpoint (on line 01 the end-of-turn came 37 ms after release, missing "Bravo").
 *   Terminate flushes all received audio into the final end-of-turn, so it's used instead.
 *   That means one session per transmission, which is also the cheaper way to bill.
 * - universal-3-6-pro: ForceEndpoint flushes all received audio (complete transcript in
 *   ~110 ms on both probe lines), so it's used, and the session could stay open.
 */
const END_SIGNAL: Record<string, "ForceEndpoint" | "Terminate"> = {
  "universal-streaming-english": "Terminate",
  "universal-3-6-pro": "ForceEndpoint",
};

export async function runAssembly(model: string, audio: ClipAudio, run: RunOptions): Promise<ClipRun> {
  for (const k of run.opts.keys()) {
    if (!KNOWN_OPTS.has(k)) throw new Error(`unknown --opt ${k} for AssemblyAI (known: ${[...KNOWN_OPTS].join(", ")})`);
  }
  const perMinute = Number(run.opts.get("sessions_per_min") ?? "5");
  if (!Number.isInteger(perMinute) || perMinute < 1) throw new Error("--opt sessions_per_min must be a positive integer");
  const first = await attempt(model, audio, run, perMinute);
  if (first.error && isRateLimit(first.error)) {
    console.error(`  assemblyai: rate-limited (${first.error}); retrying once after ${WINDOW_MS / 1000} s`);
    await sleep(WINDOW_MS);
    const second = await attempt(model, audio, run, perMinute);
    second.notes.push(`first attempt rate-limited: ${first.error}`);
    return second;
  }
  return first;
}

async function attempt(model: string, audio: ClipAudio, run: RunOptions, perMinute: number): Promise<ClipRun> {
  if (audio.sampleRate !== ASSEMBLYAI_RATE) throw new Error(`AssemblyAI needs ${ASSEMBLYAI_RATE} Hz audio`);
  const key = requireKey("ASSEMBLYAI_API_KEY");
  const out = emptyRun();
  await throttle(perMinute);
  let session: WsSession | null = null;
  let lastChunkAt: number | null = null;
  try {
    session = await WsSession.connect(assemblyUrl(model), { Authorization: key }, CONNECT_TIMEOUT_MS);
    const s = session;
    const begin = await s.waitFor(
      (m) => {
        const e = aaiError(m);
        if (e) throw new Error(e);
        return m.type === "Begin" ? m : undefined;
      },
      CONNECT_TIMEOUT_MS,
      "Begin",
    );
    out.timings.connectMs = round1(begin.at - s.connectStartedAt);
    const served = (begin.value.configuration as Json | undefined)?.model;
    if (served !== undefined && served !== model) out.notes.push(`Begin reports model=${String(served)}`);

    const streamFrom = s.log.length;
    const pace = await streamPaced(audio.pcm, audio.sampleRate, run.chunkMs, (c) => s.sendBinary(c), () => {
      if (s.ended) return s.ended;
      for (let i = streamFrom; i < s.log.length; i++) {
        const e = aaiError(s.log[i]!.msg);
        if (e) return `provider error mid-stream: ${e}`;
      }
      return null;
    });
    const endFrom = s.log.length;
    const signal = END_SIGNAL[model] ?? "ForceEndpoint";
    s.sendJson({ type: signal });
    lastChunkAt = pace.lastChunkAt;
    out.timings.streamMs = round1(pace.lastChunkAt - pace.startedAt);
    out.timings.driftMs = round1(pace.driftMs);

    const final = await s.waitFor(
      (m) => {
        const e = aaiError(m);
        if (e) throw new Error(e);
        return m.type === "Turn" && m.end_of_turn === true ? true : undefined;
      },
      run.finalTimeoutMs,
      "end-of-turn Turn",
      endFrom,
    );
    out.latencyMs = round1(final.at - pace.lastChunkAt);
    // Every end-of-turn Turn since audio start, one per turn_order (normally exactly one).
    const turns = new Map<number, string>();
    for (const { msg } of s.log.slice(streamFrom, final.index + 1)) {
      if (msg.type === "Turn" && msg.end_of_turn === true) {
        turns.set(Number(msg.turn_order ?? turns.size), typeof msg.transcript === "string" ? msg.transcript.trim() : "");
      }
    }
    if (turns.size > 1) out.notes.push(`${turns.size} turns in one clip`);
    out.transcript = [...turns.entries()].sort(([a], [b]) => a - b).map(([, t]) => t).filter(Boolean).join(" ");
    const partials = s.log
      .slice(streamFrom, final.index)
      .filter(({ msg }) => msg.type === "Turn" && msg.end_of_turn !== true && typeof msg.transcript === "string" && msg.transcript.trim() !== "");
    out.partials = partials.length;
    if (partials[0]) out.timings.firstTextMs = round1(partials[0].at - pace.startedAt);

    if (signal === "ForceEndpoint") {
      out.lateText = await s.lateText(final.index, LATE_TEXT_WINDOW_MS, turnText);
      s.sendJson({ type: "Terminate" });
    }
    try {
      const term = await s.waitFor((m) => (m.type === "Termination" ? m : undefined), 5000, "Termination", endFrom);
      const secs = term.value.session_duration_seconds;
      if (typeof secs === "number") out.timings.billedSessionSec = secs;
      if (signal === "Terminate") {
        const late = s.log.slice(final.index + 1, term.index).map(({ msg }) => turnText(msg)?.trim() ?? "").filter(Boolean);
        out.lateText = late.length ? late.join(" | ") : null;
      }
    } catch (err) {
      out.notes.push(redact(`no Termination: ${err instanceof Error ? err.message : String(err)}`));
    }
  } catch (err) {
    out.error = redact(err instanceof Error ? err.message : String(err));
  } finally {
    if (session) {
      if (lastChunkAt !== null) out.trace = session.trace(lastChunkAt);
      if (out.timings.billedSessionSec === null && session.openedAt !== null) {
        out.notes.push("billed time estimated from socket open time");
        out.timings.billedSessionSec = round1(((session.closedAt ?? performance.now()) - session.openedAt) / 1000);
      }
      await session.close();
    }
  }
  return out;
}
