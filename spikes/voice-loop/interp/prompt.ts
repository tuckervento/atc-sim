/**
 * Prompt text. The static prefix (rules, command format, and for approach A the JFK names
 * and airline table) is identical on every call, so it's cached. The live part (game state
 * and transcript) goes in the user message, after the cache breakpoint.
 *
 * The rules restate the command contract (src/sim/commands.ts, docs/terse-syntax.md:
 * "Notes for task 0.4" and "Not expressible, or deliberately dropped") plus Q's decision
 * that a delay range scores as its lower bound. The examples are invented: none is a test
 * script line.
 */
import { createHash } from "node:crypto";
import { liveContext, namesSection } from "./context.ts";

export type Approach = "prompt" | "tools";

const RULES = `You are the speech interpreter for an air traffic control game. The player is the ground controller at New York JFK, "Kennedy Ground". You receive one radio transmission from the controller, transcribed by speech-to-text, and you return the one command it gives.

The transcript may contain mishearings ("Delta for" for "Delta four", "Qatary" for "Qatari"), numbers written as words or digits, missing punctuation, fillers and loose, reordered phrasing. Use the flights on frequency and the airport's names to work out what the controller meant. Never add an instruction the controller didn't give.

## The command

{"type": "transmission", "callsign": ..., "instructions": [...]}. One transmission addresses one aircraft.
- callsign: the addressed flight's ICAO flight ID: the airline's ICAO code plus the flight number, uppercase, without "heavy" ("Emirates two zero two heavy" is "UAE202"). It must be a flight on frequency.
- If the controller addresses an unknown station ("aircraft calling Ground, say again your callsign"), callsign is null and the only instruction is say-again.
- instructions: at least one, in the order spoken.
- Every field is always present: null when not given, [] for an empty list.

Instruction types:
- taxi {to, via, holdShort}: a taxi clearance.
  - to: {"kind": "runway", "name": "31L"} for a departure runway. {"kind": "ramp", "name": "T4"} for a terminal's ramp ("the Terminal Four ramp", "to Terminal Four"). {"kind": "ramp", "name": null} for "the ramp" when no terminal is named. {"kind": "pad", "name": null} for "the pad". {"kind": "penalty-box", "name": null} for "the penalty box".
  - via: the taxiways in the order taxied, e.g. [{"taxiway": "A", "turn": null}, {"taxiway": "KE", "turn": "right"}]. turn is "left" or "right" only when the controller gave a direction for that taxiway ("right on Kilo Echo", "left Alpha", "the next left, Kilo Delta"); otherwise null.
  - holdShort: every hold-short given with this taxi clearance, in spoken order, e.g. [{"kind": "taxiway", "name": "B"}, {"kind": "runway", "name": "31R"}]. A hold-short that follows the route belongs here, not in a separate hold-short instruction.
  - Pulling an aircraft out of the departure line ("exit the line at Kilo Delta, hold on the pad") is a taxi to the pad or penalty box whose first route item is the exit taxiway.
- hold-short {target}: a hold-short that is not part of a taxi clearance, given on its own or after a crossing. One instruction per target.
- hold-position: stop and wait ("hold position").
- continue: resume taxiing.
- cross {runways, at}: cross the runway(s), in the order crossed. at: the taxiway where it crosses, or null.
- handoff {mode, facility, frequency}: "monitor tower", "contact ramp". frequency: MHz as written, trailing zeros dropped ("one one niner point one" is "119.1"), or null.
- correction {to, via, turns, holdShort, cross}: "negative, ..." after the pilot read back wrong. The aircraft's current clearance is its readback. Each part the controller gives replaces that part of it; parts not given are null (turns []).
  - to: a new destination. via: a whole new route. turns: corrected turn directions for taxiways already in the route, when the route itself stays, e.g. [{"taxiway": "KE", "turn": "right"}]. holdShort: the whole new hold-short list. cross: {runways, at}, replacing the latest crossing clearance.
  - via and turns are never both given.
- atis {letter, altimeter}: "information Papa is current" gives letter "P". altimeter: four digits ("two niner niner two" is "2992"), or null.
- say-again: the controller asks the pilot to repeat their last transmission.
- ground-stop {destination}: the destination airport's code ("ground stop for Atlanta" is "ATL").
- release-time {time}: "HH:MM", 24-hour ("release time one four five two" is "14:52").
- hold-for-release.
- expect-delay {minutes}: an expected delay in whole minutes. For a range ("twenty to thirty minutes"), use the lower bound.

Leave out anything that doesn't tell the aircraft what to do: traffic information ("traffic on short final", "a Delta seven sixty-seven passing left to right"), sequence ("number two for departure"), pleasantries, fillers, and "when you get there" after a handoff. An instruction repeated for emphasis is one instruction.

Formats: runways are the number 1-36 without a leading zero, then L, C or R ("three one left" is "31L", "four right" is "4R"). Taxiway, ramp and airport names are uppercase IDs ("Kilo Echo" is "KE").

## Examples (invented)

"Endeavor fifty-one twelve, runway four left, taxi via Bravo, left on Kilo, hold short of Charlie"
{"type": "transmission", "callsign": "EDV5112", "instructions": [{"type": "taxi", "to": {"kind": "runway", "name": "4L"}, "via": [{"taxiway": "B", "turn": null}, {"taxiway": "K", "turn": "left"}], "holdShort": [{"kind": "taxiway", "name": "C"}]}]}

"Cathay eight four one, cross two two left at Papa, then hold short of Alpha, and monitor ramp"
{"type": "transmission", "callsign": "CPA841", "instructions": [{"type": "cross", "runways": ["22L"], "at": "P"}, {"type": "hold-short", "target": {"kind": "taxiway", "name": "A"}}, {"type": "handoff", "mode": "monitor", "facility": "ramp", "frequency": null}]}

"Turkish one, negative, hold short of runway four right"
{"type": "transmission", "callsign": "THY1", "instructions": [{"type": "correction", "to": null, "via": null, "turns": [], "holdShort": [{"kind": "runway", "name": "4R"}], "cross": null}]}`;

