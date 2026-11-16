// The simulated ramp (PLAN 1.11, PRD §8.3, §4.2–4.3). It owns the gates and the ramp lanes:
// - Gates: which aircraft holds each (world.ramp.aircraft): parked there, pushing from it, or an
//   arrival assigned to it.
// - Departures: added at a gate (addAircraft, or a departure stream, SimOptions.departures), they
//   board, then push back (the only backward motion in the sim), taxi over ramp lanes to a ramp
//   edge serving their terminal, and call ground there (`check-in`, with the taxilane's name).
// - Arrivals: a ground aircraft handed to ramp ("monitor ramp") and stopped at a ramp entrance at
//   the end of its taxi there gets a free gate at its terminal, preferring its airline's. Once its
//   way in is clear, ramp takes it (`ramp-accepted`) and taxis it in; at the gate it emits
//   `arrived-at-gate` (1.12's arrival scoring point) and stays parked, holding the gate.
// It decides at the start of each tick, after the tower, and moves its pushbacks after
// movement.ts has moved the taxiing aircraft (sim.ts, `advance`; world.ts, "Controllers"). Its
// ramp-lane taxiing is movement.ts's (motion 'taxi'), on a track the ramp made, with no
// clearance, so see-and-avoid and turn speeds apply as everywhere else.
//
// Routes. The ramp finds its own way (the player names every taxiway; ramp doesn't): shortest by
// length over open ramp lanes, never into another gate's stand, never back along the edge just
// travelled, never turning more than MAX_TURN_DEG at a node. Ramp lanes never touch a runway, so
// neither do its routes. A departure goes to the nearest ramp edge (`use` departures or both)
// serving its terminal; an arrival from its entrance to its gate.
//
// Pushback. A gate's stand is its lead-in: the unnamed ramp-lane chain from the gate node back to
// the lane junction. The push is planned once per gate and type: pushed tail-first out of the
// stand (and on along lanes if it must, through no ramp handoff), until it can stop with its nose
// on a node and its tail swung onto a lane there that's long enough for its whole body, facing a
// forward way to a ramp edge. The shortest such push wins; among tails at one push point, the
// shortest taxi out. Its track runs from the far end of the tail's lane, through the push point,
// back to the gate, and it's pushed from the gate end to the push point; the taxi-out track shares
// it up to the push point, so the nose keeps its place when the tug lets go.
//
// Which gates it uses. A type can park at a gate only if its tail, parked, is farther from the
// lane junction than its half-span: see-and-avoid (traffic.ts) counts a junction a body's wing
// may be over as occupied, so a parked aircraft never blocks the lane. A departure needs a
// pushback as above; so does an arrival's gate, so it could leave again. At TEST, T1-3 (at lane
// 7's dead end) has none: the only lane from it runs back toward the ramp edge, so the nose
// would face the dead end. At KJFK, an A320 can use 123 of the 184 gates (a B77W 58). Of the 61
// it can't: 29 stands are too short (some shorter than the aircraft), 7 gate nodes are on a lane
// rather than at the end of a lead-in, and 25 have no pushback (mostly the last gate in a
// dead-end alley, or a lead-in from a ramp handoff).
//
// Holding, and never deadlocking itself. Each movement (a departure's pushback and taxi-out
// together; an arrival's taxi in) holds every edge its body will touch, start to finish, and both
// ends of each (`reserved`, `e:<id>` and `n:<id>`). It starts only when it can take them all at
// once: none held by another movement, and no other body in the way by see-and-avoid's own rules
// (staticBlocker). It lets them go only when it's done: checked in, or parked. Waiting aircraft
// are tried oldest first each tick. So:
// - Two ramp movements never share an edge or a node, so they never wait for each other once
//   started. A movement waits for nothing but a body the ramp doesn't control that moves into its
//   way (the player's), and the ramp's own bodies stay clear of the lanes: parked ones by the
//   stand rule, waiting ones at their gates, new ones only at a stand no movement holds.
// - An arrival waits at its entrance as ground's: ramp takes it only when it can move it at once
//   (PRD §4.3: "the arrival waits on the player's taxiway until it clears"). So the ramp's own
//   aircraft never wait for one another in a cycle.
// - It doesn't push into a lane an arrival is coming in along, or send an arrival into a lane a
//   departure is pushing into or taxiing out of: those movements share edges.
// The cost is throughput: whole movements are serialized where they meet, about 2–4 minutes
// each. Letting a movement give back what's behind its tail would be the next step.
//
// Not handled:
// - "No gate free": the arrival waits at the entrance, ground's, and nothing is said (the pilot's
//   "no gate yet" call is Phase 3). At a ramp handoff used both ways, such an arrival blocks the
//   departures that would free a gate: the player has to move it.
// - "monitor ramp" anywhere else is recorded and does nothing until the aircraft stops at the end
//   of a taxi to a ramp entrance (as with tower's handoff). An aircraft whose own terminal the
//   entrance doesn't serve isn't taken.
// - Metering, release times and gate-availability delays (Phase 3); tugs and towing.
// - Fairness: an older request blocked by a movement doesn't stop a younger one whose way is free
//   from going first.
//
// Values [Builder] (PRD §8.3: "behavior details are [Proposal]"), with their basis. "Mine" means
// my own reasoning, not a source.
// - PUSH_READY_S 30–90 s, uniform from the seeded RNG: from being added at the gate, boarded, to
//   asking to push. Mine: short, so sessions and tests move; Phase 3's metering holds longer.
// - PUSH_SPEED_MPS 1.5 (about 3 kt), PUSH_ACCEL_MPS2 and PUSH_DECEL_MPS2 0.3: a pushback is about
//   walking pace (the wing walker walks beside it), starting and stopping gently. Mine, from that
//   common description; no figure checked.
// - PUSH_SETTLE_S 30: stopped after the push, the tug disconnects and the crew gets the all-clear
//   before taxiing. Mine. Engine start happens during the push, so it isn't added.
// - Push distance: no fixed value. It's the stand's length plus any push along the lane before
//   the tail swings; MAX_PUSH_M 400 only bounds the search. At KJFK an A320's pushes are 109 m
//   (median) to 252 m (measured with this code).
// - RAMP_TAXI_KT 10: ramp-lane taxi speed on a straight, half movement.ts's 20 kt, since ramps are
//   congested and close to stands; a pilot set slower keeps their own speed. Mine; turns slow
//   further by movement.ts's turn speeds.
// - MAX_TURN_DEG 135: the sharpest turn at a node a ramp route or a tail swing takes (movement.ts
//   slows to about 7 kt there). Mine: sharper is close to reversing. At KJFK, an A320 can push
//   from 122 gates at 120°, 123 at 135° and 134 at 170° (measured with this code).
// - Spacing: no separate ramp value. Movements hold whole paths (above); see-and-avoid's SPACING_M
//   applies against everything else.
// - DEPARTURE_JITTER 0.15: a departure stream's spacing varies ±15%, as tower's arrival streams.

