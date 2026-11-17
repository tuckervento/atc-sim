// The text event log (PLAN 1.13): one readable, time-stamped line per sim event that matters to
// the player. Pure: the sim's events in, lines out.

import type { SimEvent } from '../../sim/sim.ts';

/**
 * How a line is shown:
 * - `pilot`: a pilot calling ground
 * - `tower`: the simulated tower answering the player
 * - `unable`: the player's instruction didn't take (unable, ambiguous, wrong frequency, no such aircraft)
 * - `info`: something that happened (takeoff, at the gate, go-around, a turnaround or tow)
 * - `player`: the player's own input, echoed by the app
 */
export type LogKind = 'pilot' | 'tower' | 'unable' | 'info' | 'player';

export interface LogLine {
  tick: number;
  /** The tick's sim time, formatSimTime. */
  time: string;
  kind: LogKind;
  /** The aircraft it's about, if any. */
  callsign: string | null;
  text: string;
}

/** What the log remembers between batches of events. */
export interface LogState {
  /** Aircraft whose crossing request tower answered "hold": its next approval is the callback. */
  held: string[];
}

export interface LogContext {
  /** Sim ticks per second (the sim's TICK_HZ). */
  tickHz: number;
  /** How a gate id reads, e.g. "T4 gate B25". */
  gateLabel: (gateId: string) => string;
  /**
   * A runway hold line, as the pilot says it: the runways it protects as tower says them (the end
   * in use, else the first end) and the taxiway it's on, if named. Needed for holding-short lines;
   * a log without it throws on one.
   */
  holdLine?: (holdShortId: string) => { runways: string[]; taxiway: string | null };
  /** A ramp entrance's name, e.g. "KG". Needed for an arrival at an entrance; a log without it throws on one. */
  entranceName?: (rampHandoffId: string) => string;
  /** The line for the session's end (session-end.ts). Needed for session-ended; a log without it throws on one. */
  endLine?: (ended: { tick: number; cause: Extract<SimEvent, { type: 'session-ended' }>['cause'] }) => string;
}

export function initialLog(): LogState {
  return { held: [] };
}

/** The lines for `events`, oldest first, and the log's state after them. Events not shown give no line. */
export function logEvents(state: LogState, events: readonly SimEvent[], context: LogContext): { state: LogState; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const held = new Set(state.held);
  for (const event of events) {
    const line = describe(event, held, context);
    if (line) lines.push({ tick: event.tick, time: formatSimTime(event.tick / context.tickHz), callsign: event.callsign, ...line });
    // A hold ends with tower's next answer for that aircraft.
    if (event.type === 'crossing-held') held.add(event.callsign);
    else if (event.type === 'crossing-approved' || event.type === 'crossing-unable' || event.type === 'crossing-cancelled') held.delete(event.callsign);
  }
  return { state: { held: [...held] }, lines };
}

