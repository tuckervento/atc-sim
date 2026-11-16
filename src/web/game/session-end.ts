// The session-ended banner and log line (PLAN 1.13): 1.12's rules end the session on a collision
// or a gridlock (rules.ts); this says what, which aircraft, where, and whose aircraft they were
// (`origin`: who controlled them, not whose fault it was). Pure: the sim's cause in, text out.
// The sim keeps running after the end (sim.ts, `step`), and so does the app's map; the counters
// freeze with the score.

import type { Point } from '../../airport/types.ts';
import type { AircraftStatus, Controller, RuleOrigin, RuleParty, SessionEndCause } from '../../sim/sim.ts';
import { formatSimTime } from './event-log.ts';

/** What the formatter needs from the airport. */
export interface EndContext {
  /** Sim ticks per second. */
  tickHz: number;
  /** A runway id as tower says it: "13R/31L" → "31L" on the 31s. */
  runwayName: (runwayId: string) => string;
  /** The nearest named taxiway or ramp lane to a point, or null if none is near. */
  nearestTaxiway: (point: Point) => string | null;
}

export interface SessionEndText {
  /** The banner's heading. */
  title: string;
  /** The banner's lines: what happened, then the origin. */
  details: string[];
  /** One line for the event log. */
  log: string;
}

export function sessionEnd(ended: { tick: number; cause: SessionEndCause }, context: EndContext): SessionEndText {
  const { cause } = ended;
  const names = list(cause.aircraft.map((a) => a.callsign));
  const near = (p: Point) => {
    const name = context.nearestTaxiway(p);
    return name === null ? '' : `near ${name}`;
  };
  let what: string;
  let where: string;
  if (cause.kind === 'collision') {
    const on = cause.runways.length > 0 ? `on ${list(cause.runways.map(context.runwayName))}` : '';
    where = [on, near(cause.point)].filter((s) => s !== '').join(', ');
    what = `${list(cause.aircraft.map(described))} collided${where === '' ? '' : ` ${where}`}.`;
  } else {
    const first = cause.aircraft[0];
    if (!first) throw new Error('a gridlock with no aircraft');
    where = near(first.nose);
    what = `${names} have blocked each other since ${formatSimTime(cause.sinceTick / context.tickHz)}${where === '' ? '' : `, ${where}`}.`;
  }
  return {
    title: `Session over at ${formatSimTime(ended.tick / context.tickHz)}: ${cause.kind}`,
    details: [what, `Origin: ${cause.origin} — ${ORIGIN[cause.origin](cause.aircraft.length)}`],
    log: `SESSION OVER: ${cause.kind} of ${names}${where === '' ? '' : `${cause.kind === 'collision' ? ' ' : ', '}${where}`} (origin: ${cause.origin})`,
  };
}

const ORIGIN: Record<RuleOrigin, (n: number) => string> = {
  player: (n) => (n === 2 ? 'both were yours.' : 'all of them were yours.'),
  mixed: (n) => (n === 2 ? 'one was yours, the other tower’s or ramp’s.' : 'some were yours, some tower’s or ramp’s.'),
  sim: () => 'none of them was yours: a bug in the simulation.',
};

const WHOSE: Record<Controller, string> = { ground: 'yours', tower: 'tower’s', ramp: 'ramp’s' };

function described(a: RuleParty): string {
  return `${a.callsign} (${a.type}, ${WHOSE[a.controller]}, ${statusText(a.status)})`;
}

function statusText(status: AircraftStatus): string {
  return status.replace(/-/g, ' ');
}

/** "A", "A and B", "A, B and C". */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
