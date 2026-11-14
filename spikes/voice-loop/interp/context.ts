/**
 * The fixed fake game context for the interpreter bake-off (task 0.4).
 *
 * Two parts:
 * - static, the same for every call: JFK runway, taxiway and ramp names, and airline radio
 *   names. It goes in the cached prompt prefix (approach A) or behind the tools (approach B).
 * - live, per script line: the flights on frequency with their state. Every flight in the
 *   script is on frequency on every line. The addressed flight's state (position, clearance,
 *   last pilot transmission) comes from that line's `context` in script.md; every other
 *   flight shows its base state. The states are written here as game data, not copied from
 *   script.md, because some script contexts carry notes for the test author (e.g. line 13's
 *   "isn't the addressee").
 *
 * Nothing here depends on the transcript, so a line's context is identical across models,
 * approaches and inputs.
 */

// ---- airport names ---------------------------------------------------------------------

const PHONETIC: Record<string, string> = {
  A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo", F: "Foxtrot", G: "Golf",
  H: "Hotel", I: "India", J: "Juliet", K: "Kilo", L: "Lima", M: "Mike", N: "November",
  O: "Oscar", P: "Papa", Q: "Quebec", R: "Romeo", S: "Sierra", T: "Tango", U: "Uniform",
  V: "Victor", W: "Whiskey", X: "X-ray", Y: "Yankee", Z: "Zulu",
};
const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];

/**
 * Taxiway IDs: the 87 labels on the FAA JFK airport diagram (cycle 2611, listed in
 * docs/research/airport-data.md §2.2), plus three the test script uses that the diagram
 * doesn't have: KF (in OpenStreetMap), KC and KK (script.md marks them [?]).
 */
export const TAXIWAYS: readonly string[] = [
  "A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P", "Q", "R", "S", "T", "U", "V", "W", "Y", "Z",
  "A1", "A4", "A7", "A8", "A10", "A11", "A12", "A13", "A14", "A15",
  "C1", "C2", "C3", "C5", "C6", "C7", "K1", "K2", "K3", "K4", "Q1", "Q2", "Q3", "Q4", "Q5", "U1", "U2", "U3",
  "DA", "DB", "EA", "EE", "FA", "FB", "GG", "JA", "JB", "KD", "KE", "LA", "LL", "MA", "MB", "MC", "MD",
  "NA", "NB", "NC", "PA", "PB", "PC", "PD", "PE", "PF", "SA", "SB", "SC", "SD", "TA", "TB", "TT", "VA", "WW", "YA",
  "KC", "KF", "KK",
];

/** Runway ends at JFK (FAA style, no leading zero). */
export const RUNWAYS: readonly string[] = ["4L", "22R", "4R", "22L", "13L", "31R", "13R", "31L"];

/** Terminal ramps operating today (Q, 2026-11-14: T1, T4, T5, T7, T8). */
export const RAMPS: readonly string[] = ["T1", "T4", "T5", "T7", "T8"];

/** "Kilo Echo" for KE, "Alpha one zero" for A10. */
export function spokenName(id: string): string {
  return [...id].map((ch) => (/\d/.test(ch) ? DIGIT_WORDS[Number(ch)]! : PHONETIC[ch]!)).join(" ");
}

/** "three one left" for 31L. */
export function spokenRunway(rwy: string): string {
  const m = /^(\d+)([LCR]?)$/.exec(rwy);
  if (!m) throw new Error(`bad runway ${rwy}`);
  const digits = [...m[1]!].map((d) => DIGIT_WORDS[Number(d)]!).join(" ");
  const side = { L: " left", C: " center", R: " right", "": "" }[m[2] as "L" | "C" | "R" | ""];
  return `${digits}${side}`;
}

// ---- airlines --------------------------------------------------------------------------

/**
 * Radio name → ICAO code. Every airline in the test script (1.2's mapping for Shamrock,
 * Speedbird, Brickyard, Qatari, Virgin and Alaska), plus the other real JFK operators that
 * 0.3's vocabulary list used, so the table isn't only the answer key.
 */
