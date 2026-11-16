// Where an aircraft's label says it's going (PRD §5: "callsign, type, and where it's going"),
// from the sim's view of it. Pure.

import type { Destination } from '../../sim/commands.ts';
import type { AircraftView } from '../../sim/sim.ts';

/** The parts of the sim's AircraftView this reads (an AircraftView is one). */
export interface DestinationInput {
  role: AircraftView['role'];
  clearance: { taxi: { to: Destination } } | null;
  final: { runwayEnd: string } | null;
}

/** What the view doesn't carry, from the session. */
export interface DestinationContext {
  /** The flight's terminal, as the traffic spawned it. null: not known. */
  terminal: string | null;
  /** The configuration's departure runway ends. */
  departureEnds: readonly string[];
}

export function destinationOf(view: DestinationInput, context: DestinationContext): string {
  const to = view.clearance?.taxi.to;
  if (to) return clearedTo(to, context);
  // No clearance: an arrival is going to its terminal (from the runway it's landing on, until
  // that's known); a departure to the configuration's departure runway.
  if (view.role === 'arrival') return context.terminal ?? view.final?.runwayEnd ?? '';
  return context.departureEnds.join('/');
}

/** A holding place or hangar: its kind, and its name if the clearance gave one. */
const PLACE_WORD: Record<Exclude<Destination['kind'], 'runway' | 'ramp'>, string> = {
  pad: 'PAD',
  'penalty-box': 'PENALTY',
  hardstand: 'HARDSTAND',
  hangar: 'HANGAR',
};

function clearedTo(to: Destination, context: DestinationContext): string {
  switch (to.kind) {
    case 'runway':
      return to.name;
    case 'ramp':
      return to.name ?? context.terminal ?? 'RAMP';
    default:
      return to.name === null ? PLACE_WORD[to.kind] : `${PLACE_WORD[to.kind]} ${to.name}`;
  }
}
