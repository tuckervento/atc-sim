// The simulation's state and its events (PLAN 1.9). Everything in `World` is plain JSON data,
// so the state hash (hash.ts) covers all of it, and a session is reproducible from its seed
// and its command script (PRD §8.2, §9.3).

import type { AirportIndex } from '../airport/graph.ts';
import type { EdgeId, GateId, HoldShortId, NodeId, Point, RampHandoffId, RunwayEndDesignator, RunwayExitId, RunwayId, TerminalId } from '../airport/types.ts';
import type { AircraftTypeCode } from './aircraft-types.ts';
import type { HoldShortTarget, Instruction, Taxi } from './commands.ts';
import type { Rng } from './rng.ts';
import type { ReachedDestination, RouteStart, RoutePath } from './route.ts';
import type { RampSetup } from './ramp.ts';
import type { ReservationState } from './reservations.ts';
import type { TowerSetup } from './tower.ts';
import type { Track } from './track.ts';

/** A running simulation: the airport, the state, and the events not yet drained. */
export interface Sim {
  readonly index: AirportIndex;
  world: World;
  /** Events in the order they happened, until `drainEvents` takes them. Not part of the state. */
  events: SimEvent[];
  /** Derived from the airport, not state: the runways each edge is in the area of (occupancy.ts). */
  readonly runwayAreas: ReadonlyMap<EdgeId, RunwayId[]>;
  /** Derived from the airport and the options, not state: the runways in use and the arrival streams. */
  readonly tower: TowerSetup;
  /** Derived from the airport and the options, not state: stands, departure streams, and plan caches. */
  readonly ramp: RampSetup;
}

/**
 * The whole simulation state.
 *
 * Controllers. The player is ground. The simulated tower (tower.ts) and ramp (1.11) each own
 * some aircraft (`Aircraft.controller`) and keep their own state here, as plain JSON, so the
 * state hash covers it. Each gets two calls in the tick (sim.ts, `advance`):
 * - decide: at the start of the tick, on the state as the last tick left it. It spawns, takes
 *   handoffs, answers requests and starts movements. The tower: `towerSpawns` (sim.ts adds what
 *   it returns) and `towerDecide`.
 * - move: after movement.ts has moved the taxiing aircraft, it moves the aircraft it moves
 *   itself (motion 'controller'), planning from the same start-of-tick places. The tower:
 *   `towerMove`.
 * The ramp (ramp.ts, 1.11):
 * - `ramp: RampState` beside `tower`: who holds each gate, and its aircraft's progress.
 * - `rampSpawns` and `rampDecide` after `towerDecide`: spawn departures at gates (controller
 *   'ramp', role 'departure'), start pushbacks, take arrivals handed off at a ramp entrance (the
 *   way `towerDecide` takes departures at the hold); its movements are granted ground a stretch at a
 *   time by the reservations (`world.reservations`, reservations.ts), brought up to date first.
 * - Parked and pushing back, its aircraft are motion 'controller' (a pushback's `s` goes
 *   backward); `rampMove`, after `towerMove`, moves the pushbacks. Ramp-lane taxi is motion
 *   'taxi' on a track the ramp made, with no clearance (movement.ts lets the ramp's aircraft
 *   taxi without one), so see-and-avoid and turn speeds come from movement.ts.
 * - At the ramp edge it hands the aircraft to ground (controller 'ground') with a `check-in`
 *   event, as the tower does with `clear-of-runway`. An arrival waiting at a ramp entrance is
 *   still ground's: ramp takes it only once it can move it.
 * - Transmissions to its aircraft get `not-on-frequency` (apply.ts), as the tower's do.
 *
 * Rules and score (rules.ts, score.ts, 1.12) run last in the tick, on the state and events the
 * tick produced. They keep `session`, `rules` and `score` here. The sim keeps advancing after
 * the session ends (sim.ts, `step`); only rules and score stop counting.
 */
