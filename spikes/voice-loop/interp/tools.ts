/**
 * Approach B's tools, run locally (no network): flight lookup by spoken callsign, and a
 * name check against the airport's names. Both are deterministic, so a line's tool results
 * depend only on what the model asks.
 *
 * find_flight matching, in order:
 *   1. airline word(s) and flight number both match  -> "exact"
 *   2. the airline matches                           -> "airline" (all that airline's flights)
 *   3. the flight number matches                     -> "number"
 *   4. nothing matches                               -> "none" (every flight on frequency)
 * Airline words match the radio name or ICAO code with a small edit distance (1 for words
 * of up to 5 letters, else 2), so "Qatary" finds Qatari. Numbers use 0.3's normalizer, so
 * "eleven twenty-three", "1123" and "one one two three" are the same.
 */
import { normalize } from "../stt/normalize.ts";
import {
  AIRLINES, RAMPS, RUNWAYS, TAXIWAYS, describeFlight, flightsAt,
} from "./context.ts";

export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}

function closeWord(a: string, b: string): boolean {
  const limit = Math.max(a.length, b.length) <= 5 ? 1 : 2;
  return editDistance(a, b) <= limit;
}

/** ICAO codes of the airlines the spoken words name. */
function airlinesIn(words: string[]): Set<string> {
  const found = new Set<string>();
  for (const a of AIRLINES) {
    const radio = normalize(a.radio);
    const code = a.icao.toLowerCase();
    for (let i = 0; i < words.length; i++) {
      if (words[i] === code) found.add(a.icao);
      const span = words.slice(i, i + radio.length);
      if (span.length === radio.length && span.every((w, k) => closeWord(w, radio[k]!))) found.add(a.icao);
    }
  }
  return found;
}

export function findFlight(num: string, spoken: string): unknown {
  const words = normalize(spoken);
  const digits = words.filter((w) => /^\d$/.test(w)).join("");
  const airlines = airlinesIn(words.filter((w) => !/^\d$/.test(w)));
  const flights = flightsAt(num);
  const split = (cs: string) => /^([A-Z]+)(\d.*)$/.exec(cs)!;
  const exact = flights.filter((f) => airlines.has(split(f.callsign)[1]!) && split(f.callsign)[2] === digits);
  const byAirline = flights.filter((f) => airlines.has(split(f.callsign)[1]!));
  const byNumber = digits === "" ? [] : flights.filter((f) => split(f.callsign)[2] === digits);
  const [match, list] = exact.length ? ["exact", exact]
    : byAirline.length ? ["airline", byAirline]
    : byNumber.length ? ["number", byNumber]
    : ["none", flights];
  return { match, flights: (list as typeof flights).map(describeFlight) };
}

const LETTER_OF: Record<string, string> = {
  alpha: "A", alfa: "A", bravo: "B", charlie: "C", delta: "D", echo: "E", foxtrot: "F", golf: "G", hotel: "H",
  india: "I", juliet: "J", juliett: "J", kilo: "K", lima: "L", mike: "M", november: "N", oscar: "O", papa: "P",
  quebec: "Q", romeo: "R", sierra: "S", tango: "T", uniform: "U", victor: "V", whiskey: "W", xray: "X",
  yankee: "Y", zulu: "Z",
};

/** Spoken or written name -> candidate ID: "Kilo Echo" -> KE, "three one left" -> 31L, "Terminal Four" -> T4. */
function toId(name: string): string {
  const words = normalize(name).filter((w) => !["taxiway", "runway", "ramp", "the"].includes(w));
  let terminal = false;
  let out = "";
  for (const w of words) {
    if (w === "terminal") terminal = true;
    else if (/^\d$/.test(w)) out += w;
    else if (w === "left" || w === "right" || w === "center") out += w[0]!.toUpperCase();
    else if (LETTER_OF[w]) out += LETTER_OF[w];
    else out += w.toUpperCase();
  }
  if (terminal) out = `T${out}`;
  return out.replace(/^0+(?=\d)/, "");
}

export function checkNames(names: unknown): unknown {
  if (!Array.isArray(names)) return { error: "names must be an array of strings" };
  const all = [...TAXIWAYS.map((id) => ({ id, kind: "taxiway" })), ...RUNWAYS.map((id) => ({ id, kind: "runway" })), ...RAMPS.map((id) => ({ id, kind: "ramp" }))];
  return names.map((raw) => {
    const name = String(raw);
    const words = normalize(name);
    if (words.includes("penalty")) return { name, kind: "penalty-box", id: null, note: "unnamed; the sim picks the spot" };
    if (words.includes("pad")) return { name, kind: "pad", id: null, note: "unnamed; the sim picks the pad" };
    const id = toId(name);
    const hit = all.find((n) => n.id === id);
    if (hit) return { name, kind: hit.kind, id: hit.id };
    const closest = all
      .map((n) => ({ ...n, d: editDistance(n.id, id) }))
      .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id))
      .slice(0, 3)
      .map((n) => `${n.id} (${n.kind})`);
    return { name, kind: "unknown", tried: id, closest };
  });
}

/** Run one tool call. Unknown tools and bad arguments return an error object (the model sees it). */
export function runTool(num: string, name: string, input: unknown): unknown {
  const args = (input ?? {}) as Record<string, unknown>;
  if (name === "find_flight") {
    if (typeof args.spoken_callsign !== "string") return { error: "spoken_callsign must be a string" };
    return findFlight(num, args.spoken_callsign);
  }
  if (name === "check_names") return checkNames(args.names);
  return { error: `unknown tool ${name}` };
}
