/**
 * Transcript sets fed to the interpreter. Each line's expected command and game context are
 * the same in every set; only the transcript changes.
 * - perfect: the script's `say` text
 * - u36pro / nova3: the final transcripts 0.3 saved for AssemblyAI Universal-3.6 Pro and
 *   Deepgram Nova-3 (the two it recommended)
 * - perturbed: hand-made mishearings, mostly ones 0.3 actually saw from some candidate, put
 *   into the line's `say` text. They test fixing callsigns and names from context.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPIKE_DIR } from "../stt/env.ts";
import type { ScriptLine } from "../stt/script.ts";

export const INPUTS = ["perfect", "u36pro", "nova3", "perturbed"] as const;
export type InputName = (typeof INPUTS)[number];

export const INPUT_LABELS: Record<InputName, string> = {
  perfect: "perfect (script text)",
  u36pro: "Universal-3.6 Pro",
  nova3: "Nova-3",
  perturbed: "perturbed",
};

const STT_FILES: Partial<Record<InputName, string>> = {
  u36pro: "assemblyai-universal-3-6-pro.json",
  nova3: "deepgram-nova-3.json",
};

/** Each entry: the script line, the misheard transcript, and where the mishearing came from. */
export const PERTURBED: ReadonlyArray<{ num: string; text: string; source: string }> = [
  { num: "01", text: "Delta for, runway three one left, taxi via Alpha, right on Kilo Echo, hold short of Bravo.", source: "PLAN 0.4's example; DAL40 'Delta forty' is also on frequency" },
  { num: "05", text: "The tons are four zero five heavy, left on Alpha, right on Kilo Echo, three one left, hold short three one right, then hold short Kilo.", source: "Flux, 0.3 ('The tons are four zero five' for Lufthansa)" },
  { num: "06", text: "Delta thirty twenty-three forty, information Papa is current, altimeter two niner niner two, runway three one left, Alpha, Kilo Delta, hold short Bravo.", source: "gpt-transcribe, 0.3" },
  { num: "09", text: "JetBlue three eighty-seven, alright, Kilo Foxtrot, red on Alpha into the ramp, and monitor right when you get there.", source: "Universal-Streaming English, 0.3 ('red on', 'monitor right')" },
  { num: "11", text: "Alaska men are three, hold short of runway four right.", source: "Flux, 0.3 (niner)" },
  { num: "13", text: "Iberia has six twenty six heavy, hold short of Bravo, you'll have a Delta seven sixty-seven passing left to right.", source: "Flux, 0.3" },
  { num: "16", text: "Speedbird one seven five heavy, stop, stop hold short.", source: "gpt-live-transcribe, 0.3 (hold position heard as hold short, no target)" },
  { num: "17", text: "Delta four, cross one way three one right at Kilo Echo.", source: "Nova-3, Flux and Universal-Streaming English, 0.3" },
  { num: "18", text: "Swiss won seven hui, go ahead and cross two two right at Yankee, then old short of Bravo.", source: "Flux, 0.3 ('Swiss won seven hui', 'old short')" },
  { num: "19", text: "Qatary seven zero one heavy, at Kilo Echo, cross three one right, then Kilo to three one left.", source: "gpt-live-transcribe, 0.3" },
  { num: "21", text: "Delta twelver for, bad news, ground stop for Atlanta, take the next right at Kilo Charlie and head over to the penalty box.", source: "Flux, 0.3" },
  { num: "22", text: "JetBlue six one five, release time one four five two for you, taxi to the pad via Alpha, Kilo, Kilo, and zip type.", source: "Universal-3.6 Pro ('Kilo, Kilo') and Nova-3 ('zip type'), 0.3" },
];

/** Transcripts for one input set, by line number. Fails loudly on a missing transcript. */
export function loadInput(name: InputName, script: ScriptLine[]): Map<string, string> {
  if (name === "perfect") return new Map(script.map((l) => [l.num, l.say]));
  if (name === "perturbed") {
    for (const p of PERTURBED) {
      if (!script.some((l) => l.num === p.num)) throw new Error(`inputs.ts: perturbed line ${p.num} isn't in script.md`);
    }
    return new Map(PERTURBED.map((p) => [p.num, p.text]));
  }
  const file = join(SPIKE_DIR, "results", "stt", STT_FILES[name]!);
  const data = JSON.parse(readFileSync(file, "utf8")) as { lines: Array<{ num: string; transcript: string | null }> };
  const out = new Map<string, string>();
  for (const l of script) {
    const entry = data.lines.find((e) => e.num === l.num);
    if (!entry || typeof entry.transcript !== "string" || entry.transcript.trim() === "") {
      throw new Error(`inputs.ts: ${file} has no transcript for line ${l.num}`);
    }
    out.set(l.num, entry.transcript);
  }
  return out;
}
