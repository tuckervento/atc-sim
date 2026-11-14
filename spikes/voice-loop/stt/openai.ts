/**
 * OpenAI Realtime API, transcription intent (gpt-live-transcribe, gpt-transcribe).
 * Docs read 2026-11-14: developers.openai.com/api/docs/guides/realtime-transcription and
 * .../guides/realtime-websocket.
 *
 * - Connect wss://api.openai.com/v1/realtime?intent=transcription, Authorization: Bearer.
 * - session.update with session.type "transcription", 24 kHz audio/pcm, turn_detection null
 *   (gpt-live-transcribe supports no server VAD; push-to-talk commits the turn).
 * - Stream input_audio_buffer.append (base64), then input_audio_buffer.commit on release.
 * - Final = conversation.item.input_audio_transcription.completed for the committed item.
 *
 * --opt keys: delay=<minimal|low|medium|high|xhigh|none>, prompt=<on|off>, keywords=<on|off>.
 *
 * Probed 2026-11-14 (see results/0.3-speech-to-text.md): `delay` is silently dropped by
 * gpt-live-transcribe (absent from the session.updated echo) and rejected by gpt-transcribe
 * ("The 'delay' parameter is not supported for this model"), so it isn't sent. `prompt` and
 * `keywords` are echoed back by both models.
 */
import { requireKey, redact } from "./env.ts";
import { streamPaced } from "./audio.ts";
import { CONTEXT_PROMPT, VOCAB } from "./vocab.ts";
import { WsSession, type Json } from "./ws.ts";
import { emptyRun, round1, LATE_TEXT_WINDOW_MS, type ClipAudio, type ClipRun, type RunOptions } from "./types.ts";

export const OPENAI_RATE = 24_000;
const URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const CONNECT_TIMEOUT_MS = 10_000;
const KNOWN_OPTS = new Set(["delay", "prompt", "keywords"]);
const DELAYS = new Set(["minimal", "low", "medium", "high", "xhigh", "none"]);

/** Defaults used for the bake-off (delay omitted: see the probe note above). */
export const OPENAI_DEFAULTS: Record<string, { delay: string; prompt: string; keywords: string }> = {
  "gpt-live-transcribe": { delay: "none", prompt: "on", keywords: "on" },
  "gpt-transcribe": { delay: "none", prompt: "on", keywords: "on" },
};

function errorText(msg: Json): string {
  const err = msg.error;
  if (err && typeof err === "object") {
    const e = err as Json;
    return [e.code, e.param, e.message].filter((v) => typeof v === "string" && v !== "").join(": ");
  }
  return JSON.stringify(msg).slice(0, 300);
}

export function openAiTranscriptionConfig(model: string, opts: Map<string, string>): Json {
  for (const key of opts.keys()) {
    if (!KNOWN_OPTS.has(key)) throw new Error(`unknown --opt ${key} for OpenAI (known: ${[...KNOWN_OPTS].join(", ")})`);
  }
  const defaults = OPENAI_DEFAULTS[model];
  if (!defaults) throw new Error(`no OpenAI defaults for model ${model}`);
  const delay = opts.get("delay") ?? defaults.delay;
  const prompt = opts.get("prompt") ?? defaults.prompt;
  const keywords = opts.get("keywords") ?? defaults.keywords;
  if (!DELAYS.has(delay)) throw new Error(`--opt delay must be one of ${[...DELAYS].join(", ")}`);
  for (const [name, value] of [["prompt", prompt], ["keywords", keywords]] as const) {
    if (value !== "on" && value !== "off") throw new Error(`--opt ${name} must be on or off`);
  }
  const transcription: Json = { model, languages: ["en"] };
  if (keywords === "on") transcription.keywords = [...VOCAB];
  if (prompt === "on") transcription.prompt = CONTEXT_PROMPT;
  if (delay !== "none") transcription.delay = delay;
  return transcription;
}

