// The text event log (PLAN 1.13): one readable, time-stamped line per sim event that matters to
// the player. Pure: the sim's events in, lines out.

import type { SimEvent } from '../../sim/sim.ts';

/**
 * How a line is shown:
 * - `pilot`: a pilot calling ground
 * - `tower`: the simulated tower answering the player
 * - `unable`: the player's instruction didn't take (unable, ambiguous, wrong frequency, no such aircraft)
 * - `info`: something that happened (takeoff, at the gate, go-around)
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

function describe(event: SimEvent, held: ReadonlySet<string>, context: LogContext): { kind: LogKind; text: string } | null {
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
    case 'ambiguous':
      return {
        kind: 'unable',
        text: `${event.callsign} unable (${event.instruction.type}): which way on ${event.taxiway}? Give the turn, L:${event.taxiway} or R:${event.taxiway}`,
      };
    case 'not-on-frequency':
      return { kind: 'unable', text: `${event.callsign} is on ${event.controller}'s frequency, not yours: no reply` };
    case 'unknown-callsign':
      return { kind: 'unable', text: `No aircraft ${event.callsign}` };
    case 'check-in':
      return { kind: 'pilot', text: `${event.callsign} taxiing on ${event.taxilane}${event.atis === null ? '' : `, information ${event.atis}`}` };
    case 'clear-of-runway':
      return { kind: 'pilot', text: `${event.callsign} clear of ${event.runwayEnd}${event.exit === null ? '' : ` at ${event.exit}`}` };
    case 'arrived-at-gate':
      return { kind: 'info', text: `${event.callsign} arrived at ${context.gateLabel(event.gate)}` };
    case 'took-off':
      return { kind: 'info', text: `${event.callsign} took off ${event.runwayEnd}` };
    case 'go-around':
      return { kind: 'info', text: `${event.callsign} going around ${event.runwayEnd}: ${event.reason}` };
    // Bookkeeping, or shown on the map: command-applied, arrived, holding-short, entered- and
    // crossed-runway, stopped-for-traffic, crossing-requested (the app echoes the player's own
    // input), tower-accepted, lining-up, takeoff-roll, departed, landed, pushback,
    // ramp-accepted, say-again-callsign.
    default:
      return null;
  }
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
