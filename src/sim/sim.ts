// The simulation core's public API (PLAN 1.9): create a sim on an airport with a seed, add
// aircraft, apply commands, step fixed ticks (as many as wanted, faster than real time), read
// state, drain events. Headless and deterministic: no clock, no timers, and all randomness
// from the seeded RNG (PRD §8.2, §9.3).
//
//   const sim = createSim(indexAirport(airport), { seed: 1 });
//   addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'rb7', arrivedVia: 'rb7-l7A' } });
//   applyCommand(sim, command);            // a Command from commands.ts, e.g. via parseTerse
//   step(sim, 600);                        // one simulated minute at TICK_HZ = 10
//   getAircraft(sim, 'DAL4').status;       // 'taxiing'
//   drainEvents(sim);                      // what happened since the last drain
//
// The simulated tower (tower.ts, PLAN 1.10) runs the airport's runway configuration. Arrivals
// come from streams in the options or from addAircraft on final:
//   createSim(index, { seed: 1, arrivals: [{ runwayEnd: '31L', perHour: 15, flight: (n) => ({ callsign: `AAL${n + 1}`, type: 'A321' }) }] });
//   addAircraft(sim, { callsign: 'UAE202', type: 'A388', at: { kind: 'final', runwayEnd: '31R', distanceM: 9000 } });
//
// The simulated ramp (ramp.ts, PLAN 1.11) owns the gates and ramp lanes. Departures come from
// streams in the options or from addAircraft at a gate; they push back and call ground at the
// ramp edge (`check-in`). Arrivals handed to ramp at a ramp entrance go to a gate (`arrived-at-gate`):
//   createSim(index, { seed: 1, departures: [{ perHour: 12, flight: (n) => ({ callsign: `JBU${n + 1}`, type: 'A320', terminal: 'T1' }) }] });
//   addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'gate', gate: 'T1-1' } });
//   getGate(sim, 'T1-1').occupant;         // 'DAL4'
// An arrival the ramp has parked turns around after a while (ramp.ts, "Turnarounds"): it leaves
// again as a new departure from its gate (`turnaround`, with the new callsign), or is towed to a
// hangar and removed (`towed-to-hangar`). `turnaround: false` in the options turns that off.
//
// Rule checks and score (rules.ts, score.ts, PLAN 1.12) run every tick. A collision or a gridlock
// ends the session; the counters are plain data for the live display and the end report:
//   getSession(sim);                       // { state: 'running' }, or { state: 'ended', tick, cause }
//   getScore(sim).combined.peakPerHour;    // the best 15 minutes, per hour
//   getUnauthorizedCrossings(sim);         // [{ tick, callsign, holdShort, runways }]

import { otherEnd, type AirportIndex } from '../airport/graph.ts';
import type { EdgeId, GateId, NodeId, Point, RunwayEndDesignator, TerminalId } from '../airport/types.ts';
import { AIRCRAFT_TYPES, isAircraftType } from './aircraft-types.ts';
import type { Taxi } from './commands.ts';
import { hashOf } from './hash.ts';
import { KNOT_MPS, moveTaxiing, PILOT_SPEED_SPREAD, TAXI_SPEED_KT, updateRunways } from './movement.ts';
import { APPROACH_SPEED_MPS, dropAircraft, FINAL_SPAWN_M, finalOfArrival, initialTowerState, placeOnFinal, towerDecide, towerMove, towerSetup, towerSpawns, type TowerOptions } from './tower.ts';
import { adoptAtGate, gateOccupant, initialRampState, placeAtGate, rampDecide, rampDrop, rampMove, rampSetup, rampSpawns, rampTurnarounds, type RampOptions } from './ramp.ts';
import { checkRules, initialRulesState } from './rules.ts';
import { initialScore, recordScore, scoreView, type ScoreView } from './score.ts';
import { dropMovement, initialReservations, updateReservations } from './reservations.ts';
import { occupancyOf } from './traffic.ts';
import { runwayAreas, runwaysOccupied } from './occupancy.ts';
import { createRng, nextInRange } from './rng.ts';
import type { RoutePath, RouteStart } from './route.ts';
import { buildTrack, placeOf, pointOf, type Track } from './track.ts';
import { emit, type Advisories, type Aircraft, type AircraftStatus, type Controller, type CrossingClearance, type Role, type Session, type Sim, type SimEvent, type UnauthorizedCrossing } from './world.ts';

