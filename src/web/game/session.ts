// A playing session in the browser (PLAN 1.13), without the DOM: the sim with its traffic, run
// in real time by the fixed-step clock, drawn between ticks, its events turned into log lines.
// The page (ui.ts, main.ts) calls `advance` once per animation frame and draws `drawnAircraft`.

import { indexAirport } from '../../airport/graph.ts';
import type { Airport } from '../../airport/types.ts';
import { applyCommand, createSim, drainEvents, listAircraft, step, TICK_HZ, TICK_S, type AircraftTypeCode, type Sim } from '../../sim/sim.ts';
import { parseTerse, type ParseError } from '../../sim/terse.ts';
import { fromAircraftView, type MapAircraft } from '../map/aircraft.ts';
import { advanceClock, initialClock, type ClockControls, type ClockState } from './clock.ts';
import { NO_COUNTERS, type Counters } from './counters.ts';
import { destinationOf } from './destination.ts';
import { formatSimTime, initialLog, logEvents, type LogContext, type LogLine, type LogState } from './event-log.ts';
import { interpolateAircraft } from './interpolate.ts';
import { TRAFFIC_RATES, trafficFor, type CanDepart, type SkippedTerminal } from './traffic.ts';

/** Catch-up limit: at 4× and 60 frames a second, a frame needs under one tick. */
export const MAX_TICKS_PER_FRAME = 8;

export interface SessionOptions {
  seed: number;
  /** The live counters' source (counters.ts). Default NO_COUNTERS, until score.ts is wired. */
  counters?: Counters;
}

export interface Session {
  readonly airport: Airport;
  readonly sim: Sim;
  readonly seed: number;
  /** Whether the airport has live traffic (TRAFFIC_RATES), and the terminals left out of it. */
  readonly traffic: { live: boolean; skipped: SkippedTerminal[] };
  readonly counters: Counters;
  /** Speed and pause; the page sets them. */
  controls: ClockControls;
  clock: ClockState;
  log: LogState;
  readonly logContext: LogContext;
  /** The aircraft before and after the last tick, and how far the frame is between them. */
  previous: MapAircraft[];
  current: MapAircraft[];
  alpha: number;
  /** Each spawned flight's terminal, for its label: the sim's view doesn't carry it. */
  readonly terminals: Map<string, string | null>;
  readonly departureEnds: string[];
}

export function createSession(airport: Airport, options: SessionOptions): Session {
  const index = indexAirport(airport);
  const rates = TRAFFIC_RATES[airport.id];
  const terminals = new Map<string, string | null>();
  const traffic = rates ? trafficFor(airport, options.seed, rates, canDepartProbe(airport)) : { arrivals: [], departures: [], skipped: [] };
  // Remember each flight's terminal as the sim asks for it.
  const remembered = <F extends { callsign: string; terminal?: string | null }>(flight: (n: number) => F) => (n: number) => {
    const f = flight(n);
    terminals.set(f.callsign, f.terminal ?? null);
    return f;
  };
  const sim = createSim(index, {
    seed: options.seed,
    arrivals: traffic.arrivals.map((s) => ({ ...s, flight: remembered(s.flight) })),
    departures: traffic.departures.map((s) => ({ ...s, flight: remembered(s.flight) })),
  });
  const configId = airport.defaultConfiguration ?? airport.configurations[0]?.id;
  const config = airport.configurations.find((c) => c.id === configId);
  const session: Session = {
    airport,
    sim,
    seed: options.seed,
    traffic: { live: rates !== undefined, skipped: traffic.skipped },
    counters: options.counters ?? NO_COUNTERS,
    controls: { speed: 1, paused: false },
    clock: initialClock(),
    log: initialLog(),
    logContext: { tickHz: TICK_HZ, gateLabel: gateLabeler(airport) },
    previous: [],
    current: [],
    alpha: 0,
    terminals,
    departureEnds: (config?.runways ?? []).filter((r) => r.roles.includes('departures')).map((r) => r.end),
  };
  session.current = snapshot(session);
  session.previous = session.current;
  return session;
}

/**
 * One animation frame, `realDtS` seconds after the last: runs the ticks due, and returns the log
 * lines for what happened in them.
 */