export async function runOpenAi(model: string, audio: ClipAudio, run: RunOptions): Promise<ClipRun> {
  if (audio.sampleRate !== OPENAI_RATE) throw new Error(`OpenAI needs ${OPENAI_RATE} Hz audio`);
  const key = requireKey("OPENAI_API_KEY");
  const out = emptyRun();
  const transcription = openAiTranscriptionConfig(model, run.opts);
  let session: WsSession | null = null;
  let lastChunkAt: number | null = null;
  try {
    session = await WsSession.connect(URL, { Authorization: `Bearer ${key}` }, CONNECT_TIMEOUT_MS);
    const s = session;
    s.sendJson({
      type: "session.update",
      session: {
        type: "transcription",
        audio: { input: { format: { type: "audio/pcm", rate: OPENAI_RATE }, transcription, turn_detection: null } },
      },
    });
    const updated = await s.waitFor(
      (m) => {
        if (m.type === "error") throw new Error(`session.update rejected: ${errorText(m)}`);
        return m.type === "session.updated" ? m : undefined;
      },
      CONNECT_TIMEOUT_MS,
      "session.updated",
    );
    out.timings.connectMs = round1(updated.at - s.connectStartedAt);
    out.notes.push(`server echo: ${describeEcho(updated.value)}`);

    const streamFrom = s.log.length;
    const pace = await streamPaced(
      audio.pcm,
      audio.sampleRate,
      run.chunkMs,
      (chunk) => s.sendJson({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }),
      () => s.ended ?? firstError(s, streamFrom),
    );
    s.sendJson({ type: "input_audio_buffer.commit" });
    lastChunkAt = pace.lastChunkAt;
    out.timings.streamMs = round1(pace.lastChunkAt - pace.startedAt);
    out.timings.driftMs = round1(pace.driftMs);

    const committed = await s.waitFor(
      (m) => {
        if (m.type === "error") throw new Error(`commit failed: ${errorText(m)}`);
        return m.type === "input_audio_buffer.committed" ? String(m.item_id ?? "") : undefined;
      },
      run.finalTimeoutMs,
      "input_audio_buffer.committed",
      streamFrom,
    );
    const final = await s.waitFor(
      (m) => {
        if (m.type === "error") throw new Error(`error after commit: ${errorText(m)}`);
        if (m.type === "conversation.item.input_audio_transcription.failed") {
          throw new Error(`transcription failed: ${errorText(m)}`);
        }
        if (m.type !== "conversation.item.input_audio_transcription.completed") return undefined;
        if (committed.value && m.item_id !== committed.value) return undefined;
        return typeof m.transcript === "string" ? m.transcript : "";
      },
      run.finalTimeoutMs,
      "input_audio_buffer transcription completed",
      streamFrom,
    );
    out.transcript = final.value.trim();
    out.latencyMs = round1(final.at - pace.lastChunkAt);

    const deltas = s.log
      .slice(streamFrom)
      .filter(({ msg }) => msg.type === "conversation.item.input_audio_transcription.delta" && typeof msg.delta === "string" && msg.delta.trim() !== "");
    out.partials = deltas.length;
    if (deltas[0]) out.timings.firstTextMs = round1(deltas[0].at - pace.startedAt);
    const usage = s.log[final.index]?.msg.usage;
    if (usage && typeof usage === "object") out.notes.push(`usage: ${JSON.stringify(usage)}`);
    out.lateText = await s.lateText(final.index, LATE_TEXT_WINDOW_MS, (m) => {
      if (m.type === "conversation.item.input_audio_transcription.delta" && typeof m.delta === "string") return m.delta;
      if (m.type === "conversation.item.input_audio_transcription.completed" && typeof m.transcript === "string") return m.transcript;
      return undefined;
    });
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

function firstError(s: WsSession, from: number): string | null {
  for (let i = from; i < s.log.length; i++) {
    const msg = s.log[i]!.msg;
    if (msg.type === "error") return `provider error mid-stream: ${errorText(msg)}`;
  }
  return null;
}

/** Summarize what the server says it applied, so silently dropped options are visible. */
function describeEcho(msg: Json): string {
  const session = msg.session as Json | undefined;
  const input = ((session?.audio as Json | undefined)?.input as Json | undefined) ?? {};
  const t = (input.transcription as Json | undefined) ?? {};
  const parts = [
    `model=${String(t.model)}`,
    `delay=${t.delay === undefined ? "(absent)" : String(t.delay)}`,
    `prompt=${typeof t.prompt === "string" && t.prompt !== "" ? "set" : "(absent)"}`,
    `keywords=${Array.isArray(t.keywords) ? t.keywords.length : "(absent)"}`,
    `languages=${Array.isArray(t.languages) ? t.languages.join("+") : String(t.languages ?? t.language ?? "(absent)")}`,
    `format=${JSON.stringify(input.format ?? null)}`,
    `turn_detection=${JSON.stringify(input.turn_detection ?? null)}`,
  ];
  return parts.join(" ");
}