export { AIRCRAFT_TYPES, type AircraftTypeCode } from './aircraft-types.ts';
export { applyCommand } from './apply.ts';
export { footprintOf, footprintsOverlap, polygonsOverlap } from './footprint.ts';
export { GRIDLOCK_S } from './rules.ts';
export { PEAK_WINDOW_S, type Rates, type ScoreView } from './score.ts';
export { TICK_HZ, TICK_S } from './movement.ts';
export { canDepartFrom } from './ramp.ts';
export type { DepartureFlight, DepartureStream, RampOptions, TurnaroundInbound, TurnaroundOptions } from './ramp.ts';
export type { ArrivalFlight, ArrivalStream, TowerOptions } from './tower.ts';
export type { Advisories, AircraftStatus, Controller, CrossingClearance, Motion, Role, RuleOrigin, RuleParty, Session, SessionEndCause, Sim, SimEvent, UnauthorizedCrossing } from './world.ts';

export interface SimOptions extends TowerOptions, RampOptions {
  /** Seeds the RNG. The same seed and the same commands give the same session. */
  seed: number;
}

/**
 * A new sim. The tower (tower.ts) runs the configuration in `options` (default: the airport's
 * default), and spawns the arrival streams in it (default: none). Throws for an unknown
 * configuration, or a stream for a runway end that takes no arrivals or none it can land on.
 */
export function createSim(index: AirportIndex, options: SimOptions): Sim {
  const areas = runwayAreas(index);
  const tower = towerSetup(index, areas, options);
  const ramp = rampSetup(index, options);
  const world = {
    tick: 0,
    rng: createRng(options.seed),
    aircraft: [],
    tower: initialTowerState(tower),
    ramp: initialRampState(ramp, options.seed),
    session: { state: 'running' } as const,
    rules: initialRulesState(),
    score: initialScore(),
    reservations: initialReservations(),
  };
  return { index, world, events: [], runwayAreas: areas, tower, ramp };
}

/** Where a new aircraft appears. */
export type SpawnPosition =
  /**
   * Stopped at `node`, nose on it, having arrived along `arrivedVia` (its body lies along that
   * edge). null: no heading, e.g. parked on a pad spot; its body is then just the node.
   */
  | { kind: 'node'; node: NodeId; arrivedVia: EdgeId | null }
  /** On `edge`, heading away from `from`, nose `distanceM` along it. */
  | { kind: 'edge'; edge: EdgeId; from: NodeId; distanceM: number }
  /**
   * On final for `runwayEnd`, `distanceM` before its landing threshold, at the approach speed
   * (tower.ts). An arrival under tower: its role defaults to 'arrival', and `controller` and
   * `speedMps` can't be given. Throws if the runway end takes no arrivals in the configuration.
   */
  | { kind: 'final'; runwayEnd: RunwayEndDesignator; distanceM: number }
  /**
   * Parked at `gate`, nose on the gate node, under ramp (ramp.ts). A departure (the default
   * role) boards, then asks to push; an arrival stays parked. Its terminal defaults to the
   * gate's. `controller` and `speedMps` can't be given. Throws if the gate is taken or can't
   * take this type.
   */
  | { kind: 'gate'; gate: GateId };

export interface AircraftSpec {
  callsign: string;
  /** An ICAO type designator in AIRCRAFT_TYPES. */
  type: string;
  at: SpawnPosition;
  /** Its terminal, for a taxi to "the ramp". Default null. */
  terminal?: TerminalId | null;
  /** Default 'departure'. */
  role?: Role;
  /** ICAO airline designator, e.g. "DAL", for "the company hangar". Default null. */
  airline?: string | null;
  /**
   * Default 'ground' ('tower' on final, 'ramp' at a gate). 'ramp' aircraft take no player
   * transmissions; one added anywhere but a gate stays where it's put (ramp.ts has no plan for
   * it). Tower takes ground aircraft only by handoff.
   */
  controller?: 'ground' | 'ramp';
  /** Initial speed, m/s. Default 0. */
  speedMps?: number;
  /**
   * This pilot's straight-line taxi speed. Default: TAXI_SPEED_KT ± PILOT_SPEED_SPREAD, from the
   * RNG. The RNG is drawn either way, so setting one aircraft's speed doesn't shift the others'.
   */
  taxiSpeedKt?: number;
}

