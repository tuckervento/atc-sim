/**
 * Templated pilot readbacks (PRD §6.2). No AI-generated wording: every word comes from a
 * template here, so it's fast and the phraseology is always well-formed.
 *
 * Rules:
 * - Callsign last ("Hold short Bravo, Delta four.").
 * - Numbers spoken as words, digit by digit as on the radio, with "niner" for 9
 *   ("three one left", "one one niner point one", "two niner niner two"). The output never
 *   contains a digit.
 * - Several wording variants per instruction type, picked by a seeded random number generator
 *   (mulberry32), so a session is reproducible from its seed.
 * - Each flight has a style, terse or chatty, fixed for the session (chosen from a hash of the
 *   seed and the callsign). Chatty pilots get extra variants with "okay", "roger", "thanks".
 *
 * Covers every instruction type in src/sim/commands.ts: taxi (runway, ramp, pad, penalty box),
 * hold-short, hold-position, continue, cross, handoff, correction, atis, say-again,
 * ground-stop, release-time, hold-for-release, expect-delay. Plus the two "didn't understand"
 * lines (PRD §6.1): "say again" with the callsign, and "Station calling Ground, say again".
 */
import type {
  Destination, HoldShortTarget, Instruction, RouteItem, Transmission,
} from "../../../src/sim/commands.ts";

export type Style = "terse" | "chatty";
export type Rng = () => number;

/** mulberry32: small, fast, seeded. Returns [0, 1). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** Fixed per flight for a given session seed. */
export function styleFor(callsign: string, seed: number): Style {
  return fnv(`${seed}:${callsign}`) % 2 === 0 ? "terse" : "chatty";
}

function pick<T>(rng: Rng, options: readonly T[]): T {
  if (options.length === 0) throw new Error("readback.ts: pick() from an empty list");
  return options[Math.floor(rng() * options.length)]!;
}

// ---- spoken forms ----------------------------------------------------------------------

const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];
const PHONETIC: Record<string, string> = {
  A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot", G: "Golf", H: "Hotel",
  I: "India", J: "Juliet", K: "Kilo", L: "Lima", M: "Mike", N: "November", O: "Oscar", P: "Papa",
  Q: "Quebec", R: "Romeo", S: "Sierra", T: "Tango", U: "Uniform", V: "Victor", W: "Whiskey",
  X: "X-ray", Y: "Yankee", Z: "Zulu",
};
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Spoken city for a ground-stop destination; unknown codes are spelled phonetically. */
const CITIES: Record<string, string> = {
  ATL: "Atlanta", BOS: "Boston", LAX: "Los Angeles", MIA: "Miami", SFO: "San Francisco", SEA: "Seattle",
  ORD: "Chicago", DFW: "Dallas", DCA: "Washington", IAD: "Dulles", MCO: "Orlando", FLL: "Fort Lauderdale",
  LAS: "Las Vegas", DEN: "Denver", PHX: "Phoenix", CLT: "Charlotte", LHR: "Heathrow", CDG: "Paris",
  FRA: "Frankfurt", MAD: "Madrid", DUB: "Dublin", AMS: "Amsterdam", DOH: "Doha", ZRH: "Zurich", DXB: "Dubai",
};

export function digitsSpoken(digits: string): string {
  return [...digits].map((d) => {
    const w = DIGITS[Number(d)];
    if (!/\d/.test(d) || w === undefined) throw new Error(`readback.ts: not a digit: ${d}`);
    return w;
  }).join(" ");
}

/** 0-99 as words: 7 "seven", 15 "fifteen", 45 "forty-five". */
export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99) throw new Error(`readback.ts: numberWords needs 0-99, got ${n}`);
  if (n < 20) return ONES[n]!;
  const t = TENS[Math.floor(n / 10)]!;
  return n % 10 === 0 ? t : `${t}-${ONES[n % 10]}`;
}

/** Whole minutes as words, for delays (1-999). 120 is "one hundred twenty". */
function minutesWords(n: number): string {
  if (n < 100) return numberWords(n);
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return rest === 0 ? `${ONES[h]} hundred` : `${ONES[h]} hundred ${numberWords(rest)}`;
}

