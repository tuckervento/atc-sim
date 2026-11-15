// The sim-core parts the simulated tower (1.10) and ramp (1.11) share: each aircraft's role,
// airline and controller, motion outside movement.ts, airborne aircraft, and removal.

import { describe, expect, it } from 'vitest';
import testAirport from '../../data/airports/TEST.json' with { type: 'json' };
import { indexAirport } from '../airport/graph.ts';
import { loadAirport } from '../airport/load.ts';
import kjfkBase from '../../data/airports/KJFK.json' with { type: 'json' };
import kjfkOverrides from '../../data/airports/KJFK.overrides.json' with { type: 'json' };
import { addAircraft, applyCommand, createSim, drainEvents, getAircraft, step, type Sim } from './sim.ts';
import { parseTerse } from './terse.ts';

const TEST = indexAirport(loadAirport(testAirport));
const KJFK = indexAirport(loadAirport(kjfkBase, kjfkOverrides));

/** Applies a terse command, which must parse. */
function transmit(sim: Sim, text: string): void {
  const result = parseTerse(text);
  if (!result.ok) throw new Error(`'${text}' doesn't parse: ${result.error.message}`);
  applyCommand(sim, result.command);
}

describe("the aircraft's airline", () => {
  it('takes "taxi hangar" with no name to the company hangar in a running sim (KJFK, Delta on S)', () => {
    const sim = createSim(KJFK, { seed: 1 });
    // North on S, as in kjfk.test.ts's hangar route.
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', airline: 'DAL', at: { kind: 'node', node: 'n12546344190', arrivedVia: 'w5786731-n45365993-n12546344190' } });
    transmit(sim, 'DAL4 taxi hangar via S');
    expect(drainEvents(sim).map((e) => e.type)).toEqual(['command-applied']);
    expect(getAircraft(sim, 'DAL4').clearance?.start.airline).toBe('DAL');
    step(sim, 3000);
    const dal4 = getAircraft(sim, 'DAL4');
    expect(dal4.status).toBe('arrived');
    expect(dal4.location).toMatchObject({ kind: 'node', node: 'n12546344193' });
    expect(drainEvents(sim).filter((e) => e.type === 'arrived')).toEqual([
      { type: 'arrived', tick: expect.any(Number), callsign: 'DAL4', destination: { kind: 'hangar', hangar: 'hgDAL', spot: 'n12546344193' } },
    ]);
  });
});

describe('role, airline and controller', () => {
  it('default to a departure with no airline, under ground, on the ground; the spawn spec sets them', () => {
    const sim = createSim(TEST, { seed: 1 });
    addAircraft(sim, { callsign: 'DAL4', type: 'A320', at: { kind: 'node', node: 'aJ', arrivedVia: 'aTC-aJ' } });
    addAircraft(sim, { callsign: 'UAE202', type: 'B77W', at: { kind: 'node', node: 'aC', arrivedVia: 'aTB-aC' }, role: 'arrival', airline: 'UAE', controller: 'ramp' });
    expect(getAircraft(sim, 'DAL4')).toMatchObject({ role: 'departure', airline: null, controller: 'ground', airborne: false });
    expect(getAircraft(sim, 'UAE202')).toMatchObject({ role: 'arrival', airline: 'UAE', controller: 'ramp', airborne: false });
  });
});