/**
 * Adds an aircraft. Throws for a duplicate callsign, an unknown type, or a position that isn't
 * on the airport: those are the caller's bugs.
 */
export function addAircraft(sim: Sim, spec: AircraftSpec): void {
  if (sim.world.aircraft.some((a) => a.callsign === spec.callsign)) throw new Error(`aircraft ${spec.callsign} already exists`);
  if (!isAircraftType(spec.type)) throw new Error(`${spec.callsign}: unknown aircraft type "${spec.type}"`);
  const { lengthM, wingspanM } = AIRCRAFT_TYPES[spec.type];
  const onFinal = spec.at.kind === 'final';
  if (onFinal && (spec.controller !== undefined || spec.speedMps !== undefined)) {
    throw new Error(`${spec.callsign}: an arrival on final is tower's, at the approach speed; don't give controller or speedMps`);
  }
  const atGate = spec.at.kind === 'gate' ? placeAtGate(sim, spec.callsign, spec.at.gate, spec.type, spec.role ?? 'departure') : null;
  if (atGate && (spec.controller !== undefined || spec.speedMps !== undefined)) {
    throw new Error(`${spec.callsign}: an aircraft at a gate is ramp's, parked; don't give controller or speedMps`);
  }
  if (atGate && spec.terminal != null && spec.terminal !== atGate.terminal) {
    throw new Error(`${spec.callsign}: gate ${spec.at.kind === 'gate' ? spec.at.gate : ''} is at ${atGate.terminal}, not ${spec.terminal}`);
  }
  const { track, s } =
    spec.at.kind === 'final' ? placeOnFinal(sim, spec.callsign, spec.at.runwayEnd, spec.at.distanceM, lengthM) : (atGate ?? spawnTrack(sim.index, spec));
  const factor = nextInRange(sim.world.rng, 1 - PILOT_SPEED_SPREAD, 1 + PILOT_SPEED_SPREAD);
  const cruiseKt = spec.taxiSpeedKt ?? TAXI_SPEED_KT * factor;
  const advisories: Advisories = {
    handoff: null,
    atis: null,
    groundStop: null,
    releaseTime: null,
    holdForRelease: false,
    expectDelayMinutes: null,
  };
  const aircraft: Aircraft = {
    callsign: spec.callsign,
    type: spec.type,
    lengthM,
    wingspanM,
    role: spec.role ?? (onFinal ? 'arrival' : 'departure'),
    airline: spec.airline ?? null,
    controller: onFinal ? 'tower' : atGate ? 'ramp' : (spec.controller ?? 'ground'),
    // The ramp moves its own; one with no gate stays where it was put.
    motion: onFinal || atGate || spec.controller === 'ramp' ? 'controller' : 'taxi',
    airborne: onFinal,
    terminal: atGate?.terminal ?? spec.terminal ?? null,
    cruiseMps: cruiseKt * KNOT_MPS,
    track,
    s,
    v: onFinal ? APPROACH_SPEED_MPS : (spec.speedMps ?? 0),
    clearance: null,
    crossings: [],
    holdPosition: false,
    status: onFinal ? 'on-final' : atGate ? 'parked' : 'idle',
    blockedBy: null,
    runways: [],
    advisories,
  };
  aircraft.runways = runwaysOccupied(sim.runwayAreas, aircraft);
  sim.world.aircraft.push(aircraft);
  if (spec.at.kind === 'gate') adoptAtGate(sim, spec.callsign, spec.at.gate, aircraft.role);
}

