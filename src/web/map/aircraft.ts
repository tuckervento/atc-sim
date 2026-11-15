// The map's aircraft layer input: a small render type, and the adapter from the sim's view.
// The map draws `MapAircraft` only, so it doesn't depend on the sim's internals and mock
// aircraft are just values.

import type { Point } from '../../airport/types.ts';
import type { AircraftView } from '../../sim/sim.ts';

/** What the map colors an aircraft by (PRD §5). */
export type AircraftRole = 'departure' | 'arrival' | 'delayed';

export const AIRCRAFT_ROLES: readonly AircraftRole[] = ['departure', 'arrival', 'delayed'];

/** One aircraft as the map draws it. */
export interface MapAircraft {
  callsign: string;
  /** ICAO type designator, e.g. "A320". */
  type: string;
  /** The nose, in the airport's local frame (meters east, north). */
  nose: Point;
  /** Degrees true, clockwise from north. null: no heading; drawn as a marker, not a shape. */
  headingDeg: number | null;
  lengthM: number;
  wingspanM: number;
  role: AircraftRole;
  /** Where it's going, as the label shows it: a runway ("31L"), a terminal ("T4"), a pad. */
  destination: string;
}

/** What the sim's `AircraftView` doesn't carry yet, so the caller supplies it. */
export interface MapAircraftExtras {
  destination: string;
  /** Shown as 'delayed' in place of its role. The sim doesn't track delay yet (PRD §4.4, Phase 3). */
  delayed: boolean;
}

export function fromAircraftView(view: AircraftView, extras: MapAircraftExtras): MapAircraft {
  return {
    callsign: view.callsign,
    type: view.type,
    nose: [view.nose[0], view.nose[1]],
    headingDeg: view.headingDeg,
    lengthM: view.lengthM,
    wingspanM: view.wingspanM,
    role: extras.delayed ? 'delayed' : view.role,
    destination: extras.destination,
  };
}