export function advance(session: Session, realDtS: number): LogLine[] {
  const due = advanceClock(session.clock, realDtS, session.controls, { tickS: TICK_S, maxTicksPerFrame: MAX_TICKS_PER_FRAME });
  session.clock = due.state;
  session.alpha = due.alpha;
  if (due.ticks > 0) {
    step(session.sim, due.ticks - 1);
    session.previous = snapshot(session);
    step(session.sim, 1);
    session.current = snapshot(session);
  }
  return drain(session);
}

/** What the log says at the start: an airport with no live traffic, and terminals left out of it. */
export function startupLines(session: Session): LogLine[] {
  const line = (text: string): LogLine => ({ tick: 0, time: formatSimTime(0), kind: 'info', callsign: null, text });
  if (!session.traffic.live) {
    const live = Object.keys(TRAFFIC_RATES).sort().join(' and ');
    return [line(`No live traffic at ${session.airport.id}: the map only. Traffic runs at ${live}.`)];
  }
  return session.traffic.skipped.map((s) => line(`No traffic at ${s.terminal}: ${s.reason}`));
}

export type SubmitResult = { ok: true; lines: LogLine[] } | { ok: false; error: ParseError };

/**
 * The dev console's Enter: parses `input` (terse syntax, parseTerse) and applies it now
 * (applyCommand). Returns the player's line, echoed as typed, and the lines for what it caused at
 * once (e.g. "unable"); or parseTerse's error, with nothing applied.
 */
export function submit(session: Session, input: string): SubmitResult {
  const text = input.trim();
  const parsed = parseTerse(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const tick = session.sim.world.tick;
  const echo: LogLine = { tick, time: formatSimTime(tick / TICK_HZ), kind: 'player', callsign: parsed.command.callsign, text };
  applyCommand(session.sim, parsed.command);
  return { ok: true, lines: [echo, ...drain(session)] };
}

/**
 * The T key (PRD §4.5): asks tower for the next runway crossing on `callsign`'s route, as the
 * terse `request-crossing`. Tower answers after a beat, in a later frame's lines.
 */
export function requestCrossing(session: Session, callsign: string): LogLine[] {
  const result = submit(session, `${callsign} request-crossing`);
  // The callsign comes from the map, so it always parses; a failure here is a bug.
  if (!result.ok) throw new Error(`request-crossing for "${callsign}" didn't parse: ${result.error.message}`);
  return result.lines;
}

/** The aircraft as this frame draws them, between the last two ticks. */
export function drawnAircraft(session: Session): MapAircraft[] {
  return interpolateAircraft(session.previous, session.current, session.alpha);
}

/** The events since the last drain: to the counters, then as log lines. */
function drain(session: Session): LogLine[] {
  const events = drainEvents(session.sim);
  if (events.length === 0) return [];
  session.counters.observe(events, session.sim);
  const { state, lines } = logEvents(session.log, events, session.logContext);
  session.log = state;
  return lines;
}

function snapshot(session: Session): MapAircraft[] {
  return listAircraft(session.sim).map((view) =>
    fromAircraftView(view, {
      destination: destinationOf(view, { terminal: session.terminals.get(view.callsign) ?? null, departureEnds: session.departureEnds }),
      delayed: false,
    }),
  );
}

/** "T4 gate B25" for a gate id. Throws for an unknown id: the sim named a gate the airport doesn't have. */
function gateLabeler(airport: Airport): (gateId: string) => string {
  const gates = new Map(airport.gates.map((g) => [g.id, `${g.terminal} gate ${g.name}`]));
  return (id) => {
    const label = gates.get(id);
    if (label === undefined) throw new Error(`no gate ${id} at ${airport.id}`);
    return label;
  };
}

/**
 * Asks the sim whether a type can depart from a terminal: a throwaway sim on the empty airport
 * with one departure stream, one tick. The ramp spawns a departure only at a gate it fits and can
 * push back from (ramp.ts), so a spawn means yes. About 80 ms for all of KJFK's.
 */
function canDepartProbe(airport: Airport): CanDepart {
  const index = indexAirport(airport);
  const known = new Map<string, boolean>();
  return (terminal, type: AircraftTypeCode) => {
    const key = `${terminal}|${type}`;
    let can = known.get(key);
    if (can === undefined) {
      const probe = createSim(index, { seed: 1, departures: [{ perHour: 1, flight: () => ({ callsign: 'PROBE1', type, terminal }) }] });
      step(probe, 1);
      can = listAircraft(probe).length > 0;
      known.set(key, can);
    }
    return can;
  };
}

