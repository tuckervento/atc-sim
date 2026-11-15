// Movement, one fixed tick at a time (PLAN 1.9, PRD §8.2).
//
// Each aircraft moves its nose forward along its track (track.ts), never back. Every tick it
// finds the nearest point it must stop at, and the speed limits ahead of it. It then picks
// the fastest speed from which it could still stop (or slow) in time, braking at the planned
// rate, within its acceleration and braking limits:
// - The planned rate is DECEL_MPS2 (stops, turns, traffic).
// - MAX_DECEL_MPS2 is the hard limit (hold position, or traffic that appears suddenly).
// Every aircraft plans from the state at the start of the tick, so the order they're
// processed in doesn't matter.
//
// Values [Builder] (PRD §8.2), with their basis:
// - TICK_HZ 10. At 20 kt an aircraft moves about 1 m per tick, finer than any footprint or
//   hold line needs, and cheap enough for multi-hour soak runs. The renderer interpolates.
// - TAXI_SPEED_KT 20, varied ±10% per pilot by the seeded RNG. Airline guidance is commonly
//   cited as about 20 kt for normal taxi, up to 30 kt on long straights, and about 10 kt for
//   turns of more than about 45° (Boeing FCTM, as quoted by pilot forums and study cards; I
//   haven't seen the FCTM text itself).
// - ACCEL_MPS2 0.5: 0 to 20 kt in about 20 s over about 100 m, a gentle breakaway.
// - DECEL_MPS2 0.6: 20 kt to a stop in about 90 m, so braking for a hold line starts about
//   one long taxiway segment out.
// - MAX_DECEL_MPS2 1.5, about 0.15 g: firm, but not an emergency stop. 20 kt to a stop in
//   about 35 m.

import { runwaysOccupied } from './occupancy.ts';
import { crossingTaxiway, nextStop, nodeAt, useCrossing, type Stop } from './stops.ts';
import { occupancyOf, RESTART_M, trafficStop, type Occupancy, type TrafficStop } from './traffic.ts';
import { emit, type Aircraft, type AircraftStatus, type Sim } from './world.ts';

/** Simulation rate: ticks per simulated second. */
export const TICK_HZ = 10;
export const TICK_S = 1 / TICK_HZ;
/** Meters per second in one knot. */
export const KNOT_MPS = 1852 / 3600;

export const TAXI_SPEED_KT = 20;
/** Each pilot's straight-line speed is TAXI_SPEED_KT times a factor drawn from 1 ± this. */
export const PILOT_SPEED_SPREAD = 0.1;
export const ACCEL_MPS2 = 0.5;
export const DECEL_MPS2 = 0.6;
export const MAX_DECEL_MPS2 = 1.5;
/**
 * The speed limit through a bend, by how far it turns: [deflection°, knots], linear between
 * points. Under the first point there's no limit. 10 kt at 45° is the guidance above; easing
 * to 5 kt for a full reversal is my extrapolation for hairpins (pad lead-ins).
 */
export const TURN_SPEEDS_KT: readonly (readonly [deg: number, kt: number])[] = [
  [10, 20],
  [45, 10],
  [180, 5],
];
/** How far ahead an aircraft looks for bends and traffic: well past its longest braking distance. */
const LOOKAHEAD_M = 300;
/**
 * Within this distance of a stop point, a crawling aircraft is put exactly on it. The speed
 * rule approaches a stop point ever more slowly and would never quite reach it otherwise.
 */
const STOP_SNAP_M = 0.05;

interface Plan {
  /** The fastest it may go this tick. */
  vMax: number;
  /** The nearest point at or ahead of the nose where it must be stopped, traffic included. */
  stop: Stop | ({ kind: 'traffic' } & TrafficStop);
}

/** Advances the world by one tick. */
export function advance(sim: Sim): void {
  sim.world.tick += 1;
  const occupancy = occupancyOf(sim);
  const plans = sim.world.aircraft.map((ac) => plan(sim, occupancy, ac));
  sim.world.aircraft.forEach((ac, i) => {
    const p = plans[i];
    if (!p) throw new Error(`no plan for ${ac.callsign}`);
    move(sim, ac, p);
  });
  for (const ac of sim.world.aircraft) {
    const now = runwaysOccupied(sim.runwayAreas, ac);
    for (const runway of ac.runways) {
      if (!now.includes(runway)) emit(sim, { type: 'crossed-runway', tick: sim.world.tick, callsign: ac.callsign, runway });
    }
    ac.runways = now;
  }
}

function plan(sim: Sim, occupancy: Occupancy, ac: Aircraft): Plan {
  const mandatory = nextStop(sim.index, ac);
  const traffic = trafficStop(sim.index, occupancy, ac, LOOKAHEAD_M);
  const stop: Plan['stop'] = traffic !== null && traffic.at < mandatory.at ? { kind: 'traffic', ...traffic } : mandatory;
  let vMax = Math.min(ac.cruiseMps, safeSpeed(stop.at - ac.s, 0));
  for (const bend of ac.track.bends) {
    if (bend.at < ac.s) continue;
    if (bend.at > ac.s + LOOKAHEAD_M) break;
    vMax = Math.min(vMax, safeSpeed(bend.at - ac.s, turnSpeedMps(bend.deflectionDeg)));
  }
  // Stopped for traffic, it waits for a real gap before moving up.
  if (stop.kind === 'traffic' && ac.v === 0 && stop.at - ac.s < RESTART_M) vMax = 0;
  // With no clearance it doesn't move, and if it was moving, it stops.
  if (ac.clearance === null) vMax = Math.min(vMax, Math.max(0, ac.v - DECEL_MPS2 * TICK_S));
  if (ac.holdPosition) vMax = Math.min(vMax, Math.max(0, ac.v - MAX_DECEL_MPS2 * TICK_S));
  return { vMax, stop };
}

