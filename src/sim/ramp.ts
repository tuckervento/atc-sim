// The simulated ramp (PLAN 1.11, reworked in cycle 9; PRD §8.3, §4.2–4.3). It owns the gates and
// the ramp lanes:
// - Gates: which aircraft holds each (world.ramp.aircraft): parked there, pushing from it, an
//   arrival assigned to it, or a departure that will swing its tail into it (`swingInto`).
// - Departures: added at a gate (addAircraft, or a departure stream, SimOptions.departures), they
//   board, then push back (the only backward motion in the sim), taxi over ramp lanes to a ramp
//   edge serving their terminal, and call ground there (`check-in`, with the taxilane's name).
// - Arrivals: a ground aircraft handed to ramp ("monitor ramp") and stopped at a ramp entrance at
//   the end of its taxi there gets a free gate at its terminal, preferring its airline's. Once it
//   can get its whole body off the entrance, ramp takes it (`ramp-accepted`) and taxis it in; at
//   the gate it emits `arrived-at-gate` (1.12's arrival scoring point) and parks, until its
//   turnaround (below).
// It decides at the start of each tick, after the tower and after the reservations have been
// brought up to date, and moves its pushbacks after movement.ts has moved the taxiing aircraft
// (sim.ts, `advance`; world.ts, "Controllers"). Its ramp-lane taxiing is movement.ts's (motion
// 'taxi'), on a track the ramp made, with no clearance, so see-and-avoid and turn speeds apply.
//
// Moving: every movement goes through reservations.ts. A departure's pushback and taxi-out are
// one movement of two legs (the push backward, then the taxi forward); an arrival's taxi-in is
// one leg. The ramp asks for each to start (`admit`) and the reservations grant it a stretch at
// a time, ahead of its nose, and take back what it has left behind (that module's header has the
// rules, and why they can't deadlock). The pushback stops at the end of what it holds; movement.ts
// stops a taxiing one there. So the ramp itself no longer holds whole paths:
// - A departure asks to push once it has boarded; it starts when the reservations admit it.
// - An arrival at its entrance is taken only when it can be granted, at once, enough to get its
//   whole body off the entrance (PRD §4.3: until then "the arrival waits on the player's
//   taxiway", still ground's). After that it's ramp's, and may wait inside for a lane to clear.
// - A parked aircraft is a reservation for good (`reserveParked`): nothing is granted into it,
//   and nothing is admitted whose way it's in. An arrival's assigned gate is held the same way
//   from the moment it's assigned (`<callsign> gate`), until the arrival itself is admitted.
//
// Priority (Q, cycle 9: "arriving plane should take priority unless the pushback is opening a
// gate for the incoming plane"). A departure asking to push yields (reservations.ts, "Priority")
// to each arrival taxiing in that was taken in no later than the tick the departure was ready:
// it doesn't start while such an arrival's way ahead crosses its push or taxi-out. The
// exception is a departure whose way goes through where the arrival will park: it's leaving
// the arrival's gate, so it goes first.
// - At the ramp the exception can't arise today: an arrival is only given a gate no departure
//   holds (a departure holds its gate until it checks in). An arrival waiting for a gate to come
//   free isn't taken in, so there's nothing to yield to: the pushback that frees one goes as before.
// - Not yielded to: arrivals taken in after the departure was ready (so it's held only until a
//   known few have passed, never starved by a stream of later ones), and arrivals waiting at an
//   entrance, still ground's.
//
// Which gates it uses. A gate takes a type if:
// - its stand fits: the tail, parked, farther from the lane junction than its half-span
//   (see-and-avoid, traffic.ts, counts a junction a body's wing may be over as occupied, so a
//   parked aircraft never blocks the lane);
// - it has a pushback (below), so a departure can leave and an arrival could;
// - and, when it's to be used, its parked footprint (footprint.ts, grown by the reservations'
//   margin) is clear of everything held: aircraft parked at neighbouring gates, assigned gates,
//   and movements. The reservations hold a parked footprint's convex hull (the cross's outline,
//   wingtip to nose to tailplane). At KJFK some neighbouring stands are closer than two of
//   those, so those gates can't both be used at once (of 58 T4 gates an E175 can use, 52 can be
//   filled together; 46 with cycle 9's first span × length footprints).
// At KJFK an A320 can use 147 of the 184 gates (1.11: 123), a B77W 73 (58), measured with this
// code. Of the 37 an A320 can't: 29 stands are too short for it, 7 gate nodes are on a lane
// rather than at the end of a lead-in (the data), and 1 (T7's g1011144702) has no pushback
// within MAX_PUSH_M and MAX_TURN_DEG.
//
// Pushback. A gate's stand is its lead-in: the unnamed ramp-lane chain from the gate node back to
// the lane junction. The push is planned once per gate and type, as a search by the distance the
// nose is pushed: out of the stand tail-first, on along lanes if it must, until it can stop with
// its nose on a node and its tail swung onto something with room for its whole body, facing a
// forward way out. The tail may swing:
// - onto a ramp lane (a "lane" plan, preferred whenever one exists);
// - into another gate's stand, if that stand is long enough (a "swing" plan). The departure
//   claims that stand from when it's added at its gate until it has left, so it's free when it
//   pushes; a gate whose only plans swing into taken stands can't take a departure then.
// Facing a way out means: on lanes forward to a ramp edge serving its terminal; or the nose
// is on that ramp edge already, facing out onto the taxiway (no taxi-out). Among plans of a kind,
// the shortest push wins, then the shortest taxi-out.
// Nothing of a pushback is ever on a taxiway: not the nose, not the tail's swing (Q, 2026-11-16,
// after the 1.13 run: "back up and turn the tail away from the exit until the nose is pointing
// the right way"), so every departure leaves the ramp nose first. Before, a push could run out
// past a ramp edge onto the taxiway, or swing the tail onto one; ANA8115 was left backwards on
// VA that way. A stand with no way out inside the ramp is unusable (the data adds lanes where a
// stand needs room: KJFK.overrides.json, PLAN 1.13b).
//
// Not handled:
// - "No gate free": the arrival waits at the entrance, ground's, and nothing is said (the pilot's
//   "no gate yet" call is Phase 3). At a ramp handoff used both ways, such an arrival blocks the
//   departures that would free a gate: the player has to move it.
// - "monitor ramp" anywhere else is recorded and does nothing until the aircraft stops at the end
//   of a taxi to a ramp entrance (as with tower's handoff). An aircraft whose own terminal the
//   entrance doesn't serve isn't taken.
// - Metering, release times and gate-availability delays (Phase 3); tugs and towing.
// - Fairness: an older request that's refused doesn't stop a younger one whose way is free,
//   except by arrival priority (above).
// - A parked arrival whose footprint is in a wider aircraft's way, at a short stand, keeps that
//   one from being admitted until it turns around or is towed (below), or is removed.
//
// Turnarounds (cycle 10; Q: parked arrivals "either depart again, or go to the hangar
// (despawn)"). An arrival the ramp parks at its gate (`arrived-at-gate`) draws, from the
// turnarounds' own generator (world.ramp.turnarounds, seeded from the session's seed so it
// doesn't shift the main one's draws), a time at the gate and what it does then:
// - Depart again: the same aircraft, type and airline as a new flight. sim.ts removes the arrival
//   (removeAircraft: its gate, its reservation and everything held about it go) and adds the
//   departure at the same gate under a new callsign (`turnaround`, with it). It's an ordinary
//   departure from there: it boards (PUSH_READY_S), asks to push, taxis out and checks in. The
//   score counted the arrival under its callsign at the gate, and counts the departure under the
//   new one at takeoff: two flights, each once, and no callsign changes on a live aircraft, so
//   nothing keyed by callsign (tower, ramp, reservations, rules, score) needs to follow a rename.
//   While it couldn't push back now (every stand its pushback swings into is taken), it waits,
//   parked, and goes once one is free. Its callsign is drawn when it goes.
// - Towed to a hangar: removed (removeAircraft), its gate free (`towed-to-hangar`). No tow is
//   drawn moving: Phase 3's tugs would.
// Only arrivals the ramp parked turn around. One added parked (addAircraft at a gate, role
// arrival) stays for good: tests use them as fillers. `RampOptions.turnaround: false` turns it
// off. New callsigns come from `TurnaroundOptions.callsign`; the app's traffic passes its own,
// from its flight-number permutation (src/web/game/traffic.ts), so they're unique in a session.
// The default is the inbound's number plus one, for tests.
//
// Turnaround values (my proposal, Q to confirm; options, TurnaroundOptions):
// - TURNAROUND_NARROWBODY_S 35–60 min and TURNAROUND_WIDEBODY_S 75–120 min at the gate, uniform.
//   Mine, from the usual published figures: about 30–45 min for a short-haul narrowbody, 1.5–2 h
//   or more for a long-haul widebody; a little longer at a busy hub. Phase 3's schedules replace it.
// - WIDEBODY_SPAN_M 36: a widebody has a wingspan of 36 m or more, ICAO aerodrome reference code D
//   and up (codes: C is 24 m up to 36 m, D 36 m up to 52 m). The span, not the type, because it's
//   what the sim has for every type: every narrowbody it knows spans 35.8 m or less (A320 family,
//   737s, E175) and every widebody 47.6 m or more (B763 up), so any threshold between gives the
//   same split; 36 is the code boundary.
// - TURNAROUND_DEPART_SHARE 0.8: 80% depart again, 20% towed. Mine: most aircraft at a hub gate
//   leave again on their next flight; the rest are parked overnight or for maintenance.
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
// - Push distance: no fixed value; MAX_PUSH_M 400 only bounds the search.
// - RAMP_TAXI_KT 10: ramp-lane taxi speed on a straight, half movement.ts's 20 kt, since ramps are
//   congested and close to stands; a pilot set slower keeps their own speed. Mine.
// - MAX_TURN_DEG 135: the sharpest turn at a node a ramp route or a tail swing takes. Mine:
//   sharper is close to reversing.
// - DEPARTURE_JITTER 0.15: a departure stream's spacing varies ±15%, as tower's arrival streams.

