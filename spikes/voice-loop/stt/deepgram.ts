/**
 * Deepgram streaming: Nova-3 (/v1/listen) and Flux (/v2/listen).
 * Docs read 2026-11-14: developers.deepgram.com/docs/finalize, /docs/keyterm,
 * /docs/flux/quickstart, /docs/flux/force-end-turn, /docs/flux/configure.
 *
 * Nova-3: linear16 16 kHz mono, interim results on, one `keyterm` query param per term.
 *   Push-to-talk release sends {"type":"Finalize"}; the final is the Results message with
 *   from_finalize: true. The transcript is every is_final Results segment joined in order.
 *   (Deepgram says from_finalize "is not guaranteed if there's no significant amount of
 *   audio"; a missing one is recorded as an error, not papered over.)
 * Flux: linear16 16 kHz, eot_threshold=1.0 so the model never ends the turn on its own, and
 *   push-to-talk release sends 500 ms of silence (in one burst) then {"type":"ForceEndTurn"};
 *   see FLUX_DEFAULT_PAD_MS for why. The final is TurnInfo EndOfTurn.
 * Both: {"type":"CloseStream"} afterwards. Auth: "Authorization: Token <key>".
 */
import { requireKey, redact } from "./env.ts";
import { streamPaced } from "./audio.ts";
import { VOCAB } from "./vocab.ts";
import { WsSession, type Json } from "./ws.ts";
import { emptyRun, round1, LATE_TEXT_WINDOW_MS, type ClipAudio, type ClipRun, type RunOptions } from "./types.ts";

export const DEEPGRAM_RATE = 16_000;
const CONNECT_TIMEOUT_MS = 10_000;

function keytermParams(params: URLSearchParams): void {
  for (const term of VOCAB) params.append("keyterm", term);
}

export function novaUrl(model: string): string {
  const params = new URLSearchParams({
    model,
    language: "en",
    encoding: "linear16",
    sample_rate: String(DEEPGRAM_RATE),
    channels: "1",
    interim_results: "true",
  });
  keytermParams(params);
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

export function fluxUrl(model: string): string {
  const params = new URLSearchParams({
    model,
    encoding: "linear16",
    sample_rate: String(DEEPGRAM_RATE),
    eot_threshold: "1.0",
  });
  keytermParams(params);
  return `wss://api.deepgram.com/v2/listen?${params}`;
}

function rejectOpts(opts: Map<string, string>): void {
  if (opts.size > 0) throw new Error(`Nova-3 takes no --opt keys (got ${[...opts.keys()].join(", ")})`);
}

/**
 * Silence sent in one burst right after the last audio chunk, before ForceEndTurn.
 * Why: Deepgram's ForceEndTurn docs say the EndOfTurn transcript "reflects audio transcribed
 * before the message arrived". Sent at release with no padding, the first full pass lost the
 * last word(s) on 9 of 34 lines ("hold short" with no "Bravo") and garbled the end of 2 more
 * (results/stt/deepgram-flux-general-en.no-padding.json). Probe on lines 04, 08, 11, 17:
 * 500 ms of padding gave complete transcripts in 330-435 ms; 250 ms was also complete but not
 * faster (271-1031 ms); CloseStream instead of ForceEndTurn closed with no EndOfTurn at all.
 * The silence is sent at release, so latency is still measured from the last audio chunk.
 */
export const FLUX_DEFAULT_PAD_MS = 500;

function fluxPadMs(opts: Map<string, string>): number {
  for (const k of opts.keys()) if (k !== "pad_ms") throw new Error(`unknown --opt ${k} for Flux (known: pad_ms)`);
  const raw = opts.get("pad_ms") ?? String(FLUX_DEFAULT_PAD_MS);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 2000) throw new Error(`--opt pad_ms must be an integer 0-2000, got "${raw}"`);
  return n;
}

function altTranscript(msg: Json): string {
  const channel = msg.channel as Json | undefined;
  const alts = channel?.alternatives;
  if (!Array.isArray(alts) || alts.length === 0) return "";
  const first = alts[0] as Json;
  return typeof first.transcript === "string" ? first.transcript : "";
}

