/**
 * Cartesia: `POST /tts/bytes` (streams audio for a complete line) and voice catalog queries.
 * Docs read 2026-11-14: https://docs.cartesia.ai/api-reference/tts/bytes ·
 * https://docs.cartesia.ai/api-reference/voices/list
 */
import { SAMPLE_RATE } from "./audio.ts";
import { getJson } from "./common.ts";
import { timedPcmPost, type TimedAudio } from "./http-stream.ts";

const BASE = "https://api.cartesia.ai";
export const ENV_VAR = "CARTESIA_API_KEY";
export const MODEL = "sonic-3.6";
export const VERSION = "2026-08-14";
/** 1 credit per character; Pro overage is $65 per 1M (docs/spikes/voice-loop.md § Shortlist). */
export const USD_PER_CHAR = 65 / 1_000_000;
/** `generation_config.speed` range per the TTS bytes docs. */
export const SPEED_RANGE: [number, number] = [0.6, 1.5];

const headers = (key: string): Record<string, string> => ({
  Authorization: `Bearer ${key}`,
  "Cartesia-Version": VERSION,
});

export interface CartesiaRequest {
  text: string;
  voiceId: string;
  speed: number;
  /** BCP-47, e.g. "en" or "en-GB". */
  language?: string;
  /** Must be one of the voice's `accents[].accent` values. Top-level field. */
  accent?: string;
  /** Default sonic-3.6. */
  model?: string;
}

export function synth(key: string, req: CartesiaRequest): Promise<TimedAudio> {
  const body: Record<string, unknown> = {
    model_id: req.model ?? MODEL,
    transcript: req.text,
    voice: { id: req.voiceId },
    output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
    language: req.language ?? "en",
    generation_config: { speed: req.speed },
  };
  if (req.accent) body.accent = req.accent;
  return timedPcmPost(`${BASE}/tts/bytes`, headers(key), body, key);
}

export interface CartesiaVoice {
  id: string;
  name: string;
  tagline: string;
  description: string;
  gender: string | null;
  accents?: { accent: string; locale: string; is_native: boolean }[];
}

/** Every voice for a language filter (`en` matches every voice with any English accent). Free. */
export async function listVoices(key: string, language: string): Promise<CartesiaVoice[]> {
  const all: CartesiaVoice[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ limit: "100", language });
    if (after) q.set("starting_after", after);
    const body = (await getJson(`${BASE}/voices?${q}`, headers(key), key)) as {
      data: CartesiaVoice[];
      has_more: boolean;
      next_page: string | null;
    };
    all.push(...body.data);
    if (!body.has_more || !body.next_page) return all;
    after = body.next_page;
  }
  throw new Error("Cartesia voice list: more than 50 pages; stopping");
}
