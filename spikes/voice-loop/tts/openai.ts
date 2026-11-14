/**
 * OpenAI `gpt-realtime-2.1-mini` over the Realtime WebSocket API, used as a voice: the model is
 * told to read each line exactly, and its own transcript of what it said is kept so the bench can
 * measure paraphrasing. A session can't change voice once it has spoken, so each (voice, speed)
 * gets its own session, and each line is an out-of-band response (`conversation: "none"`) so
 * earlier lines don't build up context. Docs read 2026-11-14:
 * https://developers.openai.com/api/docs/guides/realtime-conversations ·
 * https://developers.openai.com/api/docs/guides/realtime-websocket ·
 * https://developers.openai.com/api/reference/resources/realtime/subresources/sessions/methods/create
 */
import WebSocket from "ws";
import { SAMPLE_RATE } from "./audio.ts";
import { describeError, ProviderError, REQUEST_TIMEOUT_MS, sanitize, USER_AGENT } from "./common.ts";

export const ENV_VAR = "OPENAI_API_KEY";
export const MODEL = "gpt-realtime-2.1-mini";
export const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];
/** `audio.output.speed` range per the session reference. */
export const SPEED_RANGE: [number, number] = [0.25, 1.5];
/** Per 1M tokens (model page, read 2026-11-14). Cached text input is priced as uncached here. */
const USD_PER_TOKEN = { audioOut: 20e-6, textOut: 2.4e-6, textIn: 0.6e-6, audioIn: 10e-6 };

export const INSTRUCTIONS = [
  "You are the voice of an airline pilot in an air traffic control simulator.",
  "Each user message is one radio transmission the pilot says to Ground.",
  "Say the user's text aloud exactly as written: every word, in order. Do not add, drop, reorder or reword anything.",
  "Never reply to the text, answer it, greet, or comment. Only speak the text.",
  "Numbers and letters are already written as spoken words; read them as written.",
  "Delivery: a calm, professional airline pilot on a busy frequency. Brisk and matter-of-fact, no pauses between phrases.",
].join(" ");

export interface RealtimeLine {
  pcm: Buffer;
  /** response.create sent → first audio delta. */
  ttfaMs: number;
  /** response.create sent → response.done. */
  totalMs: number;
  /** The model's own transcript of the audio it produced. */
  transcript: string;
  usage: Usage;
  costUsd: number;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { text_tokens?: number; audio_tokens?: number; cached_tokens?: number };
  output_token_details?: { text_tokens?: number; audio_tokens?: number; reasoning_tokens?: number };
}

function costOf(u: Usage): number {
  const inT = u.input_token_details?.text_tokens ?? 0;
  const inA = u.input_token_details?.audio_tokens ?? 0;
  const outT = u.output_token_details?.text_tokens ?? 0;
  const outA = u.output_token_details?.audio_tokens ?? 0;
  return inT * USD_PER_TOKEN.textIn + inA * USD_PER_TOKEN.audioIn + outT * USD_PER_TOKEN.textOut + outA * USD_PER_TOKEN.audioOut;
}

interface ServerEvent {
  type: string;
  session?: Record<string, unknown>;
  delta?: string;
  transcript?: string;
  error?: { message?: string; code?: string; type?: string; param?: string };
  response?: { id?: string; status?: string; status_details?: unknown; usage?: Usage; metadata?: Record<string, string> };
}