export interface World {
  /** Ticks completed since the start. */
  tick: number;
  rng: Rng;
  /** In the order added, which is also the order they're processed in. */
  aircraft: Aircraft[];
  tower: TowerState;
  ramp: RampState;
  /** Who holds which stretch of ground as they move (reservations.ts): the ramp's movements, for now. */
  reservations: ReservationState;
  session: Session;
  rules: RulesState;
  score: ScoreState;
}

/**
 * Whether the session is still on (rules.ts). A collision or a gridlock ends it, in the tick it's
 * found; it stays ended, with the first cause.
 */
export type Session = { state: 'running' } | { state: 'ended'; tick: number; cause: SessionEndCause };

export type SessionEndCause =
  /**
   * Two footprints overlap (footprint.ts). `point`: midway between the two footprints' centres.
   * `runways`: the runway areas either body was in, sorted; empty off the runways.
   */
  | { kind: 'collision'; aircraft: RuleParty[]; point: Point; runways: RunwayId[]; origin: RuleOrigin }
  /**
   * Aircraft each stopped up against the next one, in a cycle (rules.ts), since `sinceTick`.
   * `aircraft` in the cycle's order: each one's `blockedBy` is the next, the last's the first.
   */
  | { kind: 'gridlock'; aircraft: RuleParty[]; sinceTick: number; origin: RuleOrigin };

/**
 * Who was moving the aircraft involved: `player` if every one was ground's (the player's
 * clearances), `sim` if none was (tower's or ramp's own movements: a sim bug), `mixed` otherwise.
 * It says who controlled them, not whose fault it was: ground's aircraft also stop and space
 * themselves by the sim's see-and-avoid (traffic.ts).
 */
export type RuleOrigin = 'player' | 'sim' | 'mixed';

/** An aircraft involved in a session-ending event, as it was at the end of that tick. */
export interface RuleParty {
  callsign: string;
  type: AircraftTypeCode;
  controller: Controller;
  status: AircraftStatus;
  speedMps: number;
  /** Where the nose is: exactly on a node, or inside an edge. */
  location: { kind: 'node'; node: NodeId } | { kind: 'edge'; edge: EdgeId };
  nose: Point;
  /** The runways whose area the body was in, sorted. */
  runways: RunwayId[];
  blockedBy: string | null;
}

/** What the rule checks have counted, and what they're watching (rules.ts). */
export interface RulesState {
  /** Every unauthorized runway crossing, in the order they happened. */
  unauthorizedCrossings: UnauthorizedCrossing[];
  /**
   * Cycles of aircraft stopped up against each other, each with the tick it was first seen; a
   * gridlock once one has lasted GRIDLOCK_S. `members` sorted. Gone once the cycle breaks.
   */
  jams: { members: string[]; since: number }[];
}

/** The player's crossing clearance took an aircraft past a runway hold line without tower's approval for it. */
export interface UnauthorizedCrossing {
  tick: number;
  callsign: string;
  holdShort: HoldShortId;
  runways: RunwayId[];
}

/** The scoring points (score.ts, PRD §4.8): departures at lift-off, arrivals at the gate. In the order they happened. */
export interface ScoreState {
  departures: ScoredMovement[];
  arrivals: ScoredMovement[];
}

export interface ScoredMovement {
  tick: number;
  callsign: string;
}

