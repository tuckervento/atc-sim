// A playing session in the browser (PLAN 1.13), without the DOM: the sim with its traffic, run
// in real time by the fixed-step clock, drawn between ticks, its events turned into log lines.
// The page (ui.ts, main.ts) calls `advance` once per animation frame and draws `drawnAircraft`.

import { edgePolyline, indexAirport, type AirportIndex } from '../../airport/graph.ts';
import type { Airport, Point } from '../../airport/types.ts';
import { applyCommand, canDepartFrom, createSim, drainEvents, getSession, listAircraft, step, TICK_HZ, TICK_S, type Sim } from '../../sim/sim.ts';
import { parseTerse, type ParseError } from '../../sim/terse.ts';
import { fromAircraftView, type MapAircraft } from '../map/aircraft.ts';
import { advanceClock, initialClock, type ClockControls, type ClockState } from './clock.ts';
import { NO_COUNTERS, type Counters } from './counters.ts';
import { destinationOf } from './destination.ts';
import { formatSimTime, initialLog, logEvents, type LogContext, type LogLine, type LogState } from './event-log.ts';
import { interpolateAircraft } from './interpolate.ts';
import { sessionEnd, type EndContext, type SessionEndText } from './session-end.ts';
import { TRAFFIC_RATES, trafficFor, type SkippedTerminal, type Traffic } from './traffic.ts';

/** Catch-up limit: at 4× and 60 frames a second, a frame needs under one tick. */
export const MAX_TICKS_PER_FRAME = 8;

export interface SessionOptions {
  seed: number;
  /** The live counters' source (counters.ts): the app passes scoreCounters(). Default NO_COUNTERS (placeholders). */
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
  /** How the session's end is said (session-end.ts): the banner's and the log's. */
  readonly endContext: EndContext;
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
  // The traffic flies only what can leave its terminal (the sim's canDepartFrom). The answer is about
  // the airport, so a sim with no traffic answers it, before the session's own sim exists.
  const empty = createSim(index, { seed: options.seed });
  const traffic: Traffic = rates
    ? trafficFor(airport, options.seed, rates, (terminal, type) => canDepartFrom(empty, terminal, type))
    : {
        arrivals: [],
        departures: [],
        skipped: [],
        // No traffic, so no arrival to turn around.
        turnaroundCallsign: (_, inbound) => {
          throw new Error(`${inbound.callsign}: a turnaround at ${airport.id}, which has no traffic`);
        },
      };
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
    // A parked arrival that departs again (ramp.ts, "Turnarounds") gets its new flight number
    // from the traffic, and keeps its terminal.
    turnaround: {
      callsign: (n, inbound) => {
        const callsign = traffic.turnaroundCallsign(n, inbound);
        terminals.set(callsign, terminals.get(inbound.callsign) ?? null);
        return callsign;
      },
    },
  });
  const configId = airport.defaultConfiguration ?? airport.configurations[0]?.id;
  const config = airport.configurations.find((c) => c.id === configId);
  const runwayName = runwayNamer(airport, config?.runways.map((r) => r.end) ?? []);
  const endContext: EndContext = { tickHz: TICK_HZ, runwayName, nearestTaxiway: nearestTaxiwayFinder(index) };
  const session: Session = {
    airport,
    sim,
    seed: options.seed,
    traffic: { live: rates !== undefined, skipped: traffic.skipped },
    counters: options.counters ?? NO_COUNTERS,
    controls: { speed: 1, paused: false },
    clock: initialClock(),
    log: initialLog(),
    logContext: { tickHz: TICK_HZ, gateLabel: gateLabeler(airport), holdLine: holdLineLabeler(airport, runwayName), entranceName: entranceNamer(airport), endLine: (ended) => sessionEnd(ended, endContext).log },
    endContext,
    previous: [],
    current: [],
    alpha: 0,
    terminals,
    departureEnds: (config?.runways ?? []).filter((r) => r.roles.includes('departures')).map((r) => r.end),
  };
  session.current = snapshot(session);
  session.previous = session.current;
  // The counters see the sim from the start, before its first events.
  session.counters.observe([], sim);
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

/** The banner's text once the session has ended (a collision or a gridlock, rules.ts); null while it runs. */
export function endedText(session: Session): SessionEndText | null {
  const state = getSession(session.sim);
  return state.state === 'ended' ? sessionEnd(state, session.endContext) : null;
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

/**
 * A hold line as the pilot says it: its runways the way tower says them (tower.ts: the end in use
 * in the configuration, else the first end), and the name of its edge toward the runway, the
 * taxiway it's on. Throws for an unknown id: the sim named a hold line the airport doesn't have.
 */
function holdLineLabeler(airport: Airport, runwayName: (id: string) => string): NonNullable<LogContext['holdLine']> {
  const edges = new Map(airport.edges.map((e) => [e.id, e]));
  return (id) => {
    const hold = airport.holdShorts.find((h) => h.id === id);
    if (!hold) throw new Error(`no hold line ${id} at ${airport.id}`);
    return { runways: hold.runways.map(runwayName), taxiway: edges.get(hold.towardEdge)?.name ?? null };
  };
}

/** A ramp entrance's name ("KG"). Throws for an unknown id. */
function entranceNamer(airport: Airport): (id: string) => string {
  const names = new Map(airport.rampHandoffs.map((h) => [h.id, h.name]));
  return (id) => {
    const name = names.get(id);
    if (name === undefined) throw new Error(`no ramp entrance ${id} at ${airport.id}`);
    return name;
  };
}

/** A runway id as tower says it (tower.ts): its end in use in the configuration, else its first end. Throws for an unknown id. */
function runwayNamer(airport: Airport, endsInUse: readonly string[]): (id: string) => string {
  const said = new Map(airport.runways.map((r) => [r.id, r.ends.find((e) => endsInUse.includes(e.designator))?.designator ?? r.ends[0].designator]));
  return (id) => {
    const name = said.get(id);
    if (name === undefined) throw new Error(`no runway ${id} at ${airport.id}`);
    return name;
  };
}

/** How far a named taxiway or lane may be from a place to name it, meters. Mine: about two aircraft lengths. */
const NEAR_M = 150;

/** The nearest named taxiway or ramp lane to a point, within NEAR_M; null if none. Runways name themselves (a cause's `runways`). */
function nearestTaxiwayFinder(index: AirportIndex): (p: Point) => string | null {
  const named = index.airport.edges
    .filter((e) => (e.kind === 'taxiway' || e.kind === 'rampLane') && e.name !== undefined)
    .map((e) => ({ name: e.name ?? '', line: edgePolyline(index, e) }));
  return (p) => {
    let best: { name: string; d: number } | null = null;
    for (const { name, line } of named) {
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1], line[i]];
        if (!a || !b) continue;
        const d = distanceToSegment(p, a, b);
        if (d <= NEAR_M && (best === null || d < best.d)) best = { name, d };
      }
    }
    return best?.name ?? null;
  };
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
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
