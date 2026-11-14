/** Paths shared by the live loop's scripts. */
import { join } from "node:path";
import { SPIKE_DIR } from "../stt/env.ts";

export const LIVE_DIR = join(SPIKE_DIR, "live");
/** Q's captured audio (gitignored: spikes/voice-loop/live/audio/). */
export const LIVE_AUDIO_DIR = join(LIVE_DIR, "audio");
export const LIVE_RESULTS_DIR = join(SPIKE_DIR, "results", "live");
/** Every paid request in 0.6 appends its estimated cost here (same format as the benches). */
export const SPEND_LOG = join(LIVE_RESULTS_DIR, "spend-log.jsonl");
