// Interim traffic for the browser session (PLAN 1.13), until Phase 3's traffic generator: the
// sim's arrival streams (tower, one per landing runway end) and departure streams (ramp, one per
// terminal), with made-up but plausible flights. Pure and deterministic from the seed: flight n
// of a stream is always the same flight.
//
// Generic over the airport data: runway ends from the default configuration, terminals and their
// airlines from the data. Only the rates are per airport (TRAFFIC_RATES).
//
// - Airline: one of the terminal's airlines that FLEETS knows and that flies a type that can
//   depart from it, at random (seeded). An arrival's terminal: one with traffic, at random.
// - Type: one of that airline's FLEETS types that can depart from the terminal, at random.
// - Callsign: the airline's ICAO code and a flight number 100–9999. Numbers are a seeded
//   permutation of the flights of all streams together, so no two flights share one (for the
//   first 9,900 flights of a session: about 280 hours at today's rates).
// - A turned-around flight (an arrival the ramp parked, departing again; ramp.ts,
//   "Turnarounds"): its inbound's airline and a number from the other end of the same
//   permutation, counting down. So it shares a number with no stream's flight and no other
//   turnaround until the two counts meet. A stream's flight n takes index n × streams + stream,
//   so at KJFK (7 streams, the busiest at 6 an hour) the streams use up about 42 indices an hour
//   and turnarounds about 10: they meet after about 190 hours.

import type { Airport, Terminal } from '../../airport/types.ts';
import type { AircraftTypeCode, ArrivalStream, DepartureStream } from '../../sim/sim.ts';

export interface TrafficRates {
  /** Arrivals an hour to each runway end that lands in the configuration. */
  arrivalsPerHourPerRunway: number;
  /** Departures an hour from each terminal. */
  departuresPerHourPerTerminal: number;
}

export interface Traffic {
  arrivals: ArrivalStream[];
  departures: DepartureStream[];
  /** Terminals with no traffic, and why: shown to the player, so a quiet terminal isn't a mystery. */
  skipped: SkippedTerminal[];
  /** The callsign of the `n`th arrival to turn around into a departure (0, 1, …): for the sim's TurnaroundOptions.callsign. */
  turnaroundCallsign: (n: number, inbound: { callsign: string; airline: string | null }) => string;
}

export interface SkippedTerminal {
  terminal: string;
  reason: string;
}

/**
 * Types each airline flies here, from the sim's AIRCRAFT_TYPES. Made up but plausible: from my
 * own knowledge of the airlines' fleets, not checked against schedules. An airline not listed
 * isn't used.
 */
export const FLEETS: Readonly<Record<string, readonly AircraftTypeCode[]>> = {
  // Terminal 1
  AFR: ['B77W', 'A359'],
  DLH: ['A333', 'A359'],
  KAL: ['B77W', 'B789'],
  THY: ['B77W', 'A359'],
  SWR: ['A333', 'B77W'],
  CCA: ['B77W'],
  EVA: ['B77W'],
  LOT: ['B789'],
  TAP: ['A321', 'A333'],
  SAS: ['A333'],
  ITY: ['A333'],
  AUA: ['B763'],
  // Terminal 4
  DAL: ['A320', 'A321', 'B739', 'B763', 'A333', 'A359'],
  UAE: ['B77W', 'A388'],
  KLM: ['B789', 'B77W'],
  VIR: ['A333', 'B789'],
  SIA: ['A359'],
  ETD: ['B789'],
  AMX: ['B738', 'B789'],
  WJA: ['B738'],
  CAL: ['A359'],
  AIC: ['B77W'],
  // Terminal 5
  JBU: ['A320', 'A321', 'E175'],
  // Terminal 7
  ANA: ['B77W', 'B789'],
  EIN: ['A321', 'A333'],
  ICE: ['B738'],
  // Terminal 8
  AAL: ['A321', 'B738', 'B789', 'B77W'],
  BAW: ['B77W', 'B789'],
  ASA: ['B739', 'B738'],
  IBE: ['A321', 'A333'],
  JAL: ['B77W', 'B789'],
  QTR: ['B77W', 'A359'],
  CPA: ['B77W', 'A359'],
  FIN: ['A333', 'A359'],
};

/**
 * The airports with live traffic, and its rates: modest for now, for typed commands (PLAN 1.13).
 * KJFK: 12 arrivals an hour on 31L and 31R together, and 3 departures an hour from each terminal
 * with traffic. An airport not listed shows the map with no traffic.
 */
export const TRAFFIC_RATES: Readonly<Record<string, TrafficRates>> = {
  KJFK: { arrivalsPerHourPerRunway: 6, departuresPerHourPerTerminal: 3 },
  TEST: { arrivalsPerHourPerRunway: 4, departuresPerHourPerTerminal: 6 },
};

/** Flight numbers run FIRST_FLIGHT_NUMBER … FIRST_FLIGHT_NUMBER + NUMBERS - 1. */
const FIRST_FLIGHT_NUMBER = 100;
const NUMBERS = 9900;
/**
 * Coprime with NUMBERS, so m → m × NUMBER_STEP mod NUMBERS is a permutation. Chosen by search so
 * that no k × NUMBER_STEP for k ≤ 60 is within 162 of a multiple of NUMBERS: flights a few apart
 * in the interleave never get near-identical numbers (7919 gave 9355 and 9360).
 */
