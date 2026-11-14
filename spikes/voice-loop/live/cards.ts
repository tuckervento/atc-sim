/**
 * Situation cards for Q's live session (PLAN 0.6, Q's choice 2026-11-14).
 *
 * Each card describes a situation and what the controller wants done, not the words: Q says it
 * their own way. They're new situations, written for 0.6, using 0.4's flights on frequency
 * (interp/context.ts FLIGHTS), so they test phrasing the 0.4 prompt never saw. Each carries:
 * - `expected`: the command in terse syntax (must parse with parseTerse; checked in check.ts)
 * - `states`: the game state the interpreter sees for this card. Flights not listed keep their
 *   0.4 base state. Correction cards show the issued clearance and the pilot's wrong readback.
 * - `wrongReadback` (correction cards): shown on the card, and playable in the pilot's voice.
 * - `repeat` (say-again cards): what the pilot says when asked to repeat.
 *
 * Geometry follows the test script's assumed layout (script.md: Alpha inner ring, Bravo outer,
 * KD/KE/KF connectors across 31R to Kilo, the 31L departure line on Kilo). Routes are plausible,
 * not real JFK; the cards test hearing and interpretation, not routing.
 */
import { FLIGHTS, type FlightState } from "../interp/context.ts";
import { STT_IDS, VOICES, providerOf, type LiveVoice, type SttId, type TtsId } from "./voices.ts";

export interface Card {
  id: string;
  /** PRD §7 command types. */
  types: string[];
  /** Addressed flight (null: unknown station). */
  callsign: string | null;
  situation: string;
  expected: string;
  states: Record<string, FlightState>;
  /** An unattributed call the controller just heard (unknown-station cards). */
  unattributed?: string;
  wrongReadback?: string;
  repeat?: { callsign: string; text: string };
}

const st = (position: string, clearance: string | null, lastTransmission: string | null, notes: string | null = null): FlightState =>
  ({ position, clearance, lastTransmission, notes });
const WRONG = "The pilot read it back wrong; the aircraft will fly its readback.";