/**
 * What an aircraft is doing, as of the end of the last tick.
 * - `idle`: stopped, with no taxi clearance.
 * - `taxiing`: moving (or about to) under a clearance. Also an arrival clear of the runway that
 *   tower is bringing to a stop before it calls ground.
 * - `holding-short`: stopped at a hold point: a runway hold line it isn't cleared across, or
 *   one of its clearance's hold-shorts.
 * - `holding-position`: told to hold position; stopping or stopped.
 * - `stopped-for-traffic`: stopped behind, or short of, another aircraft (see-and-avoid).
 * - `arrived`: stopped at the end of its path, the clearance's destination. A departure tower
 *   has taken at its hold keeps this until it lines up.
 * Under tower (tower.ts):
 * - `on-final`: airborne, approaching the runway, until touchdown.
 * - `landing`: on the runway, from touchdown until its body is clear of the runway.
 * - `lining-up`: taxiing from the hold onto the runway; `lined-up`: stopped there, waiting.
 * - `taking-off`: on the takeoff roll; `airborne`: after lift-off, until it leaves.
 * Under ramp (ramp.ts):
 * - `parked`: at a gate, a departure before its pushback or an arrival that has arrived.
 * - `pushing-back`: being pushed back from the gate, and stopped after it while the tug
 *   disconnects. Its ramp-lane taxi has the taxi statuses above.
 */
export type AircraftStatus =
  | 'idle'
  | 'taxiing'
  | 'holding-short'
  | 'holding-position'
  | 'stopped-for-traffic'
  | 'arrived'
  | 'on-final'
  | 'landing'
  | 'lining-up'
  | 'lined-up'
  | 'taking-off'
  | 'airborne'
  | 'parked'
  | 'pushing-back';

/**
 * The simulated tower's state (tower.ts). Track distances (`…At`) are meters along the
 * aircraft's own track.
 */
export interface TowerState {
  /** One per arrival stream (SimOptions.arrivals), in the order given. */
  streams: ArrivalStreamState[];
  /** Arrivals on final or on the runway, until tower hands them to ground. In the order added. */
  arrivals: TowerArrival[];
  /** Departures tower has taken at their hold, until they leave. In the order taken. */
  departures: TowerDeparture[];
  /** Crossing requests not yet answered, or held. In the order asked. */
  requests: CrossingRequestState[];
  /** Current crossing approvals (1.12 checks crossings against these). In the order given. */
  approvals: CrossingApproval[];
  /** The last takeoff roll started on each runway, for departure spacing. */
  rolls: { runway: RunwayId; tick: number; heavy: boolean }[];
}

export interface ArrivalStreamState {
  runwayEnd: RunwayEndDesignator;
  /** The tick of the next spawn, if the final and the runway allow it then. */
  nextTick: number;
  /** Arrivals spawned so far: the next flight's number. */
  count: number;
  /**
   * On a runway that also takes departures: whether a departure has started its takeoff roll
   * since the last arrival was spawned, with no arrival for this end still on final (so behind
   * that one). While a departure waits and this is false, the next arrival is held back, so
   * landings and takeoffs interleave.
   */
  departureSinceArrival: boolean;
}

export interface TowerArrival {
  callsign: string;
  runwayEnd: RunwayEndDesignator;
  /** Cleared to land: at the go-around decision point, the runway was clear. */
  committed: boolean;
  /** The exit it was sent to, chosen when committed. */
  exit: PlannedExit | null;
  /** Its whole body is past the exit's hold line (or out of the runway's area). */
  clear: boolean;
}

export interface PlannedExit {
  id: RunwayExitId;
  /** The exit's spoken name. null: an unnamed exit. */
  taxiway: string | null;
  /** Track distances: the exit's node on the centerline, and the end of its first edge. */
  nodeAt: number;
  edgeEndAt: number;
  /** Where the body counts as clear: the exit's runway hold line, else the end of the runway area. */
  clearAt: number;
  /** Where the nose stops: the tail CLEAR_MARGIN_M past `clearAt`. */
  stopAt: number;
  /** Speed through the exit, and the braking from touchdown to reach it. */
  speedMps: number;
  decelMps2: number;
}

export interface TowerDeparture {
  callsign: string;
  runwayEnd: RunwayEndDesignator;
  /** When tower took it at the hold. */
  acceptedTick: number;
  /** Track distance where the nose stops when lined up. null until it starts lining up. */
  lineupAt: number | null;
  /** When it stopped lined up. */
  linedUpTick: number | null;
  /** Tower's estimate, when it started lining up, of the tick it lifts off. */
  airborneByTick: number | null;
}

