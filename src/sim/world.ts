// The simulation's state and its events (PLAN 1.9). Everything in `World` is plain JSON data,
// so the state hash (hash.ts) covers all of it, and a session is reproducible from its seed
// and its command script (PRD §8.2, §9.3).

import type { AirportIndex } from '../airport/graph.ts';
import type { EdgeId, HoldShortId, NodeId, RunwayId, TerminalId } from '../airport/types.ts';
import type { AircraftTypeCode } from './aircraft-types.ts';
import type { HoldShortTarget, Instruction, Taxi } from './commands.ts';
import type { Rng } from './rng.ts';
import type { ReachedDestination, RouteStart, RoutePath } from './route.ts';
import type { Track } from './track.ts';

/** A running simulation: the airport, the state, and the events not yet drained. */
export interface Sim {
  readonly index: AirportIndex;
  world: World;
  /** Events in the order they happened, until `drainEvents` takes them. Not part of the state. */
  events: SimEvent[];
  /** Derived from the airport, not state: the runways each edge is in the area of (occupancy.ts). */
  readonly runwayAreas: ReadonlyMap<EdgeId, RunwayId[]>;
}

/** The whole simulation state. */
export interface World {
  /** Ticks completed since the start. */
  tick: number;
  rng: Rng;
  /** In the order added, which is also the order they're processed in. */
  aircraft: Aircraft[];
}

/**
 * What an aircraft is doing, as of the end of the last tick.
 * - `idle`: stopped, with no taxi clearance.
 * - `taxiing`: moving (or about to) under a clearance.
 * - `holding-short`: stopped at a hold point: a runway hold line it isn't cleared across, or
 *   one of its clearance's hold-shorts.
 * - `holding-position`: told to hold position; stopping or stopped.
 * - `stopped-for-traffic`: stopped behind, or short of, another aircraft (see-and-avoid).
 * - `arrived`: stopped at the end of its path, the clearance's destination.
 */
export type AircraftStatus = 'idle' | 'taxiing' | 'holding-short' | 'holding-position' | 'stopped-for-traffic' | 'arrived';

export interface Aircraft {
  callsign: string;
  type: AircraftTypeCode;
  lengthM: number;
  wingspanM: number;
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
  handoff: { mode: 'monitor' | 'contact'; facility: 'tower' | 'ramp'; frequency: string | null } | null;
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
  | (AircraftEvent & { type: 'ambiguous'; instruction: Instruction; node: NodeId; taxiway: string; edges: EdgeId[] })
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
  /** The player asked tower for a crossing (PRD §4.5): `runway`, or null for the next one. Tower is 1.10. */
  | (AircraftEvent & { type: 'crossing-requested'; runway: string | null })
  /** A transmission or request named a callsign that isn't in the sim. */
  | { tick: number; type: 'unknown-callsign'; callsign: string }
  /** "Aircraft calling Ground, say again your callsign" (an unknown-station transmission). */
  | { tick: number; type: 'say-again-callsign'; callsign: null };

export function emit(sim: Sim, event: SimEvent): void {
  sim.events.push(event);
}