import { edgeLength, edgePolyline, edgesAt, otherEnd, type AirportIndex } from '../airport/graph.ts';
import type { Edge, EdgeId, Gate, GateId, NodeId, Point, RampHandoff, RampHandoffId, TerminalId } from '../airport/types.ts';
import { AIRCRAFT_TYPES, isAircraftType, type AircraftTypeCode } from './aircraft-types.ts';
import { KNOT_MPS, safeSpeed, STOP_SNAP_M, TICK_HZ, TICK_S } from './movement.ts';
import { nextFloat, nextInRange } from './rng.ts';
import { nodeAt } from './stops.ts';
import { buildTrack, placeOf, type Track } from './track.ts';
import { occupancyOf, SPACING_M, type Occupancy } from './traffic.ts';
import { emit, type Aircraft, type RampAircraft, type RampState, type Sim } from './world.ts';

/** A departure waits this long at its gate, from when it's added, before it asks to push. */
export const PUSH_READY_S: readonly [min: number, max: number] = [30, 90];
/** A departure stream's spacing varies by this fraction either way, from the seeded RNG. */
export const DEPARTURE_JITTER = 0.15;
/** Pushback: the tug's top speed backward, and its acceleration and braking. */
export const PUSH_SPEED_MPS = 1.5;
export const PUSH_ACCEL_MPS2 = 0.3;
export const PUSH_DECEL_MPS2 = 0.3;
/** Stopped after the push, the tug disconnects for this long before the aircraft taxis. */
export const PUSH_SETTLE_S = 30;
/** The ramp's taxi speed on a straight, knots: a pilot faster than this slows to it on the ramp. */
export const RAMP_TAXI_KT = 10;
/** The sharpest turn a ramp route, or a pushed tail, takes at a node, degrees. */
export const MAX_TURN_DEG = 135;
/** The longest pushback the ramp plans, gate to the nose's stop, meters. */
export const MAX_PUSH_M = 400;

// ---------------------------------------------------------------------------------------------
// Setup: derived from the airport and the options, not state

/** The flight a departure stream spawns next. Callsigns and the rest come from the caller. */
export interface DepartureFlight {
  callsign: string;
  type: string;
  /** It's spawned at a free gate of this terminal. */
  terminal: TerminalId;
  airline?: string | null;
}

/** Departures the ramp spawns at gates of their terminal, at a set rate (interim, until Phase 3's traffic). */
export interface DepartureStream {
  perHour: number;
  /** Flight number n (0, 1, …). It must be deterministic: the same n always gives the same flight. */
  flight: (n: number) => DepartureFlight;
  /** When the first one is spawned, seconds from the start. Default 0. */
  firstAtS?: number;
}

export interface RampOptions {
  departures?: DepartureStream[];
}

/**
 * A gate's stand: its lead-in, from the junction where it leaves a ramp lane (`nodes[0]`) to
 * the gate node (last). It's the unnamed ramp-lane chain back from the gate node, through
 * nodes with no other edge.
 */
export interface Stand {
  gate: Gate;
  nodes: NodeId[];
  edges: EdgeId[];
  lengthM: number;
}

export interface RampSetup {
  /** By gate id: its stand, or why the ramp can't use the gate. */
  readonly stands: ReadonlyMap<GateId, Stand | { unusable: string }>;
  /** Every stand's edges: ramp routes and pushes never use another gate's stand. */
  readonly standEdges: ReadonlySet<EdgeId>;
  readonly handoffNodes: ReadonlySet<NodeId>;
  /** Pushback plans by `<gate>|<type>`, worked out when first needed. */
  readonly plans: Map<string, DeparturePlan | { unable: string }>;
  /** Ways in by `<entrance node>|<edge arrived along>|<gate>`, worked out when first needed. */
  readonly arrivalWays: Map<string, Way | null>;
  readonly streams: readonly DepartureStream[];
  /** Each plan's tracks and what a departure on them covers, by `<gate>|<type>`. */
  readonly departureTracks: Map<string, { plan: DeparturePlan; push: Track; out: Track; elements: string[] }>;
  /** A waiting arrival's way in, by its record (wayInFor). Not state: derived from it. */
  readonly waysIn: WeakMap<RampAircraft, { track: Track; s: number; elements: string[] }>;
}

export function rampSetup(index: AirportIndex, options: RampOptions): RampSetup {
  const streams = options.departures ?? [];
  for (const stream of streams) {
    if (!(stream.perHour > 0)) throw new Error(`departure stream: perHour must be > 0, got ${stream.perHour}`);
  }
  const stands = new Map<GateId, Stand | { unusable: string }>();
  for (const gate of index.airport.gates) stands.set(gate.id, standOf(index, gate));
  const standEdges = new Set<EdgeId>();
  for (const stand of stands.values()) if (!('unusable' in stand)) for (const e of stand.edges) standEdges.add(e);
  const handoffNodes = new Set(index.airport.rampHandoffs.map((h) => h.node));
  return { stands, standEdges, handoffNodes, plans: new Map(), arrivalWays: new Map(), streams, departureTracks: new Map(), waysIn: new WeakMap() };
}

export function initialRampState(setup: RampSetup): RampState {
  return { streams: setup.streams.map((s) => ({ nextTick: Math.round((s.firstAtS ?? 0) * TICK_HZ), count: 0 })), aircraft: [] };
}

/**
 * Each stream's departure due now, with the gate it's spawned at, for sim.ts to add (it builds
 * aircraft): a free gate of its terminal that it fits and can push from, whose stand no movement
 * holds, preferring its airline's, at random (seeded). With none free, it stays due.
 */
