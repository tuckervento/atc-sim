// The simulated tower (PLAN 1.10, PRD §8.4, §4.2–4.5). It owns the runways in the session's
// configuration:
// - Arrivals: spawned on final (SimOptions.arrivals, or addAircraft at a 'final' position),
//   cleared to land at the decision point if the runway is clear (else they go around), sent
//   to a configured exit, and handed to ground with "clear of … at …" once stopped clear.
// - Departures: taken at the departure line's front hold once handed off ("monitor tower"),
//   lined up, launched with spacing, and removed once past the runway's far end.
// - Crossing requests: answered after a beat, approved if the crossing is clear, else held,
//   with a callback when it clears. Current approvals are kept for 1.12's checks.
// It decides at the start of each tick and moves its own aircraft after movement.ts has moved
// the taxiing ones (sim.ts, `advance`; world.ts, "Controllers").
//
// The runway rule. Tower's own movements are an arrival from clearance to land until its body
// is clear of the runway, and a departure from line-up until lift-off. A movement starts only
// when no other ground aircraft is in its runway's area (occupancy.ts) and no other movement
// depends on it: they share a runway, or one's path passes through the other's runway's area
// (an intersection). So tower never puts two aircraft on a runway at once. Each runway is one
// resource: no crossing downfield behind a landing aircraft, and no line-up behind one.
//
// Values [Builder] (PRD §8.4: "within 'feels like JFK'"), with their basis. "Mine" means my own
// reasoning, not a source.
// - TOWER_BEAT_S 3: the pause before tower answers a crossing request (Q: "after a beat").
//   Mine: a natural pause; the radio scheduler (Phase 2) adds any wait for the frequency.
// - APPROACH_SPEED_KT 135, one speed for every type, held to touchdown. Mine: typical final
//   approach speeds of the jets in AIRCRAFT_TYPES are about 125–150 kt.
// - FINAL_SPAWN_M 5 NM before the threshold (133 s out), so a spawn never lands inside a
//   departure's or a crossing's window (both are shorter). Mine.
// - DECISION_S 20: tower clears an arrival to land, or sends it around, 20 s (0.75 NM) before
//   the threshold. Mine: about where a go-around decision is still comfortable.
// - TOUCHDOWN_M 300 past the threshold: the aiming-point marking is about 1,000 ft in on long
//   runways (FAA AC 150/5340-1, from memory, not re-checked).
// - Rollout: constant braking from touchdown to the exit's speed at the exit, between
//   ROLLOUT_DECEL_MIN_MPS2 1.2 and ROLLOUT_DECEL_MAX_MPS2 3.5. Mine: Airbus autobrake LO and
//   MED are about 1.7 and 3 m/s² (from memory); 3.5 allows reversers on top. Tower picks at
//   random (seeded) among the clear exits that take braking in that range; if none does, the
//   nearest clear exit beyond them, braked to at 1.2 (it then rolls to it at exit speed). An exit
//   needing more than 3.5 is never used. Farther exits are left out because they're slow: on
//   31L, PC to PF take 74–83 s from threshold to clear, against 40–61 s for MB to PA, and the
//   next arrival's decision point comes 80 s after the last one's threshold.
// - EXIT_SPEEDS_KT: 40 kt through an exit turning 30° or less off the centerline, 30 kt at
//   45°, 10 kt at 90°, linear between; sharper than 90° uses movement.ts's taxi turn speeds.
//   Mine: rapid exits are taken at about 30–50 kt, right-angle turn-offs at taxi-turn speed.
// - LEADOFF_DECEL_MPS2 1.5 (movement.ts's hard taxi braking) to stop on the exit, its tail
//   CLEAR_MARGIN_M 10 past the exit's hold line (or the end of the runway's area if none).
// - Line-up at up to LINEUP_SPEED_KT 10 with movement.ts's taxi acceleration, braking and turn
//   speeds, stopping with the nose LINEUP_MARGIN_M 5 past the point where the whole body is on
//   the centerline. ROLL_DELAY_S 5 from lined up to brake release. Mine.
// - Takeoff: 2.0 m/s² to lift-off at 150 kt (about 39 s, 1,500 m); heavies 1.6 m/s² to 165 kt
//   (about 53 s, 2,250 m). Mine: typical jet takeoff rolls are 30–50 s.
// - DEPARTURE_SPACING_S 60 between takeoff rolls on a runway, 120 behind a heavy. Mine for the
//   60; the 2 minutes behind a heavy is the FAA wake-turbulence departure interval (7110.65,
//   from memory).
// - MIN_ARRIVAL_SPACING_S 100 between arrivals on final for one runway: about 3.75 NM at
//   135 kt. Mine: JFK runs about 3–4 NM; less, and a slow exit sends the next one around.
// - Arrival streams: one every 3600/perHour s, ±ARRIVAL_JITTER 15% from the seeded RNG, never
//   closer than MIN_ARRIVAL_SPACING_S. Interim until Phase 3's traffic generator.
// - CROSSING_WINDOW_S 80: an arrival within 80 s of its threshold holds a crossing of its
//   runway. Mine: 20 s for the decision point, about 45 s for a crosser to start and clear,
//   about 10 s for the player to pass the clearance on, and a few to spare.
// - DEPARTURE_MARGIN_S 15: a departure lines up only if, by tower's estimate, it lifts off at
//   least 15 s before the next arrival's decision point. Mine.
// - APPROVAL_TIMEOUT_S 60: an approval not used within a minute is cancelled. Mine.

import { edgeLength, edgePolyline, edgesAt, otherEnd, type AirportIndex } from '../airport/graph.ts';
import type { ConfigurationId, Edge, EdgeId, HoldShort, NodeId, Point, RunwayConfiguration, RunwayEndDesignator, RunwayExit, RunwayId } from '../airport/types.ts';
import { ACCEL_MPS2, DECEL_MPS2, KNOT_MPS, LOOKAHEAD_M, MAX_DECEL_MPS2, safeSpeed, STOP_SNAP_M, TICK_HZ, TICK_S, turnSpeedMps } from './movement.ts';
import { bodySpans } from './occupancy.ts';
import { nextFloat, nextInRange } from './rng.ts';
import { nodeAt } from './stops.ts';
import { buildTrack, placeOf, type Track } from './track.ts';
import { trafficStop, type Occupancy } from './traffic.ts';
import {
  emit,
  type Aircraft,
  type CrossingApproval,
  type CrossingTarget,
  type PlannedExit,
  type Sim,
  type TowerArrival,
  type TowerDeparture,
  type TowerState,
} from './world.ts';

export const TOWER_BEAT_S = 3;
export const APPROACH_SPEED_KT = 135;
export const FINAL_SPAWN_M = 5 * 1852;
export const DECISION_S = 20;
export const TOUCHDOWN_M = 300;
export const ROLLOUT_DECEL_MIN_MPS2 = 1.2;
export const ROLLOUT_DECEL_MAX_MPS2 = 3.5;
export const EXIT_SPEEDS_KT: readonly (readonly [deg: number, kt: number])[] = [
  [30, 40],
  [45, 30],
  [90, 10],
];
export const LEADOFF_DECEL_MPS2 = MAX_DECEL_MPS2;
export const CLEAR_MARGIN_M = 10;
export const LINEUP_SPEED_KT = 10;
export const LINEUP_MARGIN_M = 5;
export const ROLL_DELAY_S = 5;
export const TAKEOFF = {
  normal: { accelMps2: 2.0, liftoffKt: 150 },
  heavy: { accelMps2: 1.6, liftoffKt: 165 },
} as const;
/** Wake category heavy (FAA): the types in AIRCRAFT_TYPES over 300,000 lb maximum takeoff weight. */
export const HEAVY_TYPES: readonly string[] = ['B763', 'B789', 'A333', 'A359', 'B77W', 'A388'];
export const DEPARTURE_SPACING_S = 60;
export const DEPARTURE_SPACING_HEAVY_S = 120;
export const MIN_ARRIVAL_SPACING_S = 100;
export const ARRIVAL_JITTER = 0.15;
export const CROSSING_WINDOW_S = 80;
export const DEPARTURE_MARGIN_S = 15;
export const APPROVAL_TIMEOUT_S = 60;