export const CARDS: readonly Card[] = [
  {
    id: "c01", types: ["C1"], callsign: "DLH405",
    situation: "Lufthansa four zero five heavy (DLH405) is at the Terminal 1 ramp edge, ready to taxi with Papa. Clear it to runway 31L: Bravo, then a right turn onto Kilo Foxtrot. It must hold short of runway 31R.",
    expected: "DLH405 taxi 31L via B R:KF hs 31R",
    states: {},
  },
  {
    id: "c02", types: ["C1"], callsign: "KLM644",
    situation: "KLM six four four heavy (KLM644) is at the Terminal 4 ramp edge, ready to taxi with Papa. Runway 31L via Alpha, Juliet, Bravo, Kilo Delta. Two hold-shorts: runway 4L, then runway 31R.",
    expected: "KLM644 taxi 31L via A J B KD hs 4L 31R",
    states: {},
  },
  {
    id: "c03", types: ["C1"], callsign: "EIN104",
    situation: "Shamrock one zero four (EIN104) is at the Terminal 5 ramp edge, ready to taxi. Runway 31L via Alpha, a right turn onto Kilo Foxtrot, then Kilo. No hold-shorts.",
    expected: "EIN104 taxi 31L via A R:KF K",
    states: {},
  },
  {
    id: "c04", types: ["C2"], callsign: "VIR3",
    situation: "Virgin three (VIR3) just cleared 31R at Kilo Foxtrot, and its gate is free now. Send it to the Terminal 4 ramp: Kilo Foxtrot, then left on Alpha.",
    expected: "VIR3 taxi ramp T4 via KF L:A",
    states: { VIR3: st("just exited runway 31R onto KF", null, "Ground, Virgin three, clear of three one right at Kilo Foxtrot, our gate's open now.") },
  },
  {
    id: "c05", types: ["C2"], callsign: "AAL142",
    situation: "American one forty-two heavy (AAL142) is clear of 31R at Kilo Delta. Taxi it to the Terminal 8 ramp: Kilo Delta, then left on Alpha.",
    expected: "AAL142 taxi ramp T8 via KD L:A",
    states: {},
  },
  {
    id: "c06", types: ["C3"], callsign: "RPA3560",
    situation: "Brickyard thirty-five sixty (RPA3560) is taxiing on Alpha toward Kilo Echo, and the Emirates A380 is coming off Kilo Echo. Stop the Brickyard short of taxiway Kilo Echo.",
    expected: "RPA3560 hs KE",
    states: { RPA3560: st("taxiing on A, approaching KE", "taxi to runway 31L via A, KE", "Three one left, Alpha, Kilo Echo, Brickyard thirty-five sixty.", "An Emirates A380 (UAE202) is coming off KE onto A ahead of it.") },
  },
  {
    id: "c07", types: ["C3"], callsign: "SWR17",
    situation: "Swiss one seven heavy (SWR17) is on Bravo heading for Terminal 1. Traffic is moving on Juliet ahead of it. Have it hold short of taxiway Juliet.",
    expected: "SWR17 hs J",
    states: { SWR17: st("taxiing on B toward the Terminal 1 ramp", "taxi to the Terminal 1 ramp via Y, B", "Cross two two right at Yankee, then Bravo, Swiss one seven heavy.", "Traffic is taxiing on J ahead of it.") },
  },
  {
    id: "c08", types: ["C4"], callsign: "DAL1204",
    situation: "Delta twelve oh four (DAL1204) is taxiing on Bravo, and a tug towing an aircraft just pulled out ahead of it. Stop it right where it is.",
    expected: "DAL1204 hold",
    states: { DAL1204: st("taxiing on B", "taxi to runway 31L via B, KD", "Three one left, Bravo, Kilo Delta, Delta twelve oh four.", "A tug is towing an aircraft across B just ahead of it.") },
  },
  {
    id: "c09", types: ["C4"], callsign: "RPA3560",
    situation: "The A380 is past. Brickyard thirty-five sixty (RPA3560) is holding short of Kilo Echo and can carry on with its taxi.",
    expected: "RPA3560 continue",
    states: { RPA3560: st("holding short of KE on A", "taxi to runway 31L via A, KE; holding short of KE", "Hold short Kilo Echo, Brickyard thirty-five sixty.", "The Emirates A380 has passed.") },
  },
  {
    id: "c10", types: ["C5"], callsign: "KLM644",
    situation: "KLM six four four heavy (KLM644) is holding short of runway 4L on Juliet, and tower has approved the crossing. Clear it across 4L at Juliet.",
    expected: "KLM644 cross 4L at J",
    states: { KLM644: st("holding short of runway 4L on J", "taxi to runway 31L via A, J, B, KD, hold short of 4L and 31R", "Holding short four left on Juliet, KLM six four four heavy.", "Tower approved: cross 4L at J.") },
  },
  {
    id: "c11", types: ["C5", "C3"], callsign: "ASA93",
    situation: "Alaska niner three (ASA93) is holding short of runway 4R on Yankee, and tower has approved the crossing. Clear it across 4R at Yankee, then have it hold short of taxiway Zulu.",
    expected: "ASA93 cross 4R at Y, hs Z",
    states: { ASA93: st("holding short of runway 4R on Y", "taxi to runway 31L via B, Y", "Holding short four right at Yankee, Alaska niner three.", "Tower approved: cross 4R at Y.") },
  },
  {
    id: "c12", types: ["C6"], callsign: "BAW175",
    situation: "Speedbird one seven five heavy (BAW175) is in the 31L departure line on Kilo and needs a few minutes to sort out a maintenance item. Pull it out of the line at the next left, Kilo Charlie, to the holding pad.",
    expected: "BAW175 taxi pad via L:KC",
    states: { BAW175: st("in the runway 31L departure line on K", "taxi to runway 31L", "Ground, Speedbird one seven five heavy, we need a few minutes to sort out a maintenance item.") },
  },
  {
    id: "c13", types: ["C6"], callsign: "DAL40",
    situation: "Delta forty (DAL40, not Delta four) is on Bravo heading for Terminal 4, but its gate is still occupied. Send it to the penalty box via Bravo and Kilo Delta.",
    expected: "DAL40 taxi penalty via B KD",
    states: { DAL40: st("taxiing along B toward the Terminal 4 ramp", "taxi to the Terminal 4 ramp via KF, B", "Ground, Delta forty, looks like our gate's still occupied.") },
  },
  {
    id: "c14", types: ["C12", "C6"], callsign: "JBU1123",
    situation: "JetBlue eleven twenty-three (JBU1123) is ready to taxi from Terminal 5, but traffic management has given it a release time of 15:10. Give it the release time, and send it to the pad via Alpha and Kilo Delta.",
    expected: "JBU1123 release 1510, taxi pad via A KD",
    states: { JBU1123: st("Terminal 5 ramp edge, ready to taxi", null, "Ground, JetBlue eleven twenty-three, Terminal Five, ready to taxi.", "Traffic management has assigned release time 15:10, well in the future.") },
  },
  {
    id: "c15", types: ["C7"], callsign: "DLH405",
    situation: "Lufthansa four zero five heavy (DLH405) is number one at the 31L hold line. Hand it to tower on 123.9. It should listen, not call (monitor).",
    expected: "DLH405 monitor tower 123.9",
    states: { DLH405: st("number one at the runway 31L hold-short line", "taxi to runway 31L via B, right on KF, hold short of 31R", null) },
  },
  {
    id: "c16", types: ["C7"], callsign: "VIR3",
    situation: "Virgin three (VIR3) has reached the Terminal 4 ramp entrance. Hand it over to ramp. It should call them (contact).",
    expected: "VIR3 contact ramp",
    states: { VIR3: st("at the Terminal 4 ramp entrance", "taxi to the Terminal 4 ramp via KF, left on A", "Kilo Foxtrot, left Alpha, Terminal Four ramp, Virgin three.") },
  },
  {
    id: "c17", types: ["C8"], callsign: "DAL2340",
    situation: "You cleared Delta twenty-three forty (DAL2340) to 31L via Alpha and Kilo Delta, holding short of Bravo and of runway 31R. Its readback left out 31R. Correct it: it must hold short of both Bravo and 31R.",
    expected: "DAL2340 neg hs B 31R",
    wrongReadback: "Three one left, Alpha, Kilo Delta, hold short Bravo, Delta twenty-three forty.",
    states: { DAL2340: st("Terminal 4 ramp edge", `issued: taxi to runway 31L via A, KD, hold short of B and 31R. ${WRONG}`, "Three one left, Alpha, Kilo Delta, hold short Bravo, Delta twenty-three forty.") },
  },
  {
    id: "c18", types: ["C8"], callsign: "EIN104",
    situation: "You gave Shamrock one zero four (EIN104) a right turn onto Kilo Foxtrot, and it read back a left turn. Correct the turn.",
    expected: "EIN104 neg turn R:KF",
    wrongReadback: "Three one left, Alpha, left Kilo Foxtrot, Kilo, Shamrock one zero four.",
    states: { EIN104: st("Terminal 5 ramp edge", `issued: taxi to runway 31L via A, right on KF, K. ${WRONG}`, "Three one left, Alpha, left Kilo Foxtrot, Kilo, Shamrock one zero four.") },
  },
  {
    id: "c19", types: ["C8"], callsign: "AAL142",
    situation: "American one forty-two heavy (AAL142) read back the Terminal 4 ramp, but it's going to Terminal 8. Correct the destination.",
    expected: "AAL142 neg to ramp T8",
    wrongReadback: "Terminal Four ramp via Kilo Delta, left Alpha, American one forty-two heavy.",
    states: { AAL142: st("on KD, just clear of runway 31R", `issued: taxi to the Terminal 8 ramp via KD, left on A. ${WRONG}`, "Terminal Four ramp via Kilo Delta, left Alpha, American one forty-two heavy.") },
  },
  {
    id: "c20", types: ["C8"], callsign: "UAE202",
    situation: "Emirates two zero two heavy (UAE202) read back Alpha instead of Bravo. Correct the route: Kilo Echo, then right on Bravo. Its hold-short of Kilo Delta was read back right.",
    expected: "UAE202 neg via KE R:B",
    wrongReadback: "Terminal Four ramp via Kilo Echo, right Alpha, hold short Kilo Delta, Emirates two zero two heavy.",
    states: { UAE202: st("just exited runway 31R onto KE", `issued: taxi to the Terminal 4 ramp via KE, right on B, hold short of KD. ${WRONG}`, "Terminal Four ramp via Kilo Echo, right Alpha, hold short Kilo Delta, Emirates two zero two heavy.") },
  },
  {
    id: "c21", types: ["C9"], callsign: "DAL4",
    situation: "Delta four (DAL4) checked in at the Terminal 4 ramp edge with information Oscar. Papa is current. Tell it; the altimeter isn't needed.",
    expected: "DAL4 atis P",
    states: { DAL4: st("Terminal 4 ramp edge, ready to taxi", null, "Ground, Delta four, Terminal Four, ready to taxi with information Oscar.") },
  },
  {
    id: "c22", types: ["C10"], callsign: "UAL1416",
    situation: "United fourteen sixteen (UAL1416) just called, but everything after its callsign was garbled. Ask it to repeat.",
    expected: "UAL1416 say-again",
    states: { UAL1416: st("Terminal 7 ramp edge, ready to taxi", null, "United fourteen sixteen ... [the rest was garbled]") },
    repeat: { callsign: "UAL1416", text: "Ground, United fourteen sixteen, Terminal Seven, ready to taxi with Papa." },
  },
  {
    id: "c23", types: ["C10"], callsign: null,
    situation: "Someone just called ready to taxi from Terminal 5, but the callsign was unreadable. Ask that station to say again its callsign.",
    expected: "? say-again",
    unattributed: "Ground, [callsign unreadable], Terminal Five, ready to taxi with Oscar.",
    states: { JBU615: st("Terminal 5 ramp edge", null, null) },
    repeat: { callsign: "JBU615", text: "Ground, JetBlue six one five, Terminal Five, ready to taxi, information Oscar." },
  },
  {
    id: "c24", types: ["C12"], callsign: "DAL4",
    situation: "Delta four (DAL4), bound for Los Angeles, is taxiing on Alpha. A ground stop for Los Angeles just came in, with about 45 minutes expected. Tell the pilot both.",
    expected: "DAL4 ground-stop LAX, delay 45",
    states: { DAL4: st("taxiing on A", "taxi to runway 31L via A, KE", "Three one left, Alpha, Kilo Echo, Delta four.", "Traffic management has just issued a ground stop for LAX, its destination, for about 45 minutes.") },
  },
  {
    id: "c25", types: ["C12"], callsign: "AAL100",
    situation: "American one hundred (AAL100), bound for Heathrow, is ready to taxi. Flow control into Heathrow means about a 25-minute departure delay. Tell it to expect that.",
    expected: "AAL100 delay 25",
    states: { AAL100: st("Terminal 8 ramp edge, ready to taxi", null, "Ground, American one hundred, Terminal Eight, ready to taxi with Papa.", "Traffic management expects about a 25-minute departure delay for flights to LHR.") },
  },
];

