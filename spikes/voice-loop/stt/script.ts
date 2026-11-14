/**
 * Load test-set/script.md with the shared parser in recorder/script.mjs (task 0.2).
 * That file is plain JS with no type declarations, and recorder/ belongs to 0.2, so it's
 * imported through a computed URL (typed here) rather than a static import.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SPIKE_DIR } from "./env.ts";

export interface ScriptLine {
  num: string;
  types: string[];
  style: string;
  context: string | null;
  say: string;
  readback: string;
  expected: string;
}

export const SCRIPT_PATH = join(SPIKE_DIR, "test-set", "script.md");
export const AUDIO_DIR = join(SPIKE_DIR, "test-set", "audio");

export async function loadScript(): Promise<ScriptLine[]> {
  const parserUrl = pathToFileURL(join(SPIKE_DIR, "recorder", "script.mjs")).href;
  const mod = (await import(parserUrl)) as { parseScript: (text: string) => ScriptLine[] };
  return mod.parseScript(readFileSync(SCRIPT_PATH, "utf8"));
}