export const AIRLINES: ReadonlyArray<{ radio: string; icao: string; airline: string }> = [
  { radio: "Delta", icao: "DAL", airline: "Delta Air Lines" },
  { radio: "JetBlue", icao: "JBU", airline: "JetBlue" },
  { radio: "American", icao: "AAL", airline: "American Airlines" },
  { radio: "Shamrock", icao: "EIN", airline: "Aer Lingus" },
  { radio: "Lufthansa", icao: "DLH", airline: "Lufthansa" },
  { radio: "Emirates", icao: "UAE", airline: "Emirates" },
  { radio: "Alaska", icao: "ASA", airline: "Alaska Airlines" },
  { radio: "Iberia", icao: "IBE", airline: "Iberia" },
  { radio: "Speedbird", icao: "BAW", airline: "British Airways" },
  { radio: "Swiss", icao: "SWR", airline: "Swiss" },
  { radio: "Qatari", icao: "QTR", airline: "Qatar Airways" },
  { radio: "Air France", icao: "AFR", airline: "Air France" },
  { radio: "Virgin", icao: "VIR", airline: "Virgin Atlantic" },
  { radio: "KLM", icao: "KLM", airline: "KLM" },
  { radio: "Aeromexico", icao: "AMX", airline: "Aeromexico" },
  { radio: "Brickyard", icao: "RPA", airline: "Republic Airways" },
  { radio: "United", icao: "UAL", airline: "United Airlines" },
  { radio: "Endeavor", icao: "EDV", airline: "Endeavor Air" },
  { radio: "Air Canada", icao: "ACA", airline: "Air Canada" },
  { radio: "Etihad", icao: "ETD", airline: "Etihad Airways" },
  { radio: "Cathay", icao: "CPA", airline: "Cathay Pacific" },
  { radio: "Korean Air", icao: "KAL", airline: "Korean Air" },
  { radio: "Air China", icao: "CCA", airline: "Air China" },
  { radio: "Turkish", icao: "THY", airline: "Turkish Airlines" },
  { radio: "Avianca", icao: "AVA", airline: "Avianca" },
];

// ---- flights on frequency --------------------------------------------------------------

export interface FlightState {
  position: string;
  /** The clearance the aircraft is flying, in words. null: none yet. */
  clearance: string | null;
  /** The pilot's most recent transmission. null: nothing since check-in. */
  lastTransmission: string | null;
  /** Other game state: tower approvals, traffic management, nearby traffic. */
  notes: string | null;
}

export interface Flight {
  callsign: string;
  spoken: string;
  aircraft: string;
  role: "departure" | "arrival";
  /** Departures: destination airport code. Arrivals: null. */
  destination: string | null;
  terminal: string;
  /** Departures: assigned runway. Arrivals: the runway it landed on. */
  runway: string;
  base: FlightState;
}

const st = (position: string, clearance: string | null, lastTransmission: string | null, notes: string | null = null): FlightState =>
  ({ position, clearance, lastTransmission, notes });

