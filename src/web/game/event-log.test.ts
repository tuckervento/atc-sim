import { describe, expect, it } from 'vitest';
import type { Taxi } from '../../sim/commands.ts';
import type { SimEvent } from '../../sim/sim.ts';
import { formatSimTime, initialLog, logEvents, type LogContext, type LogLine } from './event-log.ts';

const CONTEXT: LogContext = {
  tickHz: 10,
  gateLabel: (id) => {
    if (id === 'g1') return 'T4 gate B25';
    throw new Error(`no gate ${id}`);
  },
};

/** The lines for `events` from a fresh log. */
function lines(...events: SimEvent[]): LogLine[] {
  return logEvents(initialLog(), events, CONTEXT).lines;
}

describe('logEvents: the pilots calling ground', () => {
  it('a check-in gives the taxilane and the ATIS letter the pilot has, stamped with its sim time', () => {
    expect(lines({ tick: 7240, type: 'check-in', callsign: 'DAL4', rampHandoff: 'rhKF', taxilane: 'KF', atis: 'O' })).toEqual([
      { tick: 7240, time: '12:04', kind: 'pilot', callsign: 'DAL4', text: 'DAL4 taxiing on KF, information O' },
    ]);
    expect(lines({ tick: 10, type: 'check-in', callsign: 'DAL4', rampHandoff: 'rhKF', taxilane: 'KF', atis: null })[0]?.text).toBe('DAL4 taxiing on KF');
  });

  it('clear of the runway gives the runway and the exit, if it has a name', () => {
    expect(lines({ tick: 600, type: 'clear-of-runway', callsign: 'UAE202', runwayEnd: '31L', exit: 'KE', exitId: 'x1' })).toEqual([
      { tick: 600, time: '1:00', kind: 'pilot', callsign: 'UAE202', text: 'UAE202 clear of 31L at KE' },
    ]);
    expect(lines({ tick: 600, type: 'clear-of-runway', callsign: 'UAE202', runwayEnd: '31R', exit: null, exitId: 'x2' })[0]?.text).toBe('UAE202 clear of 31R');
  });
});

describe('logEvents: what happened', () => {
  it('arrived at its gate, as the gate reads; took off; went around, with the reason', () => {
    expect(
      lines(
        { tick: 10, type: 'arrived-at-gate', callsign: 'UAE202', gate: 'g1' },
        { tick: 20, type: 'took-off', callsign: 'DAL4', runwayEnd: '31L' },
        { tick: 30, type: 'go-around', callsign: 'JBU9', runwayEnd: '31R', reason: 'runway occupied' },
      ),
    ).toEqual([
      { tick: 10, time: '0:01', kind: 'info', callsign: 'UAE202', text: 'UAE202 arrived at T4 gate B25' },
      { tick: 20, time: '0:02', kind: 'info', callsign: 'DAL4', text: 'DAL4 took off 31L' },
      { tick: 30, time: '0:03', kind: 'info', callsign: 'JBU9', text: 'JBU9 going around 31R: runway occupied' },
    ]);
  });

  it('shows no line for the events that are only bookkeeping, or that the map already shows', () => {
    const taxi: Taxi = { type: 'taxi', to: { kind: 'runway', name: '31L' }, via: [{ taxiway: 'A', turn: null }], holdShort: [] };
    const quiet: SimEvent[] = [
      { tick: 1, type: 'command-applied', callsign: 'DAL4', instruction: taxi },
      { tick: 1, type: 'entered-runway', callsign: 'DAL4', holdShort: 'h1', runways: ['13R/31L'], cleared: true },
      { tick: 1, type: 'crossed-runway', callsign: 'DAL4', runway: '13R/31L' },
      { tick: 1, type: 'stopped-for-traffic', callsign: 'DAL4', behind: 'JBU1' },
      { tick: 1, type: 'crossing-requested', callsign: 'DAL4', runway: null },
      { tick: 1, type: 'tower-accepted', callsign: 'DAL4', runwayEnd: '31L' },
      { tick: 1, type: 'lining-up', callsign: 'DAL4', runwayEnd: '31L' },
      { tick: 1, type: 'takeoff-roll', callsign: 'DAL4', runwayEnd: '31L' },
      { tick: 1, type: 'departed', callsign: 'DAL4', runwayEnd: '31L' },
      { tick: 1, type: 'landed', callsign: 'UAE202', runwayEnd: '31L' },
      { tick: 1, type: 'pushback', callsign: 'DAL4', gate: 'g1' },
      { tick: 1, type: 'ramp-accepted', callsign: 'UAE202', rampHandoff: 'rhKG', gate: 'g1' },
      { tick: 1, type: 'say-again-callsign', callsign: null },
    ];
    expect(lines(...quiet)).toEqual([]);
  });
});