/** Where a crossing request is for: the hold line it's at, or will next stop at. */
export interface CrossingTarget {
  /** The hold line's runways, in its order. */
  runways: RunwayId[];
  holdShort: HoldShortId;
  /** The hold line's node, and the first centerline node the crossing reaches. */
  node: NodeId;
  runwayNode: NodeId;
  /** The taxiway it crosses on. */
  taxiway: string | null;
  /** Every runway whose area the crossing passes through (occupancy.ts), sorted. */
  areas: RunwayId[];
}

export interface CrossingRequestState {
  callsign: string;
  /** When asked, and when tower first answers (after a beat). */
  tick: number;
  answerTick: number;
  /** Answered "hold": tower calls back when the crossing is clear. */
  held: boolean;
  /** Where it's for, or why tower will say unable. */
  target: CrossingTarget | { unable: string };
}

export interface CrossingApproval extends CrossingTarget {
  callsign: string;
  /** When tower approved it. */
  tick: number;
  /** The aircraft's body has been in one of the runways' areas since. */
  entered: boolean;
}

/**
 * The simulated ramp's state (ramp.ts). A gate is taken while an aircraft's record names it:
 * parked there, pushing from it, or an arrival it's assigned to; or names it as the stand a
 * departure will swing its tail into (`swingInto`).
 */
export interface RampState {
  /** One per departure stream (SimOptions.departures), in the order given. */
  streams: DepartureStreamState[];
  /** The ramp's aircraft, and arrivals waiting at an entrance for it. In the order taken. */
  aircraft: RampAircraft[];
  /**
   * Turnarounds (ramp.ts): their own generator, seeded from the session's seed, so drawing a
   * parked arrival's turnaround doesn't shift what the main one gives everything else; and how
   * many arrivals have turned into departures so far (the next one's number, for its callsign).
   */
  turnarounds: { rng: Rng; turned: number };
  /**
   * Arrivals at an entrance ramp has no gate for, told so (`ramp-waiting`): with the tick of the
   * handoff it last answered, so it answers each new one once.
   */
  waiting: { callsign: string; answered: number }[];
}

export interface DepartureStreamState {
  /** The tick of the next spawn, if a gate is free then. */
  nextTick: number;
  /** Departures spawned so far: the next flight's number. */
  count: number;
}

/**
 * Where a ramp aircraft is in its life, in order:
 * - departure: `at-gate` (boarding), `ready` (asking to push), `pushback`, `pushed` (tug
 *   disconnecting), `taxi-out`; it leaves the ramp's records at the check-in.
 * - arrival: `called` (stopped at a ramp entrance, handed off, gate assigned, still ground's
 *   until its way in is clear), `taxi-in`, `parked` (stays, holding its gate).
 */
export type RampPhase = 'at-gate' | 'ready' | 'pushback' | 'pushed' | 'taxi-out' | 'called' | 'taxi-in' | 'parked';

export interface RampAircraft {
  callsign: string;
  phase: RampPhase;
  /** The gate it holds. */
  gate: GateId;
  /** The tick it entered its phase. */
  since: number;
  /** A departure at its gate: the tick it asks to push. null otherwise. */
  readyTick: number | null;
  /** The ramp handoff it leaves by (departure) or came in at (arrival). null until known. */
  rampHandoff: RampHandoffId | null;
  /** Pushing back: the track distance where the nose stops. null otherwise. */
  pushTo: number | null;
  /** A departure: the index of the pushback plan it will use (ramp.ts, departurePlansFor). null otherwise. */
  plan: number | null;
  /** A departure whose pushback swings its tail into another gate's stand: that gate, claimed until it has left. */
  swingInto: GateId | null;
  /** While the ramp taxis it slowly: its pilot's own taxi speed, given back at the check-in. */
  pilotCruiseMps: number | null;
  /**
   * An arrival parked at its gate by the ramp: the tick its turnaround is due, and what it does
   * then (ramp.ts, "Turnarounds"). null otherwise: a departure, an arrival not yet parked, one
   * added parked (addAircraft), or with turnarounds off.
   */
  turnaround: { tick: number; then: 'depart' | 'tow' } | null;
}