/** Alphabetical by callsign, so the list's order never points at the addressee. */
export const FLIGHTS: readonly Flight[] = [
  { callsign: "AAL100", spoken: "American one hundred", aircraft: "B77W", role: "departure", destination: "LHR", terminal: "T8", runway: "31L",
    base: st("Terminal 8 ramp edge, ready to taxi", null, "Ground, American one hundred, Terminal Eight, ready to taxi with Papa.") },
  { callsign: "AAL142", spoken: "American one forty-two heavy", aircraft: "B77W", role: "arrival", destination: null, terminal: "T8", runway: "31R",
    base: st("just exited runway 31R onto KD", null, "Ground, American one forty-two heavy, clear of three one right at Kilo Delta.") },
  { callsign: "AFR23", spoken: "Air France two three heavy", aircraft: "B77W", role: "departure", destination: "CDG", terminal: "T4", runway: "31L",
    base: st("in the runway 31L departure line on K", "taxi to runway 31L", null, "Its release time is still 20 minutes away.") },
  { callsign: "ASA93", spoken: "Alaska niner three", aircraft: "B739", role: "departure", destination: "SEA", terminal: "T7", runway: "31L",
    base: st("taxiing on Y toward runway 4R (inactive; crossing it needs a clearance)", "taxi to runway 31L via B, Y", "Three one left, Bravo, Yankee, Alaska niner three.") },
  { callsign: "BAW175", spoken: "Speedbird one seven five heavy", aircraft: "B772", role: "departure", destination: "LHR", terminal: "T8", runway: "31L",
    base: st("taxiing on K", "taxi to runway 31L via A, KE, K", "Three one left, Alpha, Kilo Echo, Kilo, Speedbird one seven five heavy.") },
  { callsign: "DAL1204", spoken: "Delta twelve oh four", aircraft: "A321", role: "departure", destination: "ATL", terminal: "T4", runway: "31L",
    base: st("in the runway 31L departure line on K", "taxi to runway 31L", null) },
  { callsign: "DAL2340", spoken: "Delta twenty-three forty", aircraft: "B739", role: "departure", destination: "MIA", terminal: "T4", runway: "31L",
    base: st("Terminal 4 ramp edge, ready to taxi", null, "Ground, Delta twenty-three forty, taxiing out of the Terminal Four ramp, with Oscar.") },
  { callsign: "DAL4", spoken: "Delta four", aircraft: "A321", role: "departure", destination: "LAX", terminal: "T4", runway: "31L",
    base: st("Terminal 4 ramp edge, ready to taxi", null, "Ground, Delta four, taxiing out of the Terminal Four ramp, information Papa.") },
  { callsign: "DAL40", spoken: "Delta forty", aircraft: "B763", role: "arrival", destination: null, terminal: "T4", runway: "31R",
    base: st("taxiing along B toward the Terminal 4 ramp", "taxi to the Terminal 4 ramp via KF, B", "Kilo Foxtrot, Bravo, Delta forty.") },
  { callsign: "DLH405", spoken: "Lufthansa four zero five heavy", aircraft: "B748", role: "departure", destination: "FRA", terminal: "T1", runway: "31L",
    base: st("Terminal 1 ramp edge, ready to taxi", null, "Ground, Lufthansa four zero five heavy, ready to taxi, information Papa.") },
  { callsign: "EIN104", spoken: "Shamrock one zero four", aircraft: "A333", role: "departure", destination: "DUB", terminal: "T5", runway: "31L",
    base: st("Terminal 5 ramp edge, ready to taxi", null, "Ground, Shamrock one zero four, Terminal Five, information Papa.") },
  { callsign: "IBE626", spoken: "Iberia six two six heavy", aircraft: "A359", role: "departure", destination: "MAD", terminal: "T8", runway: "31L",
    base: st("taxiing on A, approaching B", "taxi to runway 31L via A, KD", "Three one left, Alpha, Kilo Delta, Iberia six two six heavy.", "A Delta Boeing 767 (DAL40) is taxiing along B.") },
  { callsign: "JBU1123", spoken: "JetBlue eleven twenty-three", aircraft: "A320", role: "departure", destination: "MCO", terminal: "T5", runway: "31L",
    base: st("Terminal 5 ramp edge, ready to taxi", null, "Ground, JetBlue eleven twenty-three, out of the Terminal Five ramp, information Papa.") },
  { callsign: "JBU387", spoken: "JetBlue three eighty-seven", aircraft: "E190", role: "arrival", destination: null, terminal: "T5", runway: "31R",
    base: st("just exited runway 31R onto KF", null, "Ground, JetBlue three eighty-seven, clear three one right at Kilo Foxtrot.") },
  { callsign: "JBU615", spoken: "JetBlue six one five", aircraft: "A321", role: "departure", destination: "FLL", terminal: "T5", runway: "31L",
    base: st("Terminal 5 ramp edge, ready to taxi", null, "Ground, JetBlue six one five, Terminal Five, ready to taxi, information Oscar.") },
  { callsign: "KLM644", spoken: "KLM six four four heavy", aircraft: "B789", role: "departure", destination: "AMS", terminal: "T4", runway: "31L",
    base: st("Terminal 4 ramp edge, ready to taxi", null, "Ground, KLM six four four heavy, Terminal Four, ready to taxi with Papa.") },
  { callsign: "QTR701", spoken: "Qatari seven zero one heavy", aircraft: "B77W", role: "departure", destination: "DOH", terminal: "T8", runway: "31L",
    base: st("holding short of runway 31R on KE", "taxi to runway 31L via A, KE, hold short of 31R", "Holding short three one right at Kilo Echo, Qatari seven zero one heavy.", "Tower approved: cross 31R at KE.") },
  { callsign: "RPA3560", spoken: "Brickyard thirty-five sixty", aircraft: "E175", role: "departure", destination: "BOS", terminal: "T4", runway: "31L",
    base: st("taxiing on A", "taxi to runway 31L via A, KE", "Three one left, Alpha, Kilo Echo, Brickyard thirty-five sixty.") },
  { callsign: "SWR17", spoken: "Swiss one seven heavy", aircraft: "A333", role: "arrival", destination: null, terminal: "T1", runway: "31R",
    base: st("holding short of runway 22R on Y", "taxi to the Terminal 1 ramp via Y, B, hold short of 22R", "Holding short two two right at Yankee, Swiss one seven heavy.", "Tower approved: cross 22R at Y.") },
  { callsign: "UAE202", spoken: "Emirates two zero two heavy", aircraft: "A388", role: "arrival", destination: null, terminal: "T4", runway: "31R",
    base: st("just exited runway 31R onto KE", null, "Ground, Emirates two zero two heavy, clear of three one right at Kilo Echo.") },
  { callsign: "UAL1416", spoken: "United fourteen sixteen", aircraft: "B753", role: "departure", destination: "SFO", terminal: "T7", runway: "31L",
    base: st("Terminal 7 ramp edge, ready to taxi", null, "Ground, United fourteen sixteen, ready to taxi.", "Traffic management has it on hold for release.") },
  { callsign: "VIR3", spoken: "Virgin three", aircraft: "A35K", role: "arrival", destination: null, terminal: "T4", runway: "31R",
    base: st("just exited runway 31R onto KF", null, "Ground, Virgin three, clear of three one right at Kilo Foxtrot, our gate's still occupied.") },
];

