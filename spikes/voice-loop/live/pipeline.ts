/**
 * One client connection (the page, or the headless replay client) and the chain for each of its
 * transmissions: speech-to-text -> interpreter -> templated readback -> streaming voice.
 *
 * Protocol (WebSocket, JSON text frames plus binary audio):
 *   client -> server
 *     {type:"ptt-down", id, cardId}                  live: the server picks the combo from the card plan
 *     {type:"ptt-down", id, line, combo:{stt,tts}}   replay
 *     binary: PCM16LE mono 16 kHz, 20 ms per frame, between ptt-down and ptt-up
 *     {type:"ptt-up", id}      release (the server clock's origin for this transmission)
 *     {type:"cancel", id}      the page lost focus mid-transmission
 *     {type:"client-timing", id, e2eMs, firstChunkMs, outputLatencyMs, queuedBehindMs}
 *     {type:"verdict", id, understood}               live only: Q's Y/N
 *     {type:"play-wrong", cardId}                    live only: speak a correction card's wrong readback
 *   server -> client
 *     hello, recording, transcript, command, readback, audio-start, audio-end, done, error
 *     binary: [0x01][uint32 LE id][PCM16LE mono 24 kHz]
 * Every frame the server sends goes through send(), which refuses to send anything containing
 * an API key (and reports that as an error instead).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import type WebSocket from "ws";
import { parseTerse } from "../../../src/sim/terse.ts";
import type { Transmission } from "../../../src/sim/commands.ts";
import { FLIGHTS, flightsAt, liveContext, type FlightState } from "../interp/context.ts";
import { sha } from "../interp/prompt.ts";
import { scoreLine } from "../interp/score.ts";
import { SPIKE_DIR, redact } from "../stt/env.ts";
import type { ScriptLine } from "../stt/script.ts";
import { speechSpan, wavFromPcm16 } from "../tts/audio.ts";
import { wordCount } from "../tts/common.ts";
import { cardById, CARDS, voiceFlightOf, type Card, type Combo } from "./cards.ts";
import { cardContext, flightsWith, type Interpreter } from "./interp.ts";
import type { Ref, Row, RowLog } from "./log.ts";
import { GENERIC_SAY_AGAIN, readbackText, sayAgainText, seededRng, styleFor } from "./readback.ts";
import { NOVA_USD_PER_MIN, TTS_USD_PER_CHAR, overCap, record } from "./spend.ts";
import { novaTurn, type AssemblyStt, type SttFinal, type SttTurn } from "./stt.ts";
import { SAMPLE_RATE as TTS_RATE, type TtsResult, type Voices } from "./tts.ts";
import { STT_IDS, TTS_IDS, VOICES, providerOf, voiceFor, type LiveVoice, type SttId, type TtsId } from "./voices.ts";

export const MIC_RATE = 16_000;
const AUDIO_FRAME = 0x01;
const EXTRA_ID_BASE = 900_000;

export interface Services {
  mode: "live" | "replay";
  sessionTag: string;
  deepgramKey: string;
  assembly: AssemblyStt;
  interp: Interpreter;
  voices: Voices;
  log: RowLog;
  seed: number;
  maxSpend: number;
  plan: Map<string, Combo>;
  /** Live cards: each flight's voice (cards.ts cardVoicePlan). Replays use voiceFor(). */
  voicePlan: Map<string, LiveVoice>;
  /** Where Q's captured audio goes (live mode). */
  audioDir: string;
  cartesiaTts: "cartesia-ws" | "cartesia-http";
  script: Map<string, ScriptLine>;
  /** Every loaded key, for the send guard. */
  keys: string[];
  /** Transmission ids are unique per server process (one log file). */
  nextId: () => number;
}

/** What one transmission is about: a card or a script line, with everything the chain needs. */
interface TxContext {
  ref: Ref;
  label: string;
  context: string;
  expected: string | null;
  states: Map<string, FlightState>;
  /** Who repeats, and what, when asked to say again (null callsign: the unknown station). */
  repeatFor: (callsign: string | null) => { callsign: string; text: string } | null;
}

function cardTx(card: Card): TxContext {
  const states = new Map(flightsWith(card.states).map((f) => [f.callsign, f.state] as const));
  return {
    ref: { kind: "card", id: card.id },
    label: card.id,
    context: cardContext(card),
    expected: card.expected,
    states,
    repeatFor: (cs) => {
      if (card.repeat && (cs === null ? card.callsign === null : card.repeat.callsign === cs)) return card.repeat;
      return null;
    },
  };
}