/** What the flight is here to do. The map colours aircraft by it. */
export type Role = 'departure' | 'arrival';

/**
 * Who it's talking to, and so who gives it instructions.
 * - `ground`: the player. Only these aircraft take the player's transmissions.
 * - `tower`: the simulated tower (tower.ts): on final, landing, or a departure from its handoff.
 * - `ramp`: the simulated ramp (ramp.ts): parked at a gate, pushback and ramp-lane taxi.
 */
export type Controller = 'ground' | 'tower' | 'ramp';

/**
 * Who moves it each tick.
 * - `taxi`: movement.ts, along its clearance (or braking to a stop without one).
 * - `controller`: its controller moves it itself, with its own kinematics: the tower's landing
 *   roll, line-up and takeoff; the ramp's parking and pushback. Such a mover may set `track`, `s` and
 *   `v` as it likes, `s` going backward included (pushback); movement.ts leaves it alone.
 */
export type Motion = 'taxi' | 'controller';

export interface Aircraft {
  callsign: string;
  type: AircraftTypeCode;
  lengthM: number;
  wingspanM: number;
  role: Role;
  /** ICAO airline designator ("DAL"), for "the company hangar". null: unknown. */
  airline: string | null;
  controller: Controller;
  motion: Motion;
  /**
   * On final or after takeoff: not on the ground. It's in no runway area (`runways` is empty) and
   * no one's traffic (see-and-avoid ignores it). The tower's own runway logic accounts for it.
   */
  airborne: boolean;
  /** Its terminal, for a taxi to "the ramp" with no name. */
  terminal: TerminalId | null;
  /** This pilot's taxi speed on a straight, m/s. */
  cruiseMps: number;
  track: Track;
  /** Where the nose is: meters along `track`. */
  s: number;
  /** Speed, m/s. Never negative. */
  v: number;
  /** The taxi clearance it's following, as it will fly it. null: none. */
  clearance: Clearance | null;
  /** Runway crossing clearances not yet used, in the order given. */
  crossings: CrossingClearance[];
  /** Told to hold position, and not yet released. */
  holdPosition: boolean;
  status: AircraftStatus;
  /**
   * The aircraft whose body sets its nearest stop point (see-and-avoid, traffic.ts), whether
   * it's stopped for it yet or not. null: its nearest stop isn't traffic.
   */
  blockedBy: string | null;
  /** The runways whose area the body was in at the end of the last tick, sorted. */
  runways: RunwayId[];
  advisories: Advisories;
}

/** A taxi clearance and the path it resolved to. */
export interface Clearance {
  /** The clearance as the pilot flies it: the last `taxi`, with any corrections applied. */
  taxi: Taxi;
  /** Where it was resolved from. */
  start: RouteStart;
  path: RoutePath;
  /** The track index of `path.nodes[0]`: path index i is track index i + pathOffset. */
  pathOffset: number;
  /** Path node indices of the clearance hold-shorts that `continue` has released. */
  released: number[];
}

/** A `cross` clearance: the runways it may still cross, and where. */
export interface CrossingClearance {
  /** Runway ids ('18/36'), in the order given, minus the ones already crossed. */
  runways: RunwayId[];
  /** The taxiway where it crosses. null: wherever its route next meets each runway. */
  at: string | null;
}