/**
 * Per script line: the addressed flight's state at that moment (from the line's `context`).
 * Lines whose addressee is in its base state need no entry. Line 31 has no addressee: its
 * caller's callsign was unreadable, so it's an unattributed transmission instead.
 */
const LINE_STATES: Record<string, Record<string, FlightState>> = {
  "12": { DAL4: st("on KE past B, approaching runway 31R", "taxi to runway 31L via A, right on KE (its hold-short of B was released)", "Continuing, Delta four.", "An arrival is on short final for 31R.") },
  "14": { JBU1123: st("taxiing on A", "taxi to runway 31L via A, KD, hold short of B and 31R", "Three one left, Alpha, Kilo Delta, hold short Bravo and three one right, JetBlue eleven twenty-three.") },
  "15": { IBE626: st("holding short of B on A", "taxi to runway 31L via A, KD; holding short of B", "Hold short Bravo, Iberia six two six heavy.", "The Delta 767 on B has passed.") },
  "16": { BAW175: st("taxiing on K", "taxi to runway 31L via A, KE, K", "Three one left, Alpha, Kilo Echo, Kilo, Speedbird one seven five heavy.", "The aircraft ahead of it on K has stopped suddenly.") },
  "17": { DAL4: st("holding short of runway 31R on KE", "taxi to runway 31L via A, right on KE, hold short of 31R", "Holding short three one right, Delta four.", "Tower approved: cross 31R at KE.") },
  "20": { AFR23: st("in the runway 31L departure line on K", "taxi to runway 31L", null, "Its release time is still 20 minutes away.") },
  "21": { DAL1204: st("in the runway 31L departure line on K", "taxi to runway 31L", null, "Traffic management has just issued a ground stop for ATL, its destination.") },
  "22": { JBU615: st("Terminal 5 ramp edge, ready to taxi", null, "Copy Papa, two niner niner two, JetBlue six one five.", "Traffic management has assigned release time 14:52, well in the future.") },
  "24": { BAW175: st("at the runway 31L hold-short line, second in line", "taxi to runway 31L via A, KE, K", null) },
  "25": { UAE202: st("at the Terminal 4 ramp entrance", "taxi to the Terminal 4 ramp via KE, left on A", "Terminal Four ramp via Kilo Echo, left Alpha, Emirates two zero two heavy.") },
  "26": { DAL4: st("Terminal 4 ramp edge", "issued: taxi to runway 31L via A, right on KE, hold short of B. The pilot read it back wrong; the aircraft will fly its readback.", "Three one left, Alpha, right Kilo Echo, Delta four.") },
  "27": { DLH405: st("Terminal 1 ramp edge", "issued: taxi to runway 31L via left on A, right on KE, hold short of 31R, then hold short of K. The pilot read it back wrong; the aircraft will fly its readback.", "Left Alpha, left Kilo Echo, three one left, hold short three one right, then Kilo, Lufthansa four zero five heavy.") },
  "28": { AAL100: st("Terminal 8 ramp edge", "issued: taxi to runway 31L via A, KF, hold short of 31R. The pilot read it back wrong; the aircraft will fly its readback.", "Three one right, Alpha, Kilo Foxtrot, hold short three one right, American one hundred.") },
  "29": { EIN104: st("Terminal 5 ramp edge", "issued: taxi to runway 31L via A, J, hold short of B. The pilot read it back wrong; the aircraft will fly its readback.", "Three one left, Bravo, Juliet, hold short Alpha, Shamrock one zero four.") },
  "30": { KLM644: st("Terminal 4 ramp edge, ready to taxi", null, "KLM six four four heavy ... [the rest was blocked: two aircraft transmitted at once]") },
  "32": { RPA3560: st("taxiing on A", "taxi to runway 31L via A, KE", "Three one left, Alpha, Kilo Echo, Brickyard thirty-five sixty.", "Traffic management has just issued a ground stop for BOS, its destination.") },
  "33": { UAL1416: st("Terminal 7 ramp edge, ready to taxi", null, "Ground, United fourteen sixteen, ready to taxi.", "Traffic management has it on hold for release.") },
  "34": {
    JBU1123: st("taxiing on A", "taxi to runway 31L via A, KD, hold short of B and 31R", "Three one left, Alpha, Kilo Delta, hold short Bravo and three one right, JetBlue eleven twenty-three."),
    UAE202: st("turning from KE onto A", "taxi to the Terminal 4 ramp via KE, left on A", "Terminal Four ramp via Kilo Echo, left Alpha, Emirates two zero two heavy."),
  },
};