const APPROACH_MPS = APPROACH_SPEED_KT * KNOT_MPS;
/** An arrival on final flies this speed, m/s. */
export const APPROACH_SPEED_MPS = APPROACH_MPS;
const LINEUP_MPS = LINEUP_SPEED_KT * KNOT_MPS;
/** How far past the runway's area a lead-off looks for the exit's hold line. */
const HOLD_SEARCH_M = 400;
/** The most edges a walk off or onto a runway takes. */
const WALK_EDGES = 30;
/** Sharpest turn a lead-off or a walk ahead takes, degrees. */
const WALK_MAX_TURN_DEG = 120;

// ---------------------------------------------------------------------------------------------
// Setup: derived from the airport and the options, not state

/** The flight a stream spawns next. Callsigns and the rest come from the caller. */
export interface ArrivalFlight {
  callsign: string;
  type: string;
  airline?: string | null;
  terminal?: string | null;
}

/** Arrivals the tower spawns on final for one runway end, at a set rate. */
export interface ArrivalStream {
  runwayEnd: RunwayEndDesignator;
  perHour: number;
  /** Flight number n (0, 1, …). It must be deterministic: the same n always gives the same flight. */
  flight: (n: number) => ArrivalFlight;
  /** When the first one is spawned, seconds from the start. Default 0. */
  firstAtS?: number;
}

export interface TowerOptions {
  /** An id in the airport's configurations. Default its defaultConfiguration, else its first. */
  configuration?: ConfigurationId;
  arrivals?: ArrivalStream[];
}

/** One runway end in use. */
export interface RunwayEndSetup {
  end: RunwayEndDesignator;
  runway: RunwayId;
  arrivals: boolean;
  departures: boolean;
  /** The centerline from this end's node to the other end's, with distances along it. */
  nodes: NodeId[];
  edges: EdgeId[];
  nodeAt: number[];
  /** Distance from the end's node to the landing threshold. */
  thresholdM: number;
  /** The exits tower sends arrivals to. */
  exits: RunwayExit[];
  /** Every runway whose area the centerline passes through, sorted. */
  areas: RunwayId[];
}

export interface TowerSetup {
  configuration: RunwayConfiguration | null;
  ends: ReadonlyMap<RunwayEndDesignator, RunwayEndSetup>;
  streams: readonly ArrivalStream[];
}

export function towerSetup(index: AirportIndex, areas: ReadonlyMap<EdgeId, RunwayId[]>, options: TowerOptions): TowerSetup {
  const airport = index.airport;
  const id = options.configuration ?? airport.defaultConfiguration ?? airport.configurations[0]?.id;
  const configuration = id === undefined ? null : (airport.configurations.find((c) => c.id === id) ?? null);
  if (id !== undefined && configuration === null) throw new Error(`no runway configuration "${id}" at ${airport.id}`);
  const ends = new Map<RunwayEndDesignator, RunwayEndSetup>();
  for (const use of configuration?.runways ?? []) {
    const ref = index.runwayEnds.get(use.end);
    if (!ref) throw new Error(`configuration ${id}: no runway end ${use.end}`);
    const runway = ref.runway.id;
    const other = ref.runway.ends[ref.index === 0 ? 1 : 0];
    const { nodes, edges } = centerline(index, runway, ref.end.node, other.node);
    const track = buildTrack(index, nodes, edges);
    const arrivals = use.roles.includes('arrivals');
    const exits = arrivals
      ? index.airport.runwayExits.filter((x) => x.runwayEnd === use.end && (use.arrivalExits === undefined || use.arrivalExits.includes(x.id)))
      : [];
    const runwaysIn = new Set<RunwayId>(edges.flatMap((e) => areas.get(e) ?? []));
    ends.set(use.end, {
      end: use.end,
      runway,
      arrivals,
      departures: use.roles.includes('departures'),
      nodes,
      edges,
      nodeAt: track.nodeAt,
      thresholdM: ref.end.displacedThresholdM ?? 0,
      exits,
      areas: [...runwaysIn].sort(),
    });
  }
  const streams = options.arrivals ?? [];
  for (const stream of streams) {
    const end = ends.get(stream.runwayEnd);
    if (!end?.arrivals) throw new Error(`arrival stream: runway ${stream.runwayEnd} doesn't take arrivals in configuration ${id}`);
    if (!(stream.perHour > 0)) throw new Error(`arrival stream ${stream.runwayEnd}: perHour must be > 0, got ${stream.perHour}`);
    // Braking alone (no lead-off yet): fail now, not on the first spawn.
    if (!end.exits.some((x) => rolloutTo(index, end, x, 0) !== null)) throw new Error(unreachableExits(index, end));
  }
  return { configuration, ends, streams };
}

export function initialTowerState(setup: TowerSetup): TowerState {
  return {
    streams: setup.streams.map((s) => ({
      runwayEnd: s.runwayEnd,
      nextTick: Math.round((s.firstAtS ?? 0) * TICK_HZ),
      count: 0,
      departureSinceArrival: true,
    })),
    arrivals: [],
    departures: [],
    requests: [],
    approvals: [],
    rolls: [],
  };
}

