/**
 * Task 0.6, first step: does the ElevenLabs Starter plan allow shared Voice Library voices
 * through the API? On the free plan (0.5) a TTS request with a library voice returned
 * "HTTP 402 Free users cannot use library voices via the API".
 *
 *   node live/probe-library.ts --list               # free: search the shared library only
 *   node live/probe-library.ts --tts <voice_id>     # one short TTS request (~40 characters)
 *
 * The voice is used directly by its library voice_id. Nothing is added to the account: if the
 * API says the voice must be added first, that's reported, not worked around.
 */
import { parseArgs } from "node:util";
import { USER_AGENT, describeError, loadEnvLocal, redact, requireKey } from "../stt/env.ts";
import { appendSpend } from "../stt/results.ts";
import { MODEL, USD_PER_CHAR } from "../tts/elevenlabs.ts";
import { SAMPLE_RATE } from "../tts/audio.ts";
import { SPEND_LOG } from "./paths.ts";

const BASE = "https://api.elevenlabs.io";
const PROBE_TEXT = "Hold short three one left, Delta four.";

const { values } = parseArgs({
  options: { list: { type: "boolean", default: false }, tts: { type: "string" } },
});

loadEnvLocal();
const key = requireKey("ELEVENLABS_API_KEY");

async function list(): Promise<void> {
  // Same pilot filters as 0.5 (tts/voices.ts), sorted by how much the voice is used.
  const q = new URLSearchParams({ page_size: "30", language: "en", sort: "usage_character_count_1y" });
  for (const u of ["conversational", "informative_educational"]) q.append("use_cases", u);
  for (const d of ["calm", "confident", "professional", "crisp", "formal", "neutral", "serious", "deep", "mature"]) q.append("descriptives", d);
  q.append("age", "middle_aged");
  const res = await fetch(`${BASE}/v1/shared-voices?${q}`, { headers: { "xi-api-key": key, "User-Agent": USER_AGENT } });
  const text = await res.text();
  if (!res.ok) throw new Error(redact(`GET shared-voices HTTP ${res.status}: ${text}`));
  const body = JSON.parse(text) as { total_count: number; voices: Array<Record<string, unknown>> };
  console.log(`total_count=${body.total_count}`);
  for (const v of body.voices) {
    const pick = ["voice_id", "name", "gender", "age", "accent", "descriptive", "use_case", "category", "free_users_allowed", "rate", "fiat_rate", "notice_period", "live_moderation_enabled", "usage_character_count_1y", "cloned_by_count"];
    console.log(JSON.stringify(Object.fromEntries(pick.map((k) => [k, v[k]]))));
  }
}

async function tts(voiceId: string): Promise<void> {
  const url = `${BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_${SAMPLE_RATE}`;
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ text: PROBE_TEXT, model_id: MODEL, voice_settings: { speed: 1 } }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`network error: ${describeError(err)}`);
  }
  const headersMs = performance.now() - t0;
  let bytes = 0;
  let ttfaMs: number | null = null;
  let errText = "";
  if (res.ok && res.body) {
    for await (const chunk of res.body) {
      if (chunk.byteLength === 0) continue;
      ttfaMs ??= performance.now() - t0;
      bytes += chunk.byteLength;
    }
  } else {
    errText = await res.text();
  }
  // Billed only when audio came back; logged at the pay-as-you-go rate to stay conservative.
  if (res.ok) {
    appendSpend(SPEND_LOG, {
      at: new Date().toISOString(), candidate: `elevenlabs library probe ${voiceId}`, lines: 1, billedMin: 0, estUsd: PROBE_TEXT.length * USD_PER_CHAR,
    });
  }
  console.log(JSON.stringify({
    voiceId, status: res.status, headersMs: Math.round(headersMs), ttfaMs: ttfaMs === null ? null : Math.round(ttfaMs),
    audioBytes: bytes, audioSec: Math.round((bytes / 2 / SAMPLE_RATE) * 100) / 100, chars: PROBE_TEXT.length,
    error: errText ? redact(errText) : null,
  }));
}

if (values.list) await list();
if (values.tts) await tts(values.tts);
if (!values.list && !values.tts) {
  console.error("usage: node live/probe-library.ts --list | --tts <voice_id>");
  process.exit(2);
}
