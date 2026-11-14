/**
 * Streaming voices for the live loop. Each call streams PCM (16-bit mono, 24 kHz, as 0.5) to a
 * callback as it arrives, aligned to whole samples.
 *
 * - ElevenLabs eleven_flash_v2_5: HTTP streaming, the same request as 0.5's tts/elevenlabs.ts
 *   (POST /v1/text-to-speech/{voice}/stream?output_format=pcm_24000, voice_settings.speed),
 *   on Node's fetch with keep-alive (kept warm by warm.ts).
 * - Cartesia sonic-3.6, transport chosen explicitly per request (the TtsId), never switched:
 *   - "cartesia-http": POST /tts/bytes, the same body as 0.5's tts/cartesia.ts.
 *   - "cartesia-ws": one long-lived WebSocket (wss://api.cartesia.ai/tts/websocket, X-API-Key
 *     header, Cartesia-Version), one context per line with continue: false; audio arrives as
 *     base64 "chunk" messages and ends with "done" (API reference read 2026-11-14). A ws ping
 *     every 15 s keeps it open; if it closes, the next line reconnects and records that.
 * tts/http-stream.ts's timedPcmPost can't be reused: it buffers the whole body before returning.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { USER_AGENT, describeError, redact } from "../stt/env.ts";
import { connectionCount } from "../interp/net.ts";
import { MODEL as ELEVEN_MODEL } from "../tts/elevenlabs.ts";
import { MODEL as CARTESIA_MODEL, VERSION as CARTESIA_VERSION } from "../tts/cartesia.ts";
import { SAMPLE_RATE } from "../tts/audio.ts";
import { onHost } from "./warm.ts";
import type { LiveVoice, TtsId } from "./voices.ts";

export { SAMPLE_RATE };
const TIMEOUT_MS = 15_000;
const ELEVEN_HOST = "api.elevenlabs.io";
const CARTESIA_HOST = "api.cartesia.ai";

export interface TtsResult {
  tts: TtsId;
  transport: "http" | "ws";
  /** performance.now() just before the request was sent. */
  requestAt: number;
  firstByteAt: number | null;
  doneAt: number;
  bytes: number;
  chars: number;
  /** HTTP: this request opened a new HTTPS connection. WS: the socket had to be (re)opened. */
  newConnection: boolean;
  /** WS only: time spent opening the socket inside this request. */
  connectMs: number | null;
  /** Cartesia WS: summed server step_time of the chunks, when reported. */
  serverStepMs: number | null;
  error: string | null;
}

/** Splits a byte stream into whole 16-bit samples, carrying an odd byte to the next chunk. */
class Aligner {
  private carry: Buffer | null = null;
  private readonly out: (pcm: Buffer) => void;
  constructor(out: (pcm: Buffer) => void) {
    this.out = out;
  }
  push(chunk: Buffer): void {
    let buf = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = null;
    if (buf.length % 2 === 1) {
      this.carry = buf.subarray(buf.length - 1);
      buf = buf.subarray(0, buf.length - 1);
    }
    if (buf.length > 0) this.out(buf);
  }
}

async function httpStream(
  tts: TtsId, host: string, url: string, headers: Record<string, string>, body: unknown, text: string,
  onChunk: (pcm: Buffer) => void,
): Promise<TtsResult> {
  const r: TtsResult = {
    tts, transport: "http", requestAt: performance.now(), firstByteAt: null, doneAt: 0, bytes: 0, chars: text.length,
    newConnection: false, connectMs: null, serverStepMs: null, error: null,
  };
  const before = connectionCount(host);
  const align = new Aligner((pcm) => {
    r.bytes += pcm.length;
    onChunk(pcm);
  });
  await onHost(host, async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok || !res.body) {
        r.error = redact(`HTTP ${res.status}: ${await res.text()}`);
        return;
      }
      for await (const chunk of res.body) {
        if (chunk.byteLength === 0) continue;
        r.firstByteAt ??= performance.now();
        align.push(Buffer.from(chunk));
      }
    } catch (err) {
      r.error = describeError(err);
    }
  });
  r.doneAt = performance.now();
  r.newConnection = connectionCount(host) > before;
  if (!r.error && r.bytes === 0) r.error = "HTTP 200 but no audio bytes";
  return r;
}

// ---- Cartesia WebSocket ----------------------------------------------------------------

interface Pending {
  onChunk: (b: Buffer) => void;
  resolve: () => void;
  reject: (e: Error) => void;
  stepMs: number;
  sawStep: boolean;
}

class CartesiaSocket {
  private ws: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, Pending>();
  opens = 0;
  private readonly key: string;
  constructor(key: string) {
    this.key = key;
  }