function spawnTrack(index: AirportIndex, spec: AircraftSpec): { track: Track; s: number } {
  const at = spec.at;
  if (at.kind === 'final' || at.kind === 'gate') throw new Error(`spawnTrack: a ${at.kind} position is placed by its controller`);
  const edgeOf = (id: EdgeId) => {
    const edge = index.edges.get(id);
    if (!edge) throw new Error(`${spec.callsign}: unknown edge "${id}"`);
    return edge;
  };
  if (at.kind === 'node') {
    if (!index.nodes.has(at.node)) throw new Error(`${spec.callsign}: unknown node "${at.node}"`);
    if (at.arrivedVia === null) return { track: buildTrack(index, [at.node], []), s: 0 };
    const edge = edgeOf(at.arrivedVia);
    const track = buildTrack(index, [otherEnd(edge, at.node), at.node], [edge.id]);
    return { track, s: track.lengthM };
  }
  const edge = edgeOf(at.edge);
  const track = buildTrack(index, [at.from, otherEnd(edge, at.from)], [edge.id]);
  if (!(at.distanceM >= 0 && at.distanceM <= track.lengthM)) {
    throw new Error(`${spec.callsign}: distance ${at.distanceM} is off edge "${edge.id}" (0–${track.lengthM} m)`);
  }
  return { track, s: at.distanceM };
}

/**
 * Advances `ticks` fixed ticks (default 1). After the session has ended (`getSession`), the sim
 * still advances: aircraft keep moving and events keep coming, but the rules and the score no
 * longer count anything, so what they hold is the session as it ended. A caller that wants the
 * session over (the browser app) stops stepping.
 */
export function step(sim: Sim, ticks = 1): void {
  if (!Number.isInteger(ticks) || ticks < 0) throw new Error(`step: ticks must be a whole number ≥ 0, got ${ticks}`);
  for (let i = 0; i < ticks; i++) advance(sim);
}

/**
 * Removes an aircraft from the sim, and everything tower and ramp hold about it (a test's or a
 * later task's sink, e.g. an arrival the ramp has parked): its gate is free. Throws if there's none.
 */
export function removeAircraft(sim: Sim, callsign: string): void {
  if (!sim.world.aircraft.some((a) => a.callsign === callsign)) throw new Error(`no aircraft ${callsign}`);
  dropAircraft(sim, callsign);
  rampDrop(sim, callsign);
  dropMovement(sim, callsign);
}

/**
 * One tick, in this order (world.ts, "Controllers"):
 * 1. The tick count goes up. Events of this tick carry the new count.
 * 2. The controllers decide, on the state as the last tick left it: the tower's arrival streams
 *    spawn, then the tower decides (towerDecide); the reservations give back what movements have
 *    left and grant them more ahead (updateReservations); parked arrivals due to turn around do
 *    (rampTurnarounds: towed and removed, or removed and added back as a departure); the ramp's
 *    departure streams spawn at gates, then the ramp decides (rampDecide).
 * 3. Every body's place is taken (traffic.ts): the start of this tick's movement.
 * 4. Aircraft that taxi move (movement.ts), each planning from those places. That includes the
 *    ramp's on ramp lanes.
 * 5. Aircraft a controller moves itself are moved by it, from the same places: tower's (towerMove,
 *    which removes the departures that have left), then the ramp's pushbacks (rampMove, which also
 *    hands departures to ground at the ramp edge and parks arrivals at their gates).
 * 6. Each aircraft's runway areas are updated (crossed-runway events).
 * 7. While the session is running: the tick's scoring points are counted (score.ts), then the
 *    rules (rules.ts) check the state the tick left, with the events it emitted. A lift-off or
 *    a gate arrival in the tick a collision ends the session still counts.
 */