export function rampSpawns(sim: Sim): (DepartureFlight & { gate: GateId })[] {
  const due: (DepartureFlight & { gate: GateId })[] = [];
  sim.ramp.streams.forEach((stream, i) => {
    const state = sim.world.ramp.streams[i];
    if (!state) throw new Error(`no state for departure stream ${i}`);
    if (sim.world.tick < state.nextTick) return;
    const flight = stream.flight(state.count);
    if (!isAircraftType(flight.type)) throw new Error(`${flight.callsign}: unknown aircraft type "${flight.type}"`);
    const type = flight.type;
    const terminal = sim.index.airport.terminals.find((t) => t.id === flight.terminal);
    if (!terminal) throw new Error(`${flight.callsign}: no terminal ${flight.terminal}`);
    const taken = new Set([...sim.world.ramp.aircraft.map((r) => r.gate), ...due.map((d) => d.gate)]);
    const held = reservedElements(sim, '');
    const free = sim.index.airport.gates.filter((g) => {
      if (g.terminal !== terminal.id || taken.has(g.id) || 'unable' in departurePlanFor(sim, g.id, type)) return false;
      const stand = usableStand(sim, g.id);
      return !stand.edges.some((e) => held.has(`e:${e}`)) && !stand.nodes.some((n) => held.has(`n:${n}`));
    });
    const gate = pickGate(sim, free, terminal.airlines, flight.airline ?? null);
    if (gate === null) return;
    due.push({ ...flight, gate });
    state.count += 1;
    const intervalS = (3600 / stream.perHour) * nextInRange(sim.world.rng, 1 - DEPARTURE_JITTER, 1 + DEPARTURE_JITTER);
    state.nextTick = sim.world.tick + Math.round(intervalS * TICK_HZ);
  });
  return due;
}

/** Among `free`, those `airline` uses (the gate's airlines, else `terminalAirlines`), if any; one at random (seeded). */
function pickGate(sim: Sim, free: Gate[], terminalAirlines: string[], airline: string | null): GateId | null {
  const theirs = airline === null ? [] : free.filter((g) => (g.airlines ?? terminalAirlines).includes(airline));
  const pool = theirs.length > 0 ? theirs : free;
  if (pool.length <= 1) return pool[0]?.id ?? null;
  const pick = pool[Math.floor(nextFloat(sim.world.rng) * pool.length)];
  if (!pick) throw new Error('gate pick out of range');
  return pick.id;
}

function standOf(index: AirportIndex, gate: Gate): Stand | { unusable: string } {
  const handoffs = new Set(index.airport.rampHandoffs.map((h) => h.node));
  const at = edgesAt(index, gate.node);
  const first = at[0];
  if (at.length !== 1 || !first) return { unusable: `gate ${gate.id}'s node ${gate.node} has ${at.length} edges, not one lead-in` };
  if (first.kind !== 'rampLane' || first.closed) return { unusable: `gate ${gate.id}'s lead-in ${first.id} isn't an open ramp lane` };
  const nodes = [gate.node];
  const edges: EdgeId[] = [];
  let via = first;
  let node = otherEnd(via, gate.node);
  let lengthM = edgeLength(index, via);
  edges.push(via.id);
  nodes.push(node);
  for (;;) {
    const others = edgesAt(index, node).filter((e) => e.id !== via.id);
    const next = others[0];
    if (others.length !== 1 || !next || next.kind !== 'rampLane' || next.name !== undefined || next.closed || handoffs.has(node)) break;
    via = next;
    node = otherEnd(next, node);
    lengthM += edgeLength(index, next);
    edges.push(next.id);
    nodes.push(node);
  }
  return { gate, nodes: nodes.reverse(), edges: edges.reverse(), lengthM };
}

// ---------------------------------------------------------------------------------------------
// Gates

/** The stand of `gateId`, or throws why the ramp can't use it. */
function usableStand(sim: Sim, gateId: GateId): Stand {
  const stand = sim.ramp.stands.get(gateId);
  if (!stand) throw new Error(`no gate ${gateId} at ${sim.index.airport.id}`);
  if ('unusable' in stand) throw new Error(stand.unusable);
  return stand;
}

/**
 * Where an aircraft parked at `gateId` is: nose on the gate node, its body back along the
 * stand. Throws if the gate is unknown, taken, or can't park it, or for a departure, if it has
 * no way out (departurePlanFor).
 */
export function placeAtGate(sim: Sim, callsign: string, gateId: GateId, type: AircraftTypeCode, role: 'departure' | 'arrival'): { track: Track; s: number; terminal: TerminalId } {
  const stand = usableStand(sim, gateId);
  const holder = gateOccupant(sim, gateId);
  if (holder !== null) throw new Error(`${callsign}: gate ${gateId} is taken by ${holder}`);
  const fit = standFit(stand, type);
  if (fit !== null) throw new Error(`${callsign}: ${fit}`);
  // A departure must have a way out.
  const plan = role === 'departure' ? departurePlanFor(sim, gateId, type) : null;
  if (plan && 'unable' in plan) throw new Error(`${callsign}: ${plan.unable}`);
  return { track: buildTrack(sim.index, stand.nodes, stand.edges), s: stand.lengthM, terminal: stand.gate.terminal };
}

/**
 * Why `type` can't park on `stand`, or null. Parked, its tail must be farther from the lane
 * junction than its half-span, so see-and-avoid (traffic.ts) doesn't count the junction as
 * occupied: a parked aircraft never blocks the lane.
 */
function standFit(stand: Stand, type: AircraftTypeCode): string | null {
  const { lengthM, wingspanM } = AIRCRAFT_TYPES[type];
  const clear = stand.lengthM - lengthM;
  if (clear > wingspanM / 2) return null;
  const junction = stand.nodes[0];
  return `gate ${stand.gate.id} is too short for a ${type}: its tail would be ${clear.toFixed(1)} m from the lane at ${junction}, inside its half-span ${(wingspanM / 2).toFixed(1)} m`;
}