/** "KE" -> "Kilo Echo", "A10" -> "Alpha one zero", "13" -> "one three". */
export function nameSpoken(id: string): string {
  return [...id].map((ch) => {
    if (/\d/.test(ch)) return DIGITS[Number(ch)]!;
    const w = PHONETIC[ch];
    if (!w) throw new Error(`readback.ts: can't speak name character '${ch}' in '${id}'`);
    return w;
  }).join(" ");
}

/** "31L" -> "three one left", "4R" -> "four right", "13" -> "one three". */
export function runwaySpoken(rwy: string): string {
  const m = /^(\d{1,2})([LCR]?)$/.exec(rwy);
  if (!m) throw new Error(`readback.ts: bad runway '${rwy}'`);
  const side = { L: " left", C: " center", R: " right", "": "" }[m[2] as "L" | "C" | "R" | ""];
  return `${digitsSpoken(m[1]!)}${side}`;
}

/** "119.1" -> "one one niner point one". */
export function frequencySpoken(freq: string): string {
  const [whole, frac] = freq.split(".");
  if (!whole || !/^\d+$/.test(whole) || (frac !== undefined && !/^\d+$/.test(frac))) throw new Error(`readback.ts: bad frequency '${freq}'`);
  return frac === undefined ? digitsSpoken(whole) : `${digitsSpoken(whole)} point ${digitsSpoken(frac)}`;
}

/** "14:52" -> "one four five two" (digits) or "fourteen fifty-two" (words). */
function timeSpoken(time: string, rng: Rng): string {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) throw new Error(`readback.ts: bad time '${time}'`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return pick(rng, [
    digitsSpoken(`${m[1]}${m[2]}`),
    mm === 0 ? `${numberWords(hh)} hundred` : mm < 10 ? `${numberWords(hh)} oh ${numberWords(mm)}` : `${numberWords(hh)} ${numberWords(mm)}`,
  ]);
}

function citySpoken(code: string): string {
  return CITIES[code] ?? nameSpoken(code);
}

function targetSpoken(t: HoldShortTarget, rng: Rng): string {
  if (t.kind === "taxiway") return nameSpoken(t.name);
  return pick(rng, [runwaySpoken(t.name), `runway ${runwaySpoken(t.name)}`]);
}

function targetsSpoken(ts: HoldShortTarget[], rng: Rng): string {
  const words = ts.map((t) => targetSpoken(t, rng));
  if (words.length === 1) return words[0]!;
  const last = words[words.length - 1]!;
  const head = words.slice(0, -1).join(", ");
  return pick(rng, [`${head} and ${last}`, `${head}, then ${last}`]);
}

function routeItemSpoken(r: RouteItem, rng: Rng): string {
  const n = nameSpoken(r.taxiway);
  if (r.turn === null) return n;
  return pick(rng, [`${r.turn} ${n}`, `${r.turn} on ${n}`]);
}

function routeSpoken(via: RouteItem[], rng: Rng): string {
  return via.map((r) => routeItemSpoken(r, rng)).join(", ");
}

/** Destination as a noun phrase ("three one left", "the Terminal Four ramp", "the pad"). */
function destSpoken(d: Destination, rng: Rng): string {
  switch (d.kind) {
    case "runway": return pick(rng, [runwaySpoken(d.name), `runway ${runwaySpoken(d.name)}`]);
    case "ramp": return d.name === null ? "the ramp" : rampName(d.name);
    case "pad": return d.name === null ? "the pad" : `pad ${nameSpoken(d.name)}`;
    case "penalty-box": return d.name === null ? "the penalty box" : `the penalty box ${nameSpoken(d.name)}`;
  }
}

/** "T4" -> "the Terminal Four ramp". */
function rampName(id: string): string {
  const m = /^T(\d+)$/.exec(id);
  if (m) return `the Terminal ${cap(numberWords(Number(m[1])))} ramp`;
  return `the ${nameSpoken(id)} ramp`;
}

