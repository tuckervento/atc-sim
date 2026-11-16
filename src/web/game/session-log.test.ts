// What the session tells its log about the airport (session.ts, PLAN 1.13): how a hold line
// reads, and how the session's end does.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../../data/airports/KJFK.overrides.json' with { type: 'json' };
import testAirport from '../../../data/airports/TEST.json' with { type: 'json' };
import { loadAirport } from '../../airport/load.ts';
import { addAircraft } from '../../sim/sim.ts';
import { advance, createSession, endedText } from './session.ts';

const KJFK = loadAirport(kjfkBase, kjfkOverrides);
const TEST = loadAirport(testAirport);

describe("the session's log context", () => {
  it("says a hold line's runways as tower does (the end in use on the 31s, else the first end) and its taxiway, from the line's edge toward the runway (KJFK)", () => {
    const { holdLine } = createSession(KJFK, { seed: 1 }).logContext;
    if (!holdLine) throw new Error('no holdLine in the session');
    const edges = new Map(KJFK.edges.map((e) => [e.id, e]));
    const on31L = KJFK.holdShorts.filter((h) => h.runways.length === 1 && h.runways[0] === '13R/31L');
    const on4L = KJFK.holdShorts.filter((h) => h.runways.length === 1 && h.runways[0] === '4L/22R');
    expect(on31L.length).toBeGreaterThan(0);
    expect(on4L.length).toBeGreaterThan(0);
    for (const h of on31L) expect(holdLine(h.id)).toEqual({ runways: ['31L'], taxiway: edges.get(h.towardEdge)?.name ?? null });
    for (const h of on4L) expect(holdLine(h.id).runways).toEqual(['4L']);
    expect(() => holdLine('nope')).toThrow('no hold line nope at KJFK');
  });

  it('logs the end of the session, and gives the banner its text: two aircraft placed on top of each other on A at TC collide (TEST)', () => {
    const session = createSession(TEST, { seed: 1 });
    addAircraft(session.sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'aTC', arrivedVia: 'aTC-aJ' } });
    addAircraft(session.sim, { callsign: 'JBU9', type: 'A320', at: { kind: 'node', node: 'aTC', arrivedVia: 'aTC-aJ' } });
    const lines = advance(session, 0.1);
    expect(lines.filter((l) => l.text.startsWith('SESSION OVER'))).toEqual([
      { tick: 1, time: '0:00', kind: 'info', callsign: null, text: 'SESSION OVER: collision of DAL4 and JBU9 near A (origin: player)' },
    ]);
    expect(endedText(session)?.title).toBe('Session over at 0:00: collision');
  });
});