function lineTx(line: ScriptLine): TxContext {
  const states = new Map(flightsAt(line.num).map((f) => [f.callsign, f.state] as const));
  const expected = line.expected.startsWith("UNSCORED") ? null : line.expected;
  const expCs = expected ? terseCallsign(expected) : undefined;
  return {
    ref: { kind: "line", num: line.num },
    label: `L${line.num}`,
    context: liveContext(line.num),
    expected,
    states,
    repeatFor: (cs) => {
      // C10 lines: the script's readback is the pilot's repeat (line 31's is the unknown station).
      if (line.types.includes("C10") && expCs !== undefined && cs === expCs) return { callsign: cs ?? `line-${line.num}-caller`, text: line.readback };
      return null;
    },
  };
}

function terseCallsign(terse: string): string | null | undefined {
  const r = parseTerse(terse);
  return r.ok && r.command.type === "transmission" ? r.command.callsign : undefined;
}

function expectedCommand(terse: string): Transmission {
  const r = parseTerse(terse);
  if (!r.ok || r.command.type !== "transmission") throw new Error(`expected '${terse}' doesn't parse as a transmission`);
  return r.command;
}

interface Tx {
  id: number;
  combo: Combo;
  ctx: TxContext;
  stt: SttTurn;
  downAt: number;
  releaseAt: number | null;
  chunks: Buffer[];
  audioBytes: number;
  state: "recording" | "processing" | "done";
}

const round = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

export class ClientConn {
  private readonly ws: WebSocket;
  private readonly svc: Services;
  private readonly txs = new Map<number, Tx>();
  private recording: Tx | null = null;
  private extraIds = 0;