function advance(sim: Sim): void {
  const firstEvent = sim.events.length;
  sim.world.tick += 1;
  for (const flight of towerSpawns(sim)) {
    const { runwayEnd, callsign, type, airline, terminal } = flight;
    addAircraft(sim, { callsign, type, airline: airline ?? null, terminal: terminal ?? null, at: { kind: 'final', runwayEnd, distanceM: FINAL_SPAWN_M } });
  }
  towerDecide(sim);
  updateReservations(sim);
  for (const due of rampTurnarounds(sim)) {
    removeAircraft(sim, due.callsign);
    if (due.kind === 'tow') {
      emit(sim, { type: 'towed-to-hangar', tick: sim.world.tick, callsign: due.callsign, gate: due.gate });
      continue;
    }
    addAircraft(sim, { callsign: due.newCallsign, type: due.type, airline: due.airline, role: 'departure', at: { kind: 'gate', gate: due.gate } });
    emit(sim, { type: 'turnaround', tick: sim.world.tick, callsign: due.callsign, gate: due.gate, newCallsign: due.newCallsign });
  }
  for (const { callsign, type, airline, gate } of rampSpawns(sim)) addAircraft(sim, { callsign, type, airline: airline ?? null, at: { kind: 'gate', gate } });
  rampDecide(sim);
  const occupancy = occupancyOf(sim);
  moveTaxiing(sim, occupancy);
  towerMove(sim, occupancy);
  rampMove(sim);
  updateRunways(sim);
  const events = sim.events.slice(firstEvent);
  if (sim.world.session.state === 'running') recordScore(sim.world.score, events);
  checkRules(sim, events);
}

/**
 * A fingerprint of the whole simulation state (the world: tick, RNG, every aircraft, tower and
 * ramp, the session, the rules' records and the score), for determinism checks. Events and the
 * airport aren't state, so they're not in it.
 */
export function stateHash(sim: Sim): string {
  return hashOf(sim.world);
}

/** A gate, and the aircraft holding it: parked there, pushing from it, or an arrival assigned to it. */
export interface GateView {
  id: GateId;
  terminal: TerminalId;
  occupant: string | null;
}

/** The gate `id`. Throws if there's none. */
export function getGate(sim: Sim, id: GateId): GateView {
  const gate = sim.index.airport.gates.find((g) => g.id === id);
  if (!gate) throw new Error(`no gate ${id}`);
  return { id, terminal: gate.terminal, occupant: gateOccupant(sim, id) };
}

/**
 * Whether the session is running, or how and when it ended (rules.ts): plain data, the sim's own
 * object, so don't change it.
 */
export function getSession(sim: Sim): Readonly<Session> {
  return sim.world.session;
}

/**
 * The counters (score.ts): totals, average and peak rates, for departures, arrivals and both. As
 * of now while the session runs; once it has ended, as of the tick it ended.
 */
export function getScore(sim: Sim): ScoreView {
  const session = sim.world.session;
  return scoreView(sim.world.score, session.state === 'ended' ? session.tick : sim.world.tick);
}

/** Every unauthorized runway crossing so far, oldest first (rules.ts). The sim's own records: don't change them. */
export function getUnauthorizedCrossings(sim: Sim): readonly Readonly<UnauthorizedCrossing>[] {
  return sim.world.rules.unauthorizedCrossings;
}

/** Takes every event since the last drain, oldest first. */
export function drainEvents(sim: Sim): SimEvent[] {
  return sim.events.splice(0);
}

/** Where an aircraft's nose is on the graph. */
export type Location =
  /** Exactly at `node`, arrived along `arrivedVia` (null: no heading). */
  | { kind: 'node'; node: NodeId; arrivedVia: EdgeId | null }
  /** Inside `edge`, moving from `from` to `to`, `distanceM` from `from`. */
  | { kind: 'edge'; edge: EdgeId; from: NodeId; to: NodeId; distanceM: number };

/**
 * A picture of one aircraft at the moment it's taken, for tests, the renderer and the later
 * tasks. The clearance's taxi, start and path are the sim's own objects: don't change them.
 */
