// The event log's lines added in cycle 10 (PLAN 1.13): holding short (Q: "yes log holding
// short"), turnarounds and tows, and the session's end. Pure: events in, lines out.

import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../sim/sim.ts';
import { initialLog, logEvents, type LogContext, type LogLine } from './event-log.ts';

const CONTEXT: LogContext = {
  tickHz: 10,
  gateLabel: (id) => {
    if (id === 'g1') return 'T4 gate B25';
    throw new Error(`no gate ${id}`);
  },
  holdLine: (id) => {
    if (id === 'hKE') return { runways: ['31L'], taxiway: 'KE' };
    if (id === 'hJ') return { runways: ['4L', '31L'], taxiway: 'J' };
    if (id === 'hX') return { runways: ['31R'], taxiway: null };
    throw new Error(`no hold line ${id}`);
  },
  entranceName: (id) => {
    if (id === 'rhKG') return 'KG';
    throw new Error(`no ramp entrance ${id}`);
  },
};

function lines(...events: SimEvent[]): LogLine[] {
  return logEvents(initialLog(), events, CONTEXT).lines;
}

describe('logEvents: holding short', () => {
  it('at a runway hold line: the runways as tower says them, and the taxiway the line is on', () => {
    expect(lines({ tick: 900, type: 'holding-short', callsign: 'DAL4', node: 'n1', holdShort: 'hKE', runways: ['13R/31L'], target: null })).toEqual([
      { tick: 900, time: '1:30', kind: 'pilot', callsign: 'DAL4', text: 'DAL4 holding short of 31L at KE' },
    ]);
    expect(lines({ tick: 1, type: 'holding-short', callsign: 'DAL4', node: 'n1', holdShort: 'hJ', runways: ['4L/22R', '13R/31L'], target: null })[0]?.text).toBe('DAL4 holding short of 4L and 31L at J');
    expect(lines({ tick: 1, type: 'holding-short', callsign: 'DAL4', node: 'n1', holdShort: 'hX', runways: ['13L/31R'], target: null })[0]?.text).toBe('DAL4 holding short of 31R');
  });

  it("at one of the clearance's hold-shorts: the taxiway, or the runway at its hold line", () => {
    expect(lines({ tick: 1, type: 'holding-short', callsign: 'DAL4', node: 'n1', holdShort: null, runways: [], target: { kind: 'taxiway', name: 'B' } })[0]?.text).toBe('DAL4 holding short of B');
    expect(lines({ tick: 1, type: 'holding-short', callsign: 'DAL4', node: 'n1', holdShort: 'hKE', runways: [], target: { kind: 'runway', name: '31L' } })[0]?.text).toBe('DAL4 holding short of 31L at KE');
  });
});

describe('logEvents: at the end of a taxi', () => {
  it("to a runway, the pilot is holding short of it at its departure line's hold; to a ramp entrance, at the entrance; elsewhere, nothing", () => {
    expect(lines({ tick: 1, type: 'arrived', callsign: 'DAL4', destination: { kind: 'runway', runwayEnd: '31L', departureLine: 'd1', holdShort: 'hKE' } })).toEqual([
      { tick: 1, time: '0:00', kind: 'pilot', callsign: 'DAL4', text: 'DAL4 holding short of 31L at KE' },
    ]);
    expect(lines({ tick: 1, type: 'arrived', callsign: 'UAE202', destination: { kind: 'ramp', terminal: 'T4', rampHandoff: 'rhKG' } })[0]?.text).toBe('UAE202 at the T4 ramp entrance KG');
    expect(lines({ tick: 1, type: 'arrived', callsign: 'AFR23', destination: { kind: 'pad', holdingArea: 'pad1', spot: 'n9' } })).toEqual([]);
  });
});

describe('logEvents: turnarounds', () => {
  it("a turnaround names the gate and the new flight, and is about the new flight (it's the one on the map now); a tow names the gate", () => {
    expect(lines({ tick: 36_000, type: 'turnaround', callsign: 'DAL402', gate: 'g1', newCallsign: 'DAL1735' })).toEqual([
      { tick: 36_000, time: '1:00:00', kind: 'info', callsign: 'DAL1735', text: 'DAL402 turned around at T4 gate B25: departs as DAL1735' },
    ]);
    expect(lines({ tick: 600, type: 'towed-to-hangar', callsign: 'JBU77', gate: 'g1' })).toEqual([
      { tick: 600, time: '1:00', kind: 'info', callsign: 'JBU77', text: 'JBU77 towed from T4 gate B25 to a hangar' },
    ]);
  });
});
