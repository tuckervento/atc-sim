/**
 * Spend estimates and the --max-spend guard for 0.6. Every paid request appends to
 * results/live/spend-log.jsonl (the same ledger format as the benches, stt/results.ts).
 *
 * Prices (docs/spikes/voice-loop.md § Shortlist, read 2026-11-14), list rates where there's a
 * promo, to stay conservative:
 * - Deepgram Nova-3: $0.0077/min list + $0.0013/min keyterms, on audio sent.
 * - AssemblyAI Universal-3.6 Pro: $0.45/hr on session time (open time).
 * - gpt-6-luna: interp/openai.ts OPENAI_PRICING, from measured tokens.
 * - ElevenLabs Flash v2.5: $0.04 per 1K characters (pay-as-you-go; Starter credits in practice).
 * - Cartesia sonic-3.6: $65 per 1M characters (Pro overage; plan credits in practice).
 */
import { appendSpend, spendTotal } from "../stt/results.ts";
import { USD_PER_CHAR as ELEVEN_USD_PER_CHAR } from "../tts/elevenlabs.ts";
import { USD_PER_CHAR as CARTESIA_USD_PER_CHAR } from "../tts/cartesia.ts";
import { SPEND_LOG } from "./paths.ts";
import type { TtsProvider } from "./voices.ts";

export const NOVA_USD_PER_MIN = 0.0077 + 0.0013;
export const ASSEMBLY_USD_PER_SEC = 0.45 / 3600;
export const TTS_USD_PER_CHAR: Record<TtsProvider, number> = { elevenlabs: ELEVEN_USD_PER_CHAR, cartesia: CARTESIA_USD_PER_CHAR };

/** Upper bound for one transmission (8 s audio, one interp call, 150 characters), for the guard. */
export const TRANSMISSION_CEILING_USD = 0.02;

export function record(what: string, usd: number, billedMin = 0): void {
  if (!(usd >= 0)) throw new Error(`spend.ts: bad amount ${usd} for ${what}`);
  appendSpend(SPEND_LOG, { at: new Date().toISOString(), candidate: what, lines: 1, billedMin, estUsd: usd });
}

export function spent(): number {
  return spendTotal(SPEND_LOG);
}

/** null if there's room for one more transmission, else the reason to refuse. */
export function overCap(maxSpend: number, pendingUsd: number): string | null {
  const s = spent();
  if (s + pendingUsd + TRANSMISSION_CEILING_USD > maxSpend) {
    return `spend cap: logged $${s.toFixed(4)} + open sessions $${pendingUsd.toFixed(4)} + up to $${TRANSMISSION_CEILING_USD} for this transmission would pass --max-spend $${maxSpend}`;
  }
  return null;
}