/** The flight whose voice answers a card: the addressee, or the unknown station's real caller. */
export function voiceFlightOf(card: Card): string {
  const cs = card.callsign ?? card.repeat?.callsign;
  if (!cs) throw new Error(`cards.ts: ${card.id} has no addressee and no repeat caller`);
  return cs;
}

export interface Combo {
  stt: SttId;
  tts: TtsId;
}

/**
 * The combination for each card, balanced over the deck:
 * - Each flight uses one voice provider for every card it appears on, so it keeps one voice for
 *   the session (PRD §6.2). Flights are assigned greedily, in order of first appearance, to
 *   whichever provider has fewer cards so far.
 * - Speech-to-text alternates within each provider's cards, in deck order.
 * `cartesiaTts` picks the Cartesia transport for the session (an explicit server setting).
 */
export function comboPlan(cartesiaTts: "cartesia-ws" | "cartesia-http"): Map<string, Combo> {
  const counts = new Map<string, number>();
  for (const c of CARDS) counts.set(voiceFlightOf(c), (counts.get(voiceFlightOf(c)) ?? 0) + 1);
  const provider = new Map<string, TtsId>();
  const load: Record<string, number> = { elevenlabs: 0, [cartesiaTts]: 0 };
  for (const c of CARDS) {
    const f = voiceFlightOf(c);
    if (provider.has(f)) continue;
    const p: TtsId = load.elevenlabs! <= load[cartesiaTts]! ? "elevenlabs" : cartesiaTts;
    provider.set(f, p);
    load[p] = load[p]! + counts.get(f)!;
  }
  const sttTurn: Record<string, number> = { elevenlabs: 0, [cartesiaTts]: 0 };
  const plan = new Map<string, Combo>();
  for (const c of CARDS) {
    const tts = provider.get(voiceFlightOf(c))!;
    const stt = STT_IDS[sttTurn[tts]! % STT_IDS.length]!;
    sttTurn[tts] = sttTurn[tts]! + 1;
    plan.set(c.id, { stt, tts });
  }
  return plan;
}

