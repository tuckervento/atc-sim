/**
 * ElevenLabs: HTTP streaming TTS (`POST /v1/text-to-speech/{voice_id}/stream`) and voice catalog
 * queries. Docs read 2026-11-14:
 * https://elevenlabs.io/docs/api-reference/text-to-speech/stream ·
 * https://elevenlabs.io/docs/api-reference/voices/search ·
 * https://elevenlabs.io/docs/api-reference/voices/voice-library/get-shared
 */
import { SAMPLE_RATE } from "./audio.ts";
import { getJson } from "./common.ts";
import { timedPcmPost, type TimedAudio } from "./http-stream.ts";

const BASE = "https://api.elevenlabs.io";
export const ENV_VAR = "ELEVENLABS_API_KEY";
export const MODEL = "eleven_flash_v2_5";
/** Checked once for rate control (PLAN 0.5 note): the Agents docs say it has none. */
export const TURBO_MODEL = "eleven_v4_turbo";
/** $0.04 per 1K characters, API pay-as-you-go (docs/spikes/voice-loop.md § Shortlist). */
export const USD_PER_CHAR = 0.04 / 1000;
/** `voice_settings.speed` range per the shortlist. */
export const SPEED_RANGE: [number, number] = [0.7, 1.2];

export interface ElevenRequest {
  text: string;
  voiceId: string;
  speed: number;
  model?: string;
}

export function synth(key: string, req: ElevenRequest): Promise<TimedAudio> {
  const url = `${BASE}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/stream?output_format=pcm_${SAMPLE_RATE}`;
  return timedPcmPost(
    url,
    { "xi-api-key": key },
    { text: req.text, model_id: req.model ?? MODEL, voice_settings: { speed: req.speed } },
    key,
  );
}

export interface ElevenVoice {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
}

/** Voices in the account (premade defaults plus anything added). */
export async function listAccountVoices(key: string): Promise<ElevenVoice[]> {
  const body = (await getJson(`${BASE}/v2/voices?page_size=100`, { "xi-api-key": key }, key)) as {
    voices: ElevenVoice[];
  };
  return body.voices;
}

export interface SharedVoice {
  voice_id: string;
  public_owner_id: string;
  name: string;
  accent: string;
  gender: string;
  age: string;
  descriptive: string;
  use_case: string;
  category: string;
  language: string;
  locale: string;
  free_users_allowed: boolean;
}

/** One page of the shared Voice Library plus its total match count. Free, read-only. */
export async function searchShared(
  key: string,
  filters: Record<string, string | string[]>,
  pageSize = 1,
): Promise<{ total: number; voices: SharedVoice[] }> {
  const q = new URLSearchParams({ page_size: String(pageSize) });
  for (const [name, value] of Object.entries(filters)) {
    for (const v of Array.isArray(value) ? value : [value]) q.append(name, v);
  }
  const body = (await getJson(`${BASE}/v1/shared-voices?${q}`, { "xi-api-key": key }, key)) as {
    voices: SharedVoice[];
    total_count: number;
  };
  return { total: body.total_count, voices: body.voices };
}