export interface AircraftView {
  callsign: string;
  type: string;
  lengthM: number;
  wingspanM: number;
  role: Role;
  airline: string | null;
  controller: Controller;
  /** On final or after takeoff (world.ts). */
  airborne: boolean;
  /**
   * On final (status 'on-final'): the runway end, and how far it is from the landing threshold.
   * null otherwise.
   */
  final: { runwayEnd: RunwayEndDesignator; distanceM: number } | null;
  status: AircraftStatus;
  speedMps: number;
  /** Before the runway's end on final, off the graph: the runway end's node, with no heading. */
  location: Location;
  /** The nose, in the airport's local frame. */
  nose: Point;
  /** Degrees clockwise from north. null: no heading (parked on a node with no edge). */
  headingDeg: number | null;
  /**
   * The taxi clearance and its path. `distanceM`: how far the nose is along the path from
   * its first node; negative while still on the edge it was on when the clearance came.
   */
  clearance: { taxi: Taxi; start: RouteStart; path: RoutePath; distanceM: number } | null;
  crossings: CrossingClearance[];
  holdPosition: boolean;
  blockedBy: string | null;
  advisories: Advisories;
}

/** The aircraft with `callsign`. Throws if there's none. */
export function getAircraft(sim: Sim, callsign: string): AircraftView {
  const ac = sim.world.aircraft.find((a) => a.callsign === callsign);
  if (!ac) throw new Error(`no aircraft ${callsign}`);
  return view(sim, ac);
}

/** Every aircraft, in the order added. */
export function listAircraft(sim: Sim): AircraftView[] {
  return sim.world.aircraft.map((ac) => view(sim, ac));
}

function view(sim: Sim, ac: Aircraft): AircraftView {
  const { point, headingDeg } = noseOf(ac);
  const clearance = ac.clearance;
  return {
    callsign: ac.callsign,
    type: ac.type,
    lengthM: ac.lengthM,
    wingspanM: ac.wingspanM,
    role: ac.role,
    airline: ac.airline,
    controller: ac.controller,
    airborne: ac.airborne,
    final: finalOf(sim, ac),
    status: ac.status,
    speedMps: ac.v,
    location: locationOf(ac),
    nose: point,
    headingDeg,
    clearance: clearance && {
      taxi: clearance.taxi,
      start: clearance.start,
      path: clearance.path,
      distanceM: ac.s - valueAt(ac.track.nodeAt, clearance.pathOffset),
    },
    // Copies: the sim changes these in place. The clearance's parts it only ever replaces.
    crossings: ac.crossings.map((c) => ({ ...c, runways: [...c.runways] })),
    holdPosition: ac.holdPosition,
    blockedBy: ac.blockedBy,
    advisories: { ...ac.advisories },
  };
}

/** The nose and heading. Before the track's start (on final), straight back along its first segment. */
function noseOf(ac: Aircraft): { point: Point; headingDeg: number | null } {
  const at = pointOf(ac.track, ac.s);
  if (ac.s >= 0 || at.headingDeg === null) return at;
  const rad = (at.headingDeg * Math.PI) / 180;
  return { point: [at.point[0] + Math.sin(rad) * ac.s, at.point[1] + Math.cos(rad) * ac.s], headingDeg: at.headingDeg };
}

function finalOf(sim: Sim, ac: Aircraft): AircraftView['final'] {
  if (ac.status !== 'on-final') return null;
  const final = finalOfArrival(sim, ac.callsign);
  if (final === null) throw new Error(`${ac.callsign}: on final, but tower has no record of it`);
  return final;
}

function locationOf(ac: Aircraft): Location {
  const track = ac.track;
  const place = placeOf(track, ac.s);
  if (place.kind === 'node') {
    const node = track.nodes[place.i];
    if (node === undefined) throw new Error(`${ac.callsign}: track node ${place.i} is missing`);
    return { kind: 'node', node, arrivedVia: place.i > 0 ? (track.edges[place.i - 1] ?? null) : null };
  }
  const [edge, from, to] = [track.edges[place.i], track.nodes[place.i], track.nodes[place.i + 1]];
  if (edge === undefined || from === undefined || to === undefined) throw new Error(`${ac.callsign}: track edge ${place.i} is missing`);
  return { kind: 'edge', edge, from, to, distanceM: ac.s - valueAt(track.nodeAt, place.i) };
}

function valueAt(values: number[], i: number): number {
  const value = values[i];
  if (value === undefined) throw new Error(`index ${i} out of range`);
  return value;
}