/** A line's kind and text; and `callsign` when it's about another aircraft than the event's. */
function describe(event: SimEvent, held: ReadonlySet<string>, context: LogContext): { kind: LogKind; text: string; callsign?: string } | null {
  switch (event.type) {
    case 'crossing-approved': {
      const who = held.has(event.callsign) ? 'TWR callback' : 'TWR';
      return { kind: 'tower', text: `${who}: ${event.callsign} cross ${runways(event.designators)}${event.taxiway === null ? '' : ` at ${event.taxiway}`} approved` };
    }
    case 'crossing-held':
      return { kind: 'tower', text: `TWR: ${event.callsign} hold short of ${runways(event.designators)}, ${event.reason}; will call back` };
    case 'crossing-unable':
      return { kind: 'tower', text: `TWR: ${event.callsign} unable crossing: ${event.reason}` };
    case 'crossing-cancelled':
      return { kind: 'tower', text: `TWR: ${event.callsign} crossing ${runways(event.designators)} cancelled: ${event.reason}` };
    case 'unable':
      return { kind: 'unable', text: `${event.callsign} unable (${event.instruction.type}): ${event.reason}` };
    case 'ramp-waiting':
      return { kind: 'tower', text: `RAMP: ${event.callsign} waiting for a gate${event.terminal === null ? '' : ` at ${event.terminal}`}` };
    case 'ambiguous':
      return {
        kind: 'unable',
        text: `${event.callsign} unable (${event.instruction.type}): which way on ${event.taxiway} at ${event.at}? Give the turn, L:${event.taxiway} or R:${event.taxiway}`,
      };
    case 'not-on-frequency':
      return { kind: 'unable', text: `${event.callsign} is on ${event.controller}'s frequency, not yours: no reply` };
    case 'unknown-callsign':
      return { kind: 'unable', text: `No aircraft ${event.callsign}` };
    case 'holding-short':
      return { kind: 'pilot', text: `${event.callsign} holding short of ${holdingShortOf(event, context)}` };
    case 'arrived':
      return arrivedLine(event, context);
    case 'check-in':
      return { kind: 'pilot', text: `${event.callsign} taxiing on ${event.taxilane}${event.atis === null ? '' : `, information ${event.atis}`}` };
    case 'clear-of-runway':
      return { kind: 'pilot', text: `${event.callsign} clear of ${event.runwayEnd}${event.exit === null ? '' : ` at ${event.exit}`}` };
    case 'arrived-at-gate':
      return { kind: 'info', text: `${event.callsign} arrived at ${context.gateLabel(event.gate)}` };
    case 'session-ended':
      if (!context.endLine) throw new Error('the log has no endLine to say how the session ended');
      return { kind: 'info', text: context.endLine({ tick: event.tick, cause: event.cause }) };
    case 'turnaround':
      // The departure is the aircraft on the map now.
      return { kind: 'info', callsign: event.newCallsign, text: `${event.callsign} turned around at ${context.gateLabel(event.gate)}: departs as ${event.newCallsign}` };
    case 'towed-to-hangar':
      return { kind: 'info', text: `${event.callsign} towed from ${context.gateLabel(event.gate)} to a hangar` };
    case 'took-off':
      return { kind: 'info', text: `${event.callsign} took off ${event.runwayEnd}` };
    case 'go-around':
      return { kind: 'info', text: `${event.callsign} going around ${event.runwayEnd}: ${event.reason}` };
    // Bookkeeping, or shown on the map: command-applied, arrived at a pad, penalty box,
    // hardstand or hangar, entered- and
    // crossed-runway, stopped-for-traffic, crossing-requested (the app echoes the player's own
    // input), tower-accepted, lining-up, takeoff-roll, departed, landed, pushback,
    // ramp-accepted, say-again-callsign.
    default:
      return null;
  }
}

/**
 * At the end of a taxi: at a runway's departure line, the pilot is holding short of the runway
 * there, waiting for "monitor tower" (Q, cycle 10: log holding short); at a ramp entrance,
 * waiting for "monitor ramp". Elsewhere (a pad, the penalty box, a hardstand, a hangar) no line.
 */
function arrivedLine(event: Extract<SimEvent, { type: 'arrived' }>, context: LogContext): { kind: LogKind; text: string } | null {
  const to = event.destination;
  if (to.kind === 'runway') {
    if (!context.holdLine) throw new Error('the log has no holdLine to say where a holding-short is');
    const line = context.holdLine(to.holdShort);
    return { kind: 'pilot', text: `${event.callsign} holding short of ${to.runwayEnd}${line.taxiway === null ? '' : ` at ${line.taxiway}`}` };
  }
  if (to.kind === 'ramp') {
    if (!context.entranceName) throw new Error('the log has no entranceName to say which ramp entrance');
    return { kind: 'pilot', text: `${event.callsign} at the ${to.terminal} ramp entrance ${context.entranceName(to.rampHandoff)}` };
  }
  return null;
}

/** What a holding-short is short of: a runway hold line ("31L at KE"), or the clearance's taxiway ("B"). */
function holdingShortOf(event: Extract<SimEvent, { type: 'holding-short' }>, context: LogContext): string {
  if (event.target?.kind === 'taxiway') return event.target.name;
  if (event.holdShort === null) {
    // A clearance's runway hold-short is at a hold line; one without is a sim bug.
    throw new Error(`${event.callsign}: holding short at ${event.node} of neither a hold line nor a taxiway`);
  }
  if (!context.holdLine) throw new Error('the log has no holdLine to say where a holding-short is');
  const line = context.holdLine(event.holdShort);
  return `${runways(line.runways)}${line.taxiway === null ? '' : ` at ${line.taxiway}`}`;
}

function runways(designators: readonly string[]): string {
  return designators.join(' and ');
}

/** Sim time since the start: "12:04" (m:ss), "1:02:03" from the first hour on. */
export function formatSimTime(seconds: number): string {
  const whole = Math.floor(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
