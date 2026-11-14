/**
 * Pilot voices for the live loop, with a speed per voice. EDIT SPEEDS HERE: this table is the
 * only place they're set. Q's cadence ratings in 0.5 didn't follow measured wpm, so tune by ear.
 *
 * Starting speeds come from 0.5's calibration (docs/spikes/voice-loop.md § Voices):
 * - ElevenLabs: x0.9 is what 0.5 chose and what Q heard Daniel at (rated naturalness 5, cadence 4).
 *   The two library voices were never calibrated or heard by Q, so they start at the
 *   provider default x1.0.
 * - Cartesia sonic-3.6: x1.25 is what Q heard all three at (Sebastian 5/5, Derrick 5/4, Gary 5/4).
 *   0.5 found speed close to inert on 3.6, so expect little change from editing it.
 *
 * Library voices (0.6 probe, 2026-11-14): the Starter plan allows them through the API, but the
 * first request with a library voice took ~5.1 s and added the voice to the account's
 * My Voices (seen for Russell: absent before, present after). The server warms every voice at
 * startup so no transmission pays that.
 */
import { FLIGHTS } from "../interp/context.ts";

export type SttId = "nova3" | "u36pro";
/** The Cartesia transport is part of the id, so every logged row says which one ran. */
export type TtsId = "elevenlabs" | "cartesia-ws" | "cartesia-http";
export type TtsProvider = "elevenlabs" | "cartesia";

export const STT_IDS: readonly SttId[] = ["nova3", "u36pro"];
export const TTS_IDS: readonly TtsId[] = ["elevenlabs", "cartesia-ws", "cartesia-http"];

export const STT_LABELS: Record<SttId, string> = {
  nova3: "Deepgram Nova-3",
  u36pro: "AssemblyAI Universal-3.6 Pro",
};
export const TTS_LABELS: Record<TtsId, string> = {
  elevenlabs: "ElevenLabs Flash v2.5 (HTTP stream)",
  "cartesia-ws": "Cartesia sonic-3.6 (WebSocket)",
  "cartesia-http": "Cartesia sonic-3.6 (HTTP bytes)",
};

export function providerOf(tts: TtsId): TtsProvider {
  return tts === "elevenlabs" ? "elevenlabs" : "cartesia";
}

export interface LiveVoice {
  provider: TtsProvider;
  id: string;
  name: string;
  /** ElevenLabs voice_settings.speed (0.7-1.2) or Cartesia generation_config.speed (0.6-1.5). */
  speed: number;
  /** Cartesia top-level `accent` field (from the voice's accents list). */
  accent?: string;
  note: string;
}

export const VOICES: Record<TtsProvider, LiveVoice[]> = {
  elevenlabs: [
    { provider: "elevenlabs", id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", speed: 0.9, note: "premade, British; Q 0.5: naturalness 5, cadence 4, pilot y (heard at x0.9)" },
    { provider: "elevenlabs", id: "sB7vwSCyX0tQmU24cW2C", name: "Rob", speed: 1.0, note: "library 'Jon - Natural Authority' (listed in the account as 'Rob - Natural Authority'), American, rate 1; not yet heard by Q" },
    { provider: "elevenlabs", id: "pjaLAvgVlOPFqXDLNM3V", name: "Russell", speed: 1.0, note: "library 'Russell Flemming - Normal and Calm', American, rate 1; not yet heard by Q" },
  ],
  cartesia: [
    { provider: "cartesia", id: "b7187e84-fe22-4344-ba4a-bc013fcb533e", name: "Sebastian", speed: 1.25, accent: "standard-german", note: "native German voice with accent=standard-german, as on 0.5's page; Q 0.5: 5/5, pilot y" },
    { provider: "cartesia", id: "5cf0e4d9-ca2b-4fd5-81fa-89db3b645539", name: "Derrick", speed: 1.25, note: "'Professional Man', American; Q 0.5: 5/4, pilot y" },
    { provider: "cartesia", id: "dc52ada6-0e11-4684-a8fa-e0af5b7bdcb2", name: "Gary", speed: 1.25, note: "'Composed Advisor', British; Q 0.5: 5/4, pilot y" },
  ],
};

/** Callers that aren't in 0.4's flight list (e.g. script line 31's Aeromexico) get a stable hash slot. */
function slotFor(callsign: string): number {
  const i = FLIGHTS.findIndex((f) => f.callsign === callsign);
  if (i >= 0) return i;
  let h = 2166136261;
  for (const ch of callsign) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/**
 * One voice per flight per provider, fixed for the session (PRD §6.2). Flights take the
 * provider's voices round-robin in 0.4's (alphabetical) flight order, so neighbours differ.
 * The generic "station calling Ground" line uses the provider's first voice.
 */
export function voiceFor(callsign: string | null, tts: TtsId): LiveVoice {
  const list = VOICES[providerOf(tts)];
  if (callsign === null) return list[0]!;
  return list[slotFor(callsign) % list.length]!;
}