/** Takes on an aircraft just added at a gate (placeAtGate): a departure boards, then asks to push. */
export function adoptAtGate(sim: Sim, callsign: string, gateId: GateId, role: 'departure' | 'arrival'): void {
  const tick = sim.world.tick;
  const [lo, hi] = PUSH_READY_S;
  const readyTick = role === 'departure' ? tick + Math.round(nextInRange(sim.world.rng, lo, hi) * TICK_HZ) : null;
  sim.world.ramp.aircraft.push({
    callsign,
    phase: role === 'departure' ? 'at-gate' : 'parked',
    gate: gateId,
    since: tick,
    readyTick,
    rampHandoff: null,
    pushTo: null,
    reserved: [],
    pilotCruiseMps: null,
  });
}

/** Forgets an aircraft that's leaving the sim: its gate, and anything it held, are free. */
export function rampDrop(sim: Sim, callsign: string): void {
  sim.world.ramp.aircraft = sim.world.ramp.aircraft.filter((r) => r.callsign !== callsign);
}

/** The aircraft holding `gateId` (parked, pushing from it, or assigned to it), or null. */
export function gateOccupant(sim: Sim, gateId: GateId): string | null {
  return sim.world.ramp.aircraft.find((r) => r.gate === gateId)?.callsign ?? null;
}

// ---------------------------------------------------------------------------------------------
// Planning: pushbacks and ramp routes, over open ramp lanes only

/** A chain of edges from `nodes[0]`: one more node than edges. */
interface Way {
  nodes: NodeId[];
  edges: EdgeId[];
  lengthM: number;
}

/**
 * A departure's way out, for one gate and type:
 * - `push`: the pushback track, nose-forward: the tail's way onto the lane, the push point,
 *   then back along the way it's pushed to the gate. It's pushed from the end to `pushTo`.
 * - `out`: the taxi-out track: the same start up to the push point, then on to the ramp edge.
 */
export interface DeparturePlan {
  push: Way;
  out: Way;
  pushTo: number;
  rampHandoff: RampHandoffId;
}

/**
 * The way out for a `type` departing `gate`, or why there's none: the gate can't be used, the
 * type doesn't fit its stand, or no pushback works. Throws for an unknown gate. Cached.
 */
export function departurePlanFor(sim: Sim, gate: GateId, type: AircraftTypeCode): DeparturePlan | { unable: string } {
  const key = `${gate}|${type}`;
  const cached = sim.ramp.plans.get(key);
  if (cached) return cached;
  const stand = sim.ramp.stands.get(gate);
  if (!stand) throw new Error(`no gate ${gate} at ${sim.index.airport.id}`);
  const plan = 'unusable' in stand ? { unable: stand.unusable } : standFit(stand, type) !== null ? { unable: standFit(stand, type) ?? '' } : planDeparture(sim, gate, type);
  sim.ramp.plans.set(key, plan);
  return plan;
}

/**
 * The shortest pushback, by the distance the nose is pushed, after which the aircraft can taxi
 * forward to a ramp edge serving its terminal. The push goes back out of the stand and along
 * ramp lanes, never into another stand or through a ramp handoff, and stops with the nose on
 * a node, the tail swung onto a lane there: `tail` lies along lanes for at least the aircraft's
 * length from that node. From there it taxis forward (no reversing onto the tail's lane) to the
 * nearest ramp edge. Among tails at the same push point, the one with the shortest taxi wins.
 */
function planDeparture(sim: Sim, gateId: GateId, type: AircraftTypeCode): DeparturePlan | { unable: string } {
  const index = sim.index;
  const stand = usableStand(sim, gateId);
  const { lengthM } = AIRCRAFT_TYPES[type];
  const goals = new Set(
    index.airport.rampHandoffs
      .filter((h) => h.use !== 'arrivals' && (h.terminals === undefined || h.terminals.includes(stand.gate.terminal)))
      .map((h) => h.node),
  );
  if (goals.size === 0) return { unable: `no ramp edge serves ${stand.gate.terminal}` };
  const laneOk = (e: Edge) => e.kind === 'rampLane' && !e.closed && !sim.ramp.standEdges.has(e.id);
  const junction = stand.nodes[0];
  const standFirst = stand.edges[0];
  if (junction === undefined || standFirst === undefined) throw new Error(`gate ${gateId}: an empty stand`);

  interface Label {
    node: NodeId;
    /** The edge the nose was pushed along into `node`. */
    via: Edge;
    dist: number;
    /** Backward from the gate: nodes from the gate to `node`, and their edges. */
    nodes: NodeId[];
    edges: EdgeId[];
  }
  const queue: Label[] = [
    { node: junction, via: edgeOf(index, standFirst), dist: stand.lengthM, nodes: [...stand.nodes].reverse(), edges: [...stand.edges].reverse() },
  ];
  const settled = new Set<string>();
  while (queue.length > 0) {
    const label = queue.reduce((a, b) => (b.dist < a.dist ? b : a));
    queue.splice(queue.indexOf(label), 1);
    const key = `${label.node}|${label.via.id}`;
    if (settled.has(key)) continue;
    settled.add(key);
    if (sim.ramp.handoffNodes.has(label.node)) continue;
    const onward = edgesAt(index, label.node).filter((e) => e.id !== label.via.id && laneOk(e) && turnAt(index, label.node, label.via, e) <= MAX_TURN_DEG);
    // Stop the push here, with the tail swung onto one of these lanes?
    let best: { tail: Way; out: Way; rampHandoff: RampHandoffId } | null = null;
    for (const t of onward) {
      const tail = tailWay(sim, label.node, t, lengthM, laneOk);
      if (tail === null) continue;
      const out = forwardWay(index, label.node, t, laneOk, (n) => goals.has(n));
      if (out === null || (best !== null && out.lengthM >= best.out.lengthM)) continue;
      const handoff = index.airport.rampHandoffs.find((h) => h.node === out.nodes.at(-1) && h.use !== 'arrivals');
      if (!handoff) throw new Error(`ramp route ended off a ramp edge, at ${out.nodes.at(-1)}`);
      best = { tail, out, rampHandoff: handoff.id };
    }
    if (best !== null) {
      const tailNodes = [...best.tail.nodes].reverse();
      const tailEdges = [...best.tail.edges].reverse();
      const back = [...label.nodes].reverse();
      const backEdges = [...label.edges].reverse();
      return {
        push: { nodes: [...tailNodes, ...back.slice(1)], edges: [...tailEdges, ...backEdges], lengthM: best.tail.lengthM + label.dist },
        out: { nodes: [...tailNodes, ...best.out.nodes.slice(1)], edges: [...tailEdges, ...best.out.edges], lengthM: best.tail.lengthM + best.out.lengthM },
        pushTo: best.tail.lengthM,
        rampHandoff: best.rampHandoff,
      };
    }
    for (const e of onward) {
      const dist = label.dist + edgeLength(index, e);
      if (dist > MAX_PUSH_M || label.edges.includes(e.id)) continue;
      const to = otherEnd(e, label.node);
      queue.push({ node: to, via: e, dist, nodes: [...label.nodes, to], edges: [...label.edges, e.id] });
    }
  }
  return { unable: `gate ${gateId} has no pushback for a ${type} that ends facing a way to a ramp edge for ${stand.gate.terminal} (within ${MAX_PUSH_M} m, turns up to ${MAX_TURN_DEG}°)` };
}