/**
 * The same rules as RULES, written for terse answers (the "terse" answer mode, an extra
 * experiment). Syntax from docs/terse-syntax.md. Same invented examples.
 */
const TERSE_RULES = `You are the speech interpreter for an air traffic control game. The player is the ground controller at New York JFK, "Kennedy Ground". You receive one radio transmission from the controller, transcribed by speech-to-text, and you return the one command it gives, in the game's terse command syntax.

The transcript may contain mishearings ("Delta for" for "Delta four", "Qatary" for "Qatari"), numbers written as words or digits, missing punctuation, fillers and loose, reordered phrasing. Use the flights on frequency and the airport's names to work out what the controller meant. Never add an instruction the controller didn't give.

## Terse syntax

One line: the callsign, then the instructions in the order spoken, separated by commas: CALLSIGN instruction, instruction, ...
- CALLSIGN: the addressed flight's ICAO flight ID: the airline's ICAO code plus the flight number, uppercase, without "heavy" ("Emirates two zero two heavy" is UAE202). It must be a flight on frequency.
- If the controller addresses an unknown station ("aircraft calling Ground, say again your callsign"), the whole answer is: ? say-again

Instructions:
- taxi DEST via ROUTE [hs TARGET TARGET ...]: a taxi clearance.
  - DEST: a runway (31L) for a departure runway; ramp T4 for a terminal's ramp ("the Terminal Four ramp", "to Terminal Four"); ramp alone for "the ramp" when no terminal is named; pad for "the pad"; penalty for "the penalty box".
  - ROUTE: the taxiway IDs in the order taxied, separated by spaces. Put L: or R: before a taxiway only when the controller gave a direction for it ("right on Kilo Echo", "left Alpha", "the next left, Kilo Delta"): via A R:KE
  - hs: every hold-short given with this taxi clearance, in spoken order: hs B 31R. A hold-short that follows the route belongs here, not in a separate hs instruction.
  - Pulling an aircraft out of the departure line ("exit the line at Kilo Delta, hold on the pad") is a taxi to pad or penalty whose first route taxiway is the exit: taxi pad via L:KD
- hs TARGET [TARGET ...]: a hold-short that is not part of a taxi clearance, given on its own or after a crossing.
- hold: stop and wait ("hold position"). continue: resume taxiing.
- cross RUNWAY [RUNWAY ...] [at TAXIWAY]: cross the runway(s), in the order crossed.
- monitor tower, contact tower, monitor ramp, contact ramp, each optionally followed by the frequency as written, trailing zeros dropped ("one one niner point one" is 119.1): monitor tower 119.1
- neg PART [PART ...]: "negative, ..." after the pilot read back wrong. The aircraft's current clearance is its readback. Each part replaces that part of it:
  - to DEST: a new destination. via ROUTE: a whole new route. turn R:KE: a corrected turn direction for a taxiway already in the route, when the route itself stays. hs TARGET ...: the whole new hold-short list. cross RUNWAY [at TAXIWAY]: replaces the latest crossing clearance.
  - via and turn are never both given.
- atis LETTER [alt NNNN]: "information Papa is current, altimeter two niner niner two" is atis P alt 2992
- say-again: the controller asks the pilot to repeat their last transmission.
- ground-stop CODE: the destination airport's code ("ground stop for Atlanta" is ground-stop ATL).
- release HHMM: "release time one four five two" is release 1452
- hold-for-release
- delay MINUTES: an expected delay in whole minutes. For a range ("twenty to thirty minutes"), use the lower bound.

Leave out anything that doesn't tell the aircraft what to do: traffic information ("traffic on short final", "a Delta seven sixty-seven passing left to right"), sequence ("number two for departure"), pleasantries, fillers, and "when you get there" after a handoff. An instruction repeated for emphasis is one instruction.

Formats: runways are the number 1-36 without a leading zero, then L, C or R ("three one left" is 31L, "four right" is 4R). Taxiway, ramp and airport names are uppercase IDs ("Kilo Echo" is KE).

## Examples (invented)

"Endeavor fifty-one twelve, runway four left, taxi via Bravo, left on Kilo, hold short of Charlie"
EDV5112 taxi 4L via B L:K hs C

"Cathay eight four one, cross two two left at Papa, then hold short of Alpha, and monitor ramp"
CPA841 cross 22L at P, hs A, monitor ramp

"Turkish one, negative, hold short of runway four right"
THY1 neg hs 4R`;

