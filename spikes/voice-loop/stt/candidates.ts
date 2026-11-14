/**
 * The six speech-to-text candidates from docs/spikes/voice-loop.md § Shortlist, with the
 * shortlist's prices (read 2026-11-14 from each provider's pricing page) and runners.
 */
import { runOpenAi, OPENAI_RATE, openAiTranscriptionConfig } from "./openai.ts";
import { runNova, runFlux, DEEPGRAM_RATE, FLUX_DEFAULT_PAD_MS } from "./deepgram.ts";
import { runAssembly, ASSEMBLYAI_RATE } from "./assemblyai.ts";
import type { ClipAudio, ClipRun, RunOptions } from "./types.ts";
import { VOCAB } from "./vocab.ts";

export type ProviderName = "openai" | "deepgram" | "assemblyai";

export interface Pricing {
  /** "audio": billed on audio sent. "session": billed on WebSocket open time. */
  basis: "audio" | "session";
  /** USD per minute of the billed quantity, including keyterm add-ons. */
  perMin: number;
  /** List price per minute where the shortlist shows a promo price. */
  listPerMin?: number;
  note: string;
}

export interface Candidate {
  id: string;
  provider: ProviderName;
  model: string;
  sampleRate: number;
  pricing: Pricing;
  /** What's sent, for the record (never includes keys). */
  describeConfig: (opts: Map<string, string>) => Record<string, unknown>;
  run: (audio: ClipAudio, opts: RunOptions) => Promise<ClipRun>;
}

const vocabNote = { vocabTerms: VOCAB.length };

export const CANDIDATES: Candidate[] = [
  {
    id: "openai-gpt-live-transcribe",
    provider: "openai",
    model: "gpt-live-transcribe",
    sampleRate: OPENAI_RATE,
    pricing: { basis: "audio", perMin: 0.017, note: "$0.017/min" },
    describeConfig: (opts) => ({ ...vocabNote, transcription: { ...openAiTranscriptionConfig("gpt-live-transcribe", opts), keywords: `[${VOCAB.length} terms]` } }),
    run: (audio, opts) => runOpenAi("gpt-live-transcribe", audio, opts),
  },
  {
    id: "openai-gpt-transcribe",
    provider: "openai",
    model: "gpt-transcribe",
    sampleRate: OPENAI_RATE,
    pricing: { basis: "audio", perMin: 0.0045, note: "$0.0045/min" },
    describeConfig: (opts) => ({ ...vocabNote, transcription: { ...openAiTranscriptionConfig("gpt-transcribe", opts), keywords: `[${VOCAB.length} terms]` } }),
    run: (audio, opts) => runOpenAi("gpt-transcribe", audio, opts),
  },
  {
    id: "deepgram-nova-3",
    provider: "deepgram",
    model: "nova-3",
    sampleRate: DEEPGRAM_RATE,
    pricing: {
      basis: "audio",
      perMin: 0.0048 + 0.0013,
      listPerMin: 0.0077 + 0.0013,
      note: "$0.0048/min promo (list $0.0077) + keyterms $0.0013/min",
    },
    describeConfig: () => ({ ...vocabNote, endpoint: "/v1/listen", model: "nova-3", language: "en", interim_results: true, endOfTurn: "Finalize" }),
    run: (audio, opts) => runNova("nova-3", audio, opts),
  },
  {
    id: "deepgram-flux-general-en",
    provider: "deepgram",
    model: "flux-general-en",
    sampleRate: DEEPGRAM_RATE,
    pricing: {
      basis: "audio",
      perMin: 0.0065 + 0.0013,
      listPerMin: 0.0077 + 0.0013,
      note: "$0.0065/min promo (list $0.0077) + keyterms $0.0013/min (assumed to apply)",
    },
    describeConfig: (opts) => ({ ...vocabNote, endpoint: "/v2/listen", model: "flux-general-en", eot_threshold: 1.0, endOfTurn: "ForceEndTurn", silencePadMs: Number(opts.get("pad_ms") ?? FLUX_DEFAULT_PAD_MS) }),
    run: (audio, opts) => runFlux("flux-general-en", audio, opts),
  },
  {
    id: "assemblyai-universal-streaming-english",
    provider: "assemblyai",
    model: "universal-streaming-english",
    sampleRate: ASSEMBLYAI_RATE,
    pricing: { basis: "session", perMin: (0.15 + 0.04) / 60, note: "$0.15/hr + $0.04/hr keyterms, on session time" },
    describeConfig: () => ({ ...vocabNote, speech_model: "universal-streaming-english", format_turns: false, min_turn_silence: 5000, max_turn_silence: 5000, endOfTurn: "Terminate" }),
    run: (audio, opts) => runAssembly("universal-streaming-english", audio, opts),
  },
  {
    id: "assemblyai-universal-3-6-pro",
    provider: "assemblyai",
    model: "universal-3-6-pro",
    sampleRate: ASSEMBLYAI_RATE,
    pricing: { basis: "session", perMin: 0.45 / 60, note: "$0.45/hr including keyterms, on session time" },
    describeConfig: () => ({ ...vocabNote, speech_model: "universal-3-6-pro", min_turn_silence: 5000, max_turn_silence: 5000, endOfTurn: "ForceEndpoint" }),
    run: (audio, opts) => runAssembly("universal-3-6-pro", audio, opts),
  },
];

/** Peak assumption (PLAN Context / § Cost at peak): 450 transmissions/hr x 4 s = 30 min of audio. */
export const PEAK_AUDIO_MIN_PER_HR = 30;

export interface PeakCost {
  /** $/hr at the promo/current rate. Session basis: one session per transmission, session = audio. */
  low: number;
  /** Session basis: one session open all hour. Audio basis: the list rate if there is one. */
  high: number | null;
  /** Session basis: one session per transmission, scaled by measured session/audio time. */
  measured: number | null;
}

export function peakCost(p: Pricing, measuredSessionPerAudio: number | null): PeakCost {
  if (p.basis === "audio") {
    return { low: PEAK_AUDIO_MIN_PER_HR * p.perMin, high: p.listPerMin ? PEAK_AUDIO_MIN_PER_HR * p.listPerMin : null, measured: null };
  }
  return {
    low: PEAK_AUDIO_MIN_PER_HR * p.perMin,
    high: 60 * p.perMin,
    measured: measuredSessionPerAudio === null ? null : PEAK_AUDIO_MIN_PER_HR * p.perMin * measuredSessionPerAudio,
  };
}