/**
 * Where a pushed tail goes from `node`: onto `first`, then on along the straightest lanes, until
 * it has the aircraft's length. Outward from `node`. null: the lanes run out first.
 */
function tailWay(sim: Sim, node: NodeId, first: Edge, lengthM: number, laneOk: (e: Edge) => boolean): Way | null {
  const index = sim.index;
  const way: Way = { nodes: [node], edges: [first.id], lengthM: edgeLength(index, first) };
  let at = otherEnd(first, node);
  let via = first;
  way.nodes.push(at);
  while (way.lengthM < lengthM) {
    if (sim.ramp.handoffNodes.has(at) || way.edges.length > 50) return null;
    let next: Edge | null = null;
    let sharpest = Infinity;
    for (const e of edgesAt(index, at)) {
      if (e.id === via.id || !laneOk(e) || way.edges.includes(e.id)) continue;
      const turn = turnAt(index, at, via, e);
      if (turn <= MAX_TURN_DEG && turn < sharpest) [next, sharpest] = [e, turn];
    }
    if (next === null) return null;
    way.edges.push(next.id);
    way.lengthM += edgeLength(index, next);
    at = otherEnd(next, at);
    via = next;
    way.nodes.push(at);
  }
  return way;
}

/**
 * The shortest way forward from `start`, having arrived along `arrived`, over edges that pass
 * `edgeOk`, to a node that passes `isGoal`: never back along the edge just travelled, never
 * along an edge twice, never turning more than MAX_TURN_DEG. Dijkstra by length over (node,
 * edge arrived along); ties go to the label queued first, so it's deterministic. null: none.
 */
function forwardWay(index: AirportIndex, start: NodeId, arrived: Edge, edgeOk: (e: Edge) => boolean, isGoal: (n: NodeId) => boolean): Way | null {
  interface Label {
    node: NodeId;
    via: Edge;
    way: Way;
  }
  const queue: Label[] = [{ node: start, via: arrived, way: { nodes: [start], edges: [], lengthM: 0 } }];
  const settled = new Set<string>();
  while (queue.length > 0) {
    const label = queue.reduce((a, b) => (b.way.lengthM < a.way.lengthM ? b : a));
    queue.splice(queue.indexOf(label), 1);
    const key = `${label.node}|${label.via.id}`;
    if (settled.has(key)) continue;
    settled.add(key);
    if (label.node !== start && isGoal(label.node)) return label.way;
    for (const e of edgesAt(index, label.node)) {
      if (e.id === label.via.id || !edgeOk(e) || label.way.edges.includes(e.id)) continue;
      if (turnAt(index, label.node, label.via, e) > MAX_TURN_DEG) continue;
      const to = otherEnd(e, label.node);
      const way = { nodes: [...label.way.nodes, to], edges: [...label.way.edges, e.id], lengthM: label.way.lengthM + edgeLength(index, e) };
      queue.push({ node: to, via: e, way });
    }
  }
  return null;
}

/** How far the direction turns at `node`, arriving along `from` and leaving along `to`: 0–180°. */
function turnAt(index: AirportIndex, node: NodeId, from: Edge, to: Edge): number {
  const a = direction(index, from, node, 'in');
  const b = direction(index, to, node, 'out');
  if (a === null || b === null) return 0;
  return Math.abs((Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) * 180) / Math.PI);
}

/** The unit direction of `edge` arriving at (`in`) or leaving (`out`) `node`. null: no length there. */
function direction(index: AirportIndex, edge: Edge, node: NodeId, end: 'in' | 'out'): Point | null {
  const line = edgePolyline(index, edge);
  if (edge.to === node) line.reverse(); // now from `node` outward
  // The first vertex away from the node that isn't on it (a zero-length edge has none).
  const p = line[0];
  const q = line.find((v) => p !== undefined && (v[0] !== p[0] || v[1] !== p[1]));
  if (!p || !q) return null;
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const out: Point = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
  return end === 'out' ? out : [-out[0], -out[1]];
}

function edgeOf(index: AirportIndex, id: EdgeId): Edge {
  const edge = index.edges.get(id);
  if (!edge) throw new Error(`no edge ${id}`);
  return edge;
}

// ---------------------------------------------------------------------------------------------
// Reservations and blocking

/**
 * What a movement holds: every edge its body touches between track distances `from` and `to`,
 * and both ends of each.
 */
function elementsOf(track: Track, from: number, to: number): string[] {
  const out: string[] = [];
  track.edges.forEach((edge, i) => {
    const [a, b] = [track.nodeAt[i], track.nodeAt[i + 1]];
    if (a === undefined || b === undefined) throw new Error(`track edge ${i} has no extent`);
    if (b < from || a > to) return;
    out.push(`e:${edge}`, `n:${track.nodes[i]}`, `n:${track.nodes[i + 1]}`);
  });
  return [...new Set(out)];
}

/** Everything held by moving ramp aircraft, other than `except`. */
function reservedElements(sim: Sim, except: string): Set<string> {
  const held = new Set<string>();
  for (const r of sim.world.ramp.aircraft) if (r.callsign !== except) for (const x of r.reserved) held.add(x);
  return held;
}