/** Instructions with no effect on movement yet, recorded for the tasks that act on them. */
export interface Advisories {
  /** `tick`: when it was given, so a repeat is told apart (ramp answers each, ramp.ts). */
  handoff: { mode: 'monitor' | 'contact'; facility: 'tower' | 'ramp'; frequency: string | null; tick: number } | null;
  atis: { letter: string; altimeter: string | null } | null;
  groundStop: string | null;
  releaseTime: string | null;
  holdForRelease: boolean;
  expectDelayMinutes: number | null;
}

interface AircraftEvent {
  /** The tick it happened in: `world.tick` once that tick is complete. */
  tick: number;
  callsign: string;
}

export type SimEvent =
  /** An instruction was applied. */
  | (AircraftEvent & { type: 'command-applied'; instruction: Instruction })
  /** The pilot can't comply. The aircraft keeps what it had. */
  | (AircraftEvent & { type: 'unable'; instruction: Instruction; reason: string })
  /** A taxi (or correction) needs a turn direction: both ways on `taxiway` from `node` work. */
  | (AircraftEvent & { type: 'ambiguous'; instruction: Instruction; node: NodeId; /** `node` as a player finds it (junctionName). */ at: string; taxiway: string; edges: EdgeId[] })
  /** Stopped at the end of its path. */
  | (AircraftEvent & { type: 'arrived'; destination: ReachedDestination })
  /**
   * Stopped at a hold point. `runways`: the runways the hold line there protects, for a runway
   * hold line. `target`: the clearance hold-short it's obeying, if it's one of those.
   */
  | (AircraftEvent & {
      type: 'holding-short';
      node: NodeId;
      holdShort: HoldShortId | null;
      runways: RunwayId[];
      target: HoldShortTarget | null;
    })
  /**
   * The nose passed a runway hold line on the path: it's on the runway. `cleared`: it held a
   * crossing clearance for every runway the line protects (and used it up).
   */
  | (AircraftEvent & { type: 'entered-runway'; holdShort: HoldShortId; runways: RunwayId[]; cleared: boolean })
  /** The whole body has left `runway`'s area: across it, or off it. */
  | (AircraftEvent & { type: 'crossed-runway'; runway: RunwayId })
  /** Stopped for `behind`, the aircraft in its way. */
  | (AircraftEvent & { type: 'stopped-for-traffic'; behind: string })
  /** The player asked tower for a crossing (PRD §4.5): `runway`, or null for the next one. Tower answers after a beat. */
  | (AircraftEvent & { type: 'crossing-requested'; runway: string | null })
  /**
   * Tower: "cross … at … approved", as its answer or, after a hold, its callback. `runways` are
   * ids; `designators` say them as tower would (the end in use, else the first end).
   */
  | (AircraftEvent & { type: 'crossing-approved'; runways: RunwayId[]; designators: string[]; taxiway: string | null; holdShort: HoldShortId })
  /** Tower: "hold short, traffic …". It calls back with `crossing-approved` when it's clear. */
  | (AircraftEvent & { type: 'crossing-held'; runways: RunwayId[]; designators: string[]; reason: string })
  /** Tower can't give that crossing: none ahead, or the aircraft isn't ground's. */
  | (AircraftEvent & { type: 'crossing-unable'; reason: string })
  /** Tower withdrew an approval the aircraft hadn't used: landing traffic, or unused too long. */
  | (AircraftEvent & { type: 'crossing-cancelled'; runways: RunwayId[]; designators: string[]; reason: string })
  /** A transmission to an aircraft on another controller's frequency: no reply, no effect. */
  | (AircraftEvent & { type: 'not-on-frequency'; controller: Exclude<Controller, 'ground'> })
  /** Tower took a departure handed off at its hold. */
  | (AircraftEvent & { type: 'tower-accepted'; runwayEnd: RunwayEndDesignator })
  /** Tower: "line up and wait". */
  | (AircraftEvent & { type: 'lining-up'; runwayEnd: RunwayEndDesignator })
  /** Tower: "cleared for takeoff"; the roll starts. */
  | (AircraftEvent & { type: 'takeoff-roll'; runwayEnd: RunwayEndDesignator })
  /** Lift-off: a departure's scoring point (PRD §4.2). */
  | (AircraftEvent & { type: 'took-off'; runwayEnd: RunwayEndDesignator })
  /** Past the far end of the runway, airborne: removed from the sim in this tick. */
  | (AircraftEvent & { type: 'departed'; runwayEnd: RunwayEndDesignator })
  /** Touchdown. */
  | (AircraftEvent & { type: 'landed'; runwayEnd: RunwayEndDesignator })
  /** At the decision point the runway wasn't clear (or no exit was): back on final, behind the others. */
  | (AircraftEvent & { type: 'go-around'; runwayEnd: RunwayEndDesignator; reason: string })
  /**
   * The pilot's call to ground: "clear of three one left at Kilo Echo". Stopped clear of the
   * runway, it's now ground's (controller 'ground', status 'idle'). `exit`: the exit's spoken
   * name, null for an unnamed exit.
   */
  | (AircraftEvent & { type: 'clear-of-runway'; runwayEnd: RunwayEndDesignator; exit: string | null; exitId: RunwayExitId })
  /** Ramp: a departure starts its pushback from `gate`. */
  | (AircraftEvent & { type: 'pushback'; gate: GateId })
  /**
   * The pilot's call to ground at the ramp edge: "Ground, Delta four, taxiing on Kilo Foxtrot,
   * information Oscar" (PRD §4.2). `taxilane`: the handoff's name; `atis`: the letter the pilot
   * has, null if none. Stopped with its nose on the handoff node, it's now ground's
   * (controller 'ground', status 'idle').
   */
  | (AircraftEvent & { type: 'check-in'; rampHandoff: RampHandoffId; taxilane: string; atis: string | null })
  /**
   * Ramp takes an arrival handed off to it at a ramp entrance (`rampHandoff`), once its way in
   * is clear, and taxis it to `gate`, assigned when it stopped there.
   */
  | (AircraftEvent & { type: 'ramp-accepted'; rampHandoff: RampHandoffId; gate: GateId })
  /** Ramp has no gate it can reach for this arrival at its entrance (yet): it waits there, ground's. */
  | (AircraftEvent & { type: 'ramp-waiting'; rampHandoff: RampHandoffId; terminal: TerminalId | null })
  /** Stopped at its gate, parked: an arrival's scoring point (PRD §4.3). */
  | (AircraftEvent & { type: 'arrived-at-gate'; gate: GateId })
  /**
   * Ramp: a parked arrival (`callsign`) has turned around, and leaves again as a new flight: the
   * same aircraft, type and airline, now the departure `newCallsign`, parked at `gate`. The
   * arrival has left the sim; the departure boards, then asks to push (ramp.ts, "Turnarounds").
   */
  | (AircraftEvent & { type: 'turnaround'; gate: GateId; newCallsign: string })
  /** Ramp: a parked arrival was towed from `gate` to a hangar, and has left the sim. Its gate is free. */
  | (AircraftEvent & { type: 'towed-to-hangar'; gate: GateId })
  /**
   * The player's crossing clearance took it past a runway hold line without a current tower
   * approval for that line (rules.ts, PRD §4.5). Counted in `world.rules`.
   */
  | (AircraftEvent & { type: 'unauthorized-crossing'; holdShort: HoldShortId; runways: RunwayId[] })
  /** A collision or a gridlock ended the session (rules.ts). Emitted once. The aircraft are in `cause`. */
  | { tick: number; type: 'session-ended'; callsign: null; cause: SessionEndCause }
  /** A transmission or request named a callsign that isn't in the sim. */
  | { tick: number; type: 'unknown-callsign'; callsign: string }
  /** "Aircraft calling Ground, say again your callsign" (an unknown-station transmission). */
  | { tick: number; type: 'say-again-callsign'; callsign: null };

export function emit(sim: Sim, event: SimEvent): void {
  sim.events.push(event);
}
