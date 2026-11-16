// canDepartFrom (ramp.ts): which types can depart from a terminal, for the app's traffic (PLAN
// 1.13; Q: "yes add the export"). It replaces the app's startup probe, so it must give the
// probe's answers exactly.

import { describe, expect, it } from 'vitest';
import kjfkBase from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport, type AirportIndex } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import { AIRCRAFT_TYPES, canDepartFrom, createSim, listAircraft, step, type AircraftTypeCode } from './sim.ts';

const TEST = indexAirport(loadAirport(testAirport));
const KJFK = indexAirport(loadAirport(kjfkBase, kjfkOverrides));
const TYPES = Object.keys(AIRCRAFT_TYPES) as AircraftTypeCode[];

/**
 * The app's probe before this export (session.ts, cycle 9), kept as the oracle: a throwaway sim
 * on the empty airport with one departure stream, one tick; a spawn means yes.
 */
function probe(index: AirportIndex, terminal: string, type: AircraftTypeCode): boolean {
  const sim = createSim(index, { seed: 1, departures: [{ perHour: 1, flight: () => ({ callsign: 'PROBE1', type, terminal }) }] });
  step(sim, 1);
  return listAircraft(sim).length > 0;
}

describe('canDepartFrom', () => {
  // TEST has both answers (T2's 80 m stands take no widebody); at KJFK, since the ramp rework's
  // swings, every terminal takes every type.
  it.each([
    ['TEST', TEST, true],
    ['KJFK', KJFK, false],
  ])("gives the app's old probe's answer for every terminal and type (%s)", (_, index, someNo) => {
    const sim = createSim(index, { seed: 1 });
    const answers = (f: (terminal: string, type: AircraftTypeCode) => boolean) => index.airport.terminals.flatMap((t) => TYPES.map((type) => `${t.id} ${type} ${f(t.id, type)}`));
    const expected = answers((t, type) => probe(index, t, type));
    expect(answers((t, type) => canDepartFrom(sim, t, type))).toEqual(expected);
    expect(expected.some((a) => a.endsWith('true'))).toBe(true);
    expect(expected.some((a) => a.endsWith('false'))).toBe(someNo);
  }, 30_000);

  it('throws for a terminal the airport does not have: a caller bug, not a no', () => {
    const sim = createSim(TEST, { seed: 1 });
    expect(() => canDepartFrom(sim, 'T9', 'A320')).toThrow('no terminal T9 at TEST');
  });
});