/**
 * A body, other than those in `ignore`, in the way of a body covering track distances `from`
 * to `to`, by see-and-avoid's rules (traffic.ts): any part of it on the track's edges there
 * (with the spacing either side), or near a node there, within its own half-span of it. Its
 * callsign, or null.
 */
function staticBlocker(sim: Sim, occupancy: Occupancy, track: Track, from: number, to: number, ignore: ReadonlySet<string>): string | null {
  const { nodes, edges, nodeAt } = track;
  for (let i = 0; i < edges.length; i++) {
    const [id, start, end] = [edges[i], nodeAt[i], nodeAt[i + 1]];
    if (id === undefined || start === undefined || end === undefined) throw new Error(`track edge ${i} has no extent`);
    if (end < from - SPACING_M || start > to + SPACING_M) continue;
    const edge = edgeOf(sim.index, id);
    const forward = edge.from === nodes[i];
    const len = end - start;
    for (const o of occupancy.byEdge.get(id) ?? []) {
      if (ignore.has(o.callsign)) continue;
      const [t0, t1] = forward ? [start + o.u0, start + o.u1] : [start + len - o.u1, start + len - o.u0];
      if (t1 > from - SPACING_M && t0 < to + SPACING_M) return o.callsign;
    }
  }
  for (let j = 0; j < nodes.length; j++) {
    const [node, at] = [nodes[j], nodeAt[j]];
    if (node === undefined || at === undefined) throw new Error(`track node ${j} is missing`);
    if (at < from || at > to) continue;
    for (const o of occupancy.byNode.get(node) ?? []) if (!ignore.has(o.callsign)) return o.callsign;
    const own = new Set([edges[j - 1], edges[j]]);
    for (const edge of edgesAt(sim.index, node)) {
      if (own.has(edge.id)) continue;
      for (const o of occupancy.byEdge.get(edge.id) ?? []) {
        if (ignore.has(o.callsign)) continue;
        const distance = edge.from === node ? o.u0 : o.edgeLengthM - o.u1;
        if (distance <= o.wingspanM / 2) return o.callsign;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The ramp's decisions, each tick

/**
 * The ramp's decisions for this tick, on the state the last tick left: departures that have
 * boarded ask to push; then waiting aircraft, oldest first, start moving when their way is free.
 */
export function rampDecide(sim: Sim): void {
  const ramp = sim.world.ramp;
  const tick = sim.world.tick;
  for (const r of ramp.aircraft) {
    if (r.phase === 'at-gate' && r.readyTick !== null && tick >= r.readyTick) [r.phase, r.since] = ['ready', tick];
    if (r.phase === 'pushed' && tick >= r.since + PUSH_SETTLE_S * TICK_HZ) startTaxiOut(sim, r);
  }
  callArrivals(sim);
  // Oldest first (a stable sort keeps the record order for ties).
  const waiting = sim.world.ramp.aircraft.filter((r) => r.phase === 'ready' || r.phase === 'called').sort((a, b) => a.since - b.since);
  if (waiting.length === 0) return;
  let occupancy: Occupancy | null = null;
  const round: Round = {
    held: new Set(sim.world.ramp.aircraft.flatMap((r) => r.reserved)),
    moving: new Set(sim.world.ramp.aircraft.filter((r) => r.reserved.length > 0).map((r) => r.callsign)),
    occupancy: () => (occupancy ??= occupancyOf(sim)),
  };
  for (const r of waiting) {
    const ac = aircraftOf(sim, r.callsign);
    if (r.phase === 'ready') startPushback(sim, round, r, ac);
    else startTaxiIn(sim, round, r, ac);
  }
}

/** What the waiting aircraft are checked against in one decide: it grows as movements start. */
interface Round {
  /** Everything held by moving ramp aircraft. */
  held: Set<string>;
  /** Their callsigns. */
  moving: Set<string>;
  /** Where every body is, at the start of this tick (worked out once, when first needed). */
  occupancy: () => Occupancy;
}

/** Starts a movement holding `elements`: it now blocks the rest of this round. */
function hold(round: Round, r: RampAircraft, elements: string[]): void {
  r.reserved = [...elements];
  for (const x of elements) round.held.add(x);
  round.moving.add(r.callsign);
}

/**
 * Arrivals at a ramp entrance, handed to ramp: each is assigned a gate and waits, still
 * ground's, until its way in is clear. One with no gate free isn't taken: it waits where it is,
 * ground's, with nothing said (the "no gate yet" call is Phase 3). One that's no longer waiting
 * there (the player moved it) gives its gate back.
 */
function callArrivals(sim: Sim): void {
  const ramp = sim.world.ramp;
  ramp.aircraft = ramp.aircraft.filter((r) => r.phase !== 'called' || entranceOf(sim, aircraftOf(sim, r.callsign))?.id === r.rampHandoff);
  const known = new Set(ramp.aircraft.map((r) => r.callsign));
  for (const ac of sim.world.aircraft) {
    if (known.has(ac.callsign)) continue;
    const handoff = entranceOf(sim, ac);
    if (handoff === null) continue;
    const gate = assignGate(sim, ac, handoff);
    if (gate === null) continue;
    ramp.aircraft.push({ callsign: ac.callsign, phase: 'called', gate, since: sim.world.tick, readyTick: null, rampHandoff: handoff.id, pushTo: null, reserved: [], pilotCruiseMps: null });
  }
}

/**
 * The ramp entrance `ac` is waiting at for ramp: ground's, handed off to ramp, stopped at the end
 * of a taxi to the entrance. Its own terminal, if known, must be one the entrance serves. null:
 * it isn't.
 */
function entranceOf(sim: Sim, ac: Aircraft): RampHandoff | null {
  if (ac.controller !== 'ground' || ac.motion !== 'taxi' || ac.advisories.handoff?.facility !== 'ramp' || ac.v !== 0) return null;
  const clearance = ac.clearance;
  const destination = clearance?.path.destination;
  if (!clearance || destination?.kind !== 'ramp') return null;
  if (ac.s !== nodeAt(ac.track, clearance.pathOffset + clearance.path.nodes.length - 1)) return null;
  const handoff = sim.index.airport.rampHandoffs.find((h) => h.id === destination.rampHandoff);
  if (!handoff) throw new Error(`${ac.callsign}: at unknown ramp entrance ${destination.rampHandoff}`);
  if (ac.terminal !== null && handoff.terminals !== undefined && !handoff.terminals.includes(ac.terminal)) return null;
  return handoff;
}

/**
 * A free gate for `ac` at its terminal (else the entrance's), that it fits and can leave again,
 * reachable from `handoff` over ramp lanes. Among them, those its airline uses (the gate's
 * airlines, or its terminal's), if any; one of those at random (seeded). null: none free.
 */
function assignGate(sim: Sim, ac: Aircraft, handoff: RampHandoff): GateId | null {
  const destination = ac.clearance?.path.destination;
  const terminalId = ac.terminal ?? (destination?.kind === 'ramp' ? destination.terminal : null);
  const terminal = sim.index.airport.terminals.find((t) => t.id === terminalId);
  if (!terminal) return null;
  const arrived = arrivedEdge(sim, ac);
  const taken = new Set(sim.world.ramp.aircraft.map((r) => r.gate));
  const free = sim.index.airport.gates.filter(
    (g) =>
      g.terminal === terminal.id &&
      !taken.has(g.id) &&
      !('unable' in departurePlanFor(sim, g.id, ac.type)) &&
      arrivalWay(sim, handoff.node, arrived, g.id) !== null,
  );
  return pickGate(sim, free, terminal.airlines, ac.airline);
}

/** The edge `ac` arrived along at the node its nose is on. Throws if it's mid-edge or has no heading. */
function arrivedEdge(sim: Sim, ac: Aircraft): Edge {
  const place = placeOf(ac.track, ac.s);
  const id = place.kind === 'node' ? ac.track.edges[place.i - 1] : undefined;
  if (id === undefined) throw new Error(`${ac.callsign}: not stopped on a node it arrived at along an edge`);
  return edgeOf(sim.index, id);
}

/**
 * The way from ramp entrance node `from`, having arrived along `arrived`, to gate `gateId`: over
 * open ramp lanes, into no stand but its own. Cached. null: none.
 */
function arrivalWay(sim: Sim, from: NodeId, arrived: Edge, gateId: GateId): Way | null {
  const key = `${from}|${arrived.id}|${gateId}`;
  const cached = sim.ramp.arrivalWays.get(key);
  if (cached !== undefined) return cached;
  const stand = usableStand(sim, gateId);
  const own = new Set(stand.edges);
  const ok = (e: Edge) => e.kind === 'rampLane' && !e.closed && (own.has(e.id) || !sim.ramp.standEdges.has(e.id));
  const way = forwardWay(sim.index, from, arrived, ok, (n) => n === stand.gate.node);
  sim.ramp.arrivalWays.set(key, way);
  return way;
}

/**
 * A waiting arrival's track in: its trail (the edge holding its tail) up to the entrance, then the
 * way to its gate; where its nose is on it; and what it covers. Worked out once per wait: while
 * it waits it doesn't move, and a new wait is a new record.
 */
function wayInFor(sim: Sim, r: RampAircraft, ac: Aircraft): { track: Track; s: number; elements: string[] } {
  const cached = sim.ramp.waysIn.get(r);
  if (cached) return cached;
  const place = placeOf(ac.track, ac.s);
  if (place.kind !== 'node') throw new Error(`${ac.callsign}: waiting at a ramp entrance, but not on a node`);
  const way = arrivalWay(sim, nodeOf(ac.track, place.i), arrivedEdge(sim, ac), r.gate);
  if (way === null) throw new Error(`${ac.callsign}: assigned gate ${r.gate} with no way to it`);
  const t0 = Math.min(placeOf(ac.track, Math.max(0, ac.s - ac.lengthM)).i, place.i);
  const track = buildTrack(sim.index, [...ac.track.nodes.slice(t0, place.i + 1), ...way.nodes.slice(1)], [...ac.track.edges.slice(t0, place.i), ...way.edges]);
  const s = nodeAt(track, place.i - t0);
  const wayIn = { track, s, elements: elementsOf(track, s - ac.lengthM, track.lengthM) };
  sim.ramp.waysIn.set(r, wayIn);
  return wayIn;
}

/** Its way in is clear: ramp takes it, and taxis it to its gate (movement.ts moves it). */
function startTaxiIn(sim: Sim, round: Round, r: RampAircraft, ac: Aircraft): boolean {
  const { track, s, elements } = wayInFor(sim, r, ac);
  if (elements.some((x) => round.held.has(x))) return false;
  if (staticBlocker(sim, round.occupancy(), track, s - ac.lengthM, track.lengthM, new Set([...round.moving, r.callsign])) !== null) return false;
  hold(round, r, elements);
  Object.assign(r, { phase: 'taxi-in', since: sim.world.tick, pilotCruiseMps: ac.cruiseMps });
  Object.assign(ac, {
    controller: 'ramp',
    track,
    s,
    clearance: null,
    crossings: [],
    holdPosition: false,
    status: 'taxiing',
    blockedBy: null,
    cruiseMps: Math.min(ac.cruiseMps, RAMP_TAXI_KT * KNOT_MPS),
  });
  const rampHandoff = r.rampHandoff;
  if (rampHandoff === null) throw new Error(`${ac.callsign}: taken in at no ramp entrance`);
  emit(sim, { type: 'ramp-accepted', tick: sim.world.tick, callsign: ac.callsign, rampHandoff, gate: r.gate });
  return true;
}

/**
 * A departure asking to push starts, if everything its pushback and taxi-out will cover is free:
 * held by no movement, and no other body in the way (staticBlocker).
 */
function startPushback(sim: Sim, round: Round, r: RampAircraft, ac: Aircraft): boolean {
  const { plan, push, out, elements } = departureTracks(sim, r.gate, ac.type);
  if (elements.some((x) => round.held.has(x))) return false;
  const from = plan.pushTo - ac.lengthM;
  const ignore = new Set([...round.moving, r.callsign]);
  if (staticBlocker(sim, round.occupancy(), push, from, push.lengthM, ignore) !== null) return false;
  if (staticBlocker(sim, round.occupancy(), out, from, out.lengthM, ignore) !== null) return false;
  hold(round, r, elements);
  Object.assign(r, { phase: 'pushback', since: sim.world.tick, pushTo: plan.pushTo, rampHandoff: plan.rampHandoff });
  Object.assign(ac, { track: copyTrack(push), s: push.lengthM, v: 0, status: 'pushing-back' });
  emit(sim, { type: 'pushback', tick: sim.world.tick, callsign: ac.callsign, gate: r.gate });
  return true;
}

/** A departure plan's tracks, and everything the departure covers on them. Cached; don't change them. */
function departureTracks(sim: Sim, gate: GateId, type: AircraftTypeCode): { plan: DeparturePlan; push: Track; out: Track; elements: string[] } {
  const key = `${gate}|${type}`;
  const cached = sim.ramp.departureTracks.get(key);
  if (cached) return cached;
  const plan = departurePlanFor(sim, gate, type);
  if ('unable' in plan) throw new Error(`a ${type} at ${gate}: ${plan.unable}`);
  const push = buildTrack(sim.index, plan.push.nodes, plan.push.edges);
  const out = buildTrack(sim.index, plan.out.nodes, plan.out.edges);
  const from = plan.pushTo - AIRCRAFT_TYPES[type].lengthM;
  const elements = [...new Set([...elementsOf(push, from, push.lengthM), ...elementsOf(out, from, out.lengthM)])];
  const tracks = { plan, push, out, elements };
  sim.ramp.departureTracks.set(key, tracks);
  return tracks;
}

/** A track of its own, so the state never shares the cache's. */
function copyTrack(track: Track): Track {
  return {
    nodes: [...track.nodes],
    edges: [...track.edges],
    nodeAt: [...track.nodeAt],
    points: track.points.map(([x, y]) => [x, y]),
    pointAt: [...track.pointAt],
    bends: track.bends.map((b) => ({ ...b })),
    lengthM: track.lengthM,
  };
}

/** The tug's gone: it taxis forward from the push point to the ramp edge (movement.ts moves it). */
function startTaxiOut(sim: Sim, r: RampAircraft): void {
  const ac = aircraftOf(sim, r.callsign);
  const { plan, out } = departureTracks(sim, r.gate, ac.type);
  // The taxi-out track shares the push track up to the push point, so the nose keeps its place.
  const track = copyTrack(out);
  Object.assign(r, { phase: 'taxi-out', since: sim.world.tick, pushTo: null, pilotCruiseMps: ac.cruiseMps });
  Object.assign(ac, { track, s: plan.pushTo, v: 0, motion: 'taxi', status: 'taxiing', cruiseMps: Math.min(ac.cruiseMps, RAMP_TAXI_KT * KNOT_MPS) });
}

// ---------------------------------------------------------------------------------------------
// Moving the ramp's aircraft

/**
 * Moves the aircraft the ramp moves itself (motion 'controller'): pushbacks. Then, after
 * movement.ts has moved the ones taxiing, hands departures stopped at the ramp edge to ground.
 */
export function rampMove(sim: Sim): void {
  const ramp = sim.world.ramp;
  for (const r of [...ramp.aircraft]) {
    if (r.phase === 'taxi-out' || r.phase === 'taxi-in') {
      const ac = aircraftOf(sim, r.callsign);
      if (ac.v !== 0 || ac.s !== ac.track.lengthM) continue;
      if (r.phase === 'taxi-out') checkIn(sim, r, ac);
      else park(sim, r, ac);
    }
    if (r.phase !== 'pushback') continue;
    const ac = aircraftOf(sim, r.callsign);
    const pushTo = r.pushTo;
    if (pushTo === null) throw new Error(`${ac.callsign}: pushing back with nowhere to stop`);
    const vMax = Math.min(PUSH_SPEED_MPS, safeSpeed(ac.s - pushTo, 0, PUSH_DECEL_MPS2));
    let v = Math.min(ac.v + PUSH_ACCEL_MPS2 * TICK_S, vMax);
    v = Math.max(v, ac.v - PUSH_DECEL_MPS2 * TICK_S, 0);
    let s = ac.s - v * TICK_S;
    if (s <= pushTo + STOP_SNAP_M && v <= PUSH_DECEL_MPS2 * TICK_S) [s, v] = [pushTo, 0];
    [ac.s, ac.v] = [Math.max(s, pushTo), v];
    if (ac.s === pushTo && ac.v === 0) [r.phase, r.since] = ['pushed', sim.world.tick];
  }
}

/** At its gate: parked, holding the gate. "Arrived at gate" is the arrival's scoring point. */
function park(sim: Sim, r: RampAircraft, ac: Aircraft): void {
  Object.assign(ac, { motion: 'controller', status: 'parked', cruiseMps: r.pilotCruiseMps ?? ac.cruiseMps, blockedBy: null });
  Object.assign(r, { phase: 'parked', since: sim.world.tick, reserved: [], pilotCruiseMps: null });
  emit(sim, { type: 'arrived-at-gate', tick: sim.world.tick, callsign: ac.callsign, gate: r.gate });
}

/** At the ramp edge: the pilot calls ground. It's ground's, and off the ramp's books. */
function checkIn(sim: Sim, r: RampAircraft, ac: Aircraft): void {
  const handoff = sim.index.airport.rampHandoffs.find((h) => h.id === r.rampHandoff);
  if (!handoff) throw new Error(`${ac.callsign}: checking in at unknown ramp edge ${r.rampHandoff}`);
  Object.assign(ac, { controller: 'ground', status: 'idle', cruiseMps: r.pilotCruiseMps ?? ac.cruiseMps, blockedBy: null });
  sim.world.ramp.aircraft = sim.world.ramp.aircraft.filter((x) => x !== r);
  const atis = ac.advisories.atis?.letter ?? null;
  emit(sim, { type: 'check-in', tick: sim.world.tick, callsign: ac.callsign, rampHandoff: handoff.id, taxilane: handoff.name, atis });
}

function nodeOf(track: Track, i: number): NodeId {
  const node = track.nodes[i];
  if (node === undefined) throw new Error(`track node ${i} is out of range`);
  return node;
}

function aircraftOf(sim: Sim, callsign: string): Aircraft {
  const ac = sim.world.aircraft.find((a) => a.callsign === callsign);
  if (!ac) throw new Error(`ramp: no aircraft ${callsign}`);
  return ac;
}
