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

import { otherEnd, type AirportIndex } from '../airport/graph.ts';
import type { EdgeId, NodeId, Point, TerminalId } from '../airport/types.ts';
import { AIRCRAFT_TYPES, isAircraftType } from './aircraft-types.ts';
import type { Taxi } from './commands.ts';
import { hashOf } from './hash.ts';
import { advance, KNOT_MPS, PILOT_SPEED_SPREAD, TAXI_SPEED_KT } from './movement.ts';
import { runwayAreas, runwaysOccupied } from './occupancy.ts';
import { createRng, nextInRange } from './rng.ts';
import type { RoutePath, RouteStart } from './route.ts';
import { buildTrack, placeOf, pointOf, type Track } from './track.ts';
import type { Advisories, Aircraft, AircraftStatus, CrossingClearance, Sim, SimEvent } from './world.ts';

export { AIRCRAFT_TYPES, type AircraftTypeCode } from './aircraft-types.ts';
export { applyCommand } from './apply.ts';
export { footprintOf, footprintsOverlap, polygonsOverlap } from './footprint.ts';
export { TICK_HZ, TICK_S } from './movement.ts';
export type { Advisories, AircraftStatus, CrossingClearance, Sim, SimEvent } from './world.ts';

export interface SimOptions {
  /** Seeds the RNG. The same seed and the same commands give the same session. */
  seed: number;
}

export function createSim(index: AirportIndex, options: SimOptions): Sim {
  return { index, world: { tick: 0, rng: createRng(options.seed), aircraft: [] }, events: [], runwayAreas: runwayAreas(index) };
}

/** Where a new aircraft appears. */
export type SpawnPosition =
  /**
   * Stopped at `node`, nose on it, having arrived along `arrivedVia` (its body lies along that
   * edge). null: no heading, e.g. parked on a pad spot; its body is then just the node.
   */
  | { kind: 'node'; node: NodeId; arrivedVia: EdgeId | null }
  /** On `edge`, heading away from `from`, nose `distanceM` along it. */
  | { kind: 'edge'; edge: EdgeId; from: NodeId; distanceM: number };

export interface AircraftSpec {
  callsign: string;
  /** An ICAO type designator in AIRCRAFT_TYPES. */
  type: string;
  at: SpawnPosition;
  /** Its terminal, for a taxi to "the ramp". Default null. */
  terminal?: TerminalId | null;
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
  const { track, s } = spawnTrack(sim.index, spec);
  const factor = nextInRange(sim.world.rng, 1 - PILOT_SPEED_SPREAD, 1 + PILOT_SPEED_SPREAD);
  const cruiseKt = spec.taxiSpeedKt ?? TAXI_SPEED_KT * factor;
  const { lengthM, wingspanM } = AIRCRAFT_TYPES[spec.type];
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
    terminal: spec.terminal ?? null,
    cruiseMps: cruiseKt * KNOT_MPS,
    track,
    s,
    v: spec.speedMps ?? 0,
    clearance: null,
    crossings: [],
    holdPosition: false,
    status: 'idle',
    blockedBy: null,
    runways: [],
    advisories,
  };
  aircraft.runways = runwaysOccupied(sim.runwayAreas, aircraft);
  sim.world.aircraft.push(aircraft);
}

function spawnTrack(index: AirportIndex, spec: AircraftSpec): { track: Track; s: number } {
  const at = spec.at;
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

/** Advances `ticks` fixed ticks (default 1). */
export function step(sim: Sim, ticks = 1): void {
  if (!Number.isInteger(ticks) || ticks < 0) throw new Error(`step: ticks must be a whole number ≥ 0, got ${ticks}`);
  for (let i = 0; i < ticks; i++) advance(sim);
}

/**
 * A fingerprint of the whole simulation state (the world: tick, RNG, every aircraft), for
 * determinism checks. Events and the airport aren't state, so they're not in it.
 */
export function stateHash(sim: Sim): string {
  return hashOf(sim.world);
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
  status: AircraftStatus;
  speedMps: number;
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
  return view(ac);
}

/** Every aircraft, in the order added. */
export function listAircraft(sim: Sim): AircraftView[] {
  return sim.world.aircraft.map(view);
}

function view(ac: Aircraft): AircraftView {
  const { point, headingDeg } = pointOf(ac.track, ac.s);
  const clearance = ac.clearance;
  return {
    callsign: ac.callsign,
    type: ac.type,
    lengthM: ac.lengthM,
    wingspanM: ac.wingspanM,
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