  private connect(): Promise<WebSocket> {
    const url = `wss://${CARTESIA_HOST}/tts/websocket?cartesia_version=${CARTESIA_VERSION}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { "X-API-Key": this.key, "Cartesia-Version": CARTESIA_VERSION, "User-Agent": USER_AGENT },
        handshakeTimeout: 10_000,
      });
      let opened = false;
      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (b: Buffer) => { if (body.length < 2000) body += b.toString(); });
        res.on("end", () => reject(new Error(redact(`Cartesia WS HTTP ${res.statusCode} on connect: ${body}`))));
      });
      ws.on("open", () => {
        opened = true;
        this.opens++;
        resolve(ws);
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        const id = typeof msg.context_id === "string" ? msg.context_id : null;
        const p = id ? this.pending.get(id) : undefined;
        if (msg.type === "error") {
          const e = new Error(redact(`Cartesia WS error ${String(msg.status_code ?? "")}: ${String(msg.title ?? "")} ${String(msg.message ?? "")}`));
          if (p && id) {
            this.pending.delete(id);
            p.reject(e);
          } else {
            for (const [k, q] of this.pending) {
              this.pending.delete(k);
              q.reject(e);
            }
          }
          return;
        }
        if (!p || !id) return;
        if (msg.type === "chunk" && typeof msg.data === "string") {
          if (typeof msg.step_time === "number") {
            p.stepMs += msg.step_time;
            p.sawStep = true;
          }
          p.onChunk(Buffer.from(msg.data, "base64"));
        }
        if (msg.type === "done" || msg.done === true) {
          this.pending.delete(id);
          p.resolve();
        }
      });
      ws.on("error", (err) => {
        if (!opened) reject(new Error(redact(`Cartesia WS: ${err.message}`)));
      });
      ws.on("close", (code, reason) => {
        if (this.ws === ws) this.ws = null;
        const e = new Error(redact(`Cartesia WS closed (code ${code}${reason.length ? `, ${reason.toString()}` : ""})`));
        if (!opened) reject(e);
        for (const [k, q] of this.pending) {
          this.pending.delete(k);
          q.reject(e);
        }
      });
    });
  }

  /** The open socket, opening one if needed. `fresh` says whether this call opened it. */
  async socket(): Promise<{ ws: WebSocket; fresh: boolean; connectMs: number | null }> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return { ws: this.ws, fresh: false, connectMs: null };
    const t0 = performance.now();
    this.opening ??= this.connect().finally(() => { this.opening = null; });
    const ws = await this.opening;
    this.ws = ws;
    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
      }, 15_000);
      this.pingTimer.unref();
    }
    return { ws, fresh: true, connectMs: performance.now() - t0 };
  }

  async speak(voice: LiveVoice, text: string, onChunk: (pcm: Buffer) => void): Promise<TtsResult> {
    const r: TtsResult = {
      tts: "cartesia-ws", transport: "ws", requestAt: performance.now(), firstByteAt: null, doneAt: 0, bytes: 0, chars: text.length,
      newConnection: false, connectMs: null, serverStepMs: null, error: null,
    };
    const align = new Aligner((pcm) => {
      r.bytes += pcm.length;
      onChunk(pcm);
    });
    try {
      const { ws, fresh, connectMs } = await this.socket();
      r.newConnection = fresh;
      r.connectMs = connectMs;
      const contextId = randomUUID();
      const done = new Promise<{ stepMs: number; sawStep: boolean }>((resolve, reject) => {
        const p: Pending = {
          onChunk: (b) => {
            r.firstByteAt ??= performance.now();
            align.push(b);
          },
          resolve: () => resolve({ stepMs: p.stepMs, sawStep: p.sawStep }),
          reject,
          stepMs: 0,
          sawStep: false,
        };
        this.pending.set(contextId, p);
        setTimeout(() => {
          if (this.pending.delete(contextId)) reject(new Error(`Cartesia WS: no "done" after ${TIMEOUT_MS} ms`));
        }, TIMEOUT_MS).unref();
      });
      const req: Record<string, unknown> = {
        model_id: CARTESIA_MODEL,
        transcript: text,
        voice: { id: voice.id },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
        context_id: contextId,
        continue: false,
        language: "en",
        generation_config: { speed: voice.speed },
      };
      if (voice.accent) req.accent = voice.accent;
      ws.send(JSON.stringify(req));
      const d = await done;
      r.serverStepMs = d.sawStep ? d.stepMs : null;
    } catch (err) {
      r.error = describeError(err);
    }
    r.doneAt = performance.now();
    if (!r.error && r.bytes === 0) r.error = "Cartesia WS: done with no audio";
    return r;
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws?.close(1000);
    this.ws = null;
  }
}

// ---- public ----------------------------------------------------------------------------

export class Voices {
  private readonly elevenKey: string;
  private readonly cartesiaKey: string;
  private readonly cartesiaWs: CartesiaSocket;

  constructor(elevenKey: string, cartesiaKey: string) {
    this.elevenKey = elevenKey;
    this.cartesiaKey = cartesiaKey;
    this.cartesiaWs = new CartesiaSocket(cartesiaKey);
  }

  get cartesiaWsOpens(): number {
    return this.cartesiaWs.opens;
  }

  speak(tts: TtsId, voice: LiveVoice, text: string, onChunk: (pcm: Buffer) => void): Promise<TtsResult> {
    if ((tts === "elevenlabs") !== (voice.provider === "elevenlabs")) throw new Error(`voice ${voice.name} isn't a ${tts} voice`);
    if (tts === "elevenlabs") {
      const url = `https://${ELEVEN_HOST}/v1/text-to-speech/${encodeURIComponent(voice.id)}/stream?output_format=pcm_${SAMPLE_RATE}`;
      return httpStream(tts, ELEVEN_HOST, url, { "xi-api-key": this.elevenKey },
        { text, model_id: ELEVEN_MODEL, voice_settings: { speed: voice.speed } }, text, onChunk);
    }
    if (tts === "cartesia-http") {
      const body: Record<string, unknown> = {
        model_id: CARTESIA_MODEL,
        transcript: text,
        voice: { id: voice.id },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
        language: "en",
        generation_config: { speed: voice.speed },
      };
      if (voice.accent) body.accent = voice.accent;
      return httpStream(tts, CARTESIA_HOST, `https://${CARTESIA_HOST}/tts/bytes`,
        { Authorization: `Bearer ${this.cartesiaKey}`, "Cartesia-Version": CARTESIA_VERSION }, body, text, onChunk);
    }
    return this.cartesiaWs.speak(voice, text, onChunk);
  }

  close(): void {
    this.cartesiaWs.close();
  }
}