function holdsClause(ts: HoldShortTarget[], rng: Rng): string {
  return ts.length === 0 ? "" : `, hold short ${targetsSpoken(ts, rng)}`;
}

// ---- per instruction -------------------------------------------------------------------

function taxiPhrase(i: Extract<Instruction, { type: "taxi" }>, style: Style, rng: Rng): string {
  const route = routeSpoken(i.via, rng);
  const holds = holdsClause(i.holdShort, rng);
  const dest = destSpoken(i.to, rng);
  const bareDest = dest.replace(/^the /, "");
  const terse = i.to.kind === "runway"
    ? [`${dest}, ${route}${holds}`, `${route} to ${dest}${holds}`, `taxi ${dest} via ${route}${holds}`]
    : [`${bareDest} via ${route}${holds}`, `${route} to ${dest}${holds}`, `${route}, ${dest}${holds}`];
  const chatty = i.to.kind === "runway"
    ? [`okay, ${dest} via ${route}${holds}`, `${dest}, taxi via ${route}${holds}`, `alright, ${route}, ${dest}${holds}`]
    : [`okay, ${route} to ${dest}${holds}`, `roger, ${bareDest} via ${route}${holds}`, `${route} over to ${dest}${holds}`];
  return pick(rng, style === "terse" ? terse : [...terse, ...chatty]);
}

function crossPhrase(runways: string[], at: string | null, rng: Rng): string {
  const rw = runways.map(runwaySpoken).join(" and ");
  const where = at === null ? "" : ` at ${nameSpoken(at)}`;
  return pick(rng, [`cross ${rw}${where}`, `crossing ${rw}${where}`]);
}

function correctionPhrase(i: Extract<Instruction, { type: "correction" }>, style: Style, rng: Rng): string {
  const parts: string[] = [];
  if (i.to) parts.push(destSpoken(i.to, rng));
  if (i.via) parts.push(routeSpoken(i.via, rng));
  for (const t of i.turns) parts.push(pick(rng, [`${t.turn} on ${nameSpoken(t.taxiway)}`, `${t.turn} turn on ${nameSpoken(t.taxiway)}`]));
  if (i.holdShort) parts.push(`hold short ${targetsSpoken(i.holdShort, rng)}`);
  if (i.cross) parts.push(crossPhrase(i.cross.runways, i.cross.at, rng));
  const body = parts.join(", ");
  const lead = style === "terse" ? ["", "correction, "] : ["", "correction, ", "sorry about that, ", "my mistake, "];
  return `${pick(rng, lead)}${body}`;
}

function handoffPhrase(i: Extract<Instruction, { type: "handoff" }>, style: Style, rng: Rng): string {
  const freq = i.frequency === null ? "" : ` ${frequencySpoken(i.frequency)}`;
  const options = [`${i.mode} ${i.facility}${freq}`, `over to ${i.facility}${freq}`];
  if (i.mode === "contact") options.push(`switching to ${i.facility}${freq}`);
  if (style === "chatty") options.push(`${i.mode} ${i.facility}${freq}, so long`, `over to ${i.facility}${freq}, good day`);
  return pick(rng, options);
}