const NUMBER_STEP = 2759;

/**
 * Whether a departure of `type` can leave from some gate of `terminal`: it fits a stand and the
 * ramp can push it back. The sim's ramp knows; the session asks it (session.ts).
 */
export type CanDepart = (terminal: string, type: AircraftTypeCode) => boolean;

/**
 * The streams for `airport`'s default configuration. Each flight's type can depart from its
 * terminal (`canDepart`), for arrivals too: ramp only gives an arrival a gate it can leave again.
 * Otherwise a departure stream would retry a flight no gate takes, forever, and an arrival would
 * wait at the ramp entrance forever.
 */
export function trafficFor(airport: Airport, seed: number, rates: TrafficRates, canDepart: CanDepart): Traffic {
  const configId = airport.defaultConfiguration ?? airport.configurations[0]?.id;
  const config = airport.configurations.find((c) => c.id === configId);
  const landing = (config?.runways ?? []).filter((r) => r.roles.includes('arrivals')).map((r) => r.end);
  const streamCount = landing.length + airport.terminals.length;
  const numberAt = (m: number) => FIRST_FLIGHT_NUMBER + ((m * NUMBER_STEP + (hash(seed, 0, 0, 0) % NUMBERS)) % NUMBERS);
  const callsign = (stream: number, n: number, airline: string) => `${airline}${numberAt(n * streamCount + stream)}`;
  const turnaroundCallsign = (n: number, inbound: { callsign: string; airline: string | null }) => {
    // Every flight of this traffic has an airline; one without isn't ours.
    if (inbound.airline === null) throw new Error(`${inbound.callsign}: a turnaround with no airline`);
    return `${inbound.airline}${numberAt(NUMBERS - 1 - n)}`;
  };

  const served: Served[] = [];
  const skipped: SkippedTerminal[] = [];
  airport.terminals.forEach((terminal, t) => {
    const operators = operatorsAt(terminal, canDepart);
    if ('skip' in operators) skipped.push({ terminal: terminal.id, reason: operators.skip });
    else served.push({ terminal, stream: landing.length + t, operators });
  });
  /** Flight n of `stream`, at `at`: one of its operators, and one of that operator's types. */
  const flightAt = (at: Served, stream: number, n: number) => {
    const { airline, types } = pick(at.operators, hash(seed, stream, n, 1));
    return { callsign: callsign(stream, n, airline), type: pick(types, hash(seed, stream, n, 2)), terminal: at.terminal.id, airline };
  };

  // With no terminal to go to, there are no arrivals (`skipped` says why).
  const landingTo = served.length === 0 ? [] : landing;
  // Departures first: boarding, pushback and the ramp take minutes before a check-in; an arrival
  // calls about two minutes after it's spawned.
  const start = (k: number) => firstAtS(k, served.length + landingTo.length);
  const departures = served.map(
    (at, k): DepartureStream => ({
      perHour: rates.departuresPerHourPerTerminal,
      flight: (n) => flightAt(at, at.stream, n),
      firstAtS: start(k),
    }),
  );
  const arrivals = landingTo.map(
    (runwayEnd, stream): ArrivalStream => ({
      runwayEnd,
      perHour: rates.arrivalsPerHourPerRunway,
      flight: (n) => flightAt(pick(served, hash(seed, stream, n, 3)), stream, n),
      firstAtS: start(served.length + stream),
    }),
  );
  return { arrivals, departures, skipped, turnaroundCallsign };
}

/** The first FIRST_SPREAD_S of a session, after FIRST_AT_S: when stream k of `count` starts. */
const FIRST_AT_S = 10;
const FIRST_SPREAD_S = 170;

function firstAtS(k: number, count: number): number {
  return FIRST_AT_S + Math.round((k * FIRST_SPREAD_S) / count);
}

/** A terminal that has traffic: its stream number (for callsigns), and who flies what from it. */
interface Served {
  terminal: Terminal;
  stream: number;
  operators: { airline: string; types: AircraftTypeCode[] }[];
}

/**
 * The terminal's airlines that FLEETS knows, each with the types of its fleet that can depart
 * from the terminal; airlines left with none are left out. Or why the terminal has no traffic.
 */
function operatorsAt(terminal: Terminal, canDepart: CanDepart): Served['operators'] | { skip: string } {
  const known = terminal.airlines.filter((a) => Object.hasOwn(FLEETS, a));
  if (known.length === 0) return { skip: `no airline of its (${terminal.airlines.join(', ') || 'none in the data'}) has a fleet in FLEETS` };
  const operators = known
    .map((airline) => ({ airline, types: (FLEETS[airline] ?? []).filter((type) => canDepart(terminal.id, type)) }))
    .filter((o) => o.types.length > 0);
  if (operators.length === 0) return { skip: 'none of its airlines’ types can push back from a gate there' };
  return operators;
}

function pick<T>(items: readonly T[], h: number): T {
  const item = items[h % items.length];
  if (item === undefined) throw new Error('traffic: pick from an empty list');
  return item;
}

/** A 32-bit hash of four integers (murmur3's finalizer over a running mix), as an unsigned int. */
function hash(a: number, b: number, c: number, d: number): number {
  let h = 0x9e3779b9;
  for (const v of [a, b, c, d]) {
    h = Math.imul(h ^ (v | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}