interface Pending {
  tag: string;
  t0: number;
  ttfaMs: number;
  chunks: Buffer[];
  transcript: string;
  resolve: (line: RealtimeLine) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class RealtimeVoice {
  /** Connect → session.updated. */
  setupMs = 0;
  /** The session as the server echoed it in session.updated (to confirm settings took). */
  echoed: Record<string, unknown> = {};
  readonly voice: string;
  readonly speed: number;
  private ws: WebSocket;
  private key: string;
  private pending: Pending | undefined;
  private counter = 0;

  private constructor(ws: WebSocket, key: string, voice: string, speed: number) {
    this.ws = ws;
    this.key = key;
    this.voice = voice;
    this.speed = speed;
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", (code) => this.failPending(new ProviderError(`realtime socket closed (code ${code})`)));
    ws.on("error", (err) => this.failPending(new ProviderError(sanitize(`realtime socket error: ${describeError(err)}`, key))));
  }

  static open(key: string, voice: string, speed: number, extraSession: Record<string, unknown> = {}): Promise<RealtimeVoice> {
    const t0 = performance.now();
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
      headers: { Authorization: `Bearer ${key}`, "User-Agent": USER_AGENT },
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new ProviderError(`realtime session setup timed out after ${REQUEST_TIMEOUT_MS} ms`));
      }, REQUEST_TIMEOUT_MS);
      const fail = (err: Error): void => {
        clearTimeout(timer);
        ws.terminate();
        reject(err);
      };
      ws.once("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => fail(new ProviderError(sanitize(`HTTP ${res.statusCode} ${body}`, key), res.statusCode)));
      });
      ws.once("error", (err) => fail(new ProviderError(sanitize(`realtime connect error: ${describeError(err)}`, key))));
      const onSetup = (data: WebSocket.RawData): void => {
        const ev = JSON.parse(data.toString()) as ServerEvent;
        if (ev.type === "session.created") {
          ws.send(
            JSON.stringify({
              type: "session.update",
              session: {
                type: "realtime",
                output_modalities: ["audio"],
                instructions: INSTRUCTIONS,
                audio: {
                  input: { turn_detection: null },
                  output: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, voice, speed },
                },
                ...extraSession,
              },
            }),
          );
        } else if (ev.type === "session.updated") {
          clearTimeout(timer);
          ws.off("message", onSetup);
          ws.removeAllListeners("error");
          const session = new RealtimeVoice(ws, key, voice, speed);
          session.setupMs = performance.now() - t0;
          session.echoed = ev.session ?? {};
          resolve(session);
        } else if (ev.type === "error") {
          fail(new ProviderError(sanitize(`realtime error during setup: ${JSON.stringify(ev.error)}`, key)));
        }
      };
      ws.on("message", onSetup);
    });
  }

  /** Speak one line. One line at a time per session. */
  say(text: string): Promise<RealtimeLine> {
    if (this.pending) return Promise.reject(new Error("RealtimeVoice.say: a line is already in progress"));
    const tag = `line-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.failPending(new ProviderError(`realtime response timed out after ${REQUEST_TIMEOUT_MS} ms`)),
        REQUEST_TIMEOUT_MS,
      );
      this.pending = { tag, t0: performance.now(), ttfaMs: Number.NaN, chunks: [], transcript: "", resolve, reject, timer };
      this.ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            conversation: "none",
            metadata: { tag },
            output_modalities: ["audio"],
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
          },
        }),
      );
    });
  }

  close(): void {
    this.ws.close(1000);
  }

  private failPending(err: Error): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = undefined;
    p.reject(err);
  }

  private onMessage(data: WebSocket.RawData): void {
    const ev = JSON.parse(data.toString()) as ServerEvent;
    const p = this.pending;
    if (ev.type === "error") {
      this.failPending(new ProviderError(sanitize(`realtime error: ${JSON.stringify(ev.error)}`, this.key)));
      return;
    }
    if (!p) return;
    if (ev.type === "response.output_audio.delta" && ev.delta) {
      if (Number.isNaN(p.ttfaMs)) p.ttfaMs = performance.now() - p.t0;
      p.chunks.push(Buffer.from(ev.delta, "base64"));
    } else if (ev.type === "response.output_audio_transcript.done" && typeof ev.transcript === "string") {
      p.transcript = ev.transcript;
    } else if (ev.type === "response.done") {
      clearTimeout(p.timer);
      this.pending = undefined;
      const status = ev.response?.status;
      if (status !== "completed") {
        p.reject(new ProviderError(`realtime response ${status ?? "unknown"}: ${JSON.stringify(ev.response?.status_details ?? {})}`));
        return;
      }
      if (p.chunks.length === 0) {
        p.reject(new ProviderError("realtime response completed with no audio"));
        return;
      }
      const usage = ev.response?.usage ?? {};
      p.resolve({
        pcm: Buffer.concat(p.chunks),
        ttfaMs: p.ttfaMs,
        totalMs: performance.now() - p.t0,
        transcript: p.transcript,
        usage,
        costUsd: costOf(usage),
      });
    }
  }
}