/**
 * The voice each flight uses on the cards, so Q hears every voice about equally (0.4's flight
 * order alone gave one ElevenLabs voice 7 cards and another 1). Within each provider, flights
 * take voices greedily in deck order: each goes to the voice with the fewest cards so far.
 * Each flight keeps one voice for the session.
 */
export function cardVoicePlan(plan: Map<string, Combo>): Map<string, LiveVoice> {
  const cardsPerFlight = new Map<string, number>();
  for (const c of CARDS) cardsPerFlight.set(voiceFlightOf(c), (cardsPerFlight.get(voiceFlightOf(c)) ?? 0) + 1);
  const load = new Map<string, number>();
  const out = new Map<string, LiveVoice>();
  for (const c of CARDS) {
    const f = voiceFlightOf(c);
    if (out.has(f)) continue;
    const voices = VOICES[providerOf(plan.get(c.id)!.tts)];
    let best = voices[0]!;
    for (const v of voices) if ((load.get(v.id) ?? 0) < (load.get(best.id) ?? 0)) best = v;
    out.set(f, best);
    load.set(best.id, (load.get(best.id) ?? 0) + cardsPerFlight.get(f)!);
  }
  return out;
}

export function cardById(id: string): Card {
  const c = CARDS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown card '${id}'`);
  return c;
}

/** Every state override names a flight on frequency (checked by check.ts). */
export function unknownFlightsIn(card: Card): string[] {
  return Object.keys(card.states).filter((cs) => !FLIGHTS.some((f) => f.callsign === cs));
}