/** The speed limit through a bend of `deflectionDeg` (TURN_SPEEDS_KT). Infinity: none. */
export function turnSpeedMps(deflectionDeg: number): number {
  let previous: readonly [number, number] | null = null;
  for (const point of TURN_SPEEDS_KT) {
    const [deg, kt] = point;
    if (deflectionDeg <= deg) {
      if (previous === null) return Infinity;
      const [d0, k0] = previous;
      return (k0 + ((kt - k0) * (deflectionDeg - d0)) / (deg - d0)) * KNOT_MPS;
    }
    previous = point;
  }
  const last = TURN_SPEEDS_KT.at(-1);
  if (!last) throw new Error('TURN_SPEEDS_KT is empty');
  return last[1] * KNOT_MPS;
}

/**
 * The fastest speed now from which, after moving at it for one tick, the aircraft can still
 * slow to `vEnd` within `distance`, braking at DECEL_MPS2. From v·dt + (v² − vEnd²)/2a ≤ d.
 */
function safeSpeed(distance: number, vEnd: number): number {
  const a = DECEL_MPS2;
  const adt = a * TICK_S;
  return -adt + Math.sqrt(adt * adt + vEnd * vEnd + 2 * a * Math.max(distance, 0));
}

function move(sim: Sim, ac: Aircraft, p: Plan): void {
  let v = Math.min(ac.v + ACCEL_MPS2 * TICK_S, p.vMax);
  v = Math.max(v, ac.v - MAX_DECEL_MPS2 * TICK_S, 0);
  let s = ac.s + v * TICK_S;
  const end = ac.track.lengthM;
  if (s >= end) {
    // There's nothing beyond the end of the track to move onto.
    s = end;
    v = 0;
  }
  if (s >= p.stop.at - STOP_SNAP_M && s <= p.stop.at && v <= MAX_DECEL_MPS2 * TICK_S) {
    s = p.stop.at;
    v = 0;
  }
  const before = ac.s;
  ac.s = s;
  ac.v = v;
  ac.blockedBy = p.stop.kind === 'traffic' ? p.stop.behind : null;
  passHoldLines(sim, ac, before);
  setStatus(sim, ac, statusOf(ac, p), p.stop);
}

/**
 * For each runway hold line on the path that the nose has just passed (it was at or before
 * the line, and is now beyond it): uses up the crossing clearance, and emits `entered-runway`.
 */
function passHoldLines(sim: Sim, ac: Aircraft, before: number): void {
  const clearance = ac.clearance;
  if (!clearance) return;
  for (const hold of clearance.path.holdShorts) {
    if (hold.kind !== 'runway') continue;
    const trackIndex = hold.index + clearance.pathOffset;
    const at = nodeAt(ac.track, trackIndex);
    if (!(before <= at && at < ac.s)) continue;
    const cleared = useCrossing(ac.crossings, hold.runways, crossingTaxiway(sim.index, ac.track, trackIndex));
    emit(sim, { type: 'entered-runway', tick: sim.world.tick, callsign: ac.callsign, holdShort: hold.id, runways: hold.runways, cleared });
  }
}

function statusOf(ac: Aircraft, p: Plan): AircraftStatus {
  if (ac.holdPosition) return 'holding-position';
  if (ac.v > 0) return 'taxiing';
  // Held for a real gap (plan): still stopped for the traffic, though it's moved a little.
  if (p.stop.kind === 'traffic' && p.stop.at - ac.s < RESTART_M) return 'stopped-for-traffic';
  if (p.stop.at <= ac.s) {
    switch (p.stop.kind) {
      case 'end':
        return ac.clearance ? 'arrived' : 'idle';
      case 'runway-hold':
      case 'clearance-hold':
        return 'holding-short';
      case 'traffic':
        return 'stopped-for-traffic';
    }
  }
  return ac.clearance ? 'taxiing' : 'idle';
}

/** Sets the status, emitting the event for a change into a stop that the player hears about. */
function setStatus(sim: Sim, ac: Aircraft, status: AircraftStatus, stop: Plan['stop']): void {
  if (status === ac.status) return;
  ac.status = status;
  const base = { tick: sim.world.tick, callsign: ac.callsign };
  if (status === 'arrived' && ac.clearance) emit(sim, { ...base, type: 'arrived', destination: ac.clearance.path.destination });
  if (status === 'holding-short' && (stop.kind === 'runway-hold' || stop.kind === 'clearance-hold')) {
    const node = ac.track.nodes[stop.trackIndex];
    if (node === undefined) throw new Error(`${ac.callsign}: track node ${stop.trackIndex} is missing`);
    const [runways, target] = stop.kind === 'runway-hold' ? [stop.runways, null] : [[], stop.target];
    emit(sim, { ...base, type: 'holding-short', node, holdShort: stop.holdShort, runways, target });
  }
  if (status === 'stopped-for-traffic' && stop.kind === 'traffic') emit(sim, { ...base, type: 'stopped-for-traffic', behind: stop.behind });
}