import { edgeLength, edgePolyline, edgesAt, otherEnd, type AirportIndex } from '../airport/graph.ts';
import type { Edge, EdgeId, Gate, GateId, NodeId, Point, RampHandoff, RampHandoffId, TerminalId } from '../airport/types.ts';
import { AIRCRAFT_TYPES, isAircraftType, type AircraftTypeCode } from './aircraft-types.ts';
import { DECEL_MPS2, KNOT_MPS, safeSpeed, STOP_SNAP_M, TICK_HZ, TICK_S } from './movement.ts';
import { admit, dropMovement, finishMovement, holdsEnd, parkedConflict, parkedInTheWay, reserveParked, reservedStop, SEGMENT_M, setLeg, type Leg, type ParkedSpec } from './reservations.ts';
import { createRng, nextFloat, nextInRange } from './rng.ts';
import { nodeAt } from './stops.ts';
import { buildTrack, placeOf, type Track } from './track.ts';
import { emit, type Aircraft, type RampAircraft, type RampState, type Sim } from './world.ts';

/** A departure waits this long at its gate, from when it's added, before it asks to push. */
export const PUSH_READY_S: readonly [min: number, max: number] = [30, 90];
/** A departure stream's spacing varies by this fraction either way, from the seeded RNG. */
export const DEPARTURE_JITTER = 0.15;
/** Turnaround time at the gate, seconds, for a narrowbody and a widebody (the header's "Turnarounds"). */
export const TURNAROUND_NARROWBODY_S: readonly [min: number, max: number] = [35 * 60, 60 * 60];
export const TURNAROUND_WIDEBODY_S: readonly [min: number, max: number] = [75 * 60, 120 * 60];
/** A widebody, for its turnaround time: a wingspan of this or more, meters (ICAO aerodrome code D and up). */
export const WIDEBODY_SPAN_M = 36;
/** The share of parked arrivals that depart again; the rest are towed to a hangar. */
export const TURNAROUND_DEPART_SHARE = 0.8;
/** Mixed into the session's seed for the turnarounds' own generator. Any fixed value: it only has to differ from 0. */
const TURNAROUND_SEED_MIX = 0x7a3a0d17;
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
/** How far ahead a push asks to hold: its stopping distance, and two segments. */
const PUSH_LOOKAHEAD_M = PUSH_SPEED_MPS ** 2 / (2 * PUSH_DECEL_MPS2) + 2 * SEGMENT_M;

/** How far ahead a ramp taxi asks to hold: its stopping distance at its ramp speed (movement.ts's braking), and two segments. */
function taxiLookahead(cruiseMps: number): number {
  const v = Math.min(cruiseMps, RAMP_TAXI_KT * KNOT_MPS);
  return (v * v) / (2 * DECEL_MPS2) + 2 * SEGMENT_M;
}

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
  /** Parked arrivals turn around or are towed (the header's "Turnarounds"). Default: on, with the defaults there. false: they stay parked for good. */
  turnaround?: TurnaroundOptions | false;
}

/** How parked arrivals turn around (the header's "Turnarounds"). Each field defaults as there. */
export interface TurnaroundOptions {
  /** Time at the gate for a narrowbody (wingspan under WIDEBODY_SPAN_M), seconds: drawn uniformly from [min, max]. */
  narrowbodyS?: readonly [min: number, max: number];
  /** Time at the gate for a widebody (wingspan WIDEBODY_SPAN_M or more), seconds. */
  widebodyS?: readonly [min: number, max: number];
  /** The share of arrivals that depart again, 0–1; the rest are towed to a hangar. */
  departShare?: number;
  /**
   * The new flight's callsign, for the `n`th arrival to turn into a departure (0, 1, …). It must
   * be unique in the session: no other aircraft may hold it then (addAircraft throws), and the
   * caller's own flights shouldn't use it. Default: the inbound's flight number plus one, its
   * airline's usual pairing (DAL401 in, DAL402 out); for a callsign that isn't letters then a
   * number, it throws.
   */
  callsign?: (n: number, inbound: TurnaroundInbound) => string;
}