describe("logEvents: the player's instruction didn't take", () => {
  const taxi: Taxi = { type: 'taxi', to: { kind: 'runway', name: '31L' }, via: [{ taxiway: 'A', turn: null }], holdShort: [] };

  it('unable, with the instruction and the reason', () => {
    expect(lines({ tick: 50, type: 'unable', callsign: 'DAL4', instruction: taxi, reason: "taxiways A and KE don't connect" })).toEqual([
      { tick: 50, time: '0:05', kind: 'unable', callsign: 'DAL4', text: "DAL4 unable (taxi): taxiways A and KE don't connect" },
    ]);
  });

  it('ambiguous: which way on the taxiway, and how to say it', () => {
    expect(lines({ tick: 50, type: 'ambiguous', callsign: 'DAL4', instruction: taxi, node: 'n1', at: 'A/KE', taxiway: 'KE', edges: ['e1', 'e2'] })).toEqual([
      { tick: 50, time: '0:05', kind: 'unable', callsign: 'DAL4', text: 'DAL4 unable (taxi): which way on KE at A/KE? Give the turn, L:KE or R:KE' },
    ]);
  });

  it("not on ground's frequency, saying whose it is; and a callsign the sim doesn't have", () => {
    expect(lines({ tick: 50, type: 'not-on-frequency', callsign: 'UAE202', controller: 'tower' }, { tick: 51, type: 'unknown-callsign', callsign: 'DAL44' })).toEqual([
      { tick: 50, time: '0:05', kind: 'unable', callsign: 'UAE202', text: "UAE202 is on tower's frequency, not yours: no reply" },
      { tick: 51, time: '0:05', kind: 'unable', callsign: 'DAL44', text: 'No aircraft DAL44' },
    ]);
  });
});

describe("logEvents: tower's crossing replies", () => {
  const approved = (tick: number, taxiway: string | null): Extract<SimEvent, { type: 'crossing-approved' }> => ({
    tick,
    type: 'crossing-approved',
    callsign: 'DAL4',
    runways: ['13R/31L'],
    designators: ['31L'],
    taxiway,
    holdShort: 'h1',
  });

  it('approved: the runway as tower says it, and the taxiway', () => {
    expect(lines(approved(100, 'KE'))).toEqual([{ tick: 100, time: '0:10', kind: 'tower', callsign: 'DAL4', text: 'TWR: DAL4 cross 31L at KE approved' }]);
    expect(lines(approved(100, null))[0]?.text).toBe('TWR: DAL4 cross 31L approved');
    expect(lines({ ...approved(100, 'J'), runways: ['4L/22R', '4R/22L'], designators: ['4L', '4R'] })[0]?.text).toBe('TWR: DAL4 cross 4L and 4R at J approved');
  });

  it("held, with tower's reason; its later approval is the callback, and only that one", () => {
    const held: SimEvent = { tick: 100, type: 'crossing-held', callsign: 'DAL4', runways: ['13R/31L'], designators: ['31L'], reason: 'traffic on final' };
    const first = logEvents(initialLog(), [held], CONTEXT);
    expect(first.lines).toEqual([{ tick: 100, time: '0:10', kind: 'tower', callsign: 'DAL4', text: 'TWR: DAL4 hold short of 31L, traffic on final; will call back' }]);
    // In a later batch, as in the app: the log remembers the hold.
    const callback = logEvents(first.state, [approved(900, 'KE')], CONTEXT);
    expect(callback.lines.map((l) => l.text)).toEqual(['TWR callback: DAL4 cross 31L at KE approved']);
    expect(logEvents(callback.state, [approved(1500, 'KE')], CONTEXT).lines.map((l) => l.text)).toEqual(['TWR: DAL4 cross 31L at KE approved']);
  });

  it("unable and cancelled, with tower's reason; either ends a hold", () => {
    const unable: SimEvent = { tick: 30, type: 'crossing-unable', callsign: 'DAL4', reason: "no runway crossing on DAL4's route" };
    const cancelled: SimEvent = { tick: 40, type: 'crossing-cancelled', callsign: 'DAL4', runways: ['13R/31L'], designators: ['31L'], reason: 'landing traffic' };
    expect(lines(unable, cancelled)).toEqual([
      { tick: 30, time: '0:03', kind: 'tower', callsign: 'DAL4', text: "TWR: DAL4 unable crossing: no runway crossing on DAL4's route" },
      { tick: 40, time: '0:04', kind: 'tower', callsign: 'DAL4', text: 'TWR: DAL4 crossing 31L cancelled: landing traffic' },
    ]);
    const held: SimEvent = { tick: 10, type: 'crossing-held', callsign: 'DAL4', runways: ['13R/31L'], designators: ['31L'], reason: 'traffic on final' };
    for (const end of [unable, cancelled]) {
      const after = logEvents(initialLog(), [held, end], CONTEXT).state;
      expect(logEvents(after, [approved(900, 'KE')], CONTEXT).lines[0]?.text).toBe('TWR: DAL4 cross 31L at KE approved');
    }
  });
});
describe('formatSimTime', () => {
  it('stamps sim time since the start as m:ss, and h:mm:ss from the first hour', () => {
    expect(formatSimTime(0)).toBe('0:00');
    expect(formatSimTime(9.95)).toBe('0:09');
    expect(formatSimTime(724)).toBe('12:04');
    expect(formatSimTime(3723)).toBe('1:02:03');
  });
});