const UNATTRIBUTED: Record<string, string> = {
  "31": "Ground, [callsign unreadable], clear of three one right at Kilo Foxtrot.",
};

export const ATIS = { letter: "P", altimeter: "2992" } as const;

/** Every flight with its state as of this script line. */
export function flightsAt(num: string): Array<Flight & { state: FlightState }> {
  const overrides = LINE_STATES[num] ?? {};
  for (const cs of Object.keys(overrides)) {
    if (!FLIGHTS.some((f) => f.callsign === cs)) throw new Error(`context.ts: line ${num} overrides unknown flight ${cs}`);
  }
  return FLIGHTS.map((f) => ({ ...f, state: overrides[f.callsign] ?? f.base }));
}

export function unattributedAt(num: string): string | null {
  return UNATTRIBUTED[num] ?? null;
}

/** One flight as one line of text (used by the live context and by the find_flight tool). */
export function describeFlight(f: Flight & { state: FlightState }): Record<string, string | null> {
  const what = f.role === "departure"
    ? `departure to ${f.destination}, from the Terminal ${f.terminal.slice(1)} ramp, runway ${f.runway}`
    : `arrival, landed ${f.runway}, for the Terminal ${f.terminal.slice(1)} ramp`;
  return {
    callsign: f.callsign,
    spoken: f.spoken,
    aircraft: f.aircraft,
    flight: what,
    position: f.state.position,
    clearance: f.state.clearance,
    lastPilotTransmission: f.state.lastTransmission,
    notes: f.state.notes,
  };
}

function flightLine(f: Flight & { state: FlightState }): string {
  const d = describeFlight(f);
  const parts = [`${d.callsign} "${d.spoken}" ${d.aircraft}, ${d.flight}. Position: ${d.position}.`];
  if (d.clearance) parts.push(`Clearance: ${d.clearance}.`);
  if (d.lastPilotTransmission) parts.push(`Last pilot transmission: "${d.lastPilotTransmission}"`);
  if (d.notes) parts.push(`Notes: ${d.notes}`);
  return `- ${parts.join(" ")}`;
}

/** The live part of approach A's prompt: game state at this line. Follows the cached prefix. */
export function liveContext(num: string): string {
  const out = [
    `Current ATIS: information Papa (letter ${ATIS.letter}), altimeter ${ATIS.altimeter}. Runway configuration: arrivals land 31R, departures use 31L.`,
    "",
    "Flights on frequency:",
    ...flightsAt(num).map(flightLine),
  ];
  const un = unattributedAt(num);
  if (un) out.push("", `Unattributed transmission just received (the callsign was unreadable): "${un}"`);
  return out.join("\n");
}

/** The static name lists for approach A's cached prefix. */
export function namesSection(): string {
  const taxiways = TAXIWAYS.map((t) => `${t} (${spokenName(t)})`).join(", ");
  const runways = RUNWAYS.map((r) => `${r} (${spokenRunway(r)})`).join(", ");
  const ramps = RAMPS.map((r) => `${r} (Terminal ${spokenName(r.slice(1))})`).join(", ");
  const airlines = AIRLINES.map((a) => `${a.radio} = ${a.icao} (${a.airline})`).join("; ");
  return [
    "## JFK names",
    "",
    `Runways: ${runways}.`,
    "",
    `Taxiways (ID, then how it's spoken): ${taxiways}.`,
    "",
    `Terminal ramps: ${ramps}. Holding pads and the penalty box have no names: "the pad", "the penalty box".`,
    "",
    "## Airline radio names",
    "",
    `Radio name = ICAO code: ${airlines}.`,
  ].join("\n");
}