/** The arrival that's turning around, for TurnaroundOptions.callsign. */
export interface TurnaroundInbound {
  callsign: string;
  type: AircraftTypeCode;
  airline: string | null;
  gate: GateId;
}

interface Turnaround {
  narrowbodyS: readonly [number, number];
  widebodyS: readonly [number, number];
  departShare: number;
  callsign: (n: number, inbound: TurnaroundInbound) => string;
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
  /** Every stand's edges: ramp routes never use another gate's stand (a pushed tail may swing into one). */
  readonly standEdges: ReadonlySet<EdgeId>;
  /** Stands by the edge they start with at their junction. */
  readonly standsByFirstEdge: ReadonlyMap<EdgeId, Stand>;
  readonly handoffNodes: ReadonlySet<NodeId>;
  /** Pushback plans by `<gate>|<type>`, most preferred first, worked out when first needed. */
  readonly plans: Map<string, DeparturePlan[] | { unable: string }>;
  /** Ways in by `<entrance node>|<edge arrived along>|<gate>`, worked out when first needed. */
  readonly arrivalWays: Map<string, Way | null>;
  readonly streams: readonly DepartureStream[];
  /** Each plan's tracks, by `<gate>|<type>|<plan index>`. */
  readonly departureTracks: Map<string, { plan: DeparturePlan; push: Track; out: Track }>;
  /** A waiting arrival's way in, by its record (wayInFor). Not state: derived from it. */
  readonly waysIn: WeakMap<RampAircraft, { track: Track; s: number }>;
  /** canDepartFrom's answers, by `<terminal>|<type>`. */
  readonly canDepart: Map<string, boolean>;
  /** How parked arrivals turn around. null: they don't (RampOptions.turnaround false). */
  readonly turnaround: Turnaround | null;
}

export function rampSetup(index: AirportIndex, options: RampOptions): RampSetup {
  const streams = options.departures ?? [];
  for (const stream of streams) {
    if (!(stream.perHour > 0)) throw new Error(`departure stream: perHour must be > 0, got ${stream.perHour}`);
  }
  const stands = new Map<GateId, Stand | { unusable: string }>();
  for (const gate of index.airport.gates) stands.set(gate.id, standOf(index, gate));
  const standEdges = new Set<EdgeId>();
  const standsByFirstEdge = new Map<EdgeId, Stand>();
  for (const stand of stands.values()) {
    if ('unusable' in stand) continue;
    for (const e of stand.edges) standEdges.add(e);
    const first = stand.edges[0];
    if (first !== undefined) standsByFirstEdge.set(first, stand);
  }
  const handoffNodes = new Set(index.airport.rampHandoffs.map((h) => h.node));
  const turnaround = turnaroundOf(options.turnaround);
  return { stands, standEdges, standsByFirstEdge, handoffNodes, plans: new Map(), arrivalWays: new Map(), streams, departureTracks: new Map(), waysIn: new WeakMap(), canDepart: new Map(), turnaround };
}

/** The turnaround settings, defaults filled in, or null for off. Throws for a span or share that makes no sense. */
function turnaroundOf(options: TurnaroundOptions | false | undefined): Turnaround | null {
  if (options === false) return null;
  const t: Turnaround = {
    narrowbodyS: options?.narrowbodyS ?? TURNAROUND_NARROWBODY_S,
    widebodyS: options?.widebodyS ?? TURNAROUND_WIDEBODY_S,
    departShare: options?.departShare ?? TURNAROUND_DEPART_SHARE,
    callsign: options?.callsign ?? nextFlightNumber,
  };
  for (const [name, [lo, hi]] of [['narrowbodyS', t.narrowbodyS], ['widebodyS', t.widebodyS]] as const) {
    if (!(lo >= 0 && hi >= lo)) throw new Error(`turnaround ${name}: expected 0 ≤ min ≤ max seconds, got [${lo}, ${hi}]`);
  }
  if (!(t.departShare >= 0 && t.departShare <= 1)) throw new Error(`turnaround departShare: expected 0–1, got ${t.departShare}`);
  return t;
}

/** The default new callsign: the inbound's flight number plus one, "DAL401" → "DAL402". */
function nextFlightNumber(_n: number, inbound: TurnaroundInbound): string {
  const m = /^([A-Z]+)([0-9]+)$/.exec(inbound.callsign);
  if (!m) throw new Error(`${inbound.callsign}: the default turnaround callsign needs letters then a flight number; give RampOptions.turnaround.callsign`);
  return `${m[1]}${Number(m[2]) + 1}`;
}

/** `seed`: the session's, for the turnarounds' own generator. */
export function initialRampState(setup: RampSetup, seed: number): RampState {
  return {
    streams: setup.streams.map((s) => ({ nextTick: Math.round((s.firstAtS ?? 0) * TICK_HZ), count: 0 })),
    aircraft: [],
    turnarounds: { rng: createRng((seed ^ TURNAROUND_SEED_MIX) | 0), turned: 0 },
    waiting: [],
  };
}

/**
 * The departure due now, if any, with the gate it's spawned at, for sim.ts to add (it builds
 * aircraft): a free gate of its terminal that it fits, can push from now, and whose parked
 * footprint is clear of everything held, preferring its airline's, at random (seeded). With
 * none free, it stays due. At most one a tick, so two can't be given gates too close together.
 */