function phrase(i: Instruction, style: Style, rng: Rng): string {
  const chatty = style === "chatty";
  switch (i.type) {
    case "taxi": return taxiPhrase(i, style, rng);
    case "hold-short": return `hold short ${targetSpoken(i.target, rng)}`; // merged in readbackText
    case "hold-position": return pick(rng, chatty ? ["holding position", "okay, holding", "stopping, holding position"] : ["holding position", "hold position", "holding"]);
    case "continue": return pick(rng, chatty ? ["continuing, thanks", "okay, moving", "continuing"] : ["continuing", "continue taxi", "continue"]);
    case "cross": return `${chatty ? pick(rng, ["", "okay, "]) : ""}${crossPhrase(i.runways, i.at, rng)}`;
    case "handoff": return handoffPhrase(i, style, rng);
    case "correction": return correctionPhrase(i, style, rng);
    case "atis": {
      const letter = PHONETIC[i.letter];
      if (!letter) throw new Error(`readback.ts: bad ATIS letter '${i.letter}'`);
      const alt = i.altimeter === null ? "" : `, ${digitsSpoken(i.altimeter)}`;
      return pick(rng, chatty ? [`copy ${letter}${alt}`, `have ${letter} now${alt}`, `okay, ${letter}${alt}`] : [`${letter}${alt}`, `copy ${letter}${alt}`, `have ${letter}${alt}`]);
    }
    case "say-again": throw new Error("readback.ts: say-again is answered with a repeat, not a phrase");
    case "ground-stop": {
      const city = citySpoken(i.destination);
      return pick(rng, chatty ? [`copy the ground stop for ${city}`, `okay, ground stop ${city}`, `ground stop ${city}`] : [`ground stop ${city}`, `copy ground stop ${city}`]);
    }
    case "release-time": {
      const t = timeSpoken(i.time, rng);
      return pick(rng, chatty ? [`okay, release time ${t}`, `copy, release ${t}`] : [`release ${t}`, `${t} release`]);
    }
    case "hold-for-release": return pick(rng, chatty ? ["copy, hold for release", "okay, holding for release"] : ["hold for release", "holding for release"]);
    case "expect-delay": {
      const n = pick(rng, [minutesWords(i.minutes), i.minutes < 100 ? digitsSpoken(String(i.minutes)) : minutesWords(i.minutes)]);
      return pick(rng, chatty ? [`copy, about ${n} minutes`, `okay, ${n} minutes`, `expect ${n} minutes`] : [`${n} minutes`, `expect ${n} minutes`]);
    }
  }
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function finish(body: string, callsignSpoken: string): string {
  return `${cap(body)}, ${callsignSpoken}.`;
}

// ---- public ----------------------------------------------------------------------------

export interface ReadbackInput {
  command: Transmission;
  /** The addressed flight's spoken callsign, e.g. "Emirates two zero two heavy". */
  callsignSpoken: string;
  style: Style;
  rng: Rng;
  /** What the pilot says when asked to say again: their last call, in full. */
  repeat: string | null;
}

/**
 * The readback for a valid, addressed command. Consecutive hold-shorts are read back together
 * ("hold short Bravo and three one right"). A say-again is answered by repeating the last
 * call (any other instructions in the same transmission are read back first).
 */
export function readbackText(input: ReadbackInput): string {
  const { command, callsignSpoken, style, rng } = input;
  if (command.callsign === null) throw new Error("readback.ts: unknown-station transmissions are answered by the caller's repeat");
  const ins = command.instructions as Instruction[];
  const parts: string[] = [];
  let sayAgain = false;
  for (let k = 0; k < ins.length; k++) {
    const cur = ins[k]!;
    if (cur.type === "say-again") {
      sayAgain = true;
      continue;
    }
    if (cur.type === "hold-short") {
      const targets: HoldShortTarget[] = [];
      while (k < ins.length && ins[k]!.type === "hold-short") {
        targets.push((ins[k] as Extract<Instruction, { type: "hold-short" }>).target);
        k++;
      }
      k--;
      const lead = style === "chatty" ? pick(rng, ["", "okay, ", "roger, "]) : "";
      parts.push(`${lead}${pick(rng, ["hold short", "holding short"])} ${targetsSpoken(targets, rng)}`);
      continue;
    }
    parts.push(phrase(cur, style, rng));
  }
  if (sayAgain) {
    const repeat = input.repeat ?? `Ground, ${callsignSpoken}, go ahead.`;
    return parts.length === 0 ? repeat : `${finish(parts.join(", "), callsignSpoken)} ${repeat}`;
  }
  return finish(parts.join(", "), callsignSpoken);
}

/** "Say again" from the addressed pilot, when the game couldn't work out the instruction. */
export function sayAgainText(callsignSpoken: string, rng: Rng): string {
  return pick(rng, [`Say again for ${callsignSpoken}.`, `Say again, ${callsignSpoken}.`, `Sorry, say again for ${callsignSpoken}.`]);
}

/** When the game can't work out who was addressed (PRD §6.1). */
export const GENERIC_SAY_AGAIN = "Station calling Ground, say again.";