function dgError(msg: Json): string | undefined {
  if (msg.type === "Error") {
    return `${String(msg.code ?? "")} ${String(msg.description ?? msg.message ?? JSON.stringify(msg).slice(0, 200))}`.trim();
  }
  return undefined;
}

export async function runNova(model: string, audio: ClipAudio, run: RunOptions): Promise<ClipRun> {
  rejectOpts(run.opts);
  if (audio.sampleRate !== DEEPGRAM_RATE) throw new Error(`Deepgram needs ${DEEPGRAM_RATE} Hz audio`);
  const key = requireKey("DEEPGRAM_API_KEY");
  const out = emptyRun();
  let session: WsSession | null = null;
  let lastChunkAt: number | null = null;
  try {
    session = await WsSession.connect(novaUrl(model), { Authorization: `Token ${key}` }, CONNECT_TIMEOUT_MS);
    const s = session;
    out.timings.connectMs = round1((s.openedAt ?? performance.now()) - s.connectStartedAt);
    const streamFrom = s.log.length;
    const pace = await streamPaced(audio.pcm, audio.sampleRate, run.chunkMs, (c) => s.sendBinary(c), () => {
      if (s.ended) return s.ended;
      for (let i = streamFrom; i < s.log.length; i++) {
        const e = dgError(s.log[i]!.msg);
        if (e) return `provider error mid-stream: ${e}`;
      }
      return null;
    });
    s.sendJson({ type: "Finalize" });
    lastChunkAt = pace.lastChunkAt;
    out.timings.streamMs = round1(pace.lastChunkAt - pace.startedAt);
    out.timings.driftMs = round1(pace.driftMs);

    let finalErr: string | null = null;
    let finalAt: number | null = null;
    let finalIndex = s.log.length;
    try {
      const final = await s.waitFor(
        (m) => {
          const e = dgError(m);
          if (e) throw new Error(e);
          return m.type === "Results" && m.from_finalize === true ? true : undefined;
        },
        run.finalTimeoutMs,
        "Results with from_finalize",
        streamFrom,
      );
      finalAt = final.at;
      finalIndex = final.index;
    } catch (err) {
      finalErr = err instanceof Error ? err.message : String(err);
    }
    const results = s.log.slice(streamFrom, finalIndex + 1).filter(({ msg }) => msg.type === "Results");
    const finals = results.filter(({ msg }) => msg.is_final === true).map(({ msg }) => altTranscript(msg).trim()).filter(Boolean);
    const texts = results.filter(({ msg }) => altTranscript(msg).trim() !== "");
    out.partials = results.filter(({ msg }) => msg.is_final !== true && altTranscript(msg).trim() !== "").length;
    if (texts[0]) out.timings.firstTextMs = round1(texts[0].at - pace.startedAt);
    out.transcript = finals.join(" ");
    if (finalAt !== null) {
      out.latencyMs = round1(finalAt - pace.lastChunkAt);
      out.lateText = await s.lateText(finalIndex, LATE_TEXT_WINDOW_MS, (m) => (m.type === "Results" ? altTranscript(m) : undefined));
    } else {
      out.error = redact(`no final: ${finalErr}`);
      out.notes.push("transcript is the is_final segments received before the timeout");
    }
    s.sendJson({ type: "CloseStream" });
    await s.waitClosed(3000);
  } catch (err) {
    out.error = redact(err instanceof Error ? err.message : String(err));
  } finally {
    if (session) {
      if (lastChunkAt !== null) out.trace = session.trace(lastChunkAt);
      await session.close();
    }
  }
  return out;
}