  constructor(ws: WebSocket, svc: Services) {
    this.ws = ws;
    this.svc = svc;
    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) this.onAudio(data as Buffer);
        else this.onText(data.toString());
      } catch (err) {
        this.error(null, "server", err instanceof Error ? err.message : String(err));
      }
    });
    ws.on("close", () => {
      if (this.recording) this.recording.stt.cancel("client disconnected");
      this.recording = null;
    });
    this.send({
      type: "hello",
      mode: svc.mode,
      session: svc.sessionTag,
      log: relative(SPIKE_DIR, svc.log.path),
      settings: { cartesiaTts: svc.cartesiaTts, assemblySession: svc.assembly.mode, seed: svc.seed, maxSpend: svc.maxSpend },
      cards: svc.mode === "live"
        ? CARDS.map((c) => {
          const combo = svc.plan.get(c.id)!;
          const v = this.voiceOf(voiceFlightOf(c), combo.tts);
          return { id: c.id, types: c.types, callsign: c.callsign, situation: c.situation, wrongReadback: c.wrongReadback ?? null, expected: c.expected, combo, voice: v.name };
        })
        : [],
    });
  }

  /** The voice a flight speaks with: the card plan's in live sessions, else voiceFor(). */
  private voiceOf(flight: string | null, tts: TtsId): LiveVoice {
    const planned = this.svc.mode === "live" && flight ? this.svc.voicePlan.get(flight) : undefined;
    return planned && planned.provider === providerOf(tts) ? planned : voiceFor(flight, tts);
  }

  // ---- sending (with the key guard) --------------------------------------------------

  private hasKey(s: string | Buffer): boolean {
    for (const k of this.svc.keys) if (k.length >= 8 && s.indexOf(k) !== -1) return true;
    return false;
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws.readyState !== 1) return;
    const text = JSON.stringify(obj);
    if (this.hasKey(text)) {
      console.error(`live: refused to send a ${String(obj.type)} message that contained an API key`);
      this.ws.send(JSON.stringify({ type: "error", id: obj.id ?? null, where: "server", message: "a message was withheld because it contained a secret" }));
      return;
    }
    this.ws.send(text);
  }

  private sendAudio(id: number, pcm: Buffer): void {
    if (this.ws.readyState !== 1) return;
    if (this.hasKey(pcm)) {
      this.error(id, "server", "an audio frame was withheld because it contained a secret");
      return;
    }
    const head = Buffer.alloc(5);
    head.writeUInt8(AUDIO_FRAME, 0);
    head.writeUInt32LE(id, 1);
    this.ws.send(Buffer.concat([head, pcm]));
  }

  private error(id: number | null, where: string, message: string): void {
    this.send({ type: "error", id, where, message: redact(message, 600) });
  }

  // ---- inbound -----------------------------------------------------------------------

  private onAudio(buf: Buffer): void {
    const tx = this.recording;
    if (!tx) return; // audio after release or before key-down: ignored (the client gates it)
    tx.audioBytes += buf.length;
    if (this.svc.mode === "live") tx.chunks.push(buf);
    tx.stt.push(buf);
  }

  private onText(text: string): void {
    const msg = JSON.parse(text) as Record<string, unknown>;
    const id = typeof msg.id === "number" ? msg.id : null;
    switch (msg.type) {
      case "ptt-down": return this.down(msg);
      case "ptt-up": return this.up(id);
      case "cancel": return this.cancel(id);
      case "client-timing": return this.clientTiming(id, msg);
      case "verdict": return this.verdict(id, msg.understood);
      case "play-wrong": return void this.playWrong(String(msg.cardId));
      default: this.error(id, "protocol", `unknown message type ${JSON.stringify(msg.type)}`);
    }
  }

  private down(msg: Record<string, unknown>): void {
    const svc = this.svc;
    if (this.recording) {
      this.error(this.recording.id, "protocol", "key-down while already transmitting; the previous transmission was cancelled");
      this.cancel(this.recording.id);
    }
    const capped = overCap(svc.maxSpend, svc.assembly.openUsd());
    if (capped) {
      this.send({ type: "error", id: null, where: "spend", fatal: true, message: capped });
      return;
    }
    let ctx: TxContext;
    let combo: Combo;
    if (svc.mode === "live") {
      const card = cardById(String(msg.cardId));
      ctx = cardTx(card);
      combo = svc.plan.get(card.id)!;
    } else {
      const line = svc.script.get(String(msg.line));
      if (!line) throw new Error(`unknown script line ${JSON.stringify(msg.line)}`);
      const c = msg.combo as { stt?: unknown; tts?: unknown } | undefined;
      if (!c || !STT_IDS.includes(c.stt as SttId) || !TTS_IDS.includes(c.tts as TtsId)) throw new Error(`bad combo ${JSON.stringify(msg.combo)}`);
      ctx = lineTx(line);
      combo = { stt: c.stt as SttId, tts: c.tts as TtsId };
    }
    const id = svc.nextId();
    const stt = combo.stt === "nova3" ? novaTurn(svc.deepgramKey) : svc.assembly.startTurn();
    stt.ready.catch((err: unknown) => this.error(id, "stt-connect", err instanceof Error ? err.message : String(err)));
    const tx: Tx = { id, combo, ctx, stt, downAt: performance.now(), releaseAt: null, chunks: [], audioBytes: 0, state: "recording" };
    this.txs.set(id, tx);
    this.recording = tx;
    this.send({ type: "recording", id, clientId: msg.id ?? null, ref: ctx.ref, label: ctx.label, combo });
  }

  private up(clientId: number | null): void {
    const tx = this.recording;
    if (!tx) {
      this.error(clientId, "protocol", "release with no transmission in progress");
      return;
    }
    tx.releaseAt = performance.now();
    tx.state = "processing";
    this.recording = null;
    void this.process(tx);
  }

  private cancel(_clientId: number | null): void {
    const tx = this.recording;
    if (!tx) return;
    tx.stt.cancel("cancelled by the client");
    this.recording = null;
    this.txs.delete(tx.id);
    this.send({ type: "cancelled", id: tx.id });
  }

  private clientTiming(id: number | null, msg: Record<string, unknown>): void {
    if (id === null) return;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
    const ok = this.svc.log.update(id, (row) => {
      row.client = {
        clock: this.svc.mode === "live" ? "browser" : "headless",
        e2eMs: num(msg.e2eMs),
        firstChunkMs: num(msg.firstChunkMs),
        outputLatencyMs: num(msg.outputLatencyMs),
        queuedBehindMs: num(msg.queuedBehindMs),
      };
    });
    if (!ok) this.error(id, "protocol", `client timing for unknown transmission ${id}`);
  }

  private verdict(id: number | null, understood: unknown): void {
    if (this.svc.mode !== "live") {
      this.error(id, "protocol", "Y/N verdicts are for live sessions only");
      return;
    }
    if (id === null || typeof understood !== "boolean") {
      this.error(id, "protocol", "verdict needs an id and understood true/false");
      return;
    }
    const ok = this.svc.log.update(id, (row) => { row.understood = understood; });
    if (!ok) this.error(id, "verdict", `no logged transmission ${id} yet (still processing?)`);
    else this.send({ type: "verdict-saved", id, understood });
  }

  // ---- the chain ---------------------------------------------------------------------

  private async process(tx: Tx): Promise<void> {
    const svc = this.svc;
    const t0 = tx.releaseAt!;
    const since = (t: number | null): number | null => (t === null ? null : t - t0);
    const errors: string[] = [];
    let final: SttFinal | null = null;
    let sttError: string | null = null;
    let interpCall: Awaited<ReturnType<Interpreter["interpret"]>> | null = null;
    let interpDoneAt: number | null = null;
    let readyAt: number | null = null;
    let firstSentAt: number | null = null;
    let tts: TtsResult | null = null;
    let readback: Row["readback"] = {
      kind: "none", text: null, voice: null, style: null, chars: 0, ttsAudioSec: null, wpm: null,
      newConnection: null, transport: null, connectMs: null, serverStepMs: null, error: null,
    };
    let audioFile: string | null = null;
    let exact: boolean | null = null;

    // Q's audio, as captured, for offline re-scoring (live sessions only; gitignored).
    if (svc.mode === "live" && tx.chunks.length > 0) {
      try {
        mkdirSync(svc.audioDir, { recursive: true });
        const file = join(svc.audioDir, `${svc.sessionTag}-${tx.id}-${tx.ctx.label}.wav`);
        writeFileSync(file, wavFromPcm16(Buffer.concat(tx.chunks), MIC_RATE));
        audioFile = relative(SPIKE_DIR, file);
      } catch (err) {
        errors.push(`saving audio: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      try {
        final = await tx.stt.finish(t0);
      } catch (err) {
        sttError = redact(err instanceof Error ? err.message : String(err), 600);
        errors.push(`stt: ${sttError}`);
        this.error(tx.id, "stt", sttError);
        return;
      }
      this.send({ type: "transcript", id: tx.id, text: final.transcript, sttMs: round(since(final.finalAt)) });
      if (final.transcript.trim() === "") {
        errors.push("no speech heard (empty final transcript)");
        this.error(tx.id, "stt", "no speech heard: the final transcript was empty");
        return;
      }

      interpCall = await svc.interp.interpret(tx.ctx.context, final.transcript);
      interpDoneAt = performance.now();
      if (interpCall.error) {
        errors.push(`interp: ${interpCall.error}`);
        this.error(tx.id, "interp", interpCall.error);
      }
      if (tx.ctx.expected !== null && interpCall.command) {
        exact = scoreLine(expectedCommand(tx.ctx.expected), interpCall.command).exact;
      } else if (tx.ctx.expected !== null) {
        exact = false;
      }
      this.send({
        type: "command", id: tx.id, terse: interpCall.terse, valid: interpCall.command !== null,
        invalidReason: interpCall.invalidReason, expected: tx.ctx.expected, exact, interpMs: round(interpDoneAt - final.finalAt),
      });

      // Readback text and voice (no AI wording: templates only).
      const rng = seededRng((svc.seed * 1_000_003 + tx.id) >>> 0);
      const cmd = interpCall.command;
      const known = (cs: string | null) => (cs ? FLIGHTS.find((f) => f.callsign === cs) : undefined);
      let text: string;
      let voiceFlight: string | null;
      let kind: Row["readback"]["kind"];
      let style: string | null = null;
      if (!cmd) {
        const f = known(interpCall.invalidCallsign);
        if (f) {
          text = sayAgainText(f.spoken, rng);
          voiceFlight = f.callsign;
          kind = "say-again";
        } else {
          text = GENERIC_SAY_AGAIN;
          voiceFlight = null;
          kind = "generic-say-again";
        }
      } else if (cmd.callsign === null) {
        const rep = tx.ctx.repeatFor(null);
        if (rep) {
          text = rep.text;
          voiceFlight = rep.callsign;
          kind = "unknown-station-repeat";
        } else {
          text = "";
          voiceFlight = null;
          kind = "none";
          errors.push("unknown-station say-again, but no unknown station is waiting: no reply");
        }
      } else if (!known(cmd.callsign)) {
        text = GENERIC_SAY_AGAIN;
        voiceFlight = null;
        kind = "generic-say-again";
        errors.push(`callsign ${cmd.callsign} isn't on frequency`);
      } else {
        const f = known(cmd.callsign)!;
        style = styleFor(f.callsign, svc.seed);
        const rep = tx.ctx.repeatFor(f.callsign);
        const last = tx.ctx.states.get(f.callsign)?.lastTransmission ?? null;
        text = readbackText({
          command: cmd, callsignSpoken: f.spoken, style: style as "terse" | "chatty", rng,
          repeat: rep?.text ?? (last && !last.includes("[") ? last : null),
        });
        voiceFlight = f.callsign;
        kind = "readback";
      }
      readyAt = performance.now();
      const voice: LiveVoice = this.voiceOf(voiceFlight, tx.combo.tts);
      readback = {
        ...readback, kind, text: text || null, style, chars: text.length,
        voice: { provider: voice.provider, name: voice.name, id: voice.id, speed: voice.speed, accent: voice.accent ?? null },
        transport: tx.combo.tts === "elevenlabs" || tx.combo.tts === "cartesia-http" ? "http" : "ws",
      };
      this.send({ type: "readback", id: tx.id, kind, text, voice: voice.name, provider: voice.provider, tts: tx.combo.tts, style });
      if (!text) return;

      // Voice, streamed to the client as it arrives.
      const pcmParts: Buffer[] = [];
      this.send({ type: "audio-start", id: tx.id, sampleRate: TTS_RATE });
      tts = await svc.voices.speak(tx.combo.tts, voice, text, (pcm) => {
        pcmParts.push(pcm);
        this.sendAudio(tx.id, pcm);
        firstSentAt ??= performance.now();
      });
      const pcm = Buffer.concat(pcmParts);
      const audioSec = pcm.length / 2 / TTS_RATE;
      const span = pcm.length > 0 ? speechSpan(pcm, TTS_RATE) : null;
      readback = {
        ...readback,
        ttsAudioSec: round(audioSec),
        wpm: span && span.speechS > 0.5 ? round((wordCount(text) / span.speechS) * 60) : null,
        newConnection: tts.newConnection,
        connectMs: round(tts.connectMs),
        serverStepMs: round(tts.serverStepMs),
        error: tts.error,
      };
      if (tts.error) {
        errors.push(`tts: ${tts.error}`);
        this.error(tx.id, "tts", tts.error);
      }
      this.send({ type: "audio-end", id: tx.id, bytes: pcm.length, audioSec: round(audioSec), error: tts.error });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      errors.push(`pipeline: ${redact(m)}`);
      this.error(tx.id, "pipeline", m);
    } finally {
      tx.state = "done";
      const audioSec = tx.audioBytes / 2 / MIC_RATE;
      const sttUsd = tx.combo.stt === "nova3" ? (audioSec / 60) * NOVA_USD_PER_MIN : 0; // AssemblyAI is billed per session (stt.ts)
      const interpUsd = interpCall?.usd ?? 0;
      const ttsUsd = tts ? tts.chars * TTS_USD_PER_CHAR[providerOf(tx.combo.tts)] : 0;
      record(`live ${svc.mode} #${tx.id} ${tx.ctx.label} ${tx.combo.stt}+${tx.combo.tts}`, sttUsd + interpUsd + ttsUsd, tx.combo.stt === "nova3" ? audioSec / 60 : 0);
      const sttFinalAt = final?.finalAt ?? null;
      const firstByteAt = tts?.firstByteAt ?? null;
      const d = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : round(b - a));
      const row: Row = {
        id: tx.id,
        at: new Date().toISOString(),
        mode: svc.mode,
        ref: tx.ctx.ref,
        combo: { stt: tx.combo.stt, tts: tx.combo.tts, assemblySession: tx.combo.stt === "u36pro" ? svc.assembly.mode : null },
        contextSha: sha(tx.ctx.context),
        audio: { sec: round(audioSec)!, chunks: tx.chunks.length || Math.round(tx.audioBytes / 640), file: audioFile },
        stt: {
          transcript: final?.transcript ?? null,
          connectMs: round(final?.connectMs ?? null),
          readyBeforeRelease: final?.readyBeforeRelease ?? null,
          newSession: final?.newSession ?? null,
          partials: final?.partials ?? null,
          turns: final?.turns ?? null,
          notes: final?.notes ?? [],
          error: sttError,
        },
        interp: {
          called: interpCall !== null,
          terse: interpCall?.terse ?? null,
          valid: interpCall?.command != null,
          invalidReason: interpCall?.invalidReason ?? null,
          error: interpCall?.error ?? null,
          rawText: interpCall?.rawText ?? null,
          ms: round(interpCall?.ms ?? null),
          serverMs: interpCall?.serverMs ?? null,
          newConnection: interpCall?.newConnection ?? null,
          tokens: interpCall?.tokens ?? null,
          promptSha: svc.interp.promptSha,
        },
        expected: tx.ctx.expected,
        exact,
        understood: null,
        readback,
        server: {
          downToReleaseMs: round(t0 - tx.downAt),
          sttFinalMs: round(since(sttFinalAt)),
          interpDoneMs: round(since(interpDoneAt)),
          readbackReadyMs: round(since(readyAt)),
          firstVoiceByteMs: round(since(firstByteAt)),
          firstAudioSentMs: round(since(firstSentAt)),
          ttsDoneMs: round(since(tts?.doneAt ?? null)),
        },
        stages: {
          sttMs: d(t0, sttFinalAt),
          interpMs: d(sttFinalAt, interpDoneAt),
          templateMs: d(interpDoneAt, readyAt),
          ttsFirstByteMs: d(readyAt, firstByteAt),
          sendMs: d(firstByteAt, firstSentAt),
          serverTotalMs: d(t0, firstSentAt),
        },
        client: null,
        usd: { stt: sttUsd, interp: interpUsd, tts: ttsUsd },
        errors,
      };
      svc.log.put(row);
      this.send({ type: "done", id: tx.id, stages: row.stages, errors, logged: true });
      this.txs.delete(tx.id);
    }
  }

  /** Speak a correction card's wrong readback in that flight's voice (not a transmission). */
  private async playWrong(cardId: string): Promise<void> {
    if (this.svc.mode !== "live") return this.error(null, "protocol", "play-wrong is for live sessions only");
    const card = cardById(cardId);
    if (!card.wrongReadback) return this.error(null, "play-wrong", `card ${cardId} has no wrong readback`);
    const combo = this.svc.plan.get(card.id)!;
    const voice = this.voiceOf(voiceFlightOf(card), combo.tts);
    const id = EXTRA_ID_BASE + ++this.extraIds;
    this.send({ type: "audio-start", id, sampleRate: TTS_RATE, kind: "wrong-readback", cardId });
    const r = await this.svc.voices.speak(combo.tts, voice, card.wrongReadback, (pcm) => this.sendAudio(id, pcm));
    record(`live wrong-readback ${cardId} ${combo.tts}`, r.chars * TTS_USD_PER_CHAR[providerOf(combo.tts)]);
    if (r.error) this.error(id, "tts", r.error);
    this.send({ type: "audio-end", id, bytes: r.bytes, audioSec: round(r.bytes / 2 / TTS_RATE), error: r.error, kind: "wrong-readback" });
  }
}

/** Warm every voice once (first use of a library voice took ~5 s) and the interpreter's cache. */
export async function warmUp(svc: Pick<Services, "interp" | "voices">, tts: TtsId[], log: (s: string) => void): Promise<void> {
  const t0 = performance.now();
  const call = await svc.interp.interpret(liveContext("01"), "Delta four, hold position.");
  if (call.error) throw new Error(`interpreter warm-up failed: ${call.error}`);
  record("live warm-up interpreter", call.usd);
  log(`  interpreter warm: ${Math.round(call.ms)} ms (${call.terse ?? call.invalidReason})`);
  for (const t of tts) {
    for (const v of VOICES[providerOf(t)]) {
      const r = await svc.voices.speak(t, v, "Roger.", () => undefined);
      if (r.error) throw new Error(`voice warm-up failed for ${v.name} on ${t}: ${r.error}`);
      record(`live warm-up ${t} ${v.name}`, r.chars * TTS_USD_PER_CHAR[providerOf(t)]);
      log(`  ${t} ${v.name} warm: first byte ${Math.round((r.firstByteAt ?? r.doneAt) - r.requestAt)} ms`);
    }
  }
  log(`  warm-up done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
