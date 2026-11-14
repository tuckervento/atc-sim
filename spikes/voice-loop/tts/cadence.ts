/**
 * Q's controller cadence: words per minute of each recording in test-set/audio/NN.webm, using
 * the word count of the line's `say` text and the speech span of the decoded audio (leading
 * and trailing silence from push-to-talk trimmed). This is the reference for how fast a busy
 * frequency sounds. Recordings are only read.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeToPcm16, speechSpan } from "./audio.ts";
import { median, percentile, SPIKE_DIR, wordCount } from "./common.ts";

export interface ScriptLine {
  num: string;
  say: string;
  readback: string;
}

type ParseScript = (text: string) => ScriptLine[];

/**
 * Uses recorder/script.mjs (task 0.2's parser). It's plain JS with no .d.ts, and recorder/ isn't
 * ours to edit, so it's loaded through a computed URL and typed here.
 */
export async function loadScript(): Promise<ScriptLine[]> {
  const url = pathToFileURL(join(SPIKE_DIR, "recorder", "script.mjs")).href;
  const { parseScript } = (await import(url)) as { parseScript: ParseScript };
  return parseScript(readFileSync(join(SPIKE_DIR, "test-set", "script.md"), "utf8"));
}

export interface CadenceLine {
  num: string;
  words: number;
  totalS: number;
  speechS: number;
  wpm: number;
}

export interface Cadence {
  lines: CadenceLine[];
  medianWpm: number;
  p25Wpm: number;
  p75Wpm: number;
  /** Total words / total speech time: weights long lines more. */
  pooledWpm: number;
}

const CADENCE_RATE = 16_000;

export async function controllerCadence(script: ScriptLine[]): Promise<Cadence> {
  const lines: CadenceLine[] = [];
  for (const line of script) {
    const file = join(SPIKE_DIR, "test-set", "audio", `${line.num}.webm`);
    if (!existsSync(file)) continue;
    const span = speechSpan(await decodeToPcm16(file, CADENCE_RATE), CADENCE_RATE);
    const words = wordCount(line.say);
    lines.push({ num: line.num, words, totalS: span.totalS, speechS: span.speechS, wpm: (words / span.speechS) * 60 });
  }
  if (lines.length === 0) throw new Error("no recordings found in test-set/audio/");
  const wpms = lines.map((l) => l.wpm);
  const words = lines.reduce((sum, l) => sum + l.words, 0);
  const seconds = lines.reduce((sum, l) => sum + l.speechS, 0);
  return {
    lines,
    medianWpm: median(wpms),
    p25Wpm: percentile(wpms, 25),
    p75Wpm: percentile(wpms, 75),
    pooledWpm: (words / seconds) * 60,
  };
}