export async function runFlux(model: string, audio: ClipAudio, run: RunOptions): Promise<ClipRun> {
  const padMs = fluxPadMs(run.opts);
  if (audio.sampleRate !== DEEPGRAM_RATE) throw new Error(`Deepgram needs ${DEEPGRAM_RATE} Hz audio`);
  const key = requireKey("DEEPGRAM_API_KEY");
  const out = emptyRun();
  let session: WsSession | null = null;
  let lastChunkAt: number | null = null;
  try {
    session = await WsSession.connect(fluxUrl(model), { Authorization: `Token ${key}` }, CONNECT_TIMEOUT_MS);
    const s = session;
    const connected = await s.waitFor(
      (m) => {
        const e = dgError(m);
        if (e) throw new Error(e);
        return m.type === "Connected" ? true : undefined;
      },
      CONNECT_TIMEOUT_MS,
      "Connected",
    );
    out.timings.connectMs = round1(connected.at - s.connectStartedAt);
    const streamFrom = s.log.length;
    const pace = await streamPaced(audio.pcm, audio.sampleRate, run.chunkMs, (c) => s.sendBinary(c), () => {
      if (s.ended) return s.ended;
      for (let i = streamFrom; i < s.log.length; i++) {
        const e = dgError(s.log[i]!.msg);
        if (e) return `provider error mid-stream: ${e}`;
      }
      return null;
    });
    const endFrom = s.log.length;
    if (padMs > 0) s.sendBinary(Buffer.alloc(Math.round((DEEPGRAM_RATE * 2 * padMs) / 1000)));
    s.sendJson({ type: "ForceEndTurn" });
    lastChunkAt = pace.lastChunkAt;
    out.timings.streamMs = round1(pace.lastChunkAt - pace.startedAt);
    out.timings.driftMs = round1(pace.driftMs);

    const final = await s.waitFor(
      (m) => {
        const e = dgError(m);
        if (e) throw new Error(e);
        if (m.type === "Warning") return { kind: "warning" as const, text: `${String(m.code)} ${String(m.description ?? "")}` };
        if (m.type === "TurnInfo" && m.event === "EndOfTurn") return { kind: "eot" as const, text: "" };
        return undefined;
      },
      run.finalTimeoutMs,
      "TurnInfo EndOfTurn",
      endFrom,
    );
    // Every EndOfTurn since audio start, one per turn_index (normally exactly one).
    const turns = new Map<number, string>();
    for (const { msg } of s.log.slice(streamFrom, final.index + 1)) {
      if (msg.type === "TurnInfo" && msg.event === "EndOfTurn") {
        turns.set(Number(msg.turn_index ?? turns.size), typeof msg.transcript === "string" ? msg.transcript.trim() : "");
        if (msg.trigger !== undefined && msg.trigger !== "manual") out.notes.push(`EndOfTurn trigger=${String(msg.trigger)}`);
      }
    }
    if (turns.size > 1) out.notes.push(`${turns.size} turns in one clip`);
    out.transcript = [...turns.entries()].sort(([a], [b]) => a - b).map(([, t]) => t).filter(Boolean).join(" ");
    if (final.value.kind === "warning") {
      out.error = redact(`ForceEndTurn got a warning instead of EndOfTurn: ${final.value.text}`);
    } else {
      out.latencyMs = round1(final.at - pace.lastChunkAt);
    }
    const updates = s.log
      .slice(streamFrom, final.index)
      .filter(({ msg }) => msg.type === "TurnInfo" && typeof msg.transcript === "string" && msg.transcript.trim() !== "");
    out.partials = updates.filter(({ msg }) => msg.event !== "EndOfTurn").length;
    if (updates[0]) out.timings.firstTextMs = round1(updates[0].at - pace.startedAt);
    out.lateText = await s.lateText(final.index, LATE_TEXT_WINDOW_MS, (m) =>
      m.type === "TurnInfo" && typeof m.transcript === "string" ? m.transcript : undefined,
    );
    s.sendJson({ type: "CloseStream" });
    await s.waitClosed(3000);
  } catch (err) {
    out.error = redact(err instanceof Error ? err.message : String(err));
  } finally {
    if (session) {
      if (lastChunkAt !== null) out.trace = session.trace(lastChunkAt);
      await session.close();
    }
  }
  return out;
}
