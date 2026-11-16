// The live counters over the sim's score (counters.ts, scoreCounters; PLAN 1.13 over 1.12's
// score.ts). The scoring records are written straight into a real sim's score here, so the
// numbers are exact; score.ts's own tests cover how the sim records them.

import { describe, expect, it } from 'vitest';
import testAirport from '../../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../../airport/graph.ts';
import { loadAirport } from '../../airport/load.ts';
import { createSim } from '../../sim/sim.ts';
import { counterRows, scoreCounters } from './counters.ts';
import { createSession } from './session.ts';

const TEST_AIRPORT = loadAirport(testAirport);
const TEST = indexAirport(TEST_AIRPORT);

describe('scoreCounters', () => {
  it("shows the sim's score: departures, arrivals, the average rate and the 15-minute peak, both combined", () => {
    const sim = createSim(TEST, { seed: 1 });
    const counters = scoreCounters();
    expect(counters.read()).toBeNull();
    counters.observe([], sim);
    // At tick 0: nothing yet, and no time for an average.
    expect(counters.read()).toEqual({ departures: 0, arrivals: 0, ratePerHour: null, peak15PerHour: 0 });
    // Two departures and an arrival within 15 minutes, read an hour in.
    sim.world.score.departures.push({ tick: 600, callsign: 'DAL1' }, { tick: 1200, callsign: 'DAL2' });
    sim.world.score.arrivals.push({ tick: 1800, callsign: 'BAW1' });
    sim.world.tick = 36_000;
    expect(counters.read()).toEqual({ departures: 2, arrivals: 1, ratePerHour: 3, peak15PerHour: 12 });
    expect(counterRows(counters.read()).map((r) => r.value)).toEqual(['2', '1', '3', '3.0', '12.0']);
  });

  it('freezes as the score does once the session has ended: the average is over the session, not since', () => {
    const sim = createSim(TEST, { seed: 1 });
    const counters = scoreCounters();
    counters.observe([], sim);
    sim.world.score.departures.push({ tick: 600, callsign: 'DAL1' });
    sim.world.session = { state: 'ended', tick: 18_000, cause: { kind: 'gridlock', aircraft: [], sinceTick: 17_400, origin: 'player' } };
    sim.world.tick = 36_000;
    expect(counters.read()).toEqual({ departures: 1, arrivals: 0, ratePerHour: 2, peak15PerHour: 4 });
  });

  it('in a session, shows zeros from the start, before any event (the session observes once as it starts)', () => {
    const session = createSession(TEST_AIRPORT, { seed: 1, counters: scoreCounters() });
    expect(session.counters.read()).toEqual({ departures: 0, arrivals: 0, ratePerHour: null, peak15PerHour: 0 });
  });
});