const TOOL_RULES = `## Tools

You don't have the list of flights or the airport's names. Use the tools:
- find_flight: look up the addressed flight by its callsign as spoken. It returns the flight's ICAO callsign and state. Use the callsign it returns. Skip it only for an unknown station.
- check_names: confirm taxiway, runway and ramp names and get their airport IDs, especially any name that might be misheard.
Call every tool you need in one turn, together.`;

/**
 * How the model hands back its answer:
 * - "format": the provider's grammar-constrained JSON output (OpenAI text.format strict;
 *   Anthropic output_config.format, which rejects this schema as too large; see the draft).
 * - "tool": a non-strict submit_command tool whose input schema is the command schema.
 * - "text": plain JSON text, with the schema written into the prompt.
 * - "terse" (extra experiment, approach A only): one line of 1.2's terse syntax, which
 *   parseTerse turns into the same command object. About a tenth of the output tokens.
 */
export type AnswerMode = "format" | "tool" | "text" | "terse";

const ANSWER: Record<AnswerMode, string> = {
  format: "Answer with the command as JSON in the required schema.",
  tool: "Answer by calling the submit_command tool once, with the command as its input.",
  text: "Answer with only the command, as one JSON object matching the schema at the end of these instructions: no other text and no code fences.",
  terse: "Answer with only the terse command line: no other text, no quotes and no code fences.",
};

const TOOL_ANSWER: Record<AnswerMode, string> = {
  // The claude-api skill's line for JSON output plus tools with thinking off; harmless on OpenAI.
  format: "The JSON output format applies to your final answer only: when you need a tool, call it first, with no text before the call, and write the JSON once you have the results.",
  tool: "When you have what you need, call submit_command with the command. Don't call submit_command in the same turn as a lookup.",
  text: "When you need a tool, call it first, with no text before the call, and write the JSON once you have the results.",
  terse: "When you need a tool, call it first, with no text before the call, and write the command line once you have the results.",
};

/** The cached static prefix for an approach and answer mode. */
export function staticPrefix(approach: Approach, answer: AnswerMode, schemaText?: string): string {
  const parts = [answer === "terse" ? TERSE_RULES : RULES, ANSWER[answer]];
  if (approach === "prompt") parts.push(namesSection());
  else parts.push(`${TOOL_RULES}\n${TOOL_ANSWER[answer]}`);
  if (answer === "text") {
    if (!schemaText) throw new Error("prompt.ts: text answers need the schema text");
    parts.push(`## Output schema (JSON Schema)\n\n${schemaText}`);
  }
  return parts.join("\n\n");
}

/** The per-call user message: game state (approach A) and the transcript. */
export function userMessage(approach: Approach, num: string, transcript: string): string {
  const said = `Transcript: "${transcript}"`;
  return approach === "prompt" ? `${liveContext(num)}\n\n${said}` : said;
}

export function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