export function rampSpawns(sim: Sim): (DepartureFlight & { gate: GateId })[] {
  for (let i = 0; i < sim.ramp.streams.length; i++) {
    const stream = sim.ramp.streams[i];
    const state = sim.world.ramp.streams[i];
    if (!stream || !state) throw new Error(`no state for departure stream ${i}`);
    if (sim.world.tick < state.nextTick) continue;
    const flight = stream.flight(state.count);
    if (!isAircraftType(flight.type)) throw new Error(`${flight.callsign}: unknown aircraft type "${flight.type}"`);
    const type = flight.type;
    const terminal = sim.index.airport.terminals.find((t) => t.id === flight.terminal);
    if (!terminal) throw new Error(`${flight.callsign}: no terminal ${flight.terminal}`);
    const free = sim.index.airport.gates.filter(
      (g) => g.terminal === terminal.id && gateOccupant(sim, g.id) === null && choosePlan(sim, g.id, type) !== null && parkedConflict(sim, parkedAt(sim, flight.callsign, g.id, type)) === null,
    );
    const gate = pickGate(sim, free, terminal.airlines, flight.airline ?? null);
    if (gate === null) continue;
    state.count += 1;
    const intervalS = (3600 / stream.perHour) * nextInRange(sim.world.rng, 1 - DEPARTURE_JITTER, 1 + DEPARTURE_JITTER);
    state.nextTick = sim.world.tick + Math.round(intervalS * TICK_HZ);
    return [{ ...flight, gate }];
  }
  return [];
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

/** What a `type` parked at `gateId` holds, as the reservations see it, under the name `id`. */
function parkedAt(sim: Sim, id: string, gateId: GateId, type: AircraftTypeCode): ParkedSpec {
  const stand = usableStand(sim, gateId);
  const { lengthM, wingspanM } = AIRCRAFT_TYPES[type];
  return { id, nodes: stand.nodes, edges: stand.edges, s: stand.lengthM, lengthM, wingspanM };
}

/** The reservation that holds an arrival's assigned gate until the arrival itself is admitted. */
function gateHoldId(callsign: string): string {
  return `${callsign} gate`;
}

/**
 * Where an aircraft parked at `gateId` is: nose on the gate node, its body back along the
 * stand. Throws if the gate is unknown or taken, can't park it, its parked footprint isn't
 * clear (a neighbour too close, or a movement), or for a departure, if it can't push from there
 * now (departurePlansFor, choosePlan).
 */
export function placeAtGate(sim: Sim, callsign: string, gateId: GateId, type: AircraftTypeCode, role: 'departure' | 'arrival'): { track: Track; s: number; terminal: TerminalId } {
  const stand = usableStand(sim, gateId);
  const holder = gateOccupant(sim, gateId);
  if (holder !== null) throw new Error(`${callsign}: gate ${gateId} is taken by ${holder}`);
  const fit = standFit(stand, type);
  if (fit !== null) throw new Error(`${callsign}: ${fit}`);
  if (role === 'departure') {
    const plans = departurePlansFor(sim, gateId, type);
    if ('unable' in plans) throw new Error(`${callsign}: ${plans.unable}`);
    if (choosePlan(sim, gateId, type) === null) {
      const into = plans.map((p) => p.swing).filter((g) => g !== null);
      throw new Error(`${callsign}: gate ${gateId} can't push back now: its pushback swings into ${into.join(' or ')}, taken`);
    }
  }
  const blocker = parkedConflict(sim, parkedAt(sim, callsign, gateId, type));
  if (blocker !== null) throw new Error(`${callsign}: gate ${gateId} is blocked: parked there, a ${type} would be too close to ${blocker}`);
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

/**
 * Takes on an aircraft just added at a gate (placeAtGate): it's held there, parked; a departure
 * picks its pushback (claiming the stand it will swing into, if any), boards, then asks to push.
 */
export function adoptAtGate(sim: Sim, callsign: string, gateId: GateId, role: 'departure' | 'arrival'): void {
  const ac = aircraftOf(sim, callsign);
  const tick = sim.world.tick;
  const [lo, hi] = PUSH_READY_S;
  const readyTick = role === 'departure' ? tick + Math.round(nextInRange(sim.world.rng, lo, hi) * TICK_HZ) : null;
  const plan = role === 'departure' ? choosePlan(sim, gateId, ac.type) : null;
  if (role === 'departure' && plan === null) throw new Error(`${callsign}: no pushback from ${gateId} now`);
  const plans = plan === null ? null : departurePlansFor(sim, gateId, ac.type);
  const swingInto = plans && !('unable' in plans) && plan !== null ? (plans[plan]?.swing ?? null) : null;
  const blocker = reserveParked(sim, parkedAt(sim, callsign, gateId, ac.type));
  if (blocker !== null) throw new Error(`${callsign}: parked at ${gateId}, in the way of ${blocker}`);
  sim.world.ramp.aircraft.push({ callsign, phase: role === 'departure' ? 'at-gate' : 'parked', gate: gateId, since: tick, readyTick, rampHandoff: null, pushTo: null, plan, swingInto, pilotCruiseMps: null, turnaround: null });
}

/** Forgets an aircraft that's leaving the sim: its gate, the stand it claimed, and its gate hold are free. */
export function rampDrop(sim: Sim, callsign: string): void {
  sim.world.ramp.aircraft = sim.world.ramp.aircraft.filter((r) => r.callsign !== callsign);
  dropMovement(sim, gateHoldId(callsign));
}

/** The aircraft holding `gateId` (parked, pushing from it, assigned to it, or to swing its tail into it), or null. */
export function gateOccupant(sim: Sim, gateId: GateId): string | null {
  return sim.world.ramp.aircraft.find((r) => r.gate === gateId || r.swingInto === gateId)?.callsign ?? null;
}

/**
 * The plan a `type` departing `gateId` would use now: the first (most preferred) whose stand to
 * swing into, if any, is free. Its index, or null: none now (or no plans at all).
 */
function choosePlan(sim: Sim, gateId: GateId, type: AircraftTypeCode): number | null {
  const plans = departurePlansFor(sim, gateId, type);
  if ('unable' in plans) return null;
  const i = plans.findIndex((p) => p.swing === null || gateOccupant(sim, p.swing) === null);
  return i < 0 ? null : i;
}

// ---------------------------------------------------------------------------------------------
// Planning: pushbacks and ramp routes

/** A chain of edges from `nodes[0]`: one more node than edges. */
interface Way {
  nodes: NodeId[];
  edges: EdgeId[];
  lengthM: number;
}

/**
 * A departure's way out, for one gate and type:
 * - `push`: the pushback track, nose-forward: the tail's way, the push point, then back along
 *   the way it's pushed to the gate. It's pushed from the end to `pushTo`.
 * - `out`: the taxi-out track: the same start up to the push point, then on to the ramp edge.
 *   It ends at the push point if there's no taxi-out (the push ends with the nose on the ramp edge).
 * - `swing`: the gate whose stand the tail swings into, if any.
 */
export interface DeparturePlan {
  push: Way;
  out: Way;
  pushTo: number;
  rampHandoff: RampHandoffId;
  swing: GateId | null;
}

/** The most preferred way out for a `type` departing `gate` (departurePlansFor), or why there's none. */
export function departurePlanFor(sim: Sim, gate: GateId, type: AircraftTypeCode): DeparturePlan | { unable: string } {
  const plans = departurePlansFor(sim, gate, type);
  if ('unable' in plans) return plans;
  const first = plans[0];
  if (!first) throw new Error(`gate ${gate}: an empty plan list`);
  return first;
}

/**
 * Whether a `type` can depart from `terminal` at all: some gate of it fits the type and has a
 * pushback (departurePlanFor). That's a question about the airport, not the moment: the answer is
 * the same on an empty airport and a full one (a stream's departure then waits for a gate). For
 * traffic that only flies what can leave (the app's, 1.13). Throws for an unknown terminal.
 * Cached, by terminal and type.
 */
export function canDepartFrom(sim: Sim, terminal: TerminalId, type: AircraftTypeCode): boolean {
  const key = `${terminal}|${type}`;
  const known = sim.ramp.canDepart.get(key);
  if (known !== undefined) return known;
  if (!sim.index.airport.terminals.some((t) => t.id === terminal)) throw new Error(`no terminal ${terminal} at ${sim.index.airport.id}`);
  const can = sim.index.airport.gates.some((g) => g.terminal === terminal && !('unable' in departurePlanFor(sim, g.id, type)));
  sim.ramp.canDepart.set(key, can);
  return can;
}

/**
 * The ways out for a `type` departing `gate`, most preferred first: the lane plan if there is
 * one (then it's the only one); else the swing plans, shortest push first. Or why there's none: the gate can't be used, the type doesn't fit its stand, or no
 * pushback works. Throws for an unknown gate. Cached.
 */
export function departurePlansFor(sim: Sim, gate: GateId, type: AircraftTypeCode): DeparturePlan[] | { unable: string } {
  const key = `${gate}|${type}`;
  const cached = sim.ramp.plans.get(key);
  if (cached) return cached;
  const stand = sim.ramp.stands.get(gate);
  if (!stand) throw new Error(`no gate ${gate} at ${sim.index.airport.id}`);
  const fit = 'unusable' in stand ? stand.unusable : standFit(stand, type);
  // Out the exits marked for departures (or both) if it can; otherwise any serving the terminal
  // (Q, 2026-11-16: every entrance accessible by all). Arrivals come in at the arrival-marked ones,
  // so sending departures there too would meet them head-on in the lane.
  const serves = (h: RampHandoff) => h.terminals === undefined || (stand !== undefined && !('unusable' in stand) && h.terminals.includes(stand.gate.terminal));
  const all = sim.index.airport.rampHandoffs.filter(serves);
  const preferred = all.filter((h) => h.use !== 'arrivals');
  let plans: DeparturePlan[] | { unable: string } = fit !== null ? { unable: fit } : planDeparture(sim, gate, type, preferred);
  if (fit === null && 'unable' in plans && preferred.length < all.length) {
    const fallback = planDeparture(sim, gate, type, all);
    if (!('unable' in fallback)) plans = fallback;
  }
  sim.ramp.plans.set(key, plans);
  return plans;
}

/**
 * The search (the header's "Pushback"): Dijkstra over where the nose has been pushed to and
 * along which edge, by push distance. At each node, every tail swing that has room is tried,
 * with its way out; the best plan of each kind is kept. It stops at the first lane plan.
 */
function planDeparture(sim: Sim, gateId: GateId, type: AircraftTypeCode, exits: RampHandoff[]): DeparturePlan[] | { unable: string } {
  const index = sim.index;
  const stand = usableStand(sim, gateId);
  const { lengthM } = AIRCRAFT_TYPES[type];
  if (exits.length === 0) return { unable: `no ramp edge serves ${stand.gate.terminal}` };
  const goals = new Set(exits.map((h) => h.node));
  const exitAt = (n: NodeId) => exits.find((h) => h.node === n) ?? null;
  const laneOk = (e: Edge) => e.kind === 'rampLane' && !e.closed && !sim.ramp.standEdges.has(e.id);
  const groundOk = (e: Edge) => e.kind === 'taxiway' && !e.closed && !sim.runwayAreas.has(e.id);
  const turnOk = (node: NodeId, from: Edge, to: Edge) => turnAt(index, node, from, to) <= MAX_TURN_DEG;
  /** Facing out onto a taxiway at `node`, having arrived along `along`. */
  const facesGround = (node: NodeId, along: Edge, except: EdgeId | null) => edgesAt(index, node).some((e) => e.id !== along.id && e.id !== except && groundOk(e) && turnOk(node, along, e));
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
  type Kind = 'lane' | GateId;
  const best = new Map<Kind, { plan: DeparturePlan; dist: number; outM: number }>();
  const offer = (label: Label, tail: Way, out: Way, handoff: RampHandoffId, swing: GateId | null) => {
    const kind: Kind = swing ?? 'lane';
    const held = best.get(kind);
    if (held && (held.dist < label.dist || (held.dist === label.dist && held.outM <= out.lengthM))) return;
    const tailNodes = [...tail.nodes].reverse();
    const tailEdges = [...tail.edges].reverse();
    const back = [...label.nodes].reverse();
    const backEdges = [...label.edges].reverse();
    const plan: DeparturePlan = {
      push: { nodes: [...tailNodes, ...back.slice(1)], edges: [...tailEdges, ...backEdges], lengthM: tail.lengthM + label.dist },
      out: { nodes: [...tailNodes, ...out.nodes.slice(1)], edges: [...tailEdges, ...out.edges], lengthM: tail.lengthM + out.lengthM },
      pushTo: tail.lengthM,
      rampHandoff: handoff,
      swing,
    };
    best.set(kind, { plan, dist: label.dist, outM: out.lengthM });
  };
  /** The way out from `node`, the tail along `tail`: none needed at a ramp edge facing out; else forward over lanes. */
  const wayOut = (node: NodeId, tail: Edge): { out: Way; handoff: RampHandoffId } | null => {
    const here = exitAt(node);
    if (here && facesGround(node, tail, null)) return { out: { nodes: [node], edges: [], lengthM: 0 }, handoff: here.id };
    const out = forwardWay(index, node, tail, laneOk, (n) => goals.has(n));
    const handoff = out && exitAt(out.nodes.at(-1) ?? '');
    return out && handoff ? { out, handoff: handoff.id } : null;
  };

  const queue: Label[] = [{ node: junction, via: edgeOf(index, standFirst), dist: stand.lengthM, nodes: [...stand.nodes].reverse(), edges: [...stand.edges].reverse() }];
  const settled = new Set<string>();
  while (queue.length > 0) {
    const label = queue.reduce((a, b) => (b.dist < a.dist ? b : a));
    queue.splice(queue.indexOf(label), 1);
    if (best.has('lane')) break;
    const key = `${label.node}|${label.via.id}`;
    if (settled.has(key)) continue;
    settled.add(key);
    const node = label.node;
    // Stop the push here, the tail swung onto one of these?
    for (const t of edgesAt(index, node)) {
      if (t.id === label.via.id || !turnOk(node, label.via, t)) continue;
      const into = sim.ramp.standsByFirstEdge.get(t.id);
      if (into && into.gate.id !== gateId && into.nodes[0] === node) {
        if (into.lengthM < lengthM) continue;
        const way = wayOut(node, t);
        if (way) offer(label, { nodes: into.nodes, edges: into.edges, lengthM: into.lengthM }, way.out, way.handoff, into.gate.id);
        continue;
      }
      if (laneOk(t)) {
        const tail = tailWay(sim, node, t, lengthM, laneOk);
        const way = tail && wayOut(node, t);
        if (tail && way) offer(label, tail, way.out, way.handoff, null);
      }
    }
    // Push on.
    for (const e of edgesAt(index, node)) {
      if (e.id === label.via.id || label.edges.includes(e.id) || !turnOk(node, label.via, e)) continue;
      const len = edgeLength(index, e);
      const dist = label.dist + len;
      if (dist > MAX_PUSH_M) continue;
      const to = otherEnd(e, node);
      // Never through a ramp handoff: past one is the taxiway.
      if (!sim.ramp.handoffNodes.has(node) && laneOk(e)) queue.push({ node: to, via: e, dist, nodes: [...label.nodes, to], edges: [...label.edges, e.id] });
    }
  }
  const lane = best.get('lane');
  if (lane) return [lane.plan];
  const swings = [...best.entries()].filter(([k]) => k !== 'lane').map(([, v]) => v);
  swings.sort((a, b) => a.dist - b.dist || a.outM - b.outM);
  const plans = swings.map((s) => s.plan);
  if (plans.length > 0) return plans;
  return { unable: `gate ${gateId} has no pushback for a ${type} that ends facing a way to a ramp edge for ${stand.gate.terminal} (within ${MAX_PUSH_M} m, turns up to ${MAX_TURN_DEG}°)` };
}

/**
 * Where a pushed tail goes from `node`: onto `first`, then on along the straightest edges that
 * pass `ok`, until it has the aircraft's length. Outward from `node`. It never passes a ramp
 * handoff (past one is the taxiway). null: the edges run out first.
 */
function tailWay(sim: Sim, node: NodeId, first: Edge, lengthM: number, ok: (e: Edge) => boolean): Way | null {
  const index = sim.index;
  const way: Way = { nodes: [node], edges: [first.id], lengthM: edgeLength(index, first) };
  let at = otherEnd(first, node);
  let via = first;
  way.nodes.push(at);
  while (way.lengthM < lengthM) {
    if (way.edges.length > 50) return null;
    if (sim.ramp.handoffNodes.has(at)) return null;
    let next: Edge | null = null;
    let sharpest = Infinity;
    for (const e of edgesAt(index, at)) {
      if (e.id === via.id || !ok(e) || way.edges.includes(e.id)) continue;
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
// The ramp's decisions, each tick

/**
 * The ramp's decisions for this tick, on the state the last tick left (and the reservations
 * brought up to date): departures that have boarded ask to push; then waiting aircraft, oldest
 * first, ask the reservations to start.
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
  for (const r of waiting) {
    const ac = aircraftOf(sim, r.callsign);
    if (r.phase === 'ready') startPushback(sim, r, ac);
    else startTaxiIn(sim, r, ac);
  }
}

/**
 * Arrivals at a ramp entrance, handed to ramp: each is assigned a gate, held for it, and waits,
 * still ground's, until it can be taken in. One with no gate free isn't taken: it waits where it
 * is, ground's, with nothing said (the "no gate yet" call is Phase 3). One that's no longer
 * waiting there (the player moved it) gives its gate back.
 */
function callArrivals(sim: Sim): void {
  const ramp = sim.world.ramp;
  ramp.aircraft = ramp.aircraft.filter((r) => {
    if (r.phase !== 'called' || entranceOf(sim, aircraftOf(sim, r.callsign))?.id === r.rampHandoff) return true;
    dropMovement(sim, gateHoldId(r.callsign));
    return false;
  });
  const known = new Set(ramp.aircraft.map((r) => r.callsign));
  const stillWaiting: RampState['waiting'] = [];
  for (const ac of sim.world.aircraft) {
    if (known.has(ac.callsign)) continue;
    const handoff = entranceOf(sim, ac);
    if (handoff === null) continue;
    const gate = assignGate(sim, ac, handoff);
    if (gate === null) {
      // Ramp says so: when it first waits, and again for each new handoff to ramp while it does.
      const asked = ac.advisories.handoff?.tick ?? -1;
      const told = ramp.waiting.find((w) => w.callsign === ac.callsign);
      if (told?.answered !== asked) emit(sim, { type: 'ramp-waiting', tick: sim.world.tick, callsign: ac.callsign, rampHandoff: handoff.id, terminal: terminalOf(sim, ac)?.id ?? null });
      stillWaiting.push({ callsign: ac.callsign, answered: asked });
      continue;
    }
    const blocker = reserveParked(sim, parkedAt(sim, gateHoldId(ac.callsign), gate, ac.type));
    if (blocker !== null) throw new Error(`${ac.callsign}: gate ${gate} was free, but holding it is in the way of ${blocker}`);
    ramp.aircraft.push({ callsign: ac.callsign, phase: 'called', gate, since: sim.world.tick, readyTick: null, rampHandoff: handoff.id, pushTo: null, plan: null, swingInto: null, pilotCruiseMps: null, turnaround: null });
  }
  ramp.waiting = stillWaiting;
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
 * reachable from `handoff` over ramp lanes, whose parked footprint for it is clear of everything
 * held. Among them, those its airline uses (the gate's airlines, or its terminal's), if any; one
 * of those at random (seeded). null: none free.
 */
function assignGate(sim: Sim, ac: Aircraft, handoff: RampHandoff): GateId | null {
  const terminal = terminalOf(sim, ac);
  if (!terminal) return null;
  const place = placeOf(ac.track, ac.s);
  if (place.kind !== 'node' || nodeOf(ac.track, place.i) !== handoff.node) throw new Error(`${ac.callsign}: given a gate away from its entrance ${handoff.id}`);
  const free = acceptableGates(sim, ac, terminal.id, trailOf(ac, place.i), arrivedEdge(sim, ac));
  return pickGate(sim, free, terminal.airlines, ac.airline);
}

/** The terminal an arrival is for: its own, else the ramp its clearance goes to. */
function terminalOf(sim: Sim, ac: Aircraft) {
  const destination = ac.clearance?.path.destination;
  const terminalId = ac.terminal ?? (destination?.kind === 'ramp' ? destination.terminal : null);
  return sim.index.airport.terminals.find((t) => t.id === terminalId);
}

/** The edges holding an aircraft's body, up to the node its nose is on (track index `i`). */
function trailOf(ac: Aircraft, i: number): { nodes: NodeId[]; edges: EdgeId[] } {
  const t0 = Math.min(placeOf(ac.track, Math.max(0, ac.s - ac.lengthM)).i, i);
  return { nodes: ac.track.nodes.slice(t0, i + 1), edges: ac.track.edges.slice(t0, i) };
}

/**
 * The gates `ac` could be given at `terminal`, coming in with its body along `trail` (which ends
 * at the entrance, arrived along `arrived`): free, it fits and can leave again, reachable over ramp
 * lanes, its way in clear of everything parked for good (it could never get past that; seed 666,
 * EVA1126), and its parked footprint clear. The ramp's own test, for assignGate and gatesFor.
 */
function acceptableGates(sim: Sim, ac: Aircraft, terminal: TerminalId, trail: { nodes: NodeId[]; edges: EdgeId[] }, arrived: Edge): Gate[] {
  return sim.index.airport.gates.filter((g) => {
    if (g.terminal !== terminal || gateOccupant(sim, g.id) !== null || 'unable' in departurePlansFor(sim, g.id, ac.type)) return false;
    const wayIn = wayInTrack(sim, trail, arrived, g.id);
    if (wayIn === null) return false;
    const leg: Leg = { nodes: wayIn.track.nodes, edges: wayIn.track.edges, from: wayIn.s, to: wayIn.track.lengthM, seeAndAvoid: true, lookaheadM: taxiLookahead(ac.cruiseMps) };
    if (parkedInTheWay(sim, { id: ac.callsign, lengthM: ac.lengthM, wingspanM: ac.wingspanM, legs: [leg], stays: true }, [gateHoldId(ac.callsign)]) !== null) return false;
    return parkedConflict(sim, parkedAt(sim, gateHoldId(ac.callsign), g.id, ac.type)) === null;
  });
}

/**
 * The gates the ramp could give arrival `callsign` now, from any ramp entrance serving its
 * terminal (Q, 2026-11-16: "any entrance serving the terminal is fine"), by the ramp's own test
 * (acceptableGates); or, once it has one, that gate. Sorted. Empty for a departure, or with no
 * terminal.
 */
export function gatesFor(sim: Sim, callsign: string): GateId[] {
  const ac = aircraftOf(sim, callsign);
  if (ac.role !== 'arrival') return [];
  const own = sim.world.ramp.aircraft.find((r) => r.callsign === callsign);
  if (own) return [own.gate];
  const terminal = terminalOf(sim, ac);
  if (!terminal) return [];
  const found = new Set<GateId>();
  for (const h of sim.index.airport.rampHandoffs) {
    if (h.terminals !== undefined && !h.terminals.includes(terminal.id)) continue;
    // Arriving from the taxiway side, along the entrance's stub.
    for (const stub of edgesAt(sim.index, h.node)) {
      if (stub.kind !== 'taxiway') continue;
      const trail = { nodes: [otherEnd(stub, h.node), h.node], edges: [stub.id] };
      for (const g of acceptableGates(sim, ac, terminal.id, trail, stub)) found.add(g.id);
    }
  }
  return [...found].sort();
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
 * way to its gate; and where its nose is on it. Worked out once per wait: while it waits it
 * doesn't move, and a new wait is a new record.
 */
function wayInFor(sim: Sim, r: RampAircraft, ac: Aircraft): { track: Track; s: number } {
  const cached = sim.ramp.waysIn.get(r);
  if (cached) return cached;
  const place = placeOf(ac.track, ac.s);
  if (place.kind !== 'node') throw new Error(`${ac.callsign}: waiting at a ramp entrance, but not on a node`);
  const wayIn = wayInTrack(sim, trailOf(ac, place.i), arrivedEdge(sim, ac), r.gate);
  if (wayIn === null) throw new Error(`${ac.callsign}: assigned gate ${r.gate} with no way to it`);
  sim.ramp.waysIn.set(r, wayIn);
  return wayIn;
}

/** A way in to `gateId`: `trail` (ending at the entrance, arrived along `arrived`), then on to the gate; the nose at the entrance. null: no way. */
function wayInTrack(sim: Sim, trail: { nodes: NodeId[]; edges: EdgeId[] }, arrived: Edge, gateId: GateId): { track: Track; s: number } | null {
  const from = trail.nodes.at(-1);
  if (from === undefined) throw new Error('an empty trail');
  const way = arrivalWay(sim, from, arrived, gateId);
  if (way === null) return null;
  const track = buildTrack(sim.index, [...trail.nodes, ...way.nodes.slice(1)], [...trail.edges, ...way.edges]);
  return { track, s: nodeAt(track, trail.nodes.length - 1) };
}

/**
 * Takes the arrival in, if the reservations admit it with enough granted at once to get its
 * whole body off the entrance: then it's ramp's, taxiing to its gate (movement.ts moves it).
 */
function startTaxiIn(sim: Sim, r: RampAircraft, ac: Aircraft): void {
  const { track, s } = wayInFor(sim, r, ac);
  const leg: Leg = { nodes: track.nodes, edges: track.edges, from: s, to: track.lengthM, seeAndAvoid: true, lookaheadM: taxiLookahead(ac.cruiseMps) };
  const spec = { id: ac.callsign, lengthM: ac.lengthM, wingspanM: ac.wingspanM, legs: [leg], stays: true };
  // Its own gate hold gives way to the movement that ends there.
  dropMovement(sim, gateHoldId(r.callsign));
  if (admit(sim, spec, Math.min(ac.lengthM, track.lengthM - s)) !== null) {
    // Something has since parked for good across its way in: it would wait forever. It gives the
    // gate back (its hold stays dropped) and is given another (or none) next time (callArrivals).
    if (parkedInTheWay(sim, spec, [gateHoldId(r.callsign)]) !== null) {
      sim.world.ramp.aircraft = sim.world.ramp.aircraft.filter((x) => x !== r);
      sim.ramp.waysIn.delete(r);
      return;
    }
    const blocker = reserveParked(sim, parkedAt(sim, gateHoldId(r.callsign), r.gate, ac.type));
    if (blocker !== null) throw new Error(`${ac.callsign}: its gate hold at ${r.gate} came back in the way of ${blocker}`);
    return;
  }
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
}

/** A departure asking to push starts if the reservations admit its pushback and taxi-out. */
function startPushback(sim: Sim, r: RampAircraft, ac: Aircraft): void {
  if (r.plan === null) throw new Error(`${ac.callsign}: asking to push with no plan`);
  const { plan, push, out } = departureTracks(sim, r.gate, ac.type, r.plan);
  const legs: Leg[] = [
    { nodes: push.nodes, edges: push.edges, from: push.lengthM, to: plan.pushTo, seeAndAvoid: false, lookaheadM: PUSH_LOOKAHEAD_M },
    { nodes: out.nodes, edges: out.edges, from: plan.pushTo, to: out.lengthM, seeAndAvoid: true, lookaheadM: taxiLookahead(ac.cruiseMps) },
  ];
  // Arrivals taxiing in, taken in no later than this one was ready, go first (the header's "Priority").
  const yieldTo = sim.world.ramp.aircraft.filter((a) => a.phase === 'taxi-in' && a.since <= r.since).map((a) => a.callsign);
  if (admit(sim, { id: ac.callsign, lengthM: ac.lengthM, wingspanM: ac.wingspanM, legs, stays: false }, 0, yieldTo) !== null) return;
  Object.assign(r, { phase: 'pushback', since: sim.world.tick, pushTo: plan.pushTo, rampHandoff: plan.rampHandoff });
  Object.assign(ac, { track: copyTrack(push), s: push.lengthM, v: 0, status: 'pushing-back' });
  emit(sim, { type: 'pushback', tick: sim.world.tick, callsign: ac.callsign, gate: r.gate });
}

/** A departure plan's tracks. Cached; don't change them. */
function departureTracks(sim: Sim, gate: GateId, type: AircraftTypeCode, i: number): { plan: DeparturePlan; push: Track; out: Track } {
  const key = `${gate}|${type}|${i}`;
  const cached = sim.ramp.departureTracks.get(key);
  if (cached) return cached;
  const plans = departurePlansFor(sim, gate, type);
  const plan = 'unable' in plans ? undefined : plans[i];
  if (!plan) throw new Error(`a ${type} at ${gate}: no plan ${i}`);
  const tracks = { plan, push: buildTrack(sim.index, plan.push.nodes, plan.push.edges), out: buildTrack(sim.index, plan.out.nodes, plan.out.edges) };
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
  if (r.plan === null) throw new Error(`${ac.callsign}: taxiing out with no plan`);
  const { plan, out } = departureTracks(sim, r.gate, ac.type, r.plan);
  // The taxi-out track shares the push track up to the push point, so the nose keeps its place.
  setLeg(sim, ac.callsign, 1);
  Object.assign(r, { phase: 'taxi-out', since: sim.world.tick, pushTo: null, pilotCruiseMps: ac.cruiseMps });
  Object.assign(ac, { track: copyTrack(out), s: plan.pushTo, v: 0, motion: 'taxi', status: 'taxiing', cruiseMps: Math.min(ac.cruiseMps, RAMP_TAXI_KT * KNOT_MPS) });
}

// ---------------------------------------------------------------------------------------------
// Turnarounds

/** When a just-parked arrival's turnaround is due, and what it does then, from the turnarounds' generator. null: they're off. */
function drawTurnaround(sim: Sim, ac: Aircraft): RampAircraft['turnaround'] {
  const t = sim.ramp.turnaround;
  if (t === null) return null;
  const rng = sim.world.ramp.turnarounds.rng;
  const [lo, hi] = ac.wingspanM >= WIDEBODY_SPAN_M ? t.widebodyS : t.narrowbodyS;
  const atGateS = nextInRange(rng, lo, hi);
  const then = nextFloat(rng) < t.departShare ? 'depart' : 'tow';
  return { tick: sim.world.tick + Math.round(atGateS * TICK_HZ), then };
}

/** A turnaround due now, for sim.ts to carry out (it adds and removes aircraft). */
export type TurnaroundDue =
  | { kind: 'tow'; callsign: string; gate: GateId }
  | { kind: 'depart'; callsign: string; gate: GateId; newCallsign: string; type: AircraftTypeCode; airline: string | null };

/**
 * The parked arrivals whose turnaround is due this tick, oldest record first: each to be towed
 * (removed), or to leave the sim as an arrival and be added back at its gate as the departure
 * `newCallsign`. One due to depart waits, parked, while it couldn't push back now: the stand its
 * pushback swings into is taken (choosePlan). Its new callsign is drawn when it goes.
 */
export function rampTurnarounds(sim: Sim): TurnaroundDue[] {
  const t = sim.ramp.turnaround;
  if (t === null) return [];
  const due: TurnaroundDue[] = [];
  for (const r of sim.world.ramp.aircraft) {
    if (r.phase !== 'parked' || r.turnaround === null || sim.world.tick < r.turnaround.tick) continue;
    if (r.turnaround.then === 'tow') {
      due.push({ kind: 'tow', callsign: r.callsign, gate: r.gate });
      continue;
    }
    const ac = aircraftOf(sim, r.callsign);
    if (choosePlan(sim, r.gate, ac.type) === null) continue;
    // Its own reservation is left out of this check (the same id): as a departure it holds the same footprint.
    const blocker = parkedConflict(sim, parkedAt(sim, r.callsign, r.gate, ac.type));
    if (blocker !== null) throw new Error(`${r.callsign}: parked at ${r.gate}, but parking there again is in the way of ${blocker}`);
    const turned = sim.world.ramp.turnarounds;
    const newCallsign = t.callsign(turned.turned, { callsign: r.callsign, type: ac.type, airline: ac.airline, gate: r.gate });
    turned.turned += 1;
    due.push({ kind: 'depart', callsign: r.callsign, gate: r.gate, newCallsign, type: ac.type, airline: ac.airline });
  }
  return due;
}

// ---------------------------------------------------------------------------------------------
// Moving the ramp's aircraft

/**
 * Moves the aircraft the ramp moves itself (motion 'controller'): pushbacks, as far as their
 * reservation goes. Then, after movement.ts has moved the ones taxiing, hands departures stopped
 * at the ramp edge to ground, and parks arrivals at their gates.
 */
export function rampMove(sim: Sim): void {
  const ramp = sim.world.ramp;
  for (const r of [...ramp.aircraft]) {
    if (r.phase === 'taxi-out' || r.phase === 'taxi-in') {
      const ac = aircraftOf(sim, r.callsign);
      if (ac.v !== 0 || ac.s !== ac.track.lengthM || !holdsEnd(sim, ac.callsign)) continue;
      if (r.phase === 'taxi-out') checkIn(sim, r, ac);
      else park(sim, r, ac);
    }
    if (r.phase !== 'pushback') continue;
    const ac = aircraftOf(sim, r.callsign);
    const pushTo = r.pushTo;
    if (pushTo === null) throw new Error(`${ac.callsign}: pushing back with nowhere to stop`);
    const stopAt = Math.max(pushTo, reservedStop(sim, ac)?.at ?? pushTo);
    const vMax = Math.min(PUSH_SPEED_MPS, safeSpeed(ac.s - stopAt, 0, PUSH_DECEL_MPS2));
    let v = Math.min(ac.v + PUSH_ACCEL_MPS2 * TICK_S, vMax);
    v = Math.max(v, ac.v - PUSH_DECEL_MPS2 * TICK_S, 0);
    let s = ac.s - v * TICK_S;
    if (s <= stopAt + STOP_SNAP_M && v <= PUSH_DECEL_MPS2 * TICK_S) [s, v] = [stopAt, 0];
    [ac.s, ac.v] = [Math.max(s, stopAt), v];
    if (ac.s === pushTo && ac.v === 0) [r.phase, r.since] = ['pushed', sim.world.tick];
  }
}

/** At its gate: parked, holding the gate for good. "Arrived at gate" is the arrival's scoring point. */
function park(sim: Sim, r: RampAircraft, ac: Aircraft): void {
  finishMovement(sim, ac.callsign);
  Object.assign(ac, { motion: 'controller', status: 'parked', cruiseMps: r.pilotCruiseMps ?? ac.cruiseMps, blockedBy: null });
  Object.assign(r, { phase: 'parked', since: sim.world.tick, pilotCruiseMps: null, turnaround: drawTurnaround(sim, ac) });
  emit(sim, { type: 'arrived-at-gate', tick: sim.world.tick, callsign: ac.callsign, gate: r.gate });
}

/** At the ramp edge: the pilot calls ground. It's ground's, and off the ramp's books (its reservation lets go once it's clear). */
function checkIn(sim: Sim, r: RampAircraft, ac: Aircraft): void {
  const handoff = sim.index.airport.rampHandoffs.find((h) => h.id === r.rampHandoff);
  if (!handoff) throw new Error(`${ac.callsign}: checking in at unknown ramp edge ${r.rampHandoff}`);
  finishMovement(sim, ac.callsign);
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