/** The centerline of `runway` from node `from` to node `to`. Throws if it doesn't run through. */
function centerline(index: AirportIndex, runway: RunwayId, from: NodeId, to: NodeId): { nodes: NodeId[]; edges: EdgeId[] } {
  const nodes = [from];
  const edges: EdgeId[] = [];
  let at = from;
  while (at !== to) {
    const next = edgesAt(index, at).find((e) => e.kind === 'runway' && e.runway === runway && e.id !== edges.at(-1));
    if (!next) throw new Error(`runway ${runway}: its centerline stops at ${at}, short of ${to}`);
    edges.push(next.id);
    at = otherEnd(next, at);
    nodes.push(at);
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------------------------
// Arrivals on final

/** Where an arrival starts on final: its track (the whole centerline) and nose position. */
export function placeOnFinal(sim: Sim, callsign: string, runwayEnd: string, distanceM: number, lengthM: number): { track: Track; s: number } {
  const end = sim.tower.ends.get(runwayEnd);
  if (!end?.arrivals) throw new Error(`${callsign}: runway ${runwayEnd} doesn't take arrivals in this configuration`);
  if (!(distanceM >= 0)) throw new Error(`${callsign}: distance on final must be ≥ 0, got ${distanceM}`);
  if (!end.exits.some((x) => rolloutTo(sim.index, end, x, lengthM) !== null)) throw new Error(`${callsign}: ${unreachableExits(sim.index, end)}`);
  const track = buildTrack(sim.index, end.nodes, end.edges);
  sim.world.tower.arrivals.push({ callsign, runwayEnd, committed: false, exit: null, clear: false });
  return { track, s: end.thresholdM - distanceM };
}

function unreachableExits(index: AirportIndex, end: RunwayEndSetup): string {
  const touchdownAt = end.thresholdM + TOUCHDOWN_M;
  const needs = end.exits.map((x) => {
    const at = end.nodeAt[end.nodes.indexOf(x.node)] ?? NaN;
    const v = exitSpeedKt(exitTurn(index, end, x)) * KNOT_MPS;
    return `${x.id} at ${Math.round(at - end.thresholdM)} m past the threshold needs ${((APPROACH_MPS ** 2 - v ** 2) / (2 * (at - touchdownAt))).toFixed(1)} m/s²`;
  });
  return `no configured exit of runway ${end.end} can be reached braking at most ${ROLLOUT_DECEL_MAX_MPS2} m/s² from touchdown ${TOUCHDOWN_M} m past the threshold (${needs.join('; ') || 'none configured'})`;
}

/** Each stream's arrivals due now, for sim.ts to add (it builds aircraft). Advances the streams. */
export function towerSpawns(sim: Sim): (ArrivalFlight & { runwayEnd: RunwayEndDesignator })[] {
  const tower = sim.world.tower;
  const due: (ArrivalFlight & { runwayEnd: RunwayEndDesignator })[] = [];
  sim.tower.streams.forEach((stream, i) => {
    const state = tower.streams[i];
    if (!state) throw new Error(`no state for arrival stream ${i}`);
    if (sim.world.tick < state.nextTick || !canSpawn(sim, state.runwayEnd, state.departureSinceArrival)) return;
    due.push({ ...stream.flight(state.count), runwayEnd: state.runwayEnd });
    state.count += 1;
    state.departureSinceArrival = false;
    const intervalS = Math.max(MIN_ARRIVAL_SPACING_S, (3600 / stream.perHour) * nextInRange(sim.world.rng, 1 - ARRIVAL_JITTER, 1 + ARRIVAL_JITTER));
    state.nextTick = sim.world.tick + Math.round(intervalS * TICK_HZ);
  });
  return due;
}

function canSpawn(sim: Sim, runwayEnd: RunwayEndDesignator, departureSinceArrival: boolean): boolean {
  const end = setupOf(sim, runwayEnd);
  // Spacing on final behind the last one.
  for (const a of sim.world.tower.arrivals) {
    if (a.runwayEnd !== runwayEnd || a.committed) continue;
    if (FINAL_SPAWN_M - toThreshold(sim, a) < MIN_ARRIVAL_SPACING_S * APPROACH_MPS) return false;
  }
  // Interleave: a waiting departure gets its turn first.
  if (end.departures && !departureSinceArrival) {
    const waiting = sim.world.tower.departures.some((d) => d.runwayEnd === runwayEnd && ['arrived', 'holding-short', 'lining-up', 'lined-up'].includes(aircraftOf(sim, d.callsign).status));
    if (waiting) return false;
  }
  // A departure already lining up must be airborne well before this one's decision point.
  const decisionTick = sim.world.tick + Math.round((FINAL_SPAWN_M / APPROACH_MPS - DECISION_S) * TICK_HZ);
  for (const d of sim.world.tower.departures) {
    if (d.airborneByTick === null || aircraftOf(sim, d.callsign).airborne) continue;
    if (!dependent(end.runway, end.areas, setupOf(sim, d.runwayEnd).runway, setupOf(sim, d.runwayEnd).areas)) continue;
    if (decisionTick < d.airborneByTick + DEPARTURE_MARGIN_S * TICK_HZ) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// The tower's decisions, each tick

/** Tower's decisions for this tick, on the state the last tick left. */
export function towerDecide(sim: Sim): void {
  trackApprovals(sim);
  for (const arrival of [...sim.world.tower.arrivals]) {
    if (!arrival.committed) decideLanding(sim, arrival);
  }
  acceptDepartures(sim);
  decideDepartures(sim);
  answerRequests(sim);
}

/** Approvals: entered, used up (body off every runway), or cancelled unused after the timeout. */
function trackApprovals(sim: Sim): void {
  const tower = sim.world.tower;
  tower.approvals = tower.approvals.filter((approval) => {
    const ac = sim.world.aircraft.find((a) => a.callsign === approval.callsign);
    if (!ac) return false;
    const inside = ac.runways.some((r) => approval.runways.includes(r));
    if (inside) {
      approval.entered = true;
      return true;
    }
    if (approval.entered) return false;
    if (sim.world.tick - approval.tick >= APPROVAL_TIMEOUT_S * TICK_HZ) {
      cancelApproval(sim, approval, 'not used');
      return false;
    }
    return true;
  });
}

function cancelApproval(sim: Sim, approval: CrossingApproval, reason: string): void {
  const { runways } = approval;
  emit(sim, { type: 'crossing-cancelled', tick: sim.world.tick, callsign: approval.callsign, runways, designators: designators(sim, runways), reason });
}

/** At the decision point: cleared to land, with an exit, or go around. */
function decideLanding(sim: Sim, arrival: TowerArrival): void {
  if (toThreshold(sim, arrival) / APPROACH_MPS > DECISION_S) return;
  const ac = aircraftOf(sim, arrival.callsign);
  const end = setupOf(sim, arrival.runwayEnd);
  const blocked = landingBlocked(sim, ac, end);
  if (blocked !== null) return goAround(sim, ac, arrival, blocked);
  const clear = end.exits.flatMap((x) => {
    const plan = planExit(sim.index, sim.runwayAreas, end, x, ac.lengthM);
    return plan !== null && leadOffClear(sim, ac, plan.edges) ? [plan] : [];
  });
  // The exits it can make braking between the limits; failing those, the nearest beyond them.
  const inRange = clear.filter((p) => p.requiredMps2 >= ROLLOUT_DECEL_MIN_MPS2);
  const nearest = clear.reduce<ExitPlan | null>((best, p) => (best === null || p.planned.nodeAt < best.planned.nodeAt ? p : best), null);
  const options = inRange.length > 0 ? inRange : nearest === null ? [] : [nearest];
  if (options.length === 0) return goAround(sim, ac, arrival, 'no exit clear');
  const pick = options[Math.floor(nextFloat(sim.world.rng) * options.length)];
  if (!pick) throw new Error('exit pick out of range');
  const i = end.nodes.indexOf(pick.exit.node);
  ac.track = buildTrack(sim.index, [...end.nodes.slice(0, i + 1), ...pick.nodes.slice(1)], [...end.edges.slice(0, i), ...pick.edges]);
  arrival.committed = true;
  arrival.exit = pick.planned;
  // Approvals it would land over, not yet used: withdrawn.
  sim.world.tower.approvals = sim.world.tower.approvals.filter((a) => {
    if (a.entered || !a.areas.includes(end.runway)) return true;
    cancelApproval(sim, a, 'landing traffic');
    return false;
  });
}

/** Why an arrival can't land now, or null. */
function landingBlocked(sim: Sim, ac: Aircraft, end: RunwayEndSetup): string | null {
  const onRunway = groundAircraftOn(sim, end.runway, ac.callsign);
  if (onRunway) return `${onRunway} on the runway`;
  const crossing = sim.world.tower.approvals.find((a) => a.entered && a.areas.includes(end.runway));
  if (crossing) return `${crossing.callsign} crossing`;
  const movement = activeMovements(sim).find((m) => m.callsign !== ac.callsign && dependent(end.runway, end.areas, m.runway, m.areas));
  if (movement) return `${movement.callsign} on the runway`;
  return null;
}

function goAround(sim: Sim, ac: Aircraft, arrival: TowerArrival, reason: string): void {
  // Back on final, behind every other arrival on final for this runway end.
  let distance = FINAL_SPAWN_M;
  for (const other of sim.world.tower.arrivals) {
    if (other === arrival || other.runwayEnd !== arrival.runwayEnd || other.committed) continue;
    distance = Math.max(distance, toThreshold(sim, other) + MIN_ARRIVAL_SPACING_S * APPROACH_MPS);
  }
  ac.s = setupOf(sim, arrival.runwayEnd).thresholdM - distance;
  emit(sim, { type: 'go-around', tick: sim.world.tick, callsign: ac.callsign, runwayEnd: arrival.runwayEnd, reason });
}

/** Ground departures handed to tower and stopped at their departure line's front hold. */
function acceptDepartures(sim: Sim): void {
  const tower = sim.world.tower;
  for (const ac of sim.world.aircraft) {
    if (ac.controller !== 'ground' || ac.motion !== 'taxi' || ac.advisories.handoff?.facility !== 'tower' || ac.v !== 0) continue;
    const clearance = ac.clearance;
    const destination = clearance?.path.destination;
    if (!clearance || destination?.kind !== 'runway' || !sim.tower.ends.get(destination.runwayEnd)?.departures) continue;
    if (ac.s !== nodeAt(ac.track, clearance.pathOffset + clearance.path.nodes.length - 1)) continue;
    ac.controller = 'tower';
    tower.departures.push({ callsign: ac.callsign, runwayEnd: destination.runwayEnd, acceptedTick: sim.world.tick, lineupAt: null, linedUpTick: null, airborneByTick: null });
    emit(sim, { type: 'tower-accepted', tick: sim.world.tick, callsign: ac.callsign, runwayEnd: destination.runwayEnd });
  }
}

function decideDepartures(sim: Sim): void {
  const headsTaken = new Set<RunwayEndDesignator>();
  for (const d of [...sim.world.tower.departures]) {
    const ac = aircraftOf(sim, d.callsign);
    if (ac.status === 'lined-up') {
      startRoll(sim, ac, d);
      continue;
    }
    if (d.lineupAt !== null || headsTaken.has(d.runwayEnd)) continue;
    // The first waiting departure for its runway end is the only one that may line up.
    headsTaken.add(d.runwayEnd);
    if (sim.world.tick >= d.acceptedTick + TOWER_BEAT_S * TICK_HZ) lineUp(sim, ac, d);
  }
}

function lineUp(sim: Sim, ac: Aircraft, d: TowerDeparture): void {
  const end = setupOf(sim, d.runwayEnd);
  const destination = ac.clearance?.path.destination;
  if (destination?.kind !== 'runway') throw new Error(`${ac.callsign}: a waiting departure has no runway clearance`);
  const hold = sim.index.airport.holdShorts.find((h) => h.id === destination.holdShort);
  if (!hold) throw new Error(`${ac.callsign}: no hold ${destination.holdShort}`);
  const onto = walkToRunway(sim.index, hold, end.runway);
  const entry = end.nodes.indexOf(onto.nodes.at(-1) ?? '');
  if (entry < 0) throw new Error(`${ac.callsign}: hold ${hold.id} leads onto runway ${end.runway} away from its centerline`);
  const pathEdges = [...onto.edges, ...end.edges.slice(entry)];
  const areas = new Set<RunwayId>(pathEdges.flatMap((e) => sim.runwayAreas.get(e) ?? []));
  if (departureBlocked(sim, ac, end, [...areas], 'line-up') !== null) return;

  const place = placeOf(ac.track, ac.s);
  if (place.kind !== 'node') throw new Error(`${ac.callsign}: a waiting departure isn't on a node`);
  const t0 = Math.min(placeOf(ac.track, Math.max(0, ac.s - ac.lengthM)).i, place.i);
  const track = buildTrack(
    sim.index,
    [...ac.track.nodes.slice(t0, place.i + 1), ...onto.nodes.slice(1), ...end.nodes.slice(entry + 1)],
    [...ac.track.edges.slice(t0, place.i), ...pathEdges],
  );
  const s = nodeAt(track, place.i - t0);
  const lineupAt = nodeAt(track, place.i - t0 + onto.edges.length) + ac.lengthM + LINEUP_MARGIN_M;
  if (lineupAt >= track.lengthM) throw new Error(`${ac.callsign}: runway ${end.end} is too short to line up on`);

  // Estimated lift-off: line up, the pause, any wait for spacing, then the roll.
  const perf = takeoffOf(ac);
  const lineupS = 1.1 * travelTime(lineupAt - s, LINEUP_MPS, ACCEL_MPS2, DECEL_MPS2);
  const rollStart = Math.max(sim.world.tick + (lineupS + ROLL_DELAY_S) * TICK_HZ, spacingTick(sim, end.runway));
  const airborneBy = Math.ceil(rollStart + (perf.liftoffMps / perf.accelMps2) * TICK_HZ);
  for (const a of sim.world.tower.arrivals) {
    if (a.committed) continue;
    const ae = setupOf(sim, a.runwayEnd);
    if (!dependent(end.runway, [...areas], ae.runway, ae.areas)) continue;
    const decisionTick = sim.world.tick + (toThreshold(sim, a) / APPROACH_MPS - DECISION_S) * TICK_HZ;
    if (decisionTick < airborneBy + DEPARTURE_MARGIN_S * TICK_HZ) return;
  }

  Object.assign(ac, { track, s, clearance: null, crossings: [], holdPosition: false, motion: 'controller', status: 'lining-up', blockedBy: null });
  d.lineupAt = lineupAt;
  d.airborneByTick = airborneBy;
  emit(sim, { type: 'lining-up', tick: sim.world.tick, callsign: ac.callsign, runwayEnd: d.runwayEnd });
}

/** Why a departure can't line up or roll now (its path passes the `areas`), or null. */
function departureBlocked(sim: Sim, ac: Aircraft, end: RunwayEndSetup, areas: RunwayId[], start: 'line-up' | 'roll'): string | null {
  const onRunway = groundAircraftOn(sim, end.runway, ac.callsign);
  if (onRunway) return `${onRunway} on the runway`;
  const movement = activeMovements(sim).find((m) => m.callsign !== ac.callsign && dependent(end.runway, areas, m.runway, m.areas));
  if (movement) return `${movement.callsign} on the runway`;
  if (sim.world.tower.approvals.some((a) => a.areas.includes(end.runway))) return 'crossing approved';
  // A held crossing goes before a departure that hasn't started to line up: crossings are quick,
  // and would wait out every departure otherwise. One already on the runway goes first.
  if (start === 'line-up' && sim.world.tower.requests.some((r) => r.held && 'areas' in r.target && r.target.areas.includes(end.runway))) return 'crossing waiting';
  return null;
}

function startRoll(sim: Sim, ac: Aircraft, d: TowerDeparture): void {
  const end = setupOf(sim, d.runwayEnd);
  if (d.linedUpTick === null || sim.world.tick < d.linedUpTick + ROLL_DELAY_S * TICK_HZ) return;
  if (sim.world.tick < spacingTick(sim, end.runway)) return;
  const areas = movementAreas(sim, ac);
  if (departureBlocked(sim, ac, end, areas, 'roll') !== null) return;
  // It must be airborne before any arrival's decision point; if not, it waits (and that one goes around).
  const perf = takeoffOf(ac);
  const airborneTick = sim.world.tick + (perf.liftoffMps / perf.accelMps2) * TICK_HZ;
  for (const a of sim.world.tower.arrivals) {
    if (a.committed) continue;
    const ae = setupOf(sim, a.runwayEnd);
    if (!dependent(end.runway, areas, ae.runway, ae.areas)) continue;
    if (sim.world.tick + (toThreshold(sim, a) / APPROACH_MPS - DECISION_S) * TICK_HZ < airborneTick) return;
  }
  ac.status = 'taking-off';
  const heavy = HEAVY_TYPES.includes(ac.type);
  const rolls = sim.world.tower.rolls.filter((r) => r.runway !== end.runway);
  sim.world.tower.rolls = [...rolls, { runway: end.runway, tick: sim.world.tick, heavy }];
  for (const stream of sim.world.tower.streams) {
    if (stream.runwayEnd === d.runwayEnd) stream.departureSinceArrival = true;
  }
  emit(sim, { type: 'takeoff-roll', tick: sim.world.tick, callsign: ac.callsign, runwayEnd: d.runwayEnd });
}

/** The first tick a takeoff roll may start on `runway`, for spacing behind the last one. */
function spacingTick(sim: Sim, runway: RunwayId): number {
  const last = sim.world.tower.rolls.find((r) => r.runway === runway);
  if (!last) return 0;
  return last.tick + (last.heavy ? DEPARTURE_SPACING_HEAVY_S : DEPARTURE_SPACING_S) * TICK_HZ;
}

// ---------------------------------------------------------------------------------------------
// Crossing requests

/**
 * Records the player's crossing request (PRD §4.5) for tower to answer after a beat: for
 * `runway` (a designator), or the next runway crossing on its route, or the next runway ahead
 * if it has no route. A new request replaces the aircraft's unanswered or held one.
 */
export function requestCrossing(sim: Sim, ac: Aircraft, runway: string | null): void {
  const tower = sim.world.tower;
  tower.requests = tower.requests.filter((r) => r.callsign !== ac.callsign);
  tower.requests.push({
    callsign: ac.callsign,
    tick: sim.world.tick,
    answerTick: sim.world.tick + TOWER_BEAT_S * TICK_HZ,
    held: false,
    target: crossingTarget(sim, ac, runway),
  });
}

function answerRequests(sim: Sim): void {
  const tower = sim.world.tower;
  for (const request of [...tower.requests]) {
    if (sim.world.tick < request.answerTick) continue;
    const ac = sim.world.aircraft.find((a) => a.callsign === request.callsign);
    const drop = () => {
      tower.requests = tower.requests.filter((r) => r !== request);
    };
    if (!ac) {
      drop();
      continue;
    }
    const target = request.target;
    const base = { tick: sim.world.tick, callsign: ac.callsign };
    if ('unable' in target || ac.controller !== 'ground') {
      emit(sim, { ...base, type: 'crossing-unable', reason: 'unable' in target ? target.unable : `${ac.callsign} isn't on ground's frequency` });
      drop();
      continue;
    }
    const { runways, taxiway, holdShort } = target;
    const blocked = tower.approvals.some((a) => a.callsign === ac.callsign && a.holdShort === holdShort) ? null : crossingBlocked(sim, target, ac.callsign);
    if (blocked === null) {
      if (!tower.approvals.some((a) => a.callsign === ac.callsign && a.holdShort === holdShort)) {
        tower.approvals.push({ ...target, callsign: ac.callsign, tick: sim.world.tick, entered: false });
      }
      emit(sim, { ...base, type: 'crossing-approved', runways, designators: designators(sim, runways), taxiway, holdShort });
      drop();
    } else if (!request.held) {
      request.held = true;
      emit(sim, { ...base, type: 'crossing-held', runways, designators: designators(sim, runways), reason: blocked });
    }
  }
}

/** Why a crossing can't be approved now, or null. */
function crossingBlocked(sim: Sim, target: CrossingTarget, callsign: string): string | null {
  for (const m of activeMovements(sim)) {
    if (target.areas.includes(m.runway)) return m.kind === 'arrival' ? 'landing traffic' : 'departing traffic';
  }
  for (const a of sim.world.tower.arrivals) {
    if (a.committed) continue;
    if (target.areas.includes(setupOf(sim, a.runwayEnd).runway) && toThreshold(sim, a) / APPROACH_MPS <= CROSSING_WINDOW_S) return 'traffic on final';
  }
  if (sim.world.tower.approvals.some((a) => a.callsign !== callsign && a.runwayNode === target.runwayNode && a.holdShort !== target.holdShort)) return 'crossing traffic';
  return null;
}

/** Where the request is for: the next runway hold line on the route, or straight ahead. */
function crossingTarget(sim: Sim, ac: Aircraft, runway: string | null): CrossingTarget | { unable: string } {
  if (ac.controller !== 'ground') return { unable: `${ac.callsign} isn't on ground's frequency` };
  let only: RunwayId | null = null;
  if (runway !== null) {
    const ref = sim.index.runwayEnds.get(runway);
    if (!ref) return { unable: `no runway ${runway} at ${sim.index.airport.id}` };
    only = ref.runway.id;
  }
  const wanted = (h: HoldShort) => h.kind === 'runway' && (only === null || h.runways.includes(only));
  const what = only === null ? 'runway crossing' : `crossing of runway ${runway}`;
  // Along the route: its runway hold lines at or ahead of the nose.
  const clearance = ac.clearance;
  if (clearance) {
    const { path, pathOffset } = clearance;
    for (const passed of path.holdShorts) {
      if (passed.kind !== 'runway' || nodeAt(ac.track, passed.index + pathOffset) < ac.s) continue;
      const hold = sim.index.airport.holdShorts.find((h) => h.id === passed.id);
      if (!hold || !wanted(hold)) continue;
      return targetAt(sim, hold, path.nodes.slice(passed.index), path.edges.slice(passed.index));
    }
    return { unable: `no ${what} on ${ac.callsign}'s route` };
  }
  // No route: straight ahead from the node at (or ahead of) the nose.
  const place = placeOf(ac.track, ac.s);
  const i = place.kind === 'node' ? place.i : place.i + 1;
  const start = ac.track.nodes[i];
  const arrived = i > 0 ? sim.index.edges.get(ac.track.edges[i - 1] ?? '') : undefined;
  if (start === undefined || !arrived) return { unable: `${ac.callsign} has no route and no heading` };
  const ahead = walkAhead(sim.index, start, arrived, (node, next) => sim.index.airport.holdShorts.find((h) => h.node === node && h.towardEdge === next.id && wanted(h)) !== undefined);
  if (ahead === null) return { unable: `no ${what} ahead of ${ac.callsign}` };
  const hold = sim.index.airport.holdShorts.find((h) => h.node === ahead.nodes[0] && h.towardEdge === ahead.edges[0] && wanted(h));
  if (!hold) throw new Error('walkAhead stopped at no hold');
  return targetAt(sim, hold, ahead.nodes, ahead.edges);
}

/** The target for `hold`, given the way on from it (nodes[0] is the hold's node). */
function targetAt(sim: Sim, hold: HoldShort, nodes: NodeId[], edges: EdgeId[]): CrossingTarget {
  // The hold's own runways, and every runway whose area the way across passes through. A hold
  // line may stand a few edges short of the area (most of JFK's do), so skip up to it.
  const areas = new Set<RunwayId>(hold.runways);
  let inside = false;
  for (const e of edges) {
    const runways = sim.runwayAreas.get(e);
    if (!runways) {
      if (inside) break;
      continue;
    }
    inside = true;
    runways.forEach((r) => areas.add(r));
  }
  // Without a route, the way on may stop at the runway: the runway node is then the last one.
  const onRunway = (n: NodeId) => edgesAt(sim.index, n).some((e) => e.kind === 'runway' && e.runway !== undefined && hold.runways.includes(e.runway));
  const runwayNode = nodes.slice(1).find(onRunway) ?? nodes.at(-1) ?? hold.node;
  const toward = sim.index.edges.get(hold.towardEdge);
  return { runways: [...hold.runways], holdShort: hold.id, node: hold.node, runwayNode, taxiway: toward?.name ?? null, areas: [...areas].sort() };
}

// ---------------------------------------------------------------------------------------------
// Moving tower's aircraft

/**
 * Moves the aircraft tower moves itself (motion 'controller'), planning from `occupancy`, the
 * start-of-tick places. Hands stopped, clear arrivals to ground and removes departed aircraft.
 */
export function towerMove(sim: Sim, occupancy: Occupancy): void {
  const gone: string[] = [];
  for (const ac of [...sim.world.aircraft]) {
    if (ac.controller !== 'tower' || ac.motion !== 'controller') continue;
    const arrival = sim.world.tower.arrivals.find((a) => a.callsign === ac.callsign);
    if (arrival) {
      moveArrival(sim, occupancy, ac, arrival);
      continue;
    }
    const departure = sim.world.tower.departures.find((d) => d.callsign === ac.callsign);
    if (!departure) throw new Error(`${ac.callsign}: tower moves it, but has no record of it`);
    if (moveDeparture(sim, ac, departure)) gone.push(ac.callsign);
  }
  for (const callsign of gone) dropAircraft(sim, callsign);
}

function moveArrival(sim: Sim, occupancy: Occupancy, ac: Aircraft, arrival: TowerArrival): void {
  const end = setupOf(sim, arrival.runwayEnd);
  const touchdownAt = end.thresholdM + TOUCHDOWN_M;
  const exit = arrival.exit;
  if (!arrival.committed || !exit) {
    if (ac.s + APPROACH_MPS * TICK_S >= end.thresholdM) throw new Error(`${ac.callsign}: reached the threshold without a landing clearance`);
    ac.v = APPROACH_MPS;
    ac.s += APPROACH_MPS * TICK_S;
    return;
  }
  let vMax = ac.s < exit.nodeAt ? safeSpeed(exit.nodeAt - ac.s, exit.speedMps, exit.decelMps2) : exit.speedMps;
  for (const bend of ac.track.bends) {
    if (bend.at <= Math.max(ac.s, exit.edgeEndAt)) continue;
    if (bend.at > ac.s + LOOKAHEAD_M) break;
    vMax = Math.min(vMax, safeSpeed(bend.at - ac.s, turnSpeedMps(bend.deflectionDeg), LEADOFF_DECEL_MPS2));
  }
  let stopAt = exit.stopAt;
  const traffic = trafficStop(sim.index, occupancy, ac, LOOKAHEAD_M);
  if (traffic !== null && traffic.at < stopAt) stopAt = traffic.at;
  vMax = Math.min(vMax, safeSpeed(stopAt - ac.s, 0, LEADOFF_DECEL_MPS2));
  ac.blockedBy = traffic !== null && traffic.at < exit.stopAt ? traffic.behind : null;

  let v: number;
  if (ac.airborne) {
    v = ac.v; // no braking in the air
  } else {
    v = Math.min(ac.v + ACCEL_MPS2 * TICK_S, vMax);
    v = Math.max(v, ac.v - ROLLOUT_DECEL_MAX_MPS2 * TICK_S, 0);
  }
  let s = ac.s + v * TICK_S;
  if (s >= stopAt - STOP_SNAP_M && v <= LEADOFF_DECEL_MPS2 * TICK_S) {
    s = Math.max(ac.s, Math.min(s, stopAt));
    if (s >= stopAt - STOP_SNAP_M) [s, v] = [stopAt, 0];
  }
  [ac.s, ac.v] = [s, v];

  const base = { tick: sim.world.tick, callsign: ac.callsign, runwayEnd: arrival.runwayEnd };
  if (ac.airborne && ac.s >= touchdownAt) {
    ac.airborne = false;
    ac.status = 'landing';
    emit(sim, { ...base, type: 'landed' });
  }
  if (!arrival.clear && ac.s - ac.lengthM >= exit.clearAt) {
    arrival.clear = true;
    ac.status = 'taxiing';
  }
  if (arrival.clear && ac.v === 0) {
    // Stopped clear of the runway: the pilot calls ground.
    Object.assign(ac, { controller: 'ground', motion: 'taxi', status: 'idle' });
    sim.world.tower.arrivals = sim.world.tower.arrivals.filter((a) => a !== arrival);
    emit(sim, { ...base, type: 'clear-of-runway', exit: exit.taxiway, exitId: exit.id });
  }
}

/** Moves a departure one tick. Returns true when it has left (past the runway's far end). */
function moveDeparture(sim: Sim, ac: Aircraft, d: TowerDeparture): boolean {
  const base = { tick: sim.world.tick, callsign: ac.callsign, runwayEnd: d.runwayEnd };
  if (ac.status === 'lined-up') return false;
  if (ac.status === 'lining-up') {
    const lineupAt = d.lineupAt;
    if (lineupAt === null) throw new Error(`${ac.callsign}: lining up with nowhere to stop`);
    let vMax = Math.min(LINEUP_MPS, safeSpeed(lineupAt - ac.s, 0));
    for (const bend of ac.track.bends) {
      if (bend.at < ac.s) continue;
      if (bend.at > ac.s + LOOKAHEAD_M) break;
      vMax = Math.min(vMax, safeSpeed(bend.at - ac.s, turnSpeedMps(bend.deflectionDeg)));
    }
    let v = Math.min(ac.v + ACCEL_MPS2 * TICK_S, vMax);
    v = Math.max(v, ac.v - MAX_DECEL_MPS2 * TICK_S, 0);
    let s = ac.s + v * TICK_S;
    if (s >= lineupAt - STOP_SNAP_M && v <= MAX_DECEL_MPS2 * TICK_S) [s, v] = [lineupAt, 0];
    [ac.s, ac.v] = [Math.min(s, lineupAt), v];
    if (ac.s === lineupAt && ac.v === 0) {
      ac.status = 'lined-up';
      d.linedUpTick = sim.world.tick;
    }
    return false;
  }
  if (ac.status !== 'taking-off' && ac.status !== 'airborne') throw new Error(`${ac.callsign}: tower moving a departure that is ${ac.status}`);
  const perf = takeoffOf(ac);
  ac.v += perf.accelMps2 * TICK_S;
  ac.s += ac.v * TICK_S;
  if (ac.status === 'taking-off' && ac.v >= perf.liftoffMps) {
    ac.airborne = true;
    ac.status = 'airborne';
    emit(sim, { ...base, type: 'took-off' });
  }
  if (ac.s >= ac.track.lengthM) {
    ac.s = ac.track.lengthM;
    emit(sim, { ...base, type: 'departed' });
    return true;
  }
  return false;
}

/** Removes an aircraft and everything tower holds about it. */
export function dropAircraft(sim: Sim, callsign: string): void {
  const tower = sim.world.tower;
  sim.world.aircraft = sim.world.aircraft.filter((a) => a.callsign !== callsign);
  tower.arrivals = tower.arrivals.filter((a) => a.callsign !== callsign);
  tower.departures = tower.departures.filter((d) => d.callsign !== callsign);
  tower.requests = tower.requests.filter((r) => r.callsign !== callsign);
  tower.approvals = tower.approvals.filter((a) => a.callsign !== callsign);
}

/** The runway end an arrival is landing on, and its distance from the threshold. null: not tower's arrival. */
export function finalOfArrival(sim: Sim, callsign: string): { runwayEnd: RunwayEndDesignator; distanceM: number } | null {
  const arrival = sim.world.tower.arrivals.find((a) => a.callsign === callsign);
  return arrival ? { runwayEnd: arrival.runwayEnd, distanceM: toThreshold(sim, arrival) } : null;
}

// ---------------------------------------------------------------------------------------------
// Movements and runways

interface Movement {
  callsign: string;
  kind: 'arrival' | 'departure';
  runway: RunwayId;
  /** Every runway whose area the rest of its runway path passes through. */
  areas: RunwayId[];
}

/** Tower's movements now: arrivals cleared to land and not yet clear, departures from line-up to lift-off. */
function activeMovements(sim: Sim): Movement[] {
  const movements: Movement[] = [];
  for (const a of sim.world.tower.arrivals) {
    if (!a.committed || a.clear) continue;
    movements.push({ callsign: a.callsign, kind: 'arrival', runway: setupOf(sim, a.runwayEnd).runway, areas: movementAreas(sim, aircraftOf(sim, a.callsign)) });
  }
  for (const d of sim.world.tower.departures) {
    const ac = aircraftOf(sim, d.callsign);
    if (!['lining-up', 'lined-up', 'taking-off'].includes(ac.status)) continue;
    movements.push({ callsign: d.callsign, kind: 'departure', runway: setupOf(sim, d.runwayEnd).runway, areas: movementAreas(sim, ac) });
  }
  return movements;
}

/** The runways whose areas the rest of an aircraft's track passes through, from its tail. */
function movementAreas(sim: Sim, ac: Aircraft): RunwayId[] {
  const first = bodySpans(ac)[0]?.i ?? placeOf(ac.track, Math.max(ac.s, 0)).i;
  const areas = new Set<RunwayId>();
  for (const e of ac.track.edges.slice(first)) (sim.runwayAreas.get(e) ?? []).forEach((r) => areas.add(r));
  return [...areas].sort();
}

/** Two movements depend on each other: one runway, or one's path through the other's runway's area. */
function dependent(runwayA: RunwayId, areasA: RunwayId[], runwayB: RunwayId, areasB: RunwayId[]): boolean {
  return runwayA === runwayB || areasA.includes(runwayB) || areasB.includes(runwayA);
}

/** A ground aircraft (other than `except`) whose body is in `runway`'s area, or null. */
function groundAircraftOn(sim: Sim, runway: RunwayId, except: string): string | null {
  return sim.world.aircraft.find((a) => a.callsign !== except && !a.airborne && a.runways.includes(runway))?.callsign ?? null;
}

/** How the runways are said: the end in use in the configuration, else the first end. */
function designators(sim: Sim, runways: RunwayId[]): string[] {
  return runways.map((id) => {
    const inUse = [...sim.tower.ends.values()].find((e) => e.runway === id);
    return inUse?.end ?? sim.index.runways.get(id)?.ends[0].designator ?? id;
  });
}

// ---------------------------------------------------------------------------------------------
// Exits and lead-offs

interface ExitPlan {
  exit: RunwayExit;
  planned: PlannedExit;
  /** The braking it would take to make the exit, before the minimum is applied. */
  requiredMps2: number;
  /** The lead-off from the exit's centerline node: the exit edge, then on until the stop. */
  nodes: NodeId[];
  edges: EdgeId[];
}

/** The braking to reach exit `x` at `speedMps`, from touchdown. null: more than the maximum. */
function rolloutTo(
  index: AirportIndex,
  end: RunwayEndSetup,
  x: RunwayExit,
  maxStopM: number,
): { nodeAt: number; speedMps: number; decelMps2: number; requiredMps2: number } | null {
  const i = end.nodes.indexOf(x.node);
  const at = end.nodeAt[i];
  if (i < 0 || at === undefined) throw new Error(`exit ${x.id} isn't on runway ${end.runway}'s centerline`);
  const touchdownAt = end.thresholdM + TOUCHDOWN_M;
  if (at <= touchdownAt) return null;
  let speedMps = exitSpeedKt(exitTurn(index, end, x)) * KNOT_MPS;
  if (maxStopM > 0) speedMps = Math.min(speedMps, Math.sqrt(2 * LEADOFF_DECEL_MPS2 * maxStopM));
  const decel = (APPROACH_MPS ** 2 - speedMps ** 2) / (2 * (at - touchdownAt));
  if (decel > ROLLOUT_DECEL_MAX_MPS2) return null;
  return { nodeAt: at, speedMps, decelMps2: Math.max(decel, ROLLOUT_DECEL_MIN_MPS2), requiredMps2: decel };
}

/**
 * The plan for exit `x` for an aircraft `lengthM` long: the lead-off to a stop with its tail
 * past the exit's hold line, and the rollout to it. null: it can't be reached braking at the
 * maximum, or the lead-off runs out (or onto a runway) before the aircraft is clear.
 */
function planExit(index: AirportIndex, areas: ReadonlyMap<EdgeId, RunwayId[]>, end: RunwayEndSetup, x: RunwayExit, lengthM: number): ExitPlan | null {
  const first = index.edges.get(x.edge);
  const i = end.nodes.indexOf(x.node);
  const at = end.nodeAt[i];
  if (!first || at === undefined || i < 0) throw new Error(`exit ${x.id}: unknown edge or node`);
  const nodes = [x.node, otherEnd(first, x.node)];
  const edges = [first.id];
  let endAt = at + edgeLength(index, first);
  const edgeEndAt = endAt;
  let areaEnd = (areas.get(first.id) ?? []).includes(end.runway) ? endAt : at;
  let holdAt: number | null = null;
  const holdHere = (node: NodeId, via: EdgeId) =>
    index.airport.holdShorts.some((h) => h.kind === 'runway' && h.node === node && h.towardEdge === via && h.runways.includes(end.runway));
  if (holdHere(nodes[1] ?? '', first.id)) holdAt = endAt;
  let previous: Edge = first;
  for (let k = 0; ; k++) {
    const clearAt = holdAt ?? areaEnd;
    const stopAt = clearAt + lengthM + CLEAR_MARGIN_M;
    if ((holdAt !== null || endAt - areaEnd >= HOLD_SEARCH_M) && endAt >= stopAt) {
      const rollout = rolloutTo(index, end, x, stopAt - at);
      if (rollout === null) return null;
      return {
        exit: x,
        planned: { id: x.id, taxiway: x.taxiway ?? null, nodeAt: at, edgeEndAt, clearAt, stopAt, speedMps: rollout.speedMps, decelMps2: rollout.decelMps2 },
        requiredMps2: rollout.requiredMps2,
        nodes,
        edges,
      };
    }
    if (k >= WALK_EDGES) return null;
    const node = nodes.at(-1) ?? '';
    const candidates = edgesAt(index, node).filter((e) => e.id !== previous.id && e.kind === 'taxiway' && !e.closed && !areas.has(e.id));
    const named = x.taxiway === undefined ? [] : candidates.filter((e) => e.name === x.taxiway);
    const next = straightest(index, node, previous, named.length > 0 ? named : candidates);
    if (!next) return null;
    edges.push(next.id);
    nodes.push(otherEnd(next, node));
    endAt += edgeLength(index, next);
    if (holdAt === null && holdHere(nodes.at(-1) ?? '', next.id)) holdAt = endAt;
    previous = next;
  }
}

/** No other ground aircraft's body (or its parked node), or its route still ahead, uses the lead-off. */
function leadOffClear(sim: Sim, ac: Aircraft, leadOff: EdgeId[]): boolean {
  const edges = new Set(leadOff);
  const nodes = new Set(leadOff.flatMap((id) => {
    const edge = sim.index.edges.get(id);
    return edge ? [edge.from, edge.to] : [];
  }));
  for (const other of sim.world.aircraft) {
    if (other === ac || other.airborne) continue;
    const spans = bodySpans(other);
    if (spans.some(({ i }) => edges.has(other.track.edges[i] ?? ''))) return false;
    const place = placeOf(other.track, other.s);
    if (spans.length === 0 && nodes.has(other.track.nodes[place.i] ?? '')) return false;
    if (other.clearance && other.track.edges.slice(place.i).some((e) => edges.has(e))) return false;
  }
  return true;
}

/** The turn from the centerline into exit `x`, degrees: its first edge's chord against the runway. */
function exitTurn(index: AirportIndex, end: RunwayEndSetup, x: RunwayExit): number {
  const i = end.nodes.indexOf(x.node);
  const before = end.nodes[i - 1];
  const after = end.nodes[i + 1];
  const edge = index.edges.get(x.edge);
  if (!edge) throw new Error(`exit ${x.id}: unknown edge ${x.edge}`);
  const [a, b] = before !== undefined ? [before, x.node] : [x.node, after ?? x.node];
  return turnBetween(pointOfNode(index, a), pointOfNode(index, b), pointOfNode(index, x.node), pointOfNode(index, otherEnd(edge, x.node)));
}

/** EXIT_SPEEDS_KT at `deg`; sharper than its last point, the taxi turn speed (no faster). */
export function exitSpeedKt(deg: number): number {
  const first = EXIT_SPEEDS_KT[0];
  const last = EXIT_SPEEDS_KT.at(-1);
  if (!first || !last) throw new Error('EXIT_SPEEDS_KT is empty');
  if (deg <= first[0]) return first[1];
  for (let k = 1; k < EXIT_SPEEDS_KT.length; k++) {
    const [d0, v0] = EXIT_SPEEDS_KT[k - 1] ?? first;
    const [d1, v1] = EXIT_SPEEDS_KT[k] ?? last;
    if (deg <= d1) return v0 + ((v1 - v0) * (deg - d0)) / (d1 - d0);
  }
  return Math.min(last[1], turnSpeedMps(deg) / KNOT_MPS);
}

// ---------------------------------------------------------------------------------------------
// Walking the graph

/** From a hold line, onto its runway's centerline: `nodes` ends on the centerline. */
function walkToRunway(index: AirportIndex, hold: HoldShort, runway: RunwayId): { nodes: NodeId[]; edges: EdgeId[] } {
  const toward = index.edges.get(hold.towardEdge);
  if (!toward) throw new Error(`hold ${hold.id}: unknown edge ${hold.towardEdge}`);
  const nodes = [hold.node, otherEnd(toward, hold.node)];
  const edges = [toward.id];
  let previous = toward;
  const onRunway = (n: NodeId) => edgesAt(index, n).some((e) => e.kind === 'runway' && e.runway === runway);
  while (!onRunway(nodes.at(-1) ?? '')) {
    const node = nodes.at(-1) ?? '';
    const next = straightest(index, node, previous, edgesAt(index, node).filter((e) => e.id !== previous.id && e.kind !== 'runway' && !e.closed));
    if (!next || edges.length >= WALK_EDGES) throw new Error(`hold ${hold.id} doesn't lead onto runway ${runway}`);
    edges.push(next.id);
    nodes.push(otherEnd(next, node));
    previous = next;
  }
  return { nodes, edges };
}

/**
 * Straight ahead from `start` (arrived along `arrived`): the straightest open taxiway edge at
 * each node, until `stop(node, next)` says so, then on through the runway's area. null if it
 * runs out first. The result starts at the stopping node.
 */
function walkAhead(index: AirportIndex, start: NodeId, arrived: Edge, stop: (node: NodeId, next: Edge) => boolean): { nodes: NodeId[]; edges: EdgeId[] } | null {
  let node = start;
  let previous = arrived;
  let found: { nodes: NodeId[]; edges: EdgeId[] } | null = null;
  for (let k = 0; k < 4 * WALK_EDGES; k++) {
    const next = straightest(index, node, previous, edgesAt(index, node).filter((e) => e.id !== previous.id && e.kind !== 'rampLane' && !e.closed));
    if (!next) return found;
    if (found === null && stop(node, next)) found = { nodes: [node], edges: [] };
    if (found !== null) {
      found.edges.push(next.id);
      found.nodes.push(otherEnd(next, node));
      // Far enough: past the runway, onto edges in no runway's area.
      if (found.edges.length > 1 && next.kind !== 'runway' && !edgesAt(index, otherEnd(next, node)).some((e) => e.kind === 'runway')) return found;
    } else if (next.kind === 'runway') {
      return null;
    }
    node = otherEnd(next, node);
    previous = next;
  }
  return found;
}

/** Of `edges` leaving `node`, the one that turns least from `previous`; null if none within WALK_MAX_TURN_DEG. */
function straightest(index: AirportIndex, node: NodeId, previous: Edge, edges: Edge[]): Edge | null {
  const inLine = edgePolyline(index, previous);
  if (previous.to !== node) inLine.reverse();
  const [p, q] = [inLine.at(-2), inLine.at(-1)];
  if (!p || !q) throw new Error(`edge ${previous.id} has no extent`);
  let best: Edge | null = null;
  let bestTurn = WALK_MAX_TURN_DEG;
  for (const e of edges) {
    const out = edgePolyline(index, e);
    if (e.from !== node) out.reverse();
    const [a, b] = [out[0], out[1]];
    if (!a || !b) continue;
    const turn = turnBetween(p, q, a, b);
    if (turn <= bestTurn) [best, bestTurn] = [e, turn];
  }
  return best;
}

/** The angle between direction p→q and direction a→b, 0–180°. */
function turnBetween(p: Point, q: Point, a: Point, b: Point): number {
  const [ux, uy] = [q[0] - p[0], q[1] - p[1]];
  const [vx, vy] = [b[0] - a[0], b[1] - a[1]];
  return Math.abs((Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180) / Math.PI);
}

function pointOfNode(index: AirportIndex, id: NodeId): Point {
  const node = index.nodes.get(id);
  if (!node) throw new Error(`unknown node ${id}`);
  return [node.x, node.y];
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function takeoffOf(ac: Aircraft): { accelMps2: number; liftoffMps: number } {
  const perf = HEAVY_TYPES.includes(ac.type) ? TAKEOFF.heavy : TAKEOFF.normal;
  return { accelMps2: perf.accelMps2, liftoffMps: perf.liftoffKt * KNOT_MPS };
}

/** Seconds to cover `d` from a stop to a stop: accelerating at `a` to at most `vMax`, braking at `b`. */
function travelTime(d: number, vMax: number, a: number, b: number): number {
  const ramps = (vMax * vMax) / (2 * a) + (vMax * vMax) / (2 * b);
  if (d <= ramps) {
    const peak = Math.sqrt((2 * a * b * d) / (a + b));
    return peak / a + peak / b;
  }
  return vMax / a + vMax / b + (d - ramps) / vMax;
}

/** How far an arrival is from its landing threshold (negative past it). */
function toThreshold(sim: Sim, arrival: TowerArrival): number {
  return setupOf(sim, arrival.runwayEnd).thresholdM - aircraftOf(sim, arrival.callsign).s;
}

function setupOf(sim: Sim, runwayEnd: RunwayEndDesignator): RunwayEndSetup {
  const end = sim.tower.ends.get(runwayEnd);
  if (!end) throw new Error(`runway ${runwayEnd} isn't in use`);
  return end;
}

function aircraftOf(sim: Sim, callsign: string): Aircraft {
  const ac = sim.world.aircraft.find((a) => a.callsign === callsign);
  if (!ac) throw new Error(`tower: no aircraft ${callsign}`);
  return ac;
}
